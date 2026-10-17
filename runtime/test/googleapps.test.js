// Gmail and Google Calendar, the apps that come with munin, against a stand-in for Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';

const CLIENT = { web: { client_id: '1234-abc.apps.googleusercontent.com', client_secret: 'GOCSPX-secret' } };
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64url');
const headers = (pairs) => Object.entries(pairs).map(([name, value]) => ({ name, value }));

// Google's token endpoint, Gmail and Calendar, as far as munin uses them.
async function fakeGoogle({ modify = false } = {}) {
  const seen = []; // [method, path+query, body, authorization]
  let challenge = null;
  const threads = {
    t1: { id: 't1', messages: [
      { id: 'm1', payload: { mimeType: 'text/plain', headers: headers({ From: 'Ann <ann@example.com>', To: 'mikkel@example.com', Date: 'Fri, 16 Oct 2026 09:12:00 +0200', Subject: 'Lunch?', 'Message-ID': '<m1@example.com>' }), body: { data: b64('Lunch on Friday at 12?') } } },
    ] },
    t2: { id: 't2', messages: [
      { id: 'm2', payload: { mimeType: 'multipart/alternative', headers: headers({ From: 'News <news@example.com>', To: 'mikkel@example.com', Date: 'Sat, 17 Oct 2026 07:00:00 +0200', Subject: 'Weekly' }),
        parts: [{ mimeType: 'text/html', body: { data: b64('<html><style>x{}</style><p>Big <b>news</b>&amp; more</p></html>') } }] } },
    ] },
  };
  const events = [
    { id: 'e1', summary: 'Standup', start: { dateTime: '2026-10-17T07:00:00Z' }, end: { dateTime: '2026-10-17T07:15:00Z' }, attendees: [{ email: 'mikkel@example.com', self: true, responseStatus: 'accepted' }, { email: 'ann@example.com' }] },
    { id: 'e2', summary: 'Dentist', start: { dateTime: '2026-10-17T13:00:00Z' }, end: { dateTime: '2026-10-17T14:00:00Z' } },
  ];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://google');
    seen.push([req.method, `${url.pathname}${url.search}`, body, req.headers.authorization || null]);
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(value === undefined ? '' : JSON.stringify(value));
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body));
      if (form.grant_type === 'authorization_code' && createHash('sha256').update(form.code_verifier).digest('base64url') === challenge) {
        return json(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 3600, id_token: `x.${b64(JSON.stringify({ email: 'mikkel@example.com' }))}.y`,
          scope: `openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.compose${modify ? ' https://www.googleapis.com/auth/gmail.modify' : ''} https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events` });
      }
      return json(400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/revoke') return json(200, {});
    if (req.headers.authorization !== 'Bearer access-1') return json(401, { error: { message: 'Invalid Credentials' } });
    let m;
    if (url.pathname === '/gmail/threads') return json(200, { threads: [{ id: 't1', snippet: 'Lunch on Friday at 12?' }, { id: 't2', snippet: 'Big news' }] });
    if ((m = /^\/gmail\/threads\/(\w+)$/.exec(url.pathname))) return threads[m[1]] ? json(200, threads[m[1]]) : json(404, { error: { message: 'Not Found' } });
    if (url.pathname === '/gmail/drafts') return json(200, { id: 'd1' });
    if (url.pathname === '/gmail/labels' && req.method === 'GET') {
      return json(200, { labels: [['INBOX', 'system'], ['UNREAD', 'system'], ['STARRED', 'system'], ['TRASH', 'system'], ['Label_9', 'user', 'Newsletters']].map(([id, type, name]) => ({ id, type, name: name || id })) });
    }
    if (url.pathname === '/gmail/labels' && req.method === 'POST') return json(200, { id: 'Label_1', type: 'user', name: JSON.parse(body).name });
    if (/^\/gmail\/threads\/\w+\/(modify|trash)$/.test(url.pathname)) return json(200, {});
    if (url.pathname === '/gmail/messages/send') return json(200, { id: 's1' });
    if (url.pathname === '/calendar/calendars/primary/events' && req.method === 'GET') return json(200, { timeZone: 'Europe/Copenhagen', items: events });
    if (url.pathname === '/calendar/calendars/primary/events' && req.method === 'POST') return json(200, { id: 'e3', ...JSON.parse(body) });
    if ((m = /^\/calendar\/calendars\/primary\/events\/(\w+)$/.exec(url.pathname))) return json(200, events.find((e) => e.id === m[1]));
    return json(404, { error: { message: 'Not Found' } });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    google: { endpoints: { auth: 'https://accounts.example/auth', token: `${base}/token`, revoke: `${base}/revoke` }, apis: { gmail: `${base}/gmail`, calendar: `${base}/calendar` } },
    seen,
    expect: (url) => { challenge = new URL(url).searchParams.get('code_challenge'); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

test('Gmail and Google Calendar: reading and drafting go straight through, sending and changing ask first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-googleapps-'));
  const google = await fakeGoogle();
  t.after(() => google.close());
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, google: google.google });
  t.after(() => runtime.close());

  await runtime.setGoogleClient(CLIENT);
  const { url } = await runtime.googleSignIn({ services: ['gmail', 'calendar'], redirect: 'http://localhost:7779/runtime/api/google/callback' });
  google.expect(url);
  assert.equal((await runtime.googleFinish({ state: new URL(url).searchParams.get('state'), code: 'the-code' })).ok, true);
  assert.deepEqual((await runtime.apps()).filter((a) => a.builtin).map((a) => [a.id, a.connected, a.detail]),
    [['gmail', true, 'As mikkel@example.com'], ['google-calendar', true, 'As mikkel@example.com']]);

  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  const agent = await runtime.updateAgent('hugin', { apps: ['gmail', 'google-calendar'] });
  assert.deepEqual(agent.askFirst.map((r) => [r.id, r.on]), [['app:gmail:send', true], ['app:gmail:trash', true], ['app:gmail:organise', false], ['app:google-calendar', true]]);

  const heard = [];
  const turn = async (...steps) => {
    faux.setResponses(steps.map((step) => (context) => {
      heard.push(context.messages.at(-1).content?.map?.((c) => c.text).join('') ?? '');
      return typeof step === 'string' ? fauxAssistantMessage([fauxText(step)]) : fauxAssistantMessage([fauxToolCall(step[0], step[1])], { stopReason: 'toolUse' });
    }));
    await runtime.send('hugin', 'Go.');
    await runtime.waitForIdle();
  };
  const calls = (path) => google.seen.filter(([method, at]) => at.startsWith(path) && method !== 'GET');

  // Reading.
  await turn(['gmail__search_mail', { query: 'is:unread' }], 'Found.');
  assert.match(heard.at(-1), /^t1 · Fri, 16 Oct 2026 09:12:00 \+0200 · from Ann <ann@example\.com> · Lunch\? \(1 message\)\n  Lunch on Friday at 12\?/);
  assert.ok(google.seen.some(([, at]) => at.includes('metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date')));
  await turn(['gmail__read_thread', { thread: 't2' }], 'Read.');
  assert.match(heard.at(-1), /From: News <news@example\.com>[\s\S]*Subject: Weekly\n\nBig news & more$/, 'HTML mail as text');
  await turn(['google_calendar__list_events', { from: '2026-10-17' }], 'Listed.');
  assert.match(heard.at(-1), /^Times in Europe\/Copenhagen\.\ne1 · Sat 17 Oct, 09:00 – Sat 17 Oct, 09:15 · Standup · 2 people\ne2 · Sat 17 Oct, 15:00 – Sat 17 Oct, 16:00 · Dentist$/);

  // Drafting a reply: no asking, in the thread, and nothing gets past the headers.
  await turn(['gmail__draft_mail', { to: 'ann@example.com', subject: 'Re: Frokost på fredag\r\nBcc: eve@example.com', body: 'Yes, see you then.', thread: 't1' }], 'Drafted.');
  assert.match(heard.at(-1), /It's in Gmail's Drafts \(draft d1\), not sent\./);
  const draft = JSON.parse(calls('/gmail/drafts')[0][2]);
  const raw = Buffer.from(draft.message.raw, 'base64url').toString('utf8');
  assert.equal(draft.message.threadId, 't1');
  assert.match(raw, /^To: ann@example\.com\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\nIn-Reply-To: <m1@example\.com>\r\nReferences: <m1@example\.com>\r\n/);
  assert.doesNotMatch(raw, /\r\nBcc:/, 'a line break in the subject is no new header');
  assert.equal(Buffer.from(/Subject: =\?UTF-8\?B\?(.+?)\?=/.exec(raw)[1], 'base64').toString('utf8'), 'Re: Frokost på fredag Bcc: eve@example.com');

  // Sending asks first.
  await turn(['gmail__send_mail', { to: 'ann@example.com', subject: 'Lunch', body: 'Yes!' }], 'Asked.');
  assert.match(heard.at(-1), /hasn't allowed this yet \(gmail: sending mail\)/);
  assert.equal(calls('/gmail/messages/send').length, 0, 'nothing sent');
  let { items } = await runtime.conversation('hugin');
  const approval = items.filter((i) => i.kind === 'approval').at(-1);
  assert.deepEqual([approval.what, approval.target], ['send mail', 'send mail · to: ann@example.com · subject: Lunch · body: Yes!']);
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('gmail__send_mail', { to: 'ann@example.com', subject: 'Lunch', body: 'Yes!' })], { stopReason: 'toolUse' }),
    (context) => { heard.push(context.messages.at(-1).content.map((c) => c.text).join('')); return fauxAssistantMessage([fauxText('Sent.')]); },
  ]);
  await runtime.decide('hugin', approval.id, 'once');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Sent "Lunch" to ann@example\.com \(message s1\)\./);
  assert.equal(calls('/gmail/messages/send').length, 1);

  // Changing the calendar asks first too; an event with guests sends them invitations.
  await turn(['google_calendar__create_event', { title: 'Lunch with Ann', start: '2026-10-23T12:00:00+02:00', end: '2026-10-23T13:00:00+02:00', attendees: 'ann@example.com' }], 'Asked.');
  ({ items } = await runtime.conversation('hugin'));
  const create = items.filter((i) => i.kind === 'approval').at(-1);
  assert.equal(create.target, 'create event · title: Lunch with Ann · start: 2026-10-23T12:00:00+02:00 · end: 2026-10-23T13:00:00+02:00 · attendees: ann@example.com');
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('google_calendar__create_event', { title: 'Lunch with Ann', start: '2026-10-23T12:00:00+02:00', end: '2026-10-23T13:00:00+02:00', attendees: 'ann@example.com' })], { stopReason: 'toolUse' }),
    (context) => { heard.push(context.messages.at(-1).content.map((c) => c.text).join('')); return fauxAssistantMessage([fauxText('Added.')]); },
  ]);
  await runtime.decide('hugin', create.id, 'once');
  await runtime.waitForIdle();
  const [, at, sent] = calls('/calendar/calendars/primary/events').at(-1);
  assert.match(at, /sendUpdates=all/);
  assert.deepEqual(JSON.parse(sent), { summary: 'Lunch with Ann', start: { dateTime: '2026-10-23T10:00:00.000Z' }, end: { dateTime: '2026-10-23T11:00:00.000Z' }, attendees: [{ email: 'ann@example.com' }] });
  assert.match(heard.at(-1), /^Added: e3 · /);

  // Signed out: the tools are gone, and the apps say why.
  await runtime.googleSignOut();
  assert.deepEqual((await runtime.apps()).filter((a) => a.builtin).map((a) => a.connected), [false, false]);
  faux.setResponses([(context) => {
    const names = new Set();
    for (const m of context.messages.filter((message) => message.role === 'system')) {
      for (const tool of m.toolsAdded || []) names.add(tool.name);
      for (const tool of m.toolsRemoved || []) names.delete(typeof tool === 'string' ? tool : tool.name);
    }
    heard.push([...names].filter((n) => n.startsWith('gmail__')).join(','));
    return fauxAssistantMessage([fauxText('Hm.')]);
  }]);
  await runtime.send('hugin', 'Mail?');
  await runtime.waitForIdle();
  assert.equal(heard.at(-1), '', 'no Gmail tools once signed out');
});

test('organising Gmail: labels, archive and read go without asking, the bin asks first', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-googleapps-'));
  const google = await fakeGoogle({ modify: true });
  t.after(() => google.close());
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, google: google.google });
  t.after(() => runtime.close());
  await runtime.setGoogleClient(CLIENT);
  const { url } = await runtime.googleSignIn({ services: ['gmail'], redirect: 'http://localhost:7779/runtime/api/google/callback' });
  google.expect(url);
  await runtime.googleFinish({ state: new URL(url).searchParams.get('state'), code: 'the-code' });
  assert.equal((await runtime.google()).account.organise, true);
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('hugin', { apps: ['gmail'] });

  const heard = [];
  const turn = async (call) => {
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: 'toolUse' }),
      (context) => { heard.push(context.messages.at(-1).content.map((c) => c.text).join('')); return fauxAssistantMessage([fauxText('Done.')]); },
    ]);
    await runtime.send('hugin', 'Go.');
    await runtime.waitForIdle();
    return heard.at(-1);
  };
  const changes = () => google.seen.filter(([method, at]) => method === 'POST' && at.startsWith('/gmail/')).map(([, at, body]) => [at, body && JSON.parse(body)]);

  assert.equal(await turn(['gmail__list_labels', {}]), "Yours: Newsletters\nGmail's: INBOX, STARRED, UNREAD");
  assert.equal(await turn(['gmail__label_threads', { threads: 't1, t2', add: 'Receipts, starred', remove: 'newsletters' }]),
    '2 threads: added Receipts, starred; took off newsletters. Made the label Receipts.', 'no asking: sorting is off by default');
  assert.deepEqual(changes(), [
    ['/gmail/labels', { name: 'Receipts', labelListVisibility: 'labelShow', messageListVisibility: 'show' }],
    ['/gmail/threads/t1/modify', { addLabelIds: ['Label_1', 'STARRED'], removeLabelIds: ['Label_9'] }],
    ['/gmail/threads/t2/modify', { addLabelIds: ['Label_1', 'STARRED'], removeLabelIds: ['Label_9'] }],
  ]);
  assert.equal(await turn(['gmail__archive_threads', { threads: 't1' }]), 'Archived 1 thread.');
  assert.deepEqual(changes().at(-1), ['/gmail/threads/t1/modify', { removeLabelIds: ['INBOX'] }]);
  assert.equal(await turn(['gmail__mark_threads', { threads: 't2', read: false }]), 'Marked 1 thread unread.');
  assert.deepEqual(changes().at(-1), ['/gmail/threads/t2/modify', { addLabelIds: ['UNREAD'] }]);
  assert.match(await turn(['gmail__label_threads', { threads: 't1', add: 'TRASH' }]), /TRASH can't be set by name\. To move mail to the bin, use trash_threads/);
  assert.match(await turn(['gmail__archive_threads', { threads: Array.from({ length: 51 }, (_, i) => `t${i}`).join(',') }]), /At most 50 threads at a time/);

  // The bin asks first.
  const before = changes().length;
  assert.match(await turn(['gmail__trash_threads', { threads: 't2' }]), /hasn't allowed this yet \(gmail: moving mail to the bin\)/);
  assert.equal(changes().length, before, 'nothing moved');
  const { items } = await runtime.conversation('hugin');
  const approval = items.filter((i) => i.kind === 'approval').at(-1);
  assert.deepEqual([approval.what, approval.target], ['move mail to the bin', 'trash threads · threads: t2']);
});

test("without gmail.modify, Gmail still reads and drafts, and organising says to sign in again", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-googleapps-'));
  const google = await fakeGoogle();
  t.after(() => google.close());
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, google: google.google });
  t.after(() => runtime.close());
  await runtime.setGoogleClient(CLIENT);
  const { url } = await runtime.googleSignIn({ services: ['gmail'], redirect: 'http://localhost:7779/runtime/api/google/callback' });
  google.expect(url);
  await runtime.googleFinish({ state: new URL(url).searchParams.get('state'), code: 'the-code' });
  assert.equal((await runtime.apps()).find((a) => a.id === 'gmail').connected, true);
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('hugin', { apps: ['gmail'] });
  let heard = '';
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('gmail__archive_threads', { threads: 't1' })], { stopReason: 'toolUse' }),
    (context) => { heard = context.messages.at(-1).content.map((c) => c.text).join(''); return fauxAssistantMessage([fauxText('Hm.')]); },
  ]);
  await runtime.send('hugin', 'Archive it.');
  await runtime.waitForIdle();
  assert.equal(heard, 'Organising mail needs one more permission from Google: sign in with Google again under Google in Settings.');
});
