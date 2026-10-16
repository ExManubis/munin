// What setup asks the runtime: your name, whether setup is over, and the OpenRouter models
// agents pick from (favourites, recommendations, a search of its whole catalog).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { createRuntimeServer } from '../src/server.js';

async function open(dir, { env = {}, db = ':memory:', extra = [] } = {}) {
  const settings = { db, host: '127.0.0.1', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'me' };
  const models = await buildModels(settings, { env, extra });
  return openRuntime(settings, { models, timers: false });
}

test('your name and setup being over are kept, and agents call you by the name', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-setup-'));
  const db = join(dir, 'runtime.sqlite');
  let runtime = await open(dir, { db });
  assert.deepEqual(pick(await runtime.me()), { name: 'me', setup: null }, 'MUNIN_USER until setup asks');

  assert.deepEqual(pick(await runtime.updateMe({ name: '  Mikkel   N ' })), { name: 'Mikkel N', setup: null });
  await assert.rejects(runtime.updateMe({ setup: 'maybe' }), /Setup is "started" or "done"/);
  await assert.rejects(runtime.updateMe({ name: 'x'.repeat(61) }), /too long/);
  await runtime.updateMe({ setup: 'done' });
  await runtime.close();

  runtime = await open(dir, { db });
  assert.deepEqual(pick(await runtime.me()), { name: 'Mikkel N', setup: 'done' }, 'after a restart');
  assert.deepEqual(pick(await runtime.updateMe({ name: '', setup: 'started' })), { name: 'me', setup: 'started' }, 'a cleared name falls back');
  await runtime.close();

  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  let seen = ''; // everything the model was given
  faux.setResponses([(context) => {
    seen = JSON.stringify(context);
    return fauxAssistantMessage([fauxText('Hi.')]);
  }]);
  runtime = await open(dir, { db, extra: [faux.provider] });
  await runtime.updateMe({ name: 'Mikkel N' });
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  await runtime.send('pip', 'Hello');
  await runtime.waitForIdle();
  assert.match(seen, /You are pip, one of Mikkel N's agents in munin/);
  await runtime.close();
});

test('a runtime that already has agents counts as set up, unless setup is under way', async () => {
  const runtime = await open(await mkdtemp(join(tmpdir(), 'munin-setup-')));
  await runtime.createAgent({ name: 'pip', role: 'companion' });
  assert.equal((await runtime.me()).setup, 'done');
  await runtime.updateMe({ setup: 'started' });
  await runtime.createAgent({ name: 'tosk', role: 'assistant' });
  assert.equal((await runtime.me()).setup, 'started', 'its first agent doesn\'t end it');
  await runtime.close();
});

test('OpenRouter models are your favourites, with prices, plus any an agent is on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-setup-'));
  let runtime = await open(dir);
  assert.equal((await runtime.models()).find((p) => p.id === 'openrouter'), undefined, 'not without a key');
  await runtime.close();

  runtime = await open(dir, { env: { OPENROUTER_API_KEY: 'sk-or-v1-test' } });
  const openrouter = async () => (await runtime.models()).find((p) => p.id === 'openrouter').models;
  const haiku = (await openrouter())[0];
  assert.deepEqual((await openrouter()).map((m) => m.id), ['anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5']);
  assert.deepEqual([haiku.name, haiku.maker, haiku.favourite], ['Claude Haiku 5.5', 'Anthropic', true]);
  assert.ok(haiku.input > 0 && haiku.output > haiku.input, 'dollars per million tokens, in and out');

  await runtime.setFavourites(['z-ai/glm-5.3-flash', 'meta/muse-wonder', 'z-ai/glm-5.3-flash']);
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual((await openrouter()).map((m) => [m.id, m.favourite]),
    [['z-ai/glm-5.3-flash', true], ['meta/muse-wonder', true], ['anthropic/claude-sonnet-5.5', false]]);
  await assert.rejects(runtime.setFavourites(['nobody/nothing']), /OpenRouter has no model called nobody\/nothing/);
  await assert.rejects(runtime.setFavourites('meta/muse-wonder'), /a list of model ids/);
  await runtime.close();
});

test('setup recommends cheap and frontier models, and searches all of OpenRouter, key or not', async () => {
  const runtime = await open(await mkdtemp(join(tmpdir(), 'munin-setup-')));
  const { cheap, frontier } = await runtime.recommendedModels();
  assert.deepEqual(cheap.map((m) => m.id), ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash']);
  assert.deepEqual(frontier.map((m) => m.id), ['anthropic/claude-opus-5.5', 'meta/muse-wonder', 'google/gemini-4-argon']);
  assert.deepEqual([frontier[2].name, frontier[2].maker], ['Gemini 4 Argon', 'Google']);

  const found = await runtime.searchModels('GLM 5.3');
  assert.ok(found.models.some((m) => m.id === 'z-ai/glm-5.3-flash'));
  assert.ok(found.models.every((m) => /glm/i.test(m.name) && !m.id.endsWith(':batch')), 'every word matches; no batch-only ones');
  assert.equal(found.total, found.models.length);
  assert.deepEqual(await runtime.searchModels('  '), { total: 0, models: [] });
  assert.ok((await runtime.searchModels('a')).total > 20 && (await runtime.searchModels('a')).models.length === 20, 'twenty at most');
  await runtime.close();
});

test('setup over HTTP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-setup-'));
  const settings = { db: ':memory:', host: '127.0.0.1', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'me' };
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { env: { OPENROUTER_API_KEY: 'sk-or-v1-test' } }), timers: false });
  const server = createRuntimeServer(runtime, settings);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/runtime/api`;
  const call = async (method, path, body) => {
    const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await call('PATCH', '/me', { name: 'Mikkel' })).body.name, 'Mikkel');
  assert.equal((await call('PATCH', '/me', { setup: 'later' })).status, 422);
  assert.equal((await call('GET', '/models/recommended')).body.cheap.length, 3);
  assert.ok((await call('GET', `/models/search?q=${encodeURIComponent('muse wonder')}`)).body.models.some((m) => m.id === 'meta/muse-wonder'));
  const saved = await call('PUT', '/favourites', { models: ['google/gemini-4-argon'] });
  assert.deepEqual(saved.body.find((p) => p.id === 'openrouter').models.map((m) => m.id), ['google/gemini-4-argon']);

  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
});

function pick({ name, setup }) {
  return { name, setup };
}
