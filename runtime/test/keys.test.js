// Model keys pasted in Settings: kept in a file of the runtime's own, used in place of the
// environment's, and never handed back. OpenRouter isn't asked here; a stand-in check is.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildModels } from '../src/models.js';
import { KeyError, checkOpenRouterKey, cleanKey } from '../src/keys.js';
import { openRuntime } from '../src/runtime.js';
import { createRuntimeServer } from '../src/server.js';

const KEY = 'sk-or-v1-0123456789abcdef';
const accepts = async () => {};

async function settingsIn() {
  const dir = await mkdtemp(join(tmpdir(), 'munin-keys-'));
  return { db: join(dir, 'runtime.sqlite'), keysFile: join(dir, 'keys.json'), agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
}
const openrouterOf = (built) => built.providers().find((p) => p.id === 'openrouter');

test('a pasted key turns OpenRouter on, stays for the next start, and only its owner can read it', async () => {
  const settings = await settingsIn();
  const built = await buildModels(settings, { env: {}, check: accepts });
  assert.equal(openrouterOf(built).connected, false);
  assert.match(openrouterOf(built).detail, /Paste a key/);
  assert.ok(!built.catalog().some((p) => p.id === 'openrouter'));

  await built.setKey('openrouter', ` OPENROUTER_API_KEY="${KEY}"\n`);
  assert.deepEqual(openrouterOf(built).key, { from: 'settings', hint: 'cdef' });
  assert.match(openrouterOf(built).detail, /models · key …cdef$/);
  assert.ok(built.catalog().find((p) => p.id === 'openrouter').models.length > 0);
  assert.equal((await built.models.getAuth('openrouter')).auth.apiKey, KEY);
  assert.equal((await stat(settings.keysFile)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(settings.keysFile, 'utf8')).openrouter.key, KEY);

  const again = await buildModels(settings, { env: {}, check: accepts });
  assert.equal(openrouterOf(again).connected, true, 'kept across a restart');
  await again.removeKey('openrouter');
  assert.equal(openrouterOf(again).connected, false);
  assert.deepEqual(JSON.parse(await readFile(settings.keysFile, 'utf8')), {});
});

test("a pasted key wins over the environment's, which is back once it's removed", async () => {
  const settings = await settingsIn();
  const built = await buildModels(settings, { env: { OPENROUTER_API_KEY: 'sk-or-v1-from-env' }, check: accepts });
  assert.deepEqual(openrouterOf(built).key, { from: 'environment' });
  assert.equal((await built.models.getAuth('openrouter')).auth.apiKey, 'sk-or-v1-from-env');
  await built.setKey('openrouter', KEY);
  assert.equal((await built.models.getAuth('openrouter')).auth.apiKey, KEY);
  await built.removeKey('openrouter');
  assert.equal(openrouterOf(built).connected, true);
  assert.equal((await built.models.getAuth('openrouter')).auth.apiKey, 'sk-or-v1-from-env');
});

test('OpenRouter is asked about a key, and only a clear no stops it', async () => {
  const answering = (status) => async () => new Response('{}', { status });
  await assert.rejects(checkOpenRouterKey(KEY, answering(401)), /OpenRouter doesn't take that key/);
  await checkOpenRouterKey(KEY, answering(200));
  await checkOpenRouterKey(KEY, answering(404));
  await checkOpenRouterKey(KEY, async () => {
    throw new TypeError('fetch failed');
  });
  assert.equal(cleanKey(`export OPENROUTER_API_KEY='${KEY}'`), KEY);
  assert.throws(() => cleanKey('  '), /Paste the key first/);
  assert.throws(() => cleanKey('two words'), /spaces/);
});

test('keys over HTTP: set, never shown again, removed', async () => {
  const settings = await settingsIn();
  let asked = null;
  const check = async (key) => {
    asked = key;
    if (key.endsWith('nope')) throw new KeyError("OpenRouter doesn't take that key.");
  };
  const models = await buildModels(settings, { env: {}, check });
  const runtime = await openRuntime(settings, { models, timers: false });
  const server = createRuntimeServer(runtime, { ...settings, host: '127.0.0.1' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/runtime/api`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, text: await response.text() };
  };

  const wrong = await call('PUT', '/providers/openrouter/key', { key: 'sk-or-v1-nope' });
  assert.equal(wrong.status, 422);
  assert.match(JSON.parse(wrong.text).detail, /doesn't take that key/);
  assert.equal((await call('PUT', '/providers/ollama/key', { key: KEY })).status, 422);
  assert.equal((await call('PUT', '/providers/openrouter/key', {})).status, 422);

  const set = await call('PUT', '/providers/openrouter/key', { key: KEY });
  assert.equal(set.status, 200);
  assert.equal(asked, KEY);
  assert.deepEqual(JSON.parse(set.text).key, { from: 'settings', hint: 'cdef' });
  for (const path of ['/providers', '/me', '/models']) {
    assert.ok(!(await call('GET', path)).text.includes(KEY), `${path} never has the key`);
  }
  assert.ok(JSON.parse((await call('GET', '/models')).text).some((p) => p.id === 'openrouter'));

  const removed = await call('DELETE', '/providers/openrouter/key');
  assert.equal(JSON.parse(removed.text).connected, false);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
});
