// Meetings (meetings.js): figbots talking in turns, with you able to join. The turn driver with
// a scripted model, and the meetings API.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFauxCore as fauxCore, createProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { roundOf, nextTurn, discussion, hasNews, mentionsIn, turnText, parseMeeting, MeetingError, ROUNDS, SPEECHES } from '../src/meetings.js';

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'munin-meetings-'));
  const settings = { db: options.db || ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  // One faux core per model id: a single provider's queue is shared, so two agents' turns would interleave.
  const makeProvider = (id) => {
    const core = fauxCore({ provider: `scripted-${id}`, models: [{ id: `model-${id}` }] });
    const provider = createProvider({
      id: core.provider, auth: { apiKey: { name: 'Faux', resolve: async () => ({ auth: {} }) } }, models: core.models,
      api: { stream: core.stream, streamSimple: core.streamSimple, fetchDeferred: core.fetchDeferred, cancelDeferred: core.cancelDeferred },
    });
    return { id: `scripted-${id}`, model: `model-${id}`, core, provider };
  };
  const made = [makeProvider('a'), makeProvider('b')];
  const models = await buildModels(settings, { extra: made.map((m) => m.provider), env: {} });
  const faux = {
    setResponses: (turns, id = 'a') => made.find((m) => m.id === `scripted-${id}`).core.setResponses(turns),
  };
  const runtime = await openRuntime(settings, { models });
  return { runtime, faux, dir, made, settings };
}

// Two agents, each on its own scripted model, so their turns don't share a response queue.
async function twoAgents(runtime, made) {
  await runtime.createAgent({ name: 'pip', role: 'companion', colour: 'straw', provider: 'scripted-a', model: 'model-a' });
  await runtime.createAgent({ name: 'hugin', role: 'assistant', colour: 'sky', provider: 'scripted-b', model: 'model-b' });
  return made;
}

const agents = new Map([['pip', {}], ['hugin', {}]]); // for the pure functions
const meeting = (speeches) => ({ id: 'm1', title: 'Test', participants: ['pip', null, 'hugin'], status: 'open', speeches });

test('a round asks every figbot once, starting one further along each round, never the last speaker first', () => {
  assert.deepEqual(roundOf(meeting([]), agents, 0), ['pip', 'hugin']);
  assert.deepEqual(roundOf(meeting([]), agents, 1), ['hugin', 'pip']);
  assert.deepEqual(roundOf(meeting([{ from: 'hugin' }]), agents, 1), ['pip', 'hugin'], 'hugin spoke last');
  assert.deepEqual(roundOf(meeting([]), new Map([['hugin', {}]]), 0), ['hugin'], 'a gone figbot is left out');
});

test('a discussion settles on a silent round, and stops at its caps', () => {
  const never = () => false;
  const m = meeting([{ from: null, text: 'Go.' }]);
  const talk = discussion(m, agents);
  assert.deepEqual(nextTurn(talk, m, agents, never), { ask: 'pip' });
  assert.deepEqual(nextTurn(talk, m, agents, never), { ask: 'hugin' });
  assert.deepEqual(nextTurn(talk, m, agents, never), { stop: 'settled' }, 'nobody spoke in the round');

  const lively = meeting([{ from: null, text: 'Go.' }]);
  const busy = discussion(lively, agents);
  const asked = [];
  for (let turn = nextTurn(busy, lively, agents, never); turn.ask; turn = nextTurn(busy, lively, agents, never)) {
    asked.push(turn.ask);
    const other = turn.ask === 'pip' ? 'hugin' : 'pip';
    lively.speeches.push({ from: turn.ask, text: `@${other}, what do you think?` }); // each pulls the other in
    Object.assign(busy, { spoke: true, speeches: busy.speeches + 1 });
  }
  // Round one asks both; after that only whoever was just pulled in and hasn't answered yet.
  assert.deepEqual(asked, ['pip', 'hugin', 'pip', 'hugin'], `${ROUNDS} rounds`);
  assert.deepEqual(nextTurn(busy, lively, agents, never), { stop: 'bounded' });

  const once = meeting([{ from: null, text: 'Go.' }]);
  const quiet = discussion(once, agents);
  nextTurn(quiet, once, agents, never);
  once.speeches.push({ from: 'pip', text: 'Done here.' });
  quiet.spoke = true;
  nextTurn(quiet, once, agents, never);
  once.speeches.push({ from: 'hugin', text: 'Me too.' });
  assert.deepEqual(nextTurn(quiet, once, agents, never), { stop: 'settled' }, 'nobody pulled anyone in: no second round');

  const chatty = { ...discussion(m, agents), speeches: SPEECHES };
  assert.deepEqual(nextTurn(chatty, m, agents, never), { stop: 'bounded' }, `${SPEECHES} speeches at most`);
});

test('a figbot with nothing new to hear sits a round out, so a lone one waits for you', () => {
  const solo = { ...meeting([{ from: null, text: 'Hi.' }, { from: 'pip', text: 'Hello.' }]), participants: ['pip', null], seen: { pip: 1 } };
  assert.equal(hasNews(solo, 'pip'), false, 'only its own words since its turn');
  assert.equal(hasNews({ ...solo, seen: {} }, 'pip'), true);
});




test('a turn prompt attributes each speech to its speaker, you included', () => {
  const text = turnText(meeting([{ from: null, text: 'Hi both.' }, { from: 'pip', text: 'Hello!' }, { from: 'hugin', pass: true }]), 'pip', 'Mikkel');
  assert.match(text, /Mikkel: Hi both\./);
  assert.match(text, /hugin: \(passed\)/);
  assert.doesNotMatch(text, /pip: Hello!/, "its own speeches are in its session already");
  assert.match(text, /It's your turn, pip/);
  assert.match(text, /Never reveal anything from your private conversations with Mikkel/);
});

test('a turn carries only what was said since the last one, within bounds', () => {
  const said = Array.from({ length: 30 }, (_, i) => ({ from: i % 2 ? 'hugin' : null, text: `line ${i}` }));
  const text = turnText(meeting(said), 'pip', 'Mikkel', 25);
  assert.match(text, /Said since your last turn/);
  assert.deepEqual(text.match(/line \d+/g), ['line 25', 'line 26', 'line 27', 'line 28', 'line 29']);
  const first = turnText(meeting(said), 'pip', 'Mikkel');
  assert.equal(first.match(/line \d+/g).length, 24, 'at most 24 speeches');
  assert.match(first, /\(6 earlier speeches left out\)/);
});

test('a meeting takes a title, participants and you (null), and a first speech', async () => {
  const parsed = parseMeeting({ title: 'Weekly', participants: ['pip', null], first: 'Kick us off.' });
  assert.deepEqual(parsed.participants, ['pip', null]);
  assert.equal(parsed.first, 'Kick us off.');
  assert.throws(() => parseMeeting({ title: '', participants: ['pip'] }), MeetingError);
  assert.throws(() => parseMeeting({ title: 'X', participants: [] }), MeetingError);
});

// A turn consumes two scripted responses: the speak_in_meeting call, then the answer to its
// result. Each agent has its own queue, so each side scripts its own turns in order.
const turn = (text) => [reply(fauxToolCall('speak_in_meeting', text == null ? {} : { text })), reply(fauxText(text == null ? 'Passed.': 'Said.'))];

test('an agent speaks in a meeting with speak_in_meeting, and the transcript shows it', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  faux.setResponses([...turn('Hello hugin!'), ...turn('Hello again.'), ...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn('Hi pip.'), ...turn(null), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Introductions', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();

  const full = await runtime.meeting(meeting.id);
  assert.deepEqual(full.speeches.slice(0, 2).map((s) => [s.from, s.text]), [['pip', 'Hello hugin!'], ['hugin', 'Hi pip.']]);
  assert.ok(full.speeches.slice(3).every((s) => s.pass), JSON.stringify(full.speeches));
  // The turns happen in pip's session for the meeting: its own conversation has one line saying it went.
  const { items } = await runtime.conversation('pip');
  assert.deepEqual(items.map((i) => [i.kind, i.verb, i.object]), [['action', 'went to a meeting', 'Introductions']]);
  await runtime.close();
});

test('a round where everyone passes settles the meeting, and you speaking starts it again', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  // Two passes each: the meeting waits after the second pair.
  faux.setResponses([...turn(null), ...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn(null), ...turn(null), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Quiet', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();

  const full = await runtime.meeting(meeting.id);
  assert.equal(full.speeches.length, 2);
  assert.ok(full.speeches.every((s) => s.pass));
  // And you speaking keeps it going.
  faux.setResponses([...turn('Anyone? No.'), ...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn(null), ...turn(null)], 'b');
  await runtime.speakInMeetingAsHuman(meeting.id, 'Speak up if you have something.');
  await runtime.waitForIdle();
  const after = await runtime.meeting(meeting.id);
  assert.equal(after.speeches.at(-1).pass, true); // it waited again
  assert.ok(after.speeches.some((s) => s.from === null && s.text === 'Speak up if you have something.'));
  await runtime.close();
});

test('you join in, and your speech lands attributed to you', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  faux.setResponses([...turn('After you.')], 'a');
  faux.setResponses([...turn('Agreed.')], 'b');
  const meeting = await runtime.createMeeting({ title: 'Plans', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();
  // Your say starts a new round: pip passes, hugin answers.
  faux.setResponses([...turn(null)], 'a');
  faux.setResponses([...turn('Sure.')], 'b');
  await runtime.speakInMeetingAsHuman(meeting.id, 'What shall we build?');
  await runtime.waitForIdle();
  const full = await runtime.meeting(meeting.id);
  const mine = full.speeches.find((s) => s.from === null && s.text === 'What shall we build?');
  assert.ok(mine);
  assert.ok(full.speeches.some((s) => s.from === 'hugin' && s.text === 'Sure.'));
  await runtime.close();
});

test('a meeting survives a restart, and closing stops the turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-meetings-re-'));
  const settings = { db: join(dir, 'runtime.db'), agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const { runtime, faux, made } = await setup({ db: settings.db });
  await twoAgents(runtime, made);
  faux.setResponses([...turn('One.'), ...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn(null), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Kept', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();
  await runtime.closeMeeting(meeting.id);
  await runtime.close();

  const reopened = await setup({ db: settings.db });
  const list = await reopened.runtime.meetings();
  assert.equal(list.length, 1, JSON.stringify(list));
  assert.equal(list[0].title, 'Kept');
  assert.equal(list[0].status, 'closed');
  const full = await reopened.runtime.meeting(meeting.id);
  assert.ok(full.speeches.some((s) => s.text === 'One.'));
  // A closed meeting takes no more speeches.
  await assert.rejects(() => reopened.runtime.speakInMeetingAsHuman(meeting.id, 'Hello?'), /closed/);
  await reopened.runtime.close();
});
const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });

test('a lone agent and you take turns', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  faux.setResponses([...turn('Morning.'), ...turn('Sounds good.')], 'a');
  const meeting = await runtime.createMeeting({ title: 'Standup', participants: ['pip', null], first: 'Morning, pip.' });
  await runtime.waitForIdle();
  assert.deepEqual((await runtime.meeting(meeting.id)).speeches.map((s) => s.from), [null, 'pip']);
  await runtime.speakInMeetingAsHuman(meeting.id, 'Let us ship it.');
  await runtime.waitForIdle();
  assert.deepEqual((await runtime.meeting(meeting.id)).speeches.map((s) => s.from), [null, 'pip', null, 'pip']);
  await runtime.close();
});

test('a turn ended without speak_in_meeting still counts, and the meeting moves on', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  // pip answers in plain words, no tool; hugin pulls it back in, and it has nothing more, in plain words too.
  faux.setResponses([reply(fauxText('We should ship it.')), reply(fauxText('   ')), ...turn(null)], 'a');
  faux.setResponses([...turn('Agreed, @pip anything else?'), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Ship?', participants: ['pip', 'hugin', null], first: 'Ship it?' });
  await runtime.waitForIdle();
  const full = await runtime.meeting(meeting.id);
  assert.deepEqual(full.speeches.slice(0, 4).map((s) => [s.from, s.pass ? 'pass' : s.text]),
    [[null, 'Ship it?'], ['pip', 'We should ship it.'], ['hugin', 'Agreed, @pip anything else?'], ['pip', 'pass']]);
  assert.ok(!(await runtime.conversation('pip')).items.some((i) => i.kind === 'question'), 'nothing waits on you from it');
  await runtime.close();
});

test('blank words are a pass, not an empty speech', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  faux.setResponses([...turn('   '), ...turn(null)], 'a');
  faux.setResponses([...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Blank', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();
  const [first] = (await runtime.meeting(meeting.id)).speeches;
  assert.deepEqual([first.from, first.pass, first.text], ['pip', true, null]);
  await runtime.close();
});

test('an agent in two meetings answers both', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  // Each session answers its own meeting; the two run side by side, so answer by what was asked.
  const byMeeting = (context) => {
    const last = context.messages.at(-1);
    if (last.role !== 'user') return reply(fauxText('Said.'));
    return reply(fauxToolCall('speak_in_meeting', { text: /called \W*One\W/.test(JSON.stringify(last.content)) ? 'In the first.' : 'In the second.' }));
  };
  faux.setResponses(Array.from({ length: 4 }, () => byMeeting), 'a');
  const one = await runtime.createMeeting({ title: 'One', participants: ['pip', null] });
  const two = await runtime.createMeeting({ title: 'Two', participants: ['pip', null] });
  await runtime.waitForIdle();
  assert.deepEqual((await runtime.meeting(one.id)).speeches.map((s) => s.text), ['In the first.']);
  assert.deepEqual((await runtime.meeting(two.id)).speeches.map((s) => s.text), ['In the second.']);
  await runtime.close();
});

test('who was asked to speak survives a restart, and meetings have a doc of their own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-meetings-asked-'));
  const db = join(dir, 'runtime.db');
  const { runtime, made } = await setup({ db });
  await twoAgents(runtime, made);
  // No scripted answer yet: hugin's turn is asked, and munin stops before it's answered.
  const meeting = await runtime.createMeeting({ title: 'Later', participants: ['hugin', null], first: 'Over to you.' });
  assert.equal((await runtime.meeting(meeting.id)).speeches.length, 1, 'asked, not answered yet');
  await runtime.close().catch(() => {});

  const again = await setup({ db });
  again.faux.setResponses([...turn('Picked it up.')], 'b');
  await again.runtime.resume('hugin').catch(() => {});
  await again.runtime.waitForIdle();
  const full = await again.runtime.meeting(meeting.id);
  assert.deepEqual(full.speeches.map((s) => [s.from, s.text]), [[null, 'Over to you.'], ['hugin', 'Picked it up.']]);
  await again.runtime.close();
});

test("a meeting session doesn't hold the figbot's chats with you", async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  let seen = null;
  faux.setResponses([
    reply(fauxText('Noted, I will keep it to myself.')),
    (context) => { seen = JSON.stringify(context.messages); return reply(fauxToolCall('speak_in_meeting', { text: 'Hello.' })); },
    reply(fauxText('Said.')),
  ], 'a');
  await runtime.send('pip', 'Between us: the surprise party is on Friday.');
  await runtime.waitForIdle();
  await runtime.createMeeting({ title: 'Planning', participants: ['pip', null], first: 'Anything for this week?' });
  await runtime.waitForIdle();
  assert.ok(seen, 'pip was asked to speak');
  assert.doesNotMatch(seen, /surprise party/);
  assert.match(seen, /Anything for this week\?/);
  await runtime.close();
});

test('a lively discussion stops after its rounds and waits for you, a quiet one settles', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  const talker = (name, other) => (context) => (context.messages.at(-1).role === 'user'
    ? reply(fauxToolCall('speak_in_meeting', { text: `${name} has more for @${other}.` })) : reply(fauxText('Said.')));
  faux.setResponses(Array.from({ length: 20 }, () => talker('pip', 'hugin')), 'a');
  faux.setResponses(Array.from({ length: 20 }, () => talker('hugin', 'pip')), 'b');
  const lively = await runtime.createMeeting({ title: 'Lively', participants: ['pip', 'hugin', null], first: 'Go.' });
  await runtime.waitForIdle();
  let full = await runtime.meeting(lively.id);
  assert.equal(full.speeches.filter((s) => s.from).length, 4, 'both, then each pulled back in, for three rounds');
  assert.equal(full.state, 'bounded');
  assert.deepEqual(full.speeches.slice(1).map((s) => s.from), ['pip', 'hugin', 'pip', 'hugin']);

  faux.setResponses([...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn(null)], 'b');
  await runtime.speakInMeetingAsHuman(lively.id, 'Anything else?');
  await runtime.waitForIdle();
  full = await runtime.meeting(lively.id);
  assert.equal(full.state, 'settled', 'a silent round');
  assert.equal(full.speeches.slice(-2).every((s) => s.pass), true);
  await runtime.close();
});

test('your @mention picks who answers, a figbot pulls in another, and @you calls you in', async () => {
  const { runtime, faux, made } = await setup();
  await twoAgents(runtime, made);
  faux.setResponses([...turn('Happy to. @hugin, can you check the budget?'), ...turn(null)], 'a');
  faux.setResponses([...turn('It fits, but @you should decide on the venue.')], 'b');
  const meeting = await runtime.createMeeting({ title: 'Offsite', participants: ['pip', 'hugin', null], first: '@pip, plan the offsite.' });
  await runtime.waitForIdle();
  const full = await runtime.meeting(meeting.id);
  assert.deepEqual(full.speeches.map((s) => s.from), [null, 'pip', 'hugin'], 'only pip at first; hugin because pip asked');
  assert.deepEqual([full.state, full.needsYou?.from], ['settled', 'hugin']);
  const waiting = await runtime.waiting();
  assert.deepEqual(waiting.map(({ agent, item }) => [agent.name, item.kind, item.meeting?.title]), [['hugin', 'meeting', 'Offsite']]);

  faux.setResponses([...turn(null)], 'a');
  faux.setResponses([...turn(null)], 'b');
  await runtime.speakInMeetingAsHuman(meeting.id, 'The lake house.');
  await runtime.waitForIdle();
  assert.equal((await runtime.meeting(meeting.id)).needsYou, null);
  assert.deepEqual(await runtime.waiting(), [], 'answered by speaking');
  await runtime.close();
});

test('mentions are read against who is in the meeting', () => {
  const m = meeting([]);
  const found = mentionsIn('@pip and @Hugin, cc @nobody and mail@example.com', m, 'Mikkel');
  assert.deepEqual([[...found.figbots], found.everyone, found.you], [['pip', 'hugin'], false, false]);
  assert.equal(mentionsIn('@all of you', m).everyone, true);
  assert.equal(mentionsIn('over to @Mikkel', m, 'Mikkel').you, true);
  assert.equal(mentionsIn('@you decide', m).you, true);
  assert.equal(mentionsIn('@you decide', { ...m, participants: ['pip', 'hugin'] }).you, false, "you're not in this one");
});
