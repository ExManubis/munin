// The HTTP API over a real socket, and agents surviving a restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { createRuntimeServer } from '../src/server.js';

async function serve(settings) {
  const models = await buildModels(settings, { env: {} });
  const runtime = await openRuntime(settings, { models });
  const server = createRuntimeServer(runtime, settings);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/runtime/api`;
  const call = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json().catch(() => null), headers: response.headers };
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
  };
  return { base, call, runtime, close };
}

async function settingsIn(dir, db = ':memory:') {
  return { db, host: '127.0.0.1', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
}

test('agents and conversations over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-server-'));
  const { call, runtime, close } = await serve(await settingsIn(dir));
  const me = await call('GET', '/me');
  assert.equal(me.body.kind, 'runtime');
  assert.deepEqual(me.body.providers.map((p) => [p.id, p.connected]), [['openrouter', false], ['ollama', false], ['standin', true]]);

  const created = await call('POST', '/agents', { name: 'pip', role: 'companion', colour: 'straw' });
  assert.equal(created.status, 201);
  assert.equal(created.body.model, 'stand-in');
  assert.equal((await call('POST', '/agents', { name: 'pip', role: 'companion' })).status, 409);
  assert.equal((await call('GET', '/agents/nobody')).status, 404);
  assert.equal((await call('POST', '/agents/pip/messages', { text: ' ' })).status, 422);

  assert.equal((await call('POST', '/agents/pip/messages', { text: 'Hi pip' })).status, 200);
  await runtime.waitForIdle();
  const { body } = await call('GET', '/agents/pip/conversation');
  assert.deepEqual(body.items.map((i) => i.from), ['human', 'agent']);
  assert.deepEqual((await call('GET', '/agents')).body.map((a) => a.name), ['pip']);
  assert.deepEqual((await call('GET', '/waiting')).body, []);
  assert.equal((await call('GET', '/models')).body.at(-1).id, 'standin');
  await close();
});

test('only pages on this machine get in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-server-'));
  const { call, close } = await serve(await settingsIn(dir));
  const local = await call('GET', '/me', null, { Origin: 'http://127.0.0.1:7777' });
  assert.equal(local.status, 200);
  assert.equal(local.headers.get('access-control-allow-origin'), 'http://127.0.0.1:7777');
  assert.equal((await call('GET', '/me', null, { Origin: 'https://evil.example' })).status, 403);
  await close();
});

test('the stream says when something changed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-server-'));
  const { base, call, close } = await serve(await settingsIn(dir));
  const controller = new AbortController();
  const stream = await fetch(`${base}/stream`, { signal: controller.signal });
  const reader = stream.body.getReader();
  await reader.read(); // ": connected"
  await call('POST', '/agents', { name: 'pip', role: 'companion' });
  let text = '';
  while (!text.includes('event: changed')) text += new TextDecoder().decode((await reader.read()).value);
  assert.match(text, /event: changed/);
  controller.abort();
  await close();
});

test('agents and their conversations survive a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-server-'));
  const settings = await settingsIn(dir, join(dir, 'runtime.sqlite'));
  let served = await serve(settings);
  await served.call('POST', '/agents', { name: 'hugin', role: 'assistant', colour: 'sky', brief: "You're hugin." });
  await served.call('POST', '/agents/hugin/messages', { text: 'Remember me?' });
  await served.runtime.waitForIdle();
  await served.close();

  served = await serve(settings);
  const { body } = await served.call('GET', '/agents/hugin/conversation');
  assert.equal(body.agent.colour, 'sky');
  assert.equal(body.agent.brief, "You're hugin.");
  assert.deepEqual(body.items.map((i) => i.text?.slice(0, 12)), ['Remember me?', "I'm on munin"]);
  assert.equal(body.more, false);
  const newest = (await served.call('GET', '/agents/hugin/conversation?limit=1')).body;
  assert.deepEqual([newest.items.map((i) => i.text?.slice(0, 12)), newest.more], [["I'm on munin"], true]);
  const before = (await served.call('GET', `/agents/hugin/conversation?before=${encodeURIComponent(newest.items[0].id)}`)).body;
  assert.deepEqual([before.items.map((i) => i.text), before.more], [['Remember me?'], false]);
  assert.equal((await served.call('GET', '/agents/hugin/conversation?before=nope')).status, 422);
  await served.close();
});

// fetch won't set Host, and tailscale serve passes the browser's on, so ask with node:http.
function ask(base, method, path, { host, headers = {}, body } = {}) {
  const url = new URL(base + path);
  return new Promise((resolve, reject) => {
    const req = request({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers: { ...(host ? { Host: host } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

test('behind the edge, the people in MUNIN_USERS get in, and nobody else', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-server-'));
  const settings = { ...await settingsIn(dir), publicUrl: 'https://munin.tail1234.ts.net', users: ['mikkel@example.com'] };
  const { base, close } = await serve(settings);
  const host = 'munin.tail1234.ts.net';
  const me = { 'Tailscale-User-Login': 'Mikkel@Example.com' };

  assert.equal((await ask(base, 'GET', '/me', { host, headers: me })).status, 200);
  const stranger = await ask(base, 'GET', '/agents', { host, headers: { 'Tailscale-User-Login': 'someone@example.com' } });
  assert.equal(stranger.status, 403);
  assert.match(stranger.body.detail, /someone@example.com isn't one of munin's people/);
  assert.match((await ask(base, 'GET', '/agents', { host })).body.detail, /Tailscale didn't say who you are/);

  const made = await ask(base, 'POST', '/agents', { host, headers: { ...me, Origin: 'https://munin.tail1234.ts.net' }, body: { name: 'pip', role: 'companion' } });
  assert.equal(made.status, 201, 'the frontend, at the same address');
  assert.equal((await ask(base, 'POST', '/agents', { host, headers: { ...me, Origin: 'https://evil.example' }, body: { name: 'pod', role: 'companion' } })).status, 403);

  assert.equal((await ask(base, 'GET', '/me', { host: '127.0.0.1' })).status, 200, 'this machine, as before');
  assert.equal((await ask(base, 'GET', '/me', { host: 'evil.example' })).status, 400);
  await close();

  const models = await buildModels(settings, { env: {} });
  const runtime = await openRuntime(settings, { models, timers: false });
  assert.throws(() => createRuntimeServer(runtime, { ...settings, users: [] }), /MUNIN_USERS/);
  await runtime.close();
});
