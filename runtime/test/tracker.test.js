// Coders in the tracker: its tools over MCP with each agent's own token, and what they do
// showing up in the conversation. A small stand-in for the tracker's MCP endpoint answers in
// the tracker's words; the frontend's half is checked in the browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { parseIssueLine } from '../src/tracker.js';

const TOOLS = [
  { name: 'list_projects', description: 'List projects.', inputSchema: { type: 'object', properties: {} } },
  { name: 'get_issue', description: 'Get an issue.', inputSchema: { type: 'object', properties: { issue: { type: 'string' } }, required: ['issue'] } },
  {
    name: 'update_issue',
    description: 'Change an issue.',
    inputSchema: { type: 'object', properties: { issue: { type: 'string' }, status: { anyOf: [{ enum: ['todo', 'in_progress', 'in_review', 'done', 'cancelled'], type: 'string' }, { type: 'null' }], default: null } }, required: ['issue'] },
  },
  {
    name: 'add_comment',
    description: 'Comment on an issue, or ask the human something.',
    inputSchema: {
      type: 'object',
      properties: {
        issue: { type: 'string' },
        body: { type: 'string' },
        ask_human: { type: 'boolean', default: false },
        options: { anyOf: [{ type: 'array', items: { $ref: '#/$defs/QuestionOption' } }, { type: 'null' }], default: null },
      },
      required: ['issue', 'body'],
      $defs: { QuestionOption: { type: 'object', properties: { label: { type: 'string' }, detail: { type: 'string', default: '' } }, required: ['label'] } },
    },
  },
];

// The tracker's MCP endpoint, as far as these tests need it.
async function fakeTracker() {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (!token.startsWith('tok-')) {
      res.writeHead(401).end();
      return;
    }
    const reply = (result) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    const text = (t) => reply({ content: [{ type: 'text', text: t }], isError: false });
    if (method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, instructions: 'Munin is an issue tracker shared by you, other agents and a human.' });
    if (method === 'tools/list') return reply({ tools: TOOLS });
    calls.push({ token, name: params.name, args: params.arguments });
    const args = params.arguments;
    switch (params.name) {
      case 'list_projects': return text('You are forge in munin.\n\nMUN: munin\nBuild munin.');
      case 'get_issue': return text(`${args.issue}: Retry rate-limited calls\nProject: MUN · Status: in_progress`);
      case 'update_issue': return text(`Updated ${args.issue} [${args.status}] Retry rate-limited calls (assignee: forge)`);
      case 'add_comment': return text(args.ask_human
        ? `Asked the human on ${args.issue} (comment 7). Their answer shows up in the issue's comments, and wait_for_work tells you when it does.`
        : `Commented on ${args.issue} (comment 8).`);
      default: return reply({ content: [{ type: 'text', text: 'No such tool.' }], isError: true });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'munin-tracker-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  return { runtime: await openRuntime(settings, { models }), faux };
}

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });
const systemOf = (context) => JSON.stringify(context.messages.filter((m) => m.role === 'system'));

test('a coder works in the tracker with its own token, and its take and question show in the conversation', async () => {
  const tracker = await fakeTracker();
  const { runtime, faux } = await setup();
  let prompt = '';
  faux.setResponses([
    (context) => {
      prompt = systemOf(context);
      return reply(fauxText('Taking the top one.'), fauxToolCall('update_issue', { issue: 'MUN-5', status: 'in_progress' }));
    },
    reply(fauxToolCall('add_comment', { issue: 'MUN-5', body: 'Retry 429s only, or 5xx too?', ask_human: true, options: [{ label: '429 only' }, { label: 'Both', detail: 'Retries on server errors too.' }] })),
    reply(fauxText('Asked about the retries.')),
    reply(fauxText('429 only it is.')),
  ]);
  await runtime.createAgent({ name: 'forge', role: 'coder', colour: 'ember', provider: 'scripted', model: 'model', tracker: { url: tracker.url, token: 'tok-forge', projects: ['mun'] } });
  let agent = await runtime.agent('forge');
  assert.deepEqual(agent.tracker, { projects: ['MUN'], takes: 'issues', connected: true, reachable: true });
  assert.ok(!JSON.stringify(agent).includes('tok-forge'), 'the token never leaves the runtime');

  await runtime.send('forge', 'Continue MUN.');
  await runtime.waitForIdle();
  assert.deepEqual(tracker.calls.map((c) => [c.token, c.name]), [['tok-forge', 'update_issue'], ['tok-forge', 'add_comment'], ['tok-forge', 'get_issue']]);
  assert.match(prompt, /Munin is an issue tracker/);
  assert.match(prompt, /Your projects: MUN/);

  const { items } = await runtime.conversation('forge');
  const took = items.find((i) => i.kind === 'action');
  assert.deepEqual([took.verb, took.issue], ['took', { id: 'MUN-5', title: 'Retry rate-limited calls' }]);
  const run = items.find((i) => i.kind === 'run');
  assert.deepEqual(run.issue, { id: 'MUN-5', title: 'Retry rate-limited calls' });
  assert.deepEqual(run.steps.map((s) => s.text), ['Moved MUN-5 to In progress'], 'the question is a card, not a step');
  const question = items.find((i) => i.kind === 'question');
  assert.equal(question.trackerQuestion, 7);
  assert.deepEqual(question.issue, { id: 'MUN-5', title: 'Retry rate-limited calls' });
  assert.deepEqual(question.options.map((o) => o.label), ['429 only', 'Both']);
  assert.equal((await runtime.waiting())[0].item.trackerQuestion, 7);

  await runtime.answer('forge', question.id, { option: '429 only' });
  await runtime.waitForIdle();
  agent = await runtime.agent('forge');
  assert.equal(agent.preview, '429 only it is.');
  await runtime.close();
  await tracker.close();
});

test("until the tracker answers, an agent is told it's away, and its tools come once it does", async () => {
  const tracker = await fakeTracker();
  const { runtime, faux } = await setup();
  const prompts = [];
  const capture = (answer) => (context) => {
    prompts.push(systemOf(context));
    return reply(fauxText(answer));
  };
  faux.setResponses([capture('No tracker.'), capture('Tracker is back.')]);
  await runtime.createAgent({ name: 'vera', role: 'reviewer', provider: 'scripted', model: 'model', tracker: { url: 'http://127.0.0.1:9/mcp', token: 'tok-vera' } });
  assert.equal((await runtime.agent('vera')).tracker.reachable, false);
  await runtime.send('vera', 'Anything to review?');
  await runtime.waitForIdle();
  assert.match(prompts[0], /can't be reached right now/);

  await runtime.updateAgent('vera', { tracker: { url: tracker.url } });
  const agent = await runtime.agent('vera');
  assert.equal(agent.tracker.reachable, true);
  assert.equal(agent.tracker.takes, 'reviews');
  await runtime.send('vera', 'And now?');
  await runtime.waitForIdle();
  assert.match(prompts[1], /Munin is an issue tracker/);
  await runtime.close();
  await tracker.close();
});

test('an agent without a token is told how to get one, and tracker links are checked', async () => {
  const tracker = await fakeTracker();
  const { runtime, faux } = await setup();
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model', tracker: { url: tracker.url, token: 'tok-forge' } });
  await runtime.createAgent({ name: 'anvil', role: 'coder', provider: 'scripted', model: 'model' });
  assert.deepEqual((await runtime.agent('anvil')).tracker, { projects: [], takes: 'issues', connected: false, reachable: true });
  faux.setResponses([reply(fauxToolCall('list_projects', {})), reply(fauxText('No tracker for me.'))]);
  await runtime.send('anvil', 'Continue MUN.');
  await runtime.waitForIdle();
  const { items } = await runtime.conversation('anvil');
  assert.equal(items.find((i) => i.kind === 'run').steps[0].detail, 'failed');
  assert.equal(tracker.calls.length, 0);

  await assert.rejects(runtime.updateAgent('anvil', { tracker: { url: 'ftp://tracker', token: 'x' } }), /isn't an http one/);
  await assert.rejects(runtime.updateAgent('anvil', { tracker: { token: 'tok-anvil' } }), /needs the tracker’s address/);
  await assert.rejects(runtime.updateAgent('forge', { tracker: { projects: ['not a key'] } }), /keys like MUN/);
  await runtime.updateAgent('forge', { tracker: null });
  assert.equal((await runtime.agent('forge')).tracker.connected, false);
  await runtime.close();
  await tracker.close();
});

test('issue lines read back from the tracker', () => {
  assert.deepEqual(parseIssueLine('MUN-5 [in_review] Retry (and back off) (assignee: forge) (blocked by MUN-2)'),
    { id: 'MUN-5', status: 'in_review', title: 'Retry (and back off)', assignee: 'forge' });
  assert.equal(parseIssueLine('No issues match.'), null);
});
