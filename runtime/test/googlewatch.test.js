// Routines that start on mail and the calendar, against a stand-in for Gmail and Calendar.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { parseMail, describeMail, parseCalendar, describeCalendar } from '../src/googlewatch.js';

test('mail and calendar triggers in plain words', () => {
  const said = (when) => describeMail(parseMail(when));
  assert.equal(said('When new mail arrives'), 'When new mail arrives');
  assert.equal(said('when mail from ann@example.com arrives'), 'When mail from ann@example.com arrives');
  assert.equal(said('When an email from Paul Eriksen comes in'), 'When mail from Paul Eriksen arrives');
  assert.equal(parseMail('When mail from Paul Eriksen arrives').query, 'from:"Paul Eriksen"');
  assert.equal(said('When mail about invoices arrives'), 'When mail about invoices arrives');
  assert.equal(parseMail('When mail matching is:important arrives').query, 'is:important');
  assert.throws(() => parseMail('when the stars align'), /doesn't understand "when the stars align" for mail\. Try 'When new mail arrives'/);
  const cal = (when) => describeCalendar(parseCalendar(when));
  assert.equal(cal('Before each meeting'), '10 minutes before each meeting');
  assert.equal(cal('15 minutes before each event'), '15 minutes before each event');
  assert.equal(cal('an hour before each meeting'), '1 hour before each meeting');
  assert.equal(cal('When an invitation arrives'), 'When an invitation arrives');
  assert.throws(() => parseCalendar('sometimes'), /Try 'Before each meeting'/);
});

const CLIENT = { web: { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret' } };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');

// Gmail and Calendar whose contents the test changes: `mail` is { history, threads: [{id, from,
// subject}] }, `events` the calendar's events.
async function fakeGoogle() {
  const state = { history: '100', threads: [], events: [], calls: [] };
  let challenge = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://google');
    state.calls.push(`${req.method} ${url.pathname}`);
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body));
      if (createHash('sha256').update(form.code_verifier || '').digest('base64url') !== challenge) return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 360000, id_token: `x.${b64(JSON.stringify({ email: 'mikkel@example.com' }))}.y`,
        scope: 'openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events' });
    }
    if (url.pathname === '/gmail/profile') return json(200, { historyId: state.history });
    if (url.pathname === '/gmail/threads') {
      const q = url.searchParams.get('q');
      const from = /from:(\S+)/.exec(q)?.[1];
      return json(200, { threads: state.threads.filter((t) => !from || t.from.includes(from)).map((t) => ({ id: t.id })) });
    }
    const thread = /^\/gmail\/threads\/(\w+)$/.exec(url.pathname)?.[1];
    if (thread) {
      const t = state.threads.find((x) => x.id === thread);
      return json(200, { id: t.id, messages: [{ payload: { headers: [{ name: 'From', value: t.from }, { name: 'Subject', value: t.subject }, { name: 'Date', value: 'Sat, 17 Oct 2026 10:00:00 +0200' }] } }] });
    }
    if (url.pathname === '/calendar/calendars/primary/events') {
      const from = Date.parse(url.searchParams.get('timeMin'));
      const to = Date.parse(url.searchParams.get('timeMax'));
      return json(200, { timeZone: 'Europe/Copenhagen', items: state.events.filter((e) => Date.parse(e.start.dateTime) >= from && Date.parse(e.start.dateTime) <= to) });
    }
    return json(404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    google: { endpoints: { auth: 'https://accounts.example/auth', token: `${base}/token`, revoke: `${base}/revoke` }, apis: { gmail: `${base}/gmail`, calendar: `${base}/calendar` } },
    expect: (url) => { challenge = new URL(url).searchParams.get('code_challenge'); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('mail and calendar routines wake the agent for what is new, and only that', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-googlewatch-'));
  const fake = await fakeGoogle();
  t.after(() => fake.close());
  let clock = new Date('2026-10-17T08:00:00Z').getTime();
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const heard = [];
  faux.setResponses(Array.from({ length: 20 }, () => (context) => {
    heard.push(context.messages.filter((m) => m.role === 'user').at(-1).content.map?.((c) => c.text).join('') ?? context.messages.filter((m) => m.role === 'user').at(-1).content);
    return fauxAssistantMessage([fauxText('Noted.')]);
  }));
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, now: () => clock, google: fake.google });
  t.after(() => runtime.close());
  await runtime.setGoogleClient(CLIENT);
  const { url } = await runtime.googleSignIn({ services: ['gmail', 'calendar'], redirect: 'http://localhost:7779/runtime/api/google/callback' });
  fake.expect(url);
  await runtime.googleFinish({ state: new URL(url).searchParams.get('state'), code: 'the-code' });
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });

  const ann = await runtime.addRoutine('hugin', { name: 'Ann first', trigger: 'mail', when: 'when mail from ann@example.com arrives', does: 'Tell me right away.' });
  assert.equal(ann.when, 'When mail from ann@example.com arrives');
  assert.match(ann.note, /Starts once hugin has Gmail/, 'not picked yet');
  await runtime.updateAgent('hugin', { apps: ['gmail', 'google-calendar'] });
  assert.equal((await runtime.agent('hugin')).routines[0].note, null);
  await runtime.addRoutine('hugin', { name: 'Meeting prep', trigger: 'calendar', when: 'before each meeting', does: 'Brief me on it.' });
  await runtime.addRoutine('hugin', { name: 'Invites', trigger: 'calendar', when: 'When an invitation arrives', does: 'Tell me who.' });

  const tick = async (ms = 61 * 1000) => {
    clock += ms;
    await runtime.tick();
    await runtime.waitForIdle();
  };
  fake.state.threads = [{ id: 'old1', from: 'Ann <ann@example.com>', subject: 'Old news' }];
  fake.state.events = [{ id: 'inv0', summary: 'Old invite', start: { dateTime: '2026-10-20T09:00:00Z' }, attendees: [{ email: 'mikkel@example.com', self: true, responseStatus: 'needsAction' }] }];
  await tick(0);
  assert.deepEqual(heard, [], "the first look only notes what's there");

  // New mail from Ann, and some from someone else.
  fake.state.history = '101';
  fake.state.threads = [{ id: 'new1', from: 'Ann <ann@example.com>', subject: 'Lunch?' }, { id: 'spam', from: 'Shop <shop@example.com>', subject: 'Sale' }, ...fake.state.threads];
  await tick(30 * 1000);
  assert.deepEqual(heard, [], 'looked at most once a minute');
  await tick(31 * 1000);
  assert.equal(heard.length, 1);
  assert.match(heard[0], /^Your routine "Ann first" runs now, because new mail arrived:\nnew1 · Sat, 17 Oct 2026 10:00:00 \+0200 · from Ann <ann@example\.com> · Lunch\? \(1 message\)\.\n\nWhat to do: Tell me right away\.$/);

  // Nothing changed: only the history is asked for.
  const before = fake.state.calls.filter((c) => c.endsWith('/threads')).length;
  await tick();
  assert.equal(heard.length, 1);
  assert.equal(fake.state.calls.filter((c) => c.endsWith('/threads')).length, before, 'no search when Gmail says nothing changed');

  // A meeting in five minutes, an event on my own, and a new invitation.
  fake.state.events.push(
    { id: 'm1', summary: 'Standup', start: { dateTime: new Date(clock + 61 * 1000 + 5 * 60 * 1000).toISOString() }, attendees: [{ email: 'mikkel@example.com', self: true }, { email: 'ann@example.com' }] },
    { id: 'solo', summary: 'Focus time', start: { dateTime: new Date(clock + 61 * 1000 + 4 * 60 * 1000).toISOString() } },
    { id: 'inv1', summary: 'Board meeting', start: { dateTime: '2026-10-22T13:00:00Z' }, organizer: { email: 'chair@example.com' }, attendees: [{ email: 'mikkel@example.com', self: true, responseStatus: 'needsAction' }] },
  );
  await tick();
  const prep = heard.find((h) => h.startsWith('Your routine "Meeting prep"'));
  assert.match(prep, /because this is coming up:\nStandup at Sat 17 Oct, 10:\d\d, in 5 minutes \(event m1\)/);
  assert.doesNotMatch(prep, /Focus time/, 'an event on your own is no meeting');
  const invite = heard.find((h) => h.startsWith('Your routine "Invites"'));
  assert.match(invite, /because an invitation arrived:\nBoard meeting at .+ from chair@example\.com \(event inv1\)/);
  assert.doesNotMatch(invite, /Old invite/);
  const count = heard.length;
  await tick();
  assert.equal(heard.length, count, 'each meeting and invitation wakes it once');
});
