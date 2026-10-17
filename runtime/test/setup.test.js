// What setup asks the runtime: your name, whether setup is over, and the OpenRouter models
// agents pick from (favourites, recommendations, a search of its whole catalog).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { createRuntimeServer } from '../src/server.js';
import { SOULS } from '../src/roles.js';

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
  assert.match(seen, /You're pip, a companion, and you work for Mikkel N\. You're talking with Mikkel N right now, in munin/);
  await runtime.close();
});

test('an agent is told who it is talking with as a plain fact, then how it talks, then its brief', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-setup-'));
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const prompts = []; // the newest system prompt each turn, as text
  const heard = []; // the last thing the agent was told, each turn
  faux.setResponses(Array.from({ length: 2 }, () => (context) => {
    prompts.push(Object.values(context.messages.findLast((m) => m.role === 'system').sections).join('\n'));
    return fauxAssistantMessage([fauxText('Hi.')]);
  }));
  const runtime = await open(dir, { extra: [faux.provider] });
  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model', brief: "You're hugin, an assistant." });

  await runtime.send('hugin', 'Who am I?');
  await runtime.waitForIdle();
  assert.match(prompts[0], /^You're hugin, an assistant, and you work for the person you're talking with, in munin/);
  assert.match(prompts[0], /only they can write to you here\. You don't know their name yet: ask once, when it fits, and then leave it\./);
  assert.doesNotMatch(prompts[0], /\bme's\b|with me\b|about me\b/, 'MUNIN_USER\'s "me" is no name');
  assert.match(prompts[0], /- Use Gmail and Google Calendar \(the person you work for signs in with Google in Settings/);
  assert.match(prompts[0], /- The web: read a page with read_page\. Searching needs a model on OpenRouter, which you aren't on/);

  await runtime.updateMe({ name: 'Mikkel' });
  await runtime.send('hugin', 'Who do you work for?');
  await runtime.waitForIdle();
  const prompt = prompts[1];
  assert.match(prompt, /^You're hugin, an assistant, and you work for Mikkel\. You're talking with Mikkel right now, in munin, the app Mikkel uses to work with agents\. munin is private, so only Mikkel can write to you here\. Talk to Mikkel as "you"\./);
  assert.doesNotMatch(prompt, /know their name/);
  const order = ["You're talking with Mikkel", 'How you talk:', "You're hugin, an assistant.", 'What you can do.', 'What you could do, if it were switched on:', "What munin can't do yet"];
  assert.deepEqual(order.map((words) => prompt.indexOf(words)), order.map((words) => prompt.indexOf(words)).toSorted((a, b) => a - b), 'in this order');
  assert.ok(order.every((words) => prompt.includes(words)));
  for (const p of prompts) assert.doesNotMatch(p, /messages in this conversation are from|read "I"|verif|confirm who/i, 'nothing about where messages come from');

  faux.setResponses([
    () => fauxAssistantMessage([fauxToolCall('ask_human', { question: 'Lunch at 12?' })], { stopReason: 'toolUse' }),
    (context) => {
      heard.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage([fauxText('Asked.')]);
    },
    (context) => {
      heard.push(JSON.stringify(context.messages.at(-1)));
      return fauxAssistantMessage([fauxText('Booked.')]);
    },
  ]);
  await runtime.send('hugin', 'Sort out lunch.');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Asked Mikkel\. Their answer comes as a message\./);
  const question = (await runtime.conversation('hugin')).items.find((i) => i.kind === 'question');
  await runtime.answer('hugin', question.id, { text: 'Yes' });
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Mikkel answered your question \\"Lunch at 12\?\\": Yes/, 'answers name you too');
  await runtime.close();
});

test("briefs made from older words get their role's soul after a restart; your own words stay", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-setup-'));
  const db = join(dir, 'runtime.sqlite');
  const old = {
    hugin: ['assistant', "You're hugin, Mikkel's assistant. Keep their calendar and inbox in order, and say things once, briefly. Ask before you send mail or accept invites for them. Start weekdays with a briefing."],
    tosk: ['assistant', "You're tosk, the assistant of the person you work for. Keep their calendar and inbox in order, and say things once, briefly. Ask before you send mail or accept invites for them."],
    pip: ['companion', "You're pip. You're curious and cheerful, and you like riddles, word games and odd facts. Keep replies short. When Mikkel seems busy, let them be."],
    forge: ['coder', "You're forge, a coder. Take issues from the top of the pile, do the work on a branch named after the issue, and send it to review with a short note on what you did. Ask when something is unclear instead of guessing."],
    atlas: ['researcher', "You're atlas, a researcher. Read up on what you're asked, say what you found in a few lines, and list your sources."],
    vera: ['assistant', "You're vera, Mikkel's right hand. Keep his diary."],
    // the words from before souls, when a brief named the agent and listed what it's like
    quill: ['writer', "You're quill, a writer with an ear for plain, short sentences. Draft and edit, keep one voice across everything you write, and say when a sentence isn't pulling its weight. Mostly munin's docs."],
    ada: ['reviewer', "You're ada, a reviewer: thorough, fair and specific. Review what other agents send to review: run the tests, read the diff, merge what's good and send back what isn't, saying exactly what's missing."],
  };
  let runtime = await open(dir, { db });
  for (const [name, [role, brief]] of Object.entries(old)) await runtime.createAgent({ name, role, brief });
  await runtime.close();

  runtime = await open(dir, { db });
  const brief = async (name) => (await runtime.agent(name)).brief;
  const examples = async (name) => (await runtime.agent(name)).examples;
  assert.equal(await brief('hugin'), `${SOULS.assistant.brief()} Start weekdays with a briefing.`, 'what you added stays');
  assert.ok((await brief('tosk')).startsWith(SOULS.assistant.brief()));
  assert.equal(await brief('pip'), SOULS.companion.brief());
  assert.equal(await brief('forge'), SOULS.coder.brief());
  assert.equal(await brief('atlas'), SOULS.researcher.brief());
  assert.equal(await brief('quill'), `${SOULS.writer.brief()} Mostly munin's docs.`, 'from the words before souls');
  assert.equal(await brief('ada'), SOULS.reviewer.brief());
  assert.equal(await brief('vera'), "You're vera, Mikkel's right hand. Keep his diary.", 'a brief you wrote yourself');
  assert.doesNotMatch(await brief('forge'), /^You're forge/, "the runtime says who it is, so the brief doesn't");
  assert.equal(await examples('hugin'), SOULS.assistant.examples('hugin'), 'its role\'s examples, for its name');
  assert.equal(await examples('quill'), SOULS.writer.examples('quill'));
  assert.equal(await examples('vera'), '', 'none for a brief you wrote yourself');
  const upgraded = await brief('forge');
  await runtime.updateAgent('pip', { examples: '' });
  await runtime.close();

  runtime = await open(dir, { db });
  assert.equal((await runtime.agent('forge')).brief, upgraded, 'new words stay as they are');
  assert.equal((await runtime.agent('pip')).examples, '', 'examples you emptied stay empty');
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
