// Routines: schedules and tracker triggers in munin's words, and routines running on a clock
// the tests move by hand.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { parseSchedule, describeSchedule, nextRun } from '../src/schedule.js';
import { parseWatch, describeWatch, readFeed, matches } from '../src/watch.js';

const at = (d, h, m = 0) => new Date(2026, 9, d, h, m).getTime(); // October 2026; the 16th is a Friday
const MIN = 60 * 1000;

test('schedules read the way people write them, and run when they say', () => {
  const read = (text) => describeSchedule(parseSchedule(text));
  assert.equal(read('every weekday at 7:30am'), 'Weekdays 07:30');
  assert.equal(read('Mondays at 9'), 'Mondays 09:00');
  assert.equal(read('Every night 02:00'), 'Every day 02:00');
  assert.equal(read('mon-fri 9:00 and 17:00'), 'Weekdays 09:00, 17:00');
  assert.equal(read('Every 2 hours, 08–18'), 'Every 2 hours, 08:00–18:00');
  assert.equal(read('hourly between 9 and 17 on weekends'), 'Every hour on weekends, 09:00–17:00');
  assert.equal(read('Mon, Wed, Fri 09:00'), 'Mon, Wed, Fri 09:00');
  for (const bad of ['Every other Tuesday 9:00', 'every night', 'every 2 minutes', 'Weekdays 9 to 5']) {
    assert.throws(() => parseSchedule(bad), /Try 'Weekdays 07:30'/, bad);
  }
  const friday = new Date(at(16, 16, 30));
  assert.equal(nextRun(parseSchedule('Weekdays 07:30'), friday).getTime(), at(19, 7, 30));
  assert.equal(nextRun(parseSchedule('Every 2 hours, 08–18'), friday).getTime(), at(16, 18));
  assert.equal(nextRun(parseSchedule('Every day 16:30'), friday).getTime(), at(17, 16, 30), 'strictly after');
});

test('tracker triggers read the way people write them', () => {
  const read = (text) => describeWatch(parseWatch(text, 'forge'));
  assert.equal(read('When vera moves my issue to Todo'), "When vera moves forge's issue to Todo");
  assert.equal(read("When vera requests changes on forge's work"), "When vera moves forge's issue from In review to Todo");
  assert.equal(read('When a new issue is filed in WEB'), 'When an issue in WEB is created');
  assert.equal(read('When work is ready for review'), 'When an issue moves to In review');
  assert.throws(() => parseWatch('When it rains', 'forge'), /Try 'When an issue moves to In review'/);
  // Editing a routine reads its saved words again, so they have to mean the same thing.
  for (const text of ['When vera moves my issue to Todo', 'When vera files an issue in WEB', 'When someone comments on my issue', 'When anything happens', 'When claude-code asks the human', 'When codex takes an issue']) {
    const once = parseWatch(text, 'forge');
    assert.deepEqual(parseWatch(describeWatch(once), 'forge'), once, text);
  }
  for (const text of ['every 2 hours, 08-18', 'hourly on weekends between 9 and 17', 'Mon, Wed, Fri 09:00', 'Every day 07:30, 12:00']) {
    const once = parseSchedule(text);
    assert.deepEqual(parseSchedule(describeSchedule(once)), once, text);
  }

  const feed = readFeed('#41 2026-10-16 14:02 UTC  MUN-5  vera moved it from in_review to todo\n#42 2026-10-16 14:03 UTC  MUN-6  forge took it\nNext time: events(after=42)');
  assert.equal(feed.next, 42);
  const watch = parseWatch('When an issue moves to In progress', 'forge');
  assert.deepEqual(feed.events.map((e) => matches(watch, e, 'forge')), [false, false], "an agent's own take doesn't start its routines");
  assert.deepEqual(feed.events.map((e) => matches(watch, e, 'vera')), [false, true]);
});

async function setup(clock) {
  const dir = await mkdtemp(join(tmpdir(), 'munin-routines-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const heard = [];
  const answer = (context) => {
    faux.appendResponses([answer]);
    const last = context.messages.at(-1);
    heard.push(typeof last.content === 'string' ? last.content : last.content.map((c) => c.text || '').join(''));
    return fauxAssistantMessage([fauxText('On it.')]);
  };
  faux.setResponses([answer]);
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  const runtime = await openRuntime(settings, { models, now: () => clock.now, timers: false });
  return { runtime, heard };
}

const ranRoutines = async (runtime, name) => (await runtime.conversation(name)).items.filter((i) => i.verb === 'ran routine');

test('a routine on a schedule runs when it is due, and not while its agent is paused', async () => {
  const clock = { now: at(16, 8, 59) };
  const { runtime, heard } = await setup(clock);
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  const routine = await runtime.addRoutine('hugin', { name: 'Morning briefing', trigger: 'schedule', when: 'every weekday at 9', does: 'Summarise the day.' });
  assert.equal(routine.when, 'Weekdays 09:00');
  assert.equal(routine.next, new Date(at(16, 9)).toISOString());
  await assert.rejects(runtime.addRoutine('hugin', { name: 'Odd', when: 'every other day', does: 'x' }), /doesn't know "other"/);

  await runtime.tick();
  assert.equal((await ranRoutines(runtime, 'hugin')).length, 0, 'not yet');
  clock.now = at(16, 9, 0) + 20 * 1000;
  await runtime.tick();
  await runtime.waitForIdle();
  const [ran] = await ranRoutines(runtime, 'hugin');
  assert.equal(ran.object, 'Morning briefing');
  assert.match(heard.at(-1), /Your routine "Morning briefing" runs now, because it's Weekdays 09:00\.[\s\S]*What to do: Summarise the day\./);
  let [saved] = (await runtime.agent('hugin')).routines;
  assert.equal(saved.next, new Date(at(19, 9)).toISOString(), 'next on Monday');
  assert.equal(saved.last, new Date(clock.now).toISOString());

  await runtime.pause('hugin');
  clock.now = at(19, 9, 1);
  await runtime.tick();
  assert.equal((await ranRoutines(runtime, 'hugin')).length, 1, 'paused agents skip their routines');
  [saved] = (await runtime.agent('hugin')).routines;
  assert.equal(saved.next, new Date(at(20, 9)).toISOString());

  await runtime.resume('hugin');
  clock.now = at(20, 9, 30); // the runtime was away at 09:00, too long ago to catch up
  await runtime.tick();
  assert.equal((await ranRoutines(runtime, 'hugin')).length, 1);
  clock.now = at(21, 9, 10); // a run missed by ten minutes still happens
  await runtime.tick();
  await runtime.waitForIdle();
  assert.equal((await ranRoutines(runtime, 'hugin')).length, 2);

  await runtime.runRoutine('hugin', saved.id);
  await runtime.waitForIdle();
  assert.equal((await ranRoutines(runtime, 'hugin')).length, 3, 'run now');
  assert.match(heard.at(-1), /because you asked/);
  const mail = await runtime.addRoutine('hugin', { name: 'Paul first', trigger: 'mail', when: 'When mail from Paul arrives', does: 'Tell me.' });
  assert.match(mail.note, /Starts once hugin has Gmail: sign in with Google in Settings/);
  await runtime.close();
});

// The tracker's event feed, as far as routines read it.
async function fakeTracker(lines, assignees) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const text = (t) => reply({ content: [{ type: 'text', text: t }], isError: false });
    if (method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, instructions: 'The tracker.' });
    if (method === 'tools/list') return reply({ tools: [] });
    const args = params.arguments;
    if (params.name === 'get_issue') return text(`${args.issue}: Something\nProject: MUN · Status: todo · Assignee: ${assignees[args.issue] || 'none'} · Created by me`);
    const ids = lines.map((l) => Number(/^#(\d+)/.exec(l)[1]));
    const after = args.after ?? null;
    const found = after === null ? lines.slice(-(args.limit || 50)) : lines.filter((_, i) => ids[i] > after);
    if (!found.length) return text(after === null ? 'Nothing has happened yet.' : `Nothing new after event ${after}.`);
    return text(`${found.join('\n')}\nNext time: events(after=${/^#(\d+)/.exec(found.at(-1))[1]})`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('a routine on a tracker trigger runs when the feed shows a match', async () => {
  const lines = ['#1 2026-10-16 08:00 UTC  MUN-5  me created it', '#2 2026-10-16 08:01 UTC  MUN-5  vera moved it from in_review to todo'];
  const assignees = { 'MUN-5': 'forge', 'MUN-7': 'codex' };
  const tracker = await fakeTracker(lines, assignees);
  const clock = { now: at(16, 9) };
  const { runtime, heard } = await setup(clock);
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model', tracker: { url: tracker.url, token: 'tok-forge' } });
  const routine = await runtime.addRoutine('forge', { name: 'Fix what vera flags', trigger: 'tracker', when: 'When vera sends my work back', does: 'Pick it back up and fix what she found.' });
  assert.equal(routine.when, "When vera moves forge's issue from In review to Todo");
  assert.equal(routine.note, null);

  await runtime.tick(); // the first look starts from now: event 2 is old news
  assert.equal((await ranRoutines(runtime, 'forge')).length, 0);

  lines.push('#3 2026-10-16 09:01 UTC  MUN-7  vera moved it from in_review to todo'); // codex's work
  lines.push('#4 2026-10-16 09:02 UTC  MUN-6  forge moved it from in_review to todo'); // forge's own doing
  lines.push('#5 2026-10-16 09:03 UTC  MUN-5  vera moved it from in_review to todo');
  clock.now += 10 * 1000;
  await runtime.tick();
  assert.equal((await ranRoutines(runtime, 'forge')).length, 0, 'the feed is read every half minute');
  clock.now += 30 * 1000;
  await runtime.tick();
  await runtime.waitForIdle();
  const ran = await ranRoutines(runtime, 'forge');
  assert.equal(ran.length, 1);
  assert.deepEqual(ran[0].issue, { id: 'MUN-5', title: null });
  assert.match(heard.at(-1), /because in the tracker:\n#5 .* MUN-5 {2}vera moved it from in_review to todo\.[\s\S]*Pick it back up/);

  clock.now += 31 * 1000;
  await runtime.tick();
  assert.equal((await ranRoutines(runtime, 'forge')).length, 1, 'nothing new, nothing runs');
  await runtime.close();
  await tracker.close();
});

test('an agent sets up, changes and removes its own routines when asked, without asking unless you say so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-routines-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, now: () => at(16, 12) });
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  assert.deepEqual((await runtime.agent('hugin')).askFirst.map((r) => [r.id, r.on]), [['routines', false], ['skills', true]], "every agent has the rule, and it's off; saving skills asks");

  let heard = '';
  const turn = async (name, args) => {
    faux.setResponses([
      () => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
      // The tool's answer: a routine changes the prompt, so a system message may come after it.
      (context) => { heard = context.messages.findLast((m) => m.role === 'toolResult').content.map((c) => c.text).join(''); return fauxAssistantMessage([fauxText('Done.')]); },
    ]);
    await runtime.send('hugin', 'Please.');
    await runtime.waitForIdle();
    return heard;
  };

  assert.match(await turn('add_routine', { name: 'Morning brief', when: 'weekdays 7:30', does: "Today's events and the mail that needs me." }),
    /^Added: r\w+ · Morning brief · Weekdays 07:30 · next Mon 19 Oct, 07:30\n {2}does: Today's events and the mail that needs me\.$/);
  let agent = await runtime.agent('hugin');
  assert.deepEqual(agent.routines.map((r) => [r.name, r.when]), [['Morning brief', 'Weekdays 07:30']], 'on its profile like any routine');

  assert.match(await turn('add_routine', { name: 'Odd', when: 'whenever it feels right', does: 'x' }), /Try 'Weekdays 07:30'/, 'what munin doesn\'t understand comes back with examples');
  assert.match(await turn('change_routine', { routine: 'morning brief', when: 'weekdays 8' }), /^Changed: r\w+ · Morning brief · Weekdays 08:00/);
  assert.match(await turn('list_routines', {}), /Morning brief · Weekdays 08:00 · next Mon 19 Oct, 08:00/);
  assert.match(await turn('change_routine', { routine: 'Evening brief', when: '18' }), /no routine called Evening brief/);
  assert.equal(await turn('remove_routine', { routine: 'Morning brief' }), 'Removed Morning brief.');
  assert.equal((await runtime.agent('hugin')).routines.length, 0);
  const { items } = await runtime.conversation('hugin', { limit: 500 });
  assert.deepEqual(items.filter((i) => i.kind === 'action').map((i) => [i.verb, i.object]), [
    ['added routine', 'Morning brief: Weekdays 07:30'], ['changed routine', 'Morning brief: Weekdays 08:00'], ['removed routine', 'Morning brief'],
  ]);

  // Turned on, the rule makes it ask first.
  await runtime.updateAgent('hugin', { askFirst: { routines: true } });
  assert.match(await turn('add_routine', { name: 'Inbox sweep', when: 'every 30 minutes, 08-18', does: 'Sort new mail.' }), /hasn't allowed this yet \(setting up its own routines\)/);
  agent = await runtime.agent('hugin');
  assert.equal(agent.routines.length, 0, 'nothing added until you allow it');
  await runtime.close();
});
