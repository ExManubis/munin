// The web: reading pages from the runtime, and searching through OpenRouter.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels, searching } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { guardedLookup, isPrivate, readPage, withWebSearch } from '../src/web.js';

test('private networks, this machine and the tailnet are off limits', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.5', '169.254.169.254', '100.108.20.24', '0.0.0.0', '::1', 'fd7a:115c:a1e0::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivate(address), true, address);
  }
  // IPv6 that carries a private IPv4 address, in every way Node or a resolver may write it.
  for (const address of ['::ffff:7f00:1', '[::ffff:7f00:1]', '::ffff:127.0.0.1', '0:0:0:0:0:ffff:a00:1', '::7f00:1', '::127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', '2002:c0a8:101::1', 'fd7a:115c:a1e0:ab12::1', '2001:db8::1', 'not an address']) {
    assert.equal(isPrivate(address), true, address);
  }
  for (const address of ['93.184.216.34', '1.1.1.1', '100.63.0.1', '2606:4700::1111', '::ffff:5db8:d822', '2002:5db8:d822::1']) assert.equal(isPrivate(address), false, address);
});

test("the connection's own DNS lookup refuses private addresses, so a name can't change its answer", async () => {
  let answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]; // rebinding: public, then this machine
  const look = guardedLookup(async () => answers.shift());
  const ask = (options = {}) => new Promise((resolve) => look('rebind.example', options, (err, address) => resolve(err ? err.code : address)));
  assert.equal(await ask(), '93.184.216.34');
  assert.equal(await ask(), 'EPRIVATE', 'the second look is checked too');
  answers = [[{ address: '93.184.216.34', family: 4 }, { address: '::ffff:7f00:1', family: 6 }]];
  assert.equal(await ask({ all: true }), 'EPRIVATE', 'any private answer refuses the name');
  await assert.rejects(readPage('http://[::ffff:127.0.0.1]:7777/'), /private network or this machine/, 'a mapped address in the URL itself');
});

// A stand-in web: page addresses to [status, headers, body], hosts to addresses.
function web(pages, hosts) {
  const resolve = async (host) => (hosts[host] ? [{ address: hosts[host] }] : []);
  const fetch = async (url) => {
    const [status, headers, body] = pages[String(url)] || [404, {}, ''];
    return new Response(body, { status, headers });
  };
  return { resolve, fetch };
}

test('a page is read as text, and redirects into private networks are refused', async () => {
  const html = '<html><head><title>Ravens &amp; crows</title><style>p{}</style></head><body><script>x()</script><h1>Ravens</h1><p>Clever&nbsp;birds.</p></body></html>';
  const options = web({
    'https://birds.example/ravens': [200, { 'content-type': 'text/html; charset=utf-8' }, html],
    'https://birds.example/old': [301, { location: '/ravens' }, ''],
    'https://birds.example/sneaky': [302, { location: 'http://inside.example/admin' }, ''],
    'https://birds.example/logo.png': [200, { 'content-type': 'image/png' }, 'png'],
    'https://birds.example/long': [200, { 'content-type': 'text/plain' }, 'a'.repeat(30000)],
  }, { 'birds.example': '93.184.216.34', 'inside.example': '192.168.1.10', 'munin.example': '100.108.20.24' });

  const page = await readPage('https://birds.example/old', options);
  assert.deepEqual(page, { url: 'https://birds.example/ravens', title: 'Ravens & crows', text: 'Ravens\nClever birds.' });
  await assert.rejects(readPage('https://birds.example/sneaky', options), /inside\.example is on a private network or this machine/);
  await assert.rejects(readPage('https://munin.example/api/me', options), /munin\.example is on a private network/, 'the tailnet too');
  await assert.rejects(readPage('http://127.0.0.1:7777/', options), /private network or this machine/);
  await assert.rejects(readPage('file:///etc/passwd', options), /Only http and https/);
  await assert.rejects(readPage('https://birds.example/logo.png', options), /image\/png, which munin can't read/);
  await assert.rejects(readPage('https://nowhere.example/', options), /can't be found/);
  assert.match((await readPage('https://birds.example/long', options)).text, /munin read the first 20000 characters\]$/);
});

test("a request to OpenRouter swaps munin's web_search for OpenRouter's search, in either shape", async () => {
  const schema = { type: 'object', properties: { query: { type: 'string' } } };
  const openai = { model: 'openai/gpt-5.2', tools: [{ type: 'function', function: { name: 'read_page' } }, { type: 'function', function: { name: 'web_search', parameters: schema } }] };
  assert.deepEqual(withWebSearch(openai), {
    model: 'openai/gpt-5.2',
    tools: [{ type: 'function', function: { name: 'read_page' } }, { type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 5 } }],
    max_tool_calls: 5,
  });
  const anthropic = { model: 'anthropic/claude-haiku-5.5', tools: [{ name: 'web_search', input_schema: schema }] };
  assert.deepEqual(withWebSearch(anthropic).tools, [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 5 } }]);
  assert.equal('max_tool_calls' in withWebSearch(anthropic), false);
  assert.equal(withWebSearch({ tools: [{ type: 'function', function: { name: 'read_page' } }] }), undefined, 'no search, no change');

  // Only requests to OpenRouter go through it, and a caller's own onPayload still runs first.
  const sent = [];
  const fake = { streamSimple: async (model, context, options) => sent.push(await options?.onPayload?.({ tools: [{ type: 'function', function: { name: 'web_search' } }] }, model)) };
  const models = searching(fake);
  await models.streamSimple({ provider: 'openrouter' }, {}, { onPayload: (payload) => ({ ...payload, mine: true }) });
  await models.streamSimple({ provider: 'ollama' }, {}, {});
  assert.deepEqual(sent[0].tools, [{ type: 'openrouter:web_search', parameters: { max_results: 5, max_uses: 5 } }]);
  assert.equal(sent[0].mine, true);
  assert.equal(sent[1], undefined);
});

test('an agent with the Web ability reads pages, and searches only on OpenRouter', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-web-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false });
  await runtime.createAgent({ name: 'atlas', role: 'researcher', provider: 'scripted', model: 'model' });
  let tools = [];
  faux.setResponses([(context) => {
    for (const m of context.messages.filter((message) => message.role === 'system')) for (const tool of m.toolsAdded || []) tools.push(tool.name);
    return fauxAssistantMessage([fauxText('Hm.')]);
  }]);
  await runtime.send('atlas', 'Look it up.');
  await runtime.waitForIdle();
  assert.ok(tools.includes('read_page'));
  assert.ok(!tools.includes('web_search'), 'not on OpenRouter, so no search');
  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('read_page', { url: 'http://127.0.0.1:7779/runtime/api/me' })], { stopReason: 'toolUse' }),
    (context) => { tools = JSON.stringify(context.messages.at(-1)); return fauxAssistantMessage([fauxText('Refused.')]); },
  ]);
  await runtime.send('atlas', 'Read munin.');
  await runtime.waitForIdle();
  assert.match(tools, /private network or this machine/, "the runtime won't read munin for an agent");
  await runtime.close();
});
