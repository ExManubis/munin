// Skills (skills.js): SKILL.md files agents save as they learn, you approve, and they read when
// one fits.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { checkSkill, parseSkill, skillText, skillsSection } from '../src/skills.js';

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });
const BODY = '## When to use\nBefore sending gateway work to review.\n\n## Steps\n1. Set TELEGRAM_TEST_TOKEN.\n2. Run `pytest gateway/ -q`.\n\n## Pitfalls\n- Skipped looks like passed.\n\n## How to check\nNone skipped.';
const TESTS = { name: 'run-gateway-tests', description: "Run the gateway's tests before review.", body: BODY };

test('a skill is a SKILL.md, and reads back the same', () => {
  const text = skillText(TESTS);
  assert.match(text, /^---\nname: run-gateway-tests\ndescription: Run the gateway's tests before review\.\n---\n\n## When to use/);
  assert.deepEqual(parseSkill(text), TESTS);
  assert.deepEqual(parseSkill('---\nname: "quoted"\ndescription: \'Also quoted.\'\n---\nBody'), { name: 'quoted', description: 'Also quoted.', body: 'Body' });
  assert.throws(() => parseSkill('Just some text.'), /between --- lines/);
});

test('a skill needs a name, a description and steps, and is a lesson, not a log', () => {
  assert.deepEqual(checkSkill({ ...TESTS, name: '  Run-Gateway-Tests ' }).name, 'run-gateway-tests');
  assert.throws(() => checkSkill({ ...TESTS, name: 'run gateway tests' }), /lowercase words joined by dashes/);
  assert.throws(() => checkSkill({ ...TESTS, description: ' ' }), /how you find it again/);
  assert.throws(() => checkSkill({ ...TESTS, body: 'Run the tests.' }), /Say how to do it/);
  for (const [log, what] of [['Fixed in MUN-46.', 'an issue id'], ['Since 2026-10-17 the token is needed.', 'a date'], ['See #212.', 'a pull request number'], ['Yesterday this broke.', 'when something happened']]) {
    assert.throws(() => checkSkill({ ...TESTS, body: `${BODY}\n${log}` }), new RegExp(`Lessons, not logs: .* no ${what} in it`), log);
  }
});

test("the prompt lists the agent's skills and those shared with it, and how to save one", () => {
  const forge = { name: 'forge' };
  const skills = [
    { ...TESTS, owner: 'forge', sharedWith: [] },
    { name: 'review-a-change', description: 'How to review.', owner: 'vera', sharedWith: ['*'] },
    { name: 'book-travel', description: 'Trains to Aarhus.', owner: 'hugin', sharedWith: ['pip'] },
  ];
  const text = skillsSection(forge, skills, true);
  assert.match(text, /^Your skills: how things are done here, from experience\. When one fits what you're about to do, read it with read_skill first and follow it\.\n- review-a-change \(vera's\): How to review\.\n- run-gateway-tests: Run the gateway's tests before review\.\n/);
  assert.doesNotMatch(text, /book-travel/, "not shared with forge");
  assert.match(text, /Lessons, not logs: no issue ids, dates or stories\. Saving one with a name you have changes it\. Each one you save asks first\.$/);
  assert.match(skillsSection({ name: 'pip' }, [], false), /^You have no skills yet\.\n.*changes it\.$/);
});

async function open(dir, faux, db = ':memory:') {
  const settings = { db, agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  return openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }) });
}

test('an agent saves a skill you approve, reads it when it fits, and saves without asking once you always allow', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-skills-'));
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await open(dir, faux);
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  const heard = [];
  // The last thing the agent was told: a tool's result or a message, not a change to its prompt.
  const listen = (context) => {
    heard.push(JSON.stringify(context.messages.findLast((m) => m.role !== 'system')));
    return reply(fauxText('Okay.'));
  };

  // A log is turned back before it reaches you.
  faux.setResponses([reply(fauxToolCall('save_skill', { ...TESTS, body: `${BODY}\nLearned on MUN-46.` })), listen]);
  await runtime.send('forge', 'Save how you ran those tests as a skill.');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Lessons, not logs/);
  assert.ok(!(await runtime.conversation('forge')).items.some((i) => i.kind === 'approval'));

  // A skill waits on its card until you allow it, and allowing saves it.
  faux.setResponses([reply(fauxToolCall('save_skill', TESTS)), listen, listen]);
  await runtime.send('forge', 'Try again without the issue id.');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Asked Mikkel to look at the skill run-gateway-tests\. When they allow it, munin saves it/);
  let card = (await runtime.conversation('forge')).items.find((i) => i.kind === 'approval');
  assert.deepEqual([card.what, card.target, card.skill], ['save a skill', 'run-gateway-tests', TESTS]);
  assert.deepEqual((await runtime.agent('forge')).skills, [], 'not saved yet');
  await runtime.decide('forge', card.id, 'once');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Mikkel allowed the skill run-gateway-tests, and munin saved it\./);
  assert.ok(!(await runtime.conversation('forge')).items.some((i) => i.from === 'human' && /allowed the skill/.test(i.text)), 'the card shows it, not a message from you');
  let forge = await runtime.agent('forge');
  assert.deepEqual(forge.skills.map((s) => [s.name, s.mine, s.uses, s.stale]), [['run-gateway-tests', true, 0, false]]);
  assert.equal(forge.skills[0].text, skillText(TESTS));

  // It's in the prompt by name, and reading it counts a use.
  let prompt = '';
  faux.setResponses([reply(fauxToolCall('read_skill', { name: 'run-gateway-tests' })), (context) => {
    heard.push(JSON.stringify(context.messages.findLast((m) => m.role !== 'system')));
    prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
    return reply(fauxText('Tests pass.'));
  }]);
  await runtime.send('forge', 'Run the gateway tests.');
  await runtime.waitForIdle();
  assert.match(prompt, /- run-gateway-tests: Run the gateway's tests before review\./);
  assert.match(heard.at(-1), /## Steps/);
  forge = await runtime.agent('forge');
  assert.equal(forge.skills[0].uses, 1);
  assert.ok(forge.skills[0].lastUsed);
  const { items } = await runtime.conversation('forge');
  assert.ok(items.some((i) => i.kind === 'run' && i.steps.some((s) => s.text === 'Read the skill run-gateway-tests')));
  assert.ok(items.some((i) => i.kind === 'action' && i.verb === 'saved skill' && i.object === 'run-gateway-tests'));

  // Denied, nothing is saved; always allowed, the next one saves without a card.
  const flaky = { name: 'retry-flaky-tests', description: 'When a test fails once.', body: 'Run it again three times before calling it flaky, and say so.' };
  faux.setResponses([reply(fauxToolCall('save_skill', flaky)), listen, listen]);
  await runtime.send('forge', 'Save one for flaky tests.');
  await runtime.waitForIdle();
  card = (await runtime.conversation('forge')).items.findLast((i) => i.kind === 'approval');
  await runtime.decide('forge', card.id, 'deny');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /doesn't want the skill retry-flaky-tests saved/);
  assert.equal((await runtime.agent('forge')).skills.length, 1);

  faux.setResponses([reply(fauxToolCall('save_skill', flaky)), listen, listen, reply(fauxToolCall('save_skill', { ...flaky, description: 'When a test fails only sometimes.' })), listen]);
  await runtime.send('forge', 'Please save it after all.');
  await runtime.waitForIdle();
  card = (await runtime.conversation('forge')).items.findLast((i) => i.kind === 'approval');
  await runtime.decide('forge', card.id, 'always');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /From now on your skills save without asking/);
  assert.equal((await runtime.agent('forge')).askFirst.find((r) => r.id === 'skills').on, false);
  await runtime.send('forge', 'Say it happens only sometimes.');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /Saved the skill retry-flaky-tests\./);
  forge = await runtime.agent('forge');
  assert.equal(forge.skills.find((s) => s.name === 'retry-flaky-tests').description, 'When a test fails only sometimes.', 'the same name changes it');
  assert.ok((await runtime.conversation('forge')).items.some((i) => i.kind === 'action' && i.verb === 'changed skill'));
  await runtime.close();
});

test('you write, share and delete skills, and they survive a restart; an agent that goes takes its own', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-skills-'));
  const db = join(dir, 'runtime.sqlite');
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  let runtime = await open(dir, faux, db);
  await runtime.createAgent({ name: 'vera', role: 'reviewer', provider: 'scripted', model: 'model' });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });

  const review = { name: 'review-a-change', description: 'How to review work sent to review.', body: 'Read the issue, then the diff. Run the tests yourself, and say what you ran.' };
  let vera = await runtime.addSkill('vera', { text: skillText(review) });
  const id = vera.skills[0].id;
  await assert.rejects(runtime.addSkill('vera', { text: skillText(review) }), /already has a skill called review-a-change/);
  await assert.rejects(runtime.addSkill('vera', { text: 'No front matter.' }), (err) => err.status === 422);
  await assert.rejects(runtime.updateSkill('forge', id, { sharedWith: ['*'] }), (err) => err.status === 404, "only its owner's profile changes it");

  vera = await runtime.updateSkill('vera', id, { sharedWith: ['forge', 'nobody', 'vera'] });
  assert.deepEqual(vera.skills[0].sharedWith, ['forge'], 'agents there are, not itself');
  assert.deepEqual((await runtime.agent('forge')).skills.map((s) => [s.name, s.owner, s.mine]), [['review-a-change', 'vera', false]]);
  assert.deepEqual((await runtime.agent('pip')).skills, []);

  let prompt = '';
  faux.setResponses([(context) => {
    prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
    return reply(fauxText('Hi.'));
  }]);
  await runtime.send('forge', 'Hi');
  await runtime.waitForIdle();
  assert.match(prompt, /- review-a-change \(vera's\): How to review work sent to review\./);

  await runtime.updateSkill('vera', id, { sharedWith: ['*'], text: skillText({ ...review, description: 'How to review anything.' }) });
  await runtime.close();

  runtime = await open(dir, faux, db);
  assert.deepEqual((await runtime.agent('pip')).skills.map((s) => [s.name, s.description]), [['review-a-change', 'How to review anything.']], 'shared with everyone, after a restart');
  await runtime.addSkill('forge', { text: skillText({ name: 'run-tests', description: 'Run the tests.', body: 'Run npm test in runtime/ and uv run pytest in tracker/.' }) });
  await runtime.updateSkill('forge', (await runtime.agent('forge')).skills.find((s) => s.mine).id, { sharedWith: ['vera'] });
  await runtime.deleteAgent('vera');
  assert.deepEqual((await runtime.agent('pip')).skills, [], "vera's skills go with it");
  assert.deepEqual((await runtime.agent('forge')).skills.map((s) => [s.name, s.sharedWith]), [['run-tests', []]], "and it's off forge's shares");
  const forge = await runtime.deleteSkill('forge', (await runtime.agent('forge')).skills[0].id);
  assert.deepEqual(forge.skills, []);
  await runtime.close();
});
