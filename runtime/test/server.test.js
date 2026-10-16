// The HTTP API over a real socket, and agents surviving a restart.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  await served.close();
});
