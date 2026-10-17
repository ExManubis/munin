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
import { nextSpeaker, waitingOn, turnText, parseMeeting, MeetingError } from '../src/meetings.js';

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

test('turns go round-robin, and you joining counts as your say', () => {
  assert.equal(nextSpeaker(meeting([]), agents), 'pip');
  assert.equal(nextSpeaker(meeting([{ from: 'pip' }]), agents), 'hugin');
  assert.equal(nextSpeaker(meeting([{ from: 'hugin' }]), agents), 'pip'); // you're skipped: you speak when you like
  assert.equal(nextSpeaker(meeting([{ from: null }]), agents), 'pip'); // after you, the first agent
});

test('a gone agent is skipped in the round-robin', () => {
  const two = new Map([['hugin', {}]]);
  assert.equal(nextSpeaker(meeting([{ from: 'pip' }]), two), 'hugin');
  assert.equal(nextSpeaker(meeting([{ from: null }]), two), 'hugin');
});

test('the guards end a meeting that goes nowhere', () => {
  assert.equal(waitingOn(meeting([]), { agentsCount: 2, sinceHuman: 0, passed: 0 }), null);
  assert.equal(waitingOn(meeting([]), { agentsCount: 2, sinceHuman: 12, passed: 0 }), 'you');
  assert.equal(waitingOn(meeting([]), { agentsCount: 2, sinceHuman: 5, passed: 2 }), 'quiet');
  assert.equal(waitingOn({ ...meeting([]), status: 'closed' }, { agentsCount: 2, sinceHuman: 0, passed: 0 }), 'closed');
  assert.equal(waitingOn(meeting([]), { agentsCount: 0, sinceHuman: 0, passed: 0 }), 'agents');
});

test('a turn prompt attributes each speech to its speaker, you included', () => {
  const text = turnText(meeting([{ from: null, text: 'Hi both.' }, { from: 'pip', text: 'Hello!' }, { from: 'hugin', pass: true }]), 'hugin', 'Mikkel');
  assert.match(text, /Mikkel: Hi both\./);
  assert.match(text, /pip: Hello!/);
  assert.match(text, /hugin: \(passed\)/);
  assert.match(text, /It's your turn, hugin/);
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
  // pip's own conversation shows the turn as a line, not as a message from you.
  const { items } = await runtime.conversation('pip');
  const went = items.filter((i) => i.kind === 'action' && i.verb === 'went to a meeting');
  assert.ok(went.length >= 1);
  const messages = items.filter((i) => i.kind === 'message');
  assert.deepEqual(messages.map((i) => i.from), ['agent', 'agent', 'agent']); // three turns were pip's; none is a message from you
  await runtime.close();
});

test('the turn passes round-robin until the guards stop it', async () => {
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
  faux.setResponses([...turn('After you.'), ...turn('Something small.')], 'a');
  faux.setResponses([...turn('Agreed.'), ...turn('Sure.'), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Plans', participants: ['pip', 'hugin', null] });
  await runtime.waitForIdle();
  // Your say, then the round goes on: pip, then hugin, then a pass and it waits.
  faux.setResponses([...turn(null), ...turn(null)], 'a');
  faux.setResponses([...turn(null)], 'b');
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
test('nobody speaks twice in a row: a lone agent waits for you', () => {
  const solo = { id: 'm2', title: 'Solo', participants: ['pip', null], status: 'open', speeches: [] };
  assert.equal(nextSpeaker(solo, agents), 'pip');
  assert.equal(nextSpeaker({ ...solo, speeches: [{ from: null }] }, agents), 'pip');
  assert.equal(nextSpeaker({ ...solo, speeches: [{ from: null }, { from: 'pip' }] }, agents), null, 'your turn');
});

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
  // pip answers in plain words, no tool; later it has nothing to say, in plain words too.
  faux.setResponses([reply(fauxText('We should ship it.')), reply(fauxText('   ')), ...turn(null)], 'a');
  faux.setResponses([...turn('Agreed.'), ...turn(null)], 'b');
  const meeting = await runtime.createMeeting({ title: 'Ship?', participants: ['pip', 'hugin', null], first: 'Ship it?' });
  await runtime.waitForIdle();
  const full = await runtime.meeting(meeting.id);
  assert.deepEqual(full.speeches.slice(0, 4).map((s) => [s.from, s.pass ? 'pass' : s.text]),
    [[null, 'Ship it?'], ['pip', 'We should ship it.'], ['hugin', 'Agreed.'], ['pip', 'pass']]);
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
  faux.setResponses([...turn('In the first.'), ...turn('In the second.')], 'a');
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
