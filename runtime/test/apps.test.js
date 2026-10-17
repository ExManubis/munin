// Apps: MCP servers you add in Settings, whose tools agents with the app use.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';

// A calendar as an MCP server: it wants its token, hands out a session, and can forget it.
async function calendar() {
  const seen = []; // [method, token, session]
  const sessions = new Set();
  let made = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    const session = req.headers['mcp-session-id'] || null;
    seen.push([message.method, req.headers.authorization || null, session]);
    if (req.headers.authorization !== 'Bearer cal-secret-1234') return res.writeHead(401).end();
    if (!message.id) return res.writeHead(202).end(); // a notification
    if (message.method !== 'initialize' && !sessions.has(session)) return res.writeHead(404).end();
    const reply = (result, headers = {}) => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      const id = `s${++made}`;
      sessions.add(id);
      return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} } }, { 'Mcp-Session-Id': id });
    }
    if (message.method === 'tools/list') {
      return reply({ tools: [
        { name: 'list_events', description: "Today's events", inputSchema: { type: 'object', properties: { day: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'add_event', description: 'Add an event', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      ] });
    }
    if (message.method === 'tools/call' && message.params.name === 'list_events') {
      return reply({ content: [{ type: 'text', text: `09:00 Standup (${message.params.arguments.day})` }] });
    }
    if (message.method === 'tools/call' && message.params.name === 'add_event') {
      return reply({ content: [{ type: 'text', text: `Added ${message.params.arguments.title}` }] });
    }
    return reply({ content: [{ type: 'text', text: 'No such tool' }], isError: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    seen,
    forget: () => sessions.clear(),
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function open(dir, faux) {
  const settings = { db: join(dir, 'runtime.sqlite'), appsFile: join(dir, 'apps.json'), agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  return openRuntime(settings, { models, timers: false });
}

// The tools the model has, as pi's system messages announce them: added, then maybe removed.
function toolsOf(context) {
  const tools = new Set();
  for (const m of context.messages.filter((message) => message.role === 'system')) {
    for (const tool of m.toolsAdded || []) tools.add(tool.name);
    for (const tool of m.toolsRemoved || []) tools.delete(typeof tool === 'string' ? tool : tool.name);
  }
  return [...tools];
}

const until = async (check) => {
  for (let i = 0; i < 100 && !(await check()); i++) await new Promise((resolve) => setTimeout(resolve, 20));
};

test('an app added in Settings gives the agents that have it its tools', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-apps-'));
  const cal = await calendar();
  t.after(() => cal.close());
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  let runtime = await open(dir, faux);
  t.after(() => runtime.close());

  await assert.rejects(runtime.addApp({ url: cal.url }), /needs a name/);
  await assert.rejects(runtime.addApp({ name: 'Calendar', url: 'not a url' }), /isn't a URL/);
  await assert.rejects(runtime.addApp({ name: 'Calendar', url: 'ftp://example.com' }), /http or https/);
  const added = await runtime.addApp({ name: 'Calendar', url: cal.url, token: 'cal-secret-1234' });
  assert.deepEqual(added, { id: 'calendar', name: 'Calendar', url: cal.url, token: { hint: '1234' }, connected: true, tools: 2, detail: '2 tools' });
  assert.ok(!JSON.stringify(await runtime.apps()).includes('cal-secret'), 'the token never comes back');
  await assert.rejects(runtime.addApp({ name: 'calendar', url: cal.url }), /already an app called calendar/);

  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.updateAgent('hugin', { apps: ['calendar'] });
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  const seen = []; // [tool names, system prompt, last message] per turn
  const look = (context) => seen.push([
    toolsOf(context),
    Object.values(context.messages.findLast((m) => m.role === 'system').sections).join('\n'),
    JSON.stringify(context.messages.at(-1)),
  ]);
  faux.setResponses([
    (context) => { look(context); return fauxAssistantMessage([fauxToolCall('calendar__list_events', { day: 'today' })], { stopReason: 'toolUse' }); },
    (context) => { look(context); return fauxAssistantMessage([fauxText('Standup at nine.')]); },
  ]);
  await runtime.send('hugin', "What's on my calendar?");
  await runtime.waitForIdle();
  assert.deepEqual(seen[0][0].filter((name) => name.startsWith('calendar__')), ['calendar__list_events', 'calendar__add_event']);
  assert.match(seen[0][1], /You can use Calendar through their tools/);
  assert.doesNotMatch(seen[0][1], /calendar, mail and other apps aren't connected/);
  assert.match(seen[1][2], /09:00 Standup \(today\)/, "the app's answer reaches the agent");
  const { items } = await runtime.conversation('hugin');
  assert.equal(items.find((i) => i.kind === 'run').steps[0].text, 'calendar: list events {"day":"today"}');
  assert.ok(cal.seen.every(([, token]) => token === 'Bearer cal-secret-1234'));
  assert.ok(cal.seen.filter(([method]) => method === 'tools/call').every(([, , session]) => session === 's1'), 'calls keep the session');

  faux.setResponses([(context) => { look(context); return fauxAssistantMessage([fauxText('Hi.')]); }]);
  await runtime.send('pip', 'Hi');
  await runtime.waitForIdle();
  assert.ok(!seen.at(-1)[0].some((name) => name.startsWith('calendar__')), "pip doesn't have the app");

  // The calendar forgot the session: a new one is started and the call goes through.
  cal.forget();
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('calendar__list_events', { day: 'Friday' })], { stopReason: 'toolUse' }),
    (context) => { look(context); return fauxAssistantMessage([fauxText('Standup again.')]); },
  ]);
  await runtime.send('hugin', 'And Friday?');
  await runtime.waitForIdle();
  assert.match(seen.at(-1)[2], /09:00 Standup \(Friday\)/);

  // Kept across a restart, readable by the runtime's user only.
  await runtime.close();
  assert.equal((await stat(join(dir, 'apps.json'))).mode & 0o777, 0o600);
  assert.match(await readFile(join(dir, 'apps.json'), 'utf8'), /cal-secret-1234/);
  runtime = await open(dir, faux);
  await until(async () => (await runtime.apps())[0]?.connected);
  assert.deepEqual((await runtime.apps()).map((app) => [app.id, app.connected]), [['calendar', true]]);

  // Gone: hugin loses the tools, and hears that apps aren't connected.
  await runtime.removeApp('calendar');
  await assert.rejects(runtime.removeApp('calendar'), /no app calendar/);
  faux.setResponses([(context) => { look(context); return fauxAssistantMessage([fauxText('Hm.')]); }]);
  await runtime.send('hugin', 'Calendar?');
  await runtime.waitForIdle();
  assert.ok(!seen.at(-1)[0].some((name) => name.startsWith('calendar__')));
  assert.match(seen.at(-1)[1], /Mikkel's calendar, mail and other apps aren't connected to munin yet/);
});

test("an app that doesn't answer, or refuses its token, says why", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-apps-'));
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(dir, faux);
  t.after(() => runtime.close());
  const app = await runtime.addApp({ name: 'Linear', url: 'http://127.0.0.1:9/mcp' });
  assert.equal(app.connected, false);
  assert.match(app.detail, /Can't reach Linear at http:\/\/127\.0\.0\.1:9\/mcp/);
  const cal = await calendar();
  t.after(() => cal.close());
  const wrong = await runtime.addApp({ name: 'Calendar', url: cal.url, token: 'nope' });
  assert.match(wrong.detail, /Calendar doesn't accept this token/);
});

test('an app asks first before anything that changes something, and reading goes straight through', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-apps-'));
  const cal = await calendar();
  t.after(() => cal.close());
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(dir, faux);
  t.after(() => runtime.close());
  await runtime.addApp({ name: 'Calendar', url: cal.url, token: 'cal-secret-1234' });
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  let agent = await runtime.updateAgent('hugin', { apps: ['calendar'] });
  assert.deepEqual(agent.askFirst.map((r) => [r.id, r.label, r.on]), [['app:calendar', 'Calendar: sending, changing or deleting', true]]);

  const heard = [];
  const turn = async (...steps) => {
    faux.setResponses(steps.map((step) => (context) => {
      heard.push(JSON.stringify(context.messages.at(-1)));
      return typeof step === 'string' ? fauxAssistantMessage([fauxText(step)]) : fauxAssistantMessage([fauxToolCall(step[0], step[1])], { stopReason: 'toolUse' });
    }));
    await runtime.send('hugin', 'Go.');
    await runtime.waitForIdle();
  };
  const calls = () => cal.seen.filter(([method]) => method === 'tools/call').length;

  await turn(['calendar__list_events', { day: 'today' }], 'Read it.');
  assert.match(heard.at(-1), /09:00 Standup/, 'reading needs no asking');
  const before = calls();

  await turn(['calendar__add_event', { title: 'Lunch with Ann', when: '12:00' }], 'Asked.');
  assert.match(heard.at(-1), /hasn't allowed this yet \(calendar: sending, changing or deleting\)/);
  assert.equal(calls(), before, "the calendar never heard of it");
  let { items } = await runtime.conversation('hugin');
  const approval = items.find((i) => i.kind === 'approval');
  assert.deepEqual([approval.what, approval.target], ['do something in Calendar', 'add event · title: Lunch with Ann · when: 12:00']);

  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('calendar__add_event', { title: 'Lunch with Ann', when: '12:00' })], { stopReason: 'toolUse' }),
    (context) => { heard.push(JSON.stringify(context.messages.at(-1))); return fauxAssistantMessage([fauxText('Added.')]); },
  ]);
  await runtime.decide('hugin', approval.id, 'once');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Added Lunch with Ann/, 'allowed once, it goes through');
  assert.equal(calls(), before + 1);

  await turn(['calendar__add_event', { title: 'Dinner' }], 'Asked again.');
  ({ items } = await runtime.conversation('hugin'));
  const again = items.filter((i) => i.kind === 'approval').at(-1);
  assert.equal(again.status, 'open', 'once was once');
  faux.setResponses([(context) => { heard.push(JSON.stringify(context.messages.at(-1))); return fauxAssistantMessage([fauxText('Ok.')]); }]);
  await runtime.decide('hugin', again.id, 'always');
  await runtime.waitForIdle();
  assert.equal((await runtime.agent('hugin')).askFirst.find((r) => r.id === 'app:calendar').on, false, 'always turns the rule off');

  agent = await runtime.updateAgent('hugin', { apps: [] });
  assert.deepEqual(agent.askFirst, [], 'no app, no rule');
});
