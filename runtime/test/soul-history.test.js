// An agent's soul over time (soul.js): every version kept, changes the agent proposes and you
// decide, and going back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { SOULS } from '../src/roles.js';
import { KEPT, LIMITS, checkSoul, withVersion } from '../src/soul.js';
import { wordDiff } from '../../web/diff.js';

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });

test('a proposed soul has a brief, stays short and changes something', () => {
  const now = { brief: 'You like small PRs.', examples: '' };
  assert.deepEqual(checkSoul({ brief: '  You like small, tested PRs. ' }, now), { brief: 'You like small, tested PRs.', examples: '' });
  assert.deepEqual(checkSoul({ examples: 'You: Hi\nforge: Hi.' }, now), { brief: now.brief, examples: 'You: Hi\nforge: Hi.' }, 'what it leaves out stays');
  assert.throws(() => checkSoul({ brief: ' ' }, now), /can't be empty/);
  assert.throws(() => checkSoul({ brief: 'x'.repeat(LIMITS.brief + 1) }, now), /under 2,000 characters; it's 2,001/);
  assert.throws(() => checkSoul({ examples: 'x'.repeat(LIMITS.examples + 1) }, now), /under 1,500 characters/);
  assert.throws(() => checkSoul({ brief: now.brief }, now), /nothing would change/);
});

test('a version is kept only when something changed, and only so many', () => {
  let history = withVersion([], { brief: 'A', examples: '' }, 'you', 1);
  history = withVersion(history, { brief: 'A', examples: null }, 'you', 2);
  assert.equal(history.length, 1, 'the same soul is no new version');
  for (let i = 0; i < KEPT + 5; i += 1) history = withVersion(history, { brief: `B${i}`, examples: '' }, 'forge', 10 + i, 'Sharper.');
  assert.equal(history.length, KEPT);
  assert.deepEqual(history[0], { at: 10 + KEPT + 4, by: 'forge', why: 'Sharper.', brief: `B${KEPT + 4}`, examples: '' });
});

test('what changed, word by word', () => {
  assert.deepEqual(wordDiff('You like small PRs.', 'You like small, tested PRs.'), [
    { op: 'same', text: 'You like ' }, { op: 'del', text: 'small ' }, { op: 'add', text: 'small, tested ' }, { op: 'same', text: 'PRs.' },
  ]);
  assert.deepEqual(wordDiff('', 'New.'), [{ op: 'add', text: 'New.' }]);
  assert.deepEqual(wordDiff('Old.', ''), [{ op: 'del', text: 'Old.' }]);
});

async function open(dir, faux, db = ':memory:') {
  const settings = { db, agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  return openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false });
}

test('an agent proposes a change to who it is, you decide, and the profile keeps each version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-soul-'));
  const db = join(dir, 'runtime.sqlite');
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  let runtime = await open(dir, faux, db);
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  let forge = await runtime.agent('forge');
  assert.deepEqual(forge.soulHistory.map((v) => v.by), ['you']);

  const sharper = `${SOULS.coder.brief()} You write the test that fails before you write the fix.`;
  const heard = [];
  const listen = (context) => {
    heard.push(JSON.stringify(context.messages.findLast((m) => m.role !== 'system')));
    return reply(fauxText('Okay.'));
  };
  faux.setResponses([
    reply(fauxToolCall('propose_soul_change', { why: 'I keep writing the fix first and the test after; I work better the other way round.', brief: sharper })),
    reply(fauxToolCall('propose_soul_change', { why: 'Also this.', brief: `${sharper} Twice.` })),
    listen,
  ]);
  await runtime.send('forge', 'Anything you would change about how you work?');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /You've proposed a change already; wait for Mikkel's answer\./);
  const card = (await runtime.conversation('forge')).items.find((i) => i.kind === 'approval');
  assert.deepEqual([card.what, card.target, card.soul.why], ['change who it is', 'its brief', 'I keep writing the fix first and the test after; I work better the other way round.']);
  assert.equal(card.soul.was.brief, SOULS.coder.brief());
  assert.equal(card.soul.brief, sharper);
  assert.equal((await runtime.agent('forge')).brief, SOULS.coder.brief(), 'nothing changes until you say so');

  let prompt = '';
  faux.setResponses([(context) => {
    heard.push(JSON.stringify(context.messages.findLast((m) => m.role !== 'system')));
    prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
    return reply(fauxText('Thanks.'));
  }]);
  await runtime.decide('forge', card.id, 'once');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Mikkel accepted the change: your brief and examples are the new ones from now on\./);
  assert.match(prompt, /You write the test that fails before you write the fix\./);
  forge = await runtime.agent('forge');
  assert.equal(forge.brief, sharper);
  assert.deepEqual(forge.soulHistory.map((v) => [v.by, v.why]), [['forge', 'I keep writing the fix first and the test after; I work better the other way round.'], ['you', null]]);
  assert.ok((await runtime.conversation('forge')).items.some((i) => i.kind === 'action' && i.verb === 'changed who it is'));

  // Denied, it stays; too long, it never reaches you.
  faux.setResponses([
    reply(fauxToolCall('propose_soul_change', { why: 'Shorter examples.', examples: 'You: Hi.\nforge: Hi.' })), listen, listen,
    reply(fauxToolCall('propose_soul_change', { why: 'Everything.', brief: 'x'.repeat(LIMITS.brief + 1) })), listen,
  ]);
  await runtime.send('forge', 'And your examples?');
  await runtime.waitForIdle();
  const second = (await runtime.conversation('forge')).items.findLast((i) => i.kind === 'approval');
  assert.equal(second.target, 'how it talks');
  await runtime.decide('forge', second.id, 'deny');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /wants your brief and examples to stay as they are/);
  assert.equal((await runtime.agent('forge')).examples, SOULS.coder.examples('forge'));
  await runtime.send('forge', 'Say it all differently?');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Keep your brief under 2,000 characters/);

  // You go back to the first version, which is a version of its own.
  const first = forge.soulHistory.at(-1);
  forge = await runtime.updateAgent('forge', { brief: first.brief, examples: first.examples, why: 'Back to the version from the start' });
  assert.deepEqual(forge.soulHistory.map((v) => v.by), ['you', 'forge', 'you']);
  assert.equal(forge.soulHistory[0].why, 'Back to the version from the start');
  await runtime.close();

  runtime = await open(dir, faux, db);
  assert.equal((await runtime.agent('forge')).soulHistory.length, 3, 'after a restart');
  await runtime.close();
});

test("an older brief's history starts with how it was, and the role's newer words are munin's", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-soul-'));
  const db = join(dir, 'runtime.sqlite');
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  let runtime = await open(dir, faux, db);
  const old = "You're atlas, a researcher. Read up on what you're asked, say what you found in a few lines, and list your sources.";
  await runtime.createAgent({ name: 'atlas', role: 'researcher', brief: old });
  await runtime.close();
  runtime = await open(dir, faux, db);
  const atlas = await runtime.agent('atlas');
  assert.equal(atlas.brief, SOULS.researcher.brief());
  assert.deepEqual(atlas.soulHistory.map((v) => [v.by, v.brief === old]), [['munin', false], ['you', true]]);
  await runtime.close();
});
