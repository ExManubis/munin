// An agent's own rhythm (rhythm.js): heartbeats that may come to nothing, a journal at the end
// of a day it worked, and who it is repeated at the end of a long conversation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { HEARTBEAT_MS, heartbeatDue, isQuiet, journalDue, proactivityFor } from '../src/rhythm.js';

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });
const HOUR = 60 * 60 * 1000;
const at = (h, m = 0, day = 4) => new Date(2027, 0, day, h, m).getTime(); // a Monday in January

test('who speaks up by default, and what counts as saying nothing', () => {
  assert.deepEqual(['companion', 'assistant', 'coder', 'reviewer', 'writer', 'researcher'].map(proactivityFor), ['chatty', 'matters', 'off', 'off', 'off', 'off']);
  for (const quiet of ['NO_REPLY', ' NO_REPLY.', '"NO_REPLY"']) assert.ok(isQuiet(quiet), quiet);
  for (const said of ['NO_REPLY but here is a riddle', 'Nothing new.', '']) assert.ok(!isQuiet(said) || said === '', said);
});

test('a heartbeat comes after a quiet spell, in waking hours, and not twice without an answer', () => {
  const pip = { proactivity: 'chatty', createdAt: at(7), rhythm: {} };
  assert.ok(!heartbeatDue(pip, { now: at(8) }), 'made an hour ago');
  assert.ok(heartbeatDue(pip, { now: at(9, 30) }));
  assert.ok(!heartbeatDue({ ...pip, proactivity: 'off' }, { now: at(12) }));
  assert.ok(!heartbeatDue({ ...pip, paused: true }, { now: at(12) }));
  assert.ok(!heartbeatDue(pip, { now: at(22) }) && !heartbeatDue(pip, { now: at(7, 59, 5) }), 'asleep');
  assert.ok(!heartbeatDue(pip, { now: at(12), lastAt: at(11) }), 'talked an hour ago');
  assert.ok(!heartbeatDue({ ...pip, rhythm: { heartbeat: at(11) } }, { now: at(12) }), 'the last heartbeat was an hour ago');
  const spoke = { ...pip, rhythm: { heartbeat: at(9), spoke: at(9) } };
  assert.ok(!heartbeatDue(spoke, { now: at(12), lastAt: at(9) }), 'said something, no answer yet');
  assert.ok(heartbeatDue(spoke, { now: at(12), lastAt: at(9, 5), lastHumanAt: at(9, 5) }), 'answered, then quiet');
});

test("the journal comes late on a day it worked, once the conversation's quiet, once a day", () => {
  const hugin = { rhythm: {} };
  assert.ok(journalDue(hugin, { now: at(21, 30), workedToday: true, lastAt: at(20) }));
  assert.ok(!journalDue(hugin, { now: at(20, 30), workedToday: true, lastAt: at(19) }), 'too early');
  assert.ok(!journalDue(hugin, { now: at(21, 30), workedToday: false, lastAt: at(9, 0, 3) }), 'nothing done today');
  assert.ok(!journalDue(hugin, { now: at(21, 30), workedToday: true, lastAt: at(21, 20) }), 'still talking');
  assert.ok(!journalDue({ rhythm: { journal: '2027-01-04' } }, { now: at(23), workedToday: true, lastAt: at(20) }), 'written today');
});

async function open(t, faux) {
  t.mock.timers.enable({ apis: ['Date'], now: at(7) });
  const dir = await mkdtemp(join(tmpdir(), 'munin-rhythm-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  return openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false });
}

test('a heartbeat that comes to nothing leaves no trace; one that speaks up waits for an answer', async (t) => {
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(t, faux);
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  assert.equal((await runtime.agent('pip')).proactivity, 'chatty');
  assert.equal((await runtime.agent('forge')).proactivity, 'off');
  await assert.rejects(runtime.updateAgent('forge', { proactivity: 'loud' }), /Speaking up is one of off, matters, chatty/);

  let told = '';
  faux.setResponses([(context) => {
    told = JSON.stringify(context.messages.findLast((m) => m.role === 'user'));
    return reply(fauxText('NO_REPLY'));
  }]);
  t.mock.timers.tick(3 * HOUR); // 10:00
  await runtime.tick();
  await runtime.waitForIdle();
  assert.match(told, /munin checking in: it's Monday 10:00, and nobody has asked you anything\. If you have something worth sharing with Mikkel/);
  let { items } = await runtime.conversation('pip');
  assert.deepEqual(items, [], 'nothing to show');
  assert.equal((await runtime.agents()).find((a) => a.name === 'forge').state, 'idle', 'a coder is left alone');

  faux.setResponses([reply(fauxText('Here is one: what has keys but opens no locks?'))]);
  t.mock.timers.tick(HEARTBEAT_MS); // 12:00
  await runtime.tick();
  await runtime.waitForIdle();
  ({ items } = await runtime.conversation('pip'));
  assert.deepEqual(items.map((i) => [i.kind, i.from, i.text]), [['message', 'agent', 'Here is one: what has keys but opens no locks?']]);

  t.mock.timers.tick(HEARTBEAT_MS * 2); // 16:00, and no answer yet
  await runtime.tick();
  await runtime.waitForIdle();
  assert.equal((await runtime.conversation('pip')).items.length, 1, "it doesn't speak twice without an answer");

  faux.setResponses([reply(fauxText('A piano!')), reply(fauxText('NO_REPLY'))]);
  await runtime.send('pip', 'Is it a piano?');
  await runtime.waitForIdle();
  t.mock.timers.tick(HEARTBEAT_MS); // 18:00
  await runtime.tick();
  await runtime.waitForIdle();
  assert.equal((await runtime.conversation('pip')).items.length, 3, 'answered, it checks in again, and says nothing');
  await runtime.close();
});

test('at the end of a day it worked, an agent writes in its journal and keeps what it learned', async (t) => {
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(t, faux);
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('hugin', { proactivity: 'off' });
  t.mock.timers.tick(12 * HOUR); // 19:00
  faux.setResponses([reply(fauxText('Moved.'))]);
  await runtime.send('hugin', 'Move the dentist to Thursday.');
  await runtime.waitForIdle();

  t.mock.timers.tick(HOUR); // 20:00: too early
  await runtime.tick();
  assert.equal((await runtime.conversation('hugin')).items.length, 2);

  let told = '';
  faux.setResponses([
    (context) => {
      told = JSON.stringify(context.messages.findLast((m) => m.role === 'user'));
      return reply(fauxToolCall('remember', { note: 'Mikkel prefers dentist visits on Thursdays.', kind: 'you' }));
    },
    reply(fauxText('Moved the dentist to Thursday. Learned that Mikkel likes Thursdays for that. The Aarhus offsite still has no agenda.')),
  ]);
  t.mock.timers.tick(1.5 * HOUR); // 21:30
  await runtime.tick();
  await runtime.waitForIdle();
  assert.match(told, /End of the day\. Write today's entry in your journal, which Mikkel reads on your profile, so write it to them as \\"you\\"/);
  const hugin = await runtime.agent('hugin');
  assert.deepEqual(hugin.journal.map((e) => e.text), ['Moved the dentist to Thursday. Learned that Mikkel likes Thursdays for that. The Aarhus offsite still has no agenda.']);
  assert.deepEqual(hugin.memory.map((n) => n.text), ['Mikkel prefers dentist visits on Thursdays.'], 'what it learned, through its own tools');
  const { items } = await runtime.conversation('hugin');
  assert.deepEqual(items.slice(2).map((i) => [i.kind, i.verb, i.object]), [['action', 'remembered', 'Mikkel prefers dentist visits on Thursdays.'], ['action', 'wrote in its journal', 'Moved the dentist to Thursday.']]);
  assert.ok(!items.some((i) => i.kind === 'message' && /End of the day/.test(i.text)), "munin's input isn't shown as yours");
  assert.equal((await runtime.agents()).find((a) => a.name === 'hugin').preview, 'Moved the dentist to Thursday.', 'the sidebar shows it while idle');

  t.mock.timers.tick(HOUR); // 22:30
  await runtime.tick();
  assert.equal((await runtime.agent('hugin')).journal.length, 1, 'once a day');
  await runtime.close();
});

test('in a long conversation, who the agent is comes again at the end of the request', async (t) => {
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(t, faux);
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('pip', { proactivity: 'off' });
  const last = [];
  faux.setResponses(Array.from({ length: 22 }, () => (context) => {
    last.push(context.messages.at(-1));
    return reply(fauxText('Ha.'));
  }));
  for (let i = 0; i < 22; i += 1) {
    await runtime.send('pip', `Joke ${i}`);
    await runtime.waitForIdle();
  }
  assert.equal(last[0].role, 'user', 'a short conversation goes as it is');
  assert.equal(last.at(-1).role, 'system');
  assert.match(last.at(-1).content, /^This conversation is long, so a reminder of who you are: pip, a companion\. You're curious, cheerful and a little odd\./);
  assert.ok(!(await runtime.conversation('pip')).items.some((i) => /reminder of who you are/.test(i.text || '')), 'for the request only');
  await runtime.close();
});
