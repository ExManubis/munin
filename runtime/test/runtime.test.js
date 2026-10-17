// The runtime on pi-durable, with a scripted model: conversations, questions, approvals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';

async function setup(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'munin-runtime-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  const runtime = await openRuntime(settings, { models, ...options });
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

test('an agent pauses itself at its budget for the month, and resumes with a bigger budget or a new month', async () => {
  let clock = new Date(2026, 9, 17, 12).getTime(); // 17 October
  const { runtime, faux } = await setup({ now: () => clock, costOf: () => 0.4 }); // every response costs 40 cents
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('hugin', { budget: 1 });

  faux.setResponses([reply(fauxText('One.')), reply(fauxText('Two.'))]);
  await runtime.send('hugin', 'Count.');
  await runtime.waitForIdle();
  await runtime.send('hugin', 'Again.');
  await runtime.waitForIdle();
  let agent = await runtime.agent('hugin');
  assert.equal(agent.paused, false, '80 cents of a dollar');
  assert.equal(agent.usage.month, 0.8);

  faux.setResponses([reply(fauxToolCall('remember', { note: 'Mikkel counts things.' })), reply(fauxText('Three.'))]);
  await runtime.send('hugin', 'Once more.');
  await runtime.waitForIdle();
  agent = await runtime.agent('hugin');
  assert.equal(agent.paused, true, 'a dollar and twenty cents');
  assert.deepEqual(agent.memory, [], 'the tool call in the response that crossed the budget is blocked');
  assert.equal(agent.usage.month, 1.6, 'and the agent answers once more and stops');
  assert.equal(agent.pausedFor, 'budget');
  assert.equal(agent.state, 'paused');
  assert.equal((await runtime.agents()).find((a) => a.name === 'hugin').preview, 'Paused at its budget');
  const { items } = await runtime.conversation('hugin');
  assert.deepEqual(items.filter((i) => i.kind === 'action' && i.verb === 'paused').map((i) => i.object), ['at its $1 budget for October']);
  await assert.rejects(runtime.send('hugin', 'Hello?'), /paused/);
  await assert.rejects(runtime.resume('hugin'), /hugin has spent \$1\.60 of its \$1 budget this month\. Raise the budget/);

  await runtime.updateAgent('hugin', { budget: 5 });
  assert.equal((await runtime.agent('hugin')).paused, true, "a bigger budget doesn't resume it by itself");
  await runtime.resume('hugin');
  agent = await runtime.agent('hugin');
  assert.equal(agent.paused, false);
  assert.equal(agent.pausedFor, null);

  await runtime.updateAgent('hugin', { budget: 1 });
  await runtime.pause('hugin');
  assert.equal((await runtime.agent('hugin')).pausedFor, 'you');
  await assert.rejects(runtime.resume('hugin'), /budget/, 'still over it this month');
  clock = new Date(2026, 10, 1, 9).getTime(); // 1 November
  await runtime.resume('hugin');
  assert.equal((await runtime.agent('hugin')).usage.month, 0, 'a new month starts at nothing');
  await runtime.close();
});

test('an agent with no budget never pauses itself', async () => {
  const { runtime, faux } = await setup({ costOf: () => 50 });
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  faux.setResponses([reply(fauxText('Hi.'))]);
  await runtime.send('pip', 'Hi');
  await runtime.waitForIdle();
  assert.equal((await runtime.agent('pip')).paused, false);
  await runtime.close();
});

test('a conversation reads in pages, newest first, and keeps up with new messages', async () => {
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  for (let n = 1; n <= 6; n++) {
    faux.setResponses([reply(fauxText(`Answer ${n}.`))]);
    await runtime.send('pip', `Question ${n}?`);
    await runtime.waitForIdle();
  }
  const texts = (page) => page.items.map((i) => i.text);

  let page = await runtime.conversation('pip', { limit: 5 });
  assert.deepEqual(texts(page), ['Answer 4.', 'Question 5?', 'Answer 5.', 'Question 6?', 'Answer 6.']);
  assert.equal(page.more, true);
  page = await runtime.conversation('pip', { before: page.items[0].id, limit: 5 });
  assert.deepEqual(texts(page), ['Question 2?', 'Answer 2.', 'Question 3?', 'Answer 3.', 'Question 4?']);
  assert.equal(page.more, true);
  page = await runtime.conversation('pip', { before: page.items[0].id, limit: 5 });
  assert.deepEqual(texts(page), ['Question 1?', 'Answer 1.']);
  assert.equal(page.more, false);
  assert.equal((await runtime.conversation('pip')).items.length, 12, 'a hundred by default');
  await assert.rejects(runtime.conversation('pip', { before: 'nope' }), /no item nope/);

  faux.setResponses([reply(fauxText('Answer 7.'))]);
  await runtime.send('pip', 'Question 7?');
  await runtime.waitForIdle();
  assert.deepEqual(texts(await runtime.conversation('pip', { limit: 2 })), ['Question 7?', 'Answer 7.'], 'new messages show up');

  await runtime.deleteAgent('pip');
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  assert.deepEqual((await runtime.conversation('pip')).items, [], 'a new pip starts a new conversation');
  await runtime.close();
});
