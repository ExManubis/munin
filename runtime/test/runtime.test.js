// The runtime on pi-durable, with a scripted model: conversations, questions, approvals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'munin-runtime-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  const runtime = await openRuntime(settings, { models });
  return { runtime, faux, dir };
}

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });

test('an agent answers a message, and its conversation reads as items', async () => {
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'pip', role: 'companion', colour: 'straw', provider: 'scripted', model: 'model', brief: "You're pip." });
  faux.setResponses([reply(fauxText('Hi! Want a riddle?'))]);
  await runtime.send('pip', 'Hello');
  await runtime.waitForIdle();

  const { agent, items } = await runtime.conversation('pip');
  assert.deepEqual(items.map((i) => [i.kind, i.from, i.text]), [['message', 'human', 'Hello'], ['message', 'agent', 'Hi! Want a riddle?']]);
  assert.equal(agent.state, 'idle');
  assert.equal(agent.preview, 'Hi! Want a riddle?');
  assert.equal(agent.colour, 'straw');
  assert.equal(agent.roleName, 'Companion');
  await runtime.close();
});

test('without a model set up, the stand-in answers', async () => {
  const { runtime } = await setup();
  await runtime.createAgent({ name: 'moss', role: 'companion' });
  await runtime.send('moss', 'Are you there?');
  await runtime.waitForIdle();
  const { items } = await runtime.conversation('moss');
  assert.match(items[1].text, /stand-in model/);
  assert.match(items[1].text, /You said: Are you there\?/);
  await runtime.close();
});

test('a question with options waits for an answer, and the answer reaches the agent', async () => {
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'hugin', role: 'assistant', colour: 'sky', provider: 'scripted', model: 'model' });
  faux.setResponses([
    reply(fauxText('The dentist has two free slots.'), fauxToolCall('ask_human', { question: 'Move the dentist to which slot?', options: [{ label: 'Thursday 10:00', detail: 'Your morning is clear.' }, { label: 'Friday 14:30' }] })),
    reply(fauxText('I asked.')),
  ]);
  await runtime.send('hugin', 'Move the dentist, please.');
  await runtime.waitForIdle();

  let { items } = await runtime.conversation('hugin');
  const question = items.find((i) => i.kind === 'question');
  assert.equal(question.status, 'open');
  assert.deepEqual(question.options, [{ label: 'Thursday 10:00', detail: 'Your morning is clear.' }, { label: 'Friday 14:30', detail: '' }]);
  assert.equal(items.some((i) => i.kind === 'run'), false, 'asking is a card, not a run');
  const [waiting] = await runtime.waiting();
  assert.equal(waiting.agent.name, 'hugin');
  assert.equal(waiting.agent.state, 'asks');

  faux.setResponses([reply(fauxText('Done: Thursday at 10:00.'))]);
  await runtime.answer('hugin', question.id, { option: 'Thursday 10:00' });
  await runtime.waitForIdle();
  ({ items } = await runtime.conversation('hugin'));
  assert.deepEqual(items.find((i) => i.kind === 'question').answer, { option: 'Thursday 10:00', text: null });
  assert.equal(items.at(-1).text, 'Done: Thursday at 10:00.');
  assert.deepEqual(await runtime.waiting(), []);
  const request = faux.state.callCount;
  assert.ok(request >= 3);
  await runtime.close();
});

test('a message while a question is open answers it', async () => {
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  faux.setResponses([reply(fauxToolCall('ask_human', { question: 'Which day?' })), reply(fauxText('Asked.'))]);
  await runtime.send('hugin', 'Book it.');
  await runtime.waitForIdle();
  faux.setResponses([reply(fauxText('Booked for Monday.'))]);
  await runtime.send('hugin', 'Monday');
  await runtime.waitForIdle();
  const { items } = await runtime.conversation('hugin');
  const question = items.find((i) => i.kind === 'question');
  assert.deepEqual([question.status, question.answer.text], ['answered', 'Monday']);
  assert.deepEqual(items.slice(-2).map((i) => [i.from, i.text]), [['human', 'Monday'], ['agent', 'Booked for Monday.']]);
  await runtime.close();
});

test('a coder works in its own folder, its tool calls make a run, and pushing asks first', async () => {
  const { runtime, faux, dir } = await setup();
  const forge = await runtime.createAgent({ name: 'forge', role: 'coder', colour: 'ember', provider: 'scripted', model: 'model' });
  assert.equal(forge.worksIn.folder, join(dir, 'agents', 'forge'));
  assert.deepEqual(forge.askFirst.filter((r) => r.on).map((r) => r.id), ['push', 'delete']);

  faux.setResponses([
    reply(fauxText('On it.'), fauxToolCall('bash', { command: 'echo hello > notes.txt && cat notes.txt' })),
    reply(fauxToolCall('bash', { command: 'git push origin main' })),
    reply(fauxText('Waiting for you to allow the push.')),
  ]);
  await runtime.send('forge', 'Write a note and push it.');
  await runtime.waitForIdle();

  let { items, agent } = await runtime.conversation('forge');
  const run = items.find((i) => i.kind === 'run');
  assert.deepEqual(run.steps.map((s) => [s.text, s.detail]), [
    ['Ran echo hello > notes.txt && cat notes.txt', 'hello'],
    ['Ran git push origin main', 'failed'],
  ]);
  assert.equal(run.status, 'done');
  const approval = items.find((i) => i.kind === 'approval');
  assert.deepEqual([approval.label, approval.target, approval.status], ['Pushing to git', 'git push origin main', 'open']);
  assert.equal(agent.state, 'asks');

  // Always allow switches the rule off, and can be undone for a moment.
  faux.setResponses([reply(fauxToolCall('bash', { command: 'echo pushed' })), reply(fauxText('Pushed.'))]);
  await runtime.decide('forge', approval.id, 'always');
  await runtime.waitForIdle();
  ({ items, agent } = await runtime.conversation('forge'));
  assert.equal(items.find((i) => i.kind === 'approval').status, 'always');
  assert.equal(agent.askFirst.find((r) => r.id === 'push').on, false);
  assert.match(items.findLast((i) => i.from === 'human').text, /allowed you to push to git .*from now on/);
  await runtime.undo('forge', approval.id);
  ({ agent } = await runtime.conversation('forge'));
  assert.equal(agent.askFirst.find((r) => r.id === 'push').on, true);
  await runtime.close();
});

test('an agent remembers what it learns in later turns, until you make it forget', async () => {
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  let prompt = '';
  faux.setResponses([
    reply(fauxToolCall('remember', { note: 'Mikkel keeps his mornings free.' })),
    reply(fauxText('Noted.')),
    (context) => {
      prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system')); // the system prompt, as providers see it
      return reply(fauxText('After lunch, then.'));
    },
  ]);
  await runtime.send('hugin', 'I keep my mornings free, remember that.');
  await runtime.waitForIdle();
  let agent = await runtime.agent('hugin');
  assert.deepEqual(agent.memory.map((n) => n.text), ['Mikkel keeps his mornings free.']);
  const { items } = await runtime.conversation('hugin');
  assert.ok(items.some((i) => i.kind === 'action' && i.verb === 'remembered'));

  await runtime.send('hugin', 'When should we meet?');
  await runtime.waitForIdle();
  assert.match(prompt, /Mikkel keeps his mornings free/);

  await runtime.forget('hugin', agent.memory[0].id);
  agent = await runtime.agent('hugin');
  assert.equal(agent.memory.length, 0);
  await runtime.close();
});

test('pausing stops an agent taking messages until it resumes', async () => {
  const { runtime } = await setup();
  await runtime.createAgent({ name: 'moss', role: 'companion' });
  await runtime.pause('moss');
  await assert.rejects(runtime.send('moss', 'Hi'), /paused/);
  assert.equal((await runtime.agent('moss')).state, 'paused');
  await runtime.resume('moss');
  assert.equal((await runtime.agent('moss')).state, 'idle');
  const { items } = await runtime.conversation('moss');
  assert.deepEqual(items.map((i) => i.verb), ['paused', 'resumed']);
  await runtime.close();
});

test('names, roles and colours are checked', async () => {
  const { runtime } = await setup();
  await assert.rejects(runtime.createAgent({ name: 'X', role: 'coder' }), /letters, digits or dashes/);
  await assert.rejects(runtime.createAgent({ name: 'ok', role: 'wizard' }), /no role called wizard/);
  await assert.rejects(runtime.createAgent({ name: 'ok', role: 'coder', colour: 'plaid' }), /no colour called plaid/);
  await runtime.createAgent({ name: 'ok', role: 'writer' });
  await assert.rejects(runtime.createAgent({ name: 'ok', role: 'writer' }), /already an agent called ok/);
  await assert.rejects(runtime.agent('nobody'), /no agent called nobody/);
  await runtime.close();
});
