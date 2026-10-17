// Who each agent is: its role's soul and examples, how they reach the prompt, and who else is
// on the team (roles.js, prompt.js).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { ROLES, SOULS, examplesFor } from '../src/roles.js';
import { VOICE, identity, team } from '../src/prompt.js';
import { ROLES as SCREEN_ROLES, movedForTeam, startingModel } from '../../web/runtime/roles.js';

test("the screens offer the runtime's roles, with the same souls", () => {
  assert.deepEqual(SCREEN_ROLES.map((r) => r.id).toSorted(), Object.keys(ROLES).toSorted());
  for (const role of SCREEN_ROLES) {
    assert.equal(role.brief('quill'), SOULS[role.id].brief(), `${role.id}'s brief`);
    assert.equal(role.examples('quill'), SOULS[role.id].examples('quill'), `${role.id}'s examples`);
  }
});

test('every soul is written as behaviour, in two paragraphs, with examples of its own', () => {
  for (const [role, soul] of Object.entries(SOULS)) {
    const brief = soul.brief();
    const words = brief.split(/\s+/).length;
    assert.ok(words >= 80 && words <= 250, `${role}'s soul is ${words} words`);
    assert.equal(brief.split('\n\n').length, 2, `${role}: who it is, then how it works`);
    assert.doesNotMatch(brief, /^You're \w+, an? (coder|reviewer|assistant|writer|researcher|companion)\b/, `${role}: the runtime says its name and role`);
    const examples = soul.examples('ada');
    assert.match(examples, /^You: .+\nada: .+/, `${role}'s examples start with you`);
    assert.ok(examples.split('\n\n').length >= 2, `${role} has at least two exchanges`);
  }
  assert.notEqual(new Set(Object.values(SOULS).map((s) => s.brief())).size, 1);
});

test("the shared voice says what to leave out, and leaves opinions to each agent's soul", () => {
  assert.match(VOICE, /^How you talk:/);
  assert.match(VOICE, /Skip filler/);
  assert.doesNotMatch(VOICE, /Have opinions/);
  assert.ok(VOICE.split(/\s+/).length < 80, 'shorter than any soul');
});

test('examples follow the brief, with your name on your lines, and are labelled made up', () => {
  const forge = { name: 'forge', role: 'coder', brief: SOULS.coder.brief(), examples: SOULS.coder.examples('forge') };
  const named = identity(forge, 'Mikkel');
  assert.match(named, /^You're forge, a coder, and you work for Mikkel\./);
  assert.equal(named.match(/You're forge/g).length, 1, 'introduced once');
  const at = (words) => named.indexOf(words);
  assert.ok(at('How you talk:') < at('You like code') && at('You like code') < at('How you sound'));
  assert.match(named, /How you sound, in a few made-up exchanges with Mikkel\. They're there for your voice: they didn't happen, so don't bring up what's in them\.\nMikkel: Can you make the inbox faster\?\nYou: Faster to load/);
  assert.doesNotMatch(named, /^forge:/m, 'no lines under its own name to copy');

  const unnamed = identity(forge, null);
  assert.match(unnamed, /exchanges with the person you work for \("Them"\)\. [^\n]+\nThem: Can you make the inbox faster\?\nYou: /);
  assert.doesNotMatch(identity({ ...forge, examples: '' }, 'Mikkel'), /How you sound/);
  assert.doesNotMatch(identity({ ...forge, examples: null }, 'Mikkel'), /How you sound/);
});

test("an agent gets its role's examples only while its brief is its role's soul", () => {
  assert.equal(examplesFor({ name: 'pip', role: 'companion', brief: SOULS.companion.brief() }), SOULS.companion.examples('pip'));
  assert.equal(examplesFor({ name: 'pip', role: 'companion', brief: `${SOULS.companion.brief()} Loves boats.` }), SOULS.companion.examples('pip'), 'with your words after it');
  assert.equal(examplesFor({ name: 'pip', role: 'companion', brief: "You're pip. Be nice." }), '');
  assert.equal(examplesFor({ name: 'pip', role: 'gardener', brief: 'Grow things.' }), '');
});

test("the team lists the other agents, what each does, what a coder last took, and who's paused", () => {
  assert.equal(team([]), undefined, 'no team, no section');
  const text = team([
    { name: 'forge', role: 'coder', abilities: { code: true }, work: { issue: { id: 'MUN-46', title: 'Stream tool output' } } },
    { name: 'vera', role: 'reviewer', abilities: { code: true }, work: { issue: { id: 'MUN-45', title: 'Retry' }, detached: true } },
    { name: 'moss', role: 'companion', abilities: {}, paused: true },
  ]);
  assert.deepEqual(text.split('\n').slice(1, -1), [
    '- forge, a coder: takes issues, writes code and sends it to review. Last took MUN-46 · Stream tool output.',
    "- vera, a reviewer: reviews what the others send to review, and merges what's good.",
    '- moss, a companion: someone to talk to. Paused.',
  ], "a reviewer's copy of someone else's branch isn't its issue");
  assert.match(text, /^Your team: munin's other agents\. You don't message them/);
});

test("a reviewer starts on another maker's model than your coders'", () => {
  const reviewer = SCREEN_ROLES.find((r) => r.id === 'reviewer');
  const coder = SCREEN_ROLES.find((r) => r.id === 'coder');
  const catalog = [
    { id: 'openrouter', models: [{ id: 'anthropic/claude-haiku-5.5' }, { id: 'anthropic/claude-opus-5.5' }, { id: 'openai/gpt-5.4' }] },
    { id: 'standin', models: [{ id: 'stand-in' }] },
  ];
  const coders = [{ name: 'forge', role: 'coder', model: 'anthropic/claude-sonnet-5.5' }];
  assert.deepEqual(startingModel(catalog, reviewer, coders), { provider: 'openrouter', model: 'openai/gpt-5.4' });
  assert.deepEqual(startingModel(catalog, reviewer, []), { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, 'no coders yet: the first there is');
  const withArgon = [{ id: 'openrouter', models: [...catalog[0].models, { id: 'google/gemini-4-argon' }] }];
  assert.deepEqual(startingModel(withArgon, reviewer, coders), { provider: 'openrouter', model: 'google/gemini-4-argon' }, "its role's, when it's offered");
  assert.deepEqual(startingModel(withArgon, reviewer, [{ role: 'coder', model: 'google/gemini-4-argon' }]), { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, 'not the coders\' maker, even when it\'s the role\'s');
  const anthropicOnly = [{ id: 'openrouter', models: [{ id: 'anthropic/claude-haiku-5.5' }] }, catalog[1]];
  assert.deepEqual(startingModel(anthropicOnly, reviewer, coders), { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, 'never the stand-in instead');
  assert.deepEqual(startingModel(catalog, coder, coders), { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, 'a coder starts anywhere');
});

test("the other roles start on a maker the team doesn't use yet, at no more than twice the price", () => {
  const role = (id) => SCREEN_ROLES.find((r) => r.id === id);
  const catalog = [{ id: 'openrouter', models: [
    { id: 'anthropic/claude-haiku-5.5', output: 5 }, { id: 'anthropic/claude-opus-5.5', output: 25 },
    { id: 'meta/muse-wonder', output: 20 }, { id: 'deepseek/deepseek-v4-flash', output: 0.18 }, { id: 'z-ai/glm-5.3', output: 6 },
  ] }];
  const team = [{ role: 'coder', model: 'anthropic/claude-sonnet-5.5' }];
  assert.deepEqual(startingModel(catalog, role('assistant'), team), { provider: 'openrouter', model: 'z-ai/glm-5.3' }, 'the nearest in price to Haiku that nobody uses');
  assert.ok(movedForTeam(catalog, role('assistant'), team));
  assert.deepEqual(startingModel(catalog, role('companion'), [...team, { role: 'writer', model: 'z-ai/glm-5.3' }]).model, 'deepseek/deepseek-v4-flash');
  assert.deepEqual(startingModel(catalog, role('assistant'), [{ role: 'writer', model: 'z-ai/glm-5.3' }]).model, 'anthropic/claude-haiku-5.5', "its role's, when nobody uses that maker");
  const crowded = [...team, { role: 'writer', model: 'z-ai/glm-5.3' }, { role: 'companion', model: 'deepseek/deepseek-v4-flash' }];
  assert.equal(startingModel(catalog, role('assistant'), crowded).model, 'anthropic/claude-haiku-5.5', 'not four times the price to be different');
  assert.ok(!movedForTeam(catalog, role('assistant'), crowded));
  assert.equal(startingModel(catalog, role('coder'), team).model, 'anthropic/claude-haiku-5.5', 'a coder keeps its strong default where it can');
  assert.ok(SCREEN_ROLES.filter((r) => r.spread).map((r) => r.id).join() === 'reviewer,assistant,writer,researcher,companion');
});

test('an agent hears its examples and its team, and keeps the examples you give it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-soul-'));
  const settings = { db: ':memory:', host: '127.0.0.1', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'me' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const prompts = [];
  faux.setResponses(Array.from({ length: 3 }, () => (context) => {
    prompts.push(Object.values(context.messages.findLast((m) => m.role === 'system').sections).join('\n'));
    return fauxAssistantMessage([fauxText('Hi.')]);
  }));
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider] }), timers: false });
  await runtime.updateMe({ name: 'Mikkel' });

  const pip = await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });
  assert.equal(pip.brief, SOULS.companion.brief(), "a brief left empty is its role's soul");
  assert.equal(pip.examples, SOULS.companion.examples('pip'));
  await runtime.createAgent({ name: 'vera', role: 'reviewer', examples: '' });
  assert.equal((await runtime.agent('vera')).examples, '', 'examples given empty stay empty');
  await runtime.createAgent({ name: 'moss', role: 'companion', brief: "You're moss. Slow and calm." });
  assert.equal((await runtime.agent('moss')).examples, '', 'none for a brief you wrote yourself');
  await runtime.pause('moss');

  await runtime.send('pip', 'Hello');
  await runtime.waitForIdle();
  const prompt = prompts[0];
  const at = (words) => prompt.indexOf(words);
  const order = ['How you talk:', "You're curious, cheerful", 'How you sound', 'What you can do.', 'Your team:'];
  assert.deepEqual(order.map(at), order.map(at).toSorted((a, b) => a - b), 'in this order');
  assert.ok(order.every((words) => prompt.includes(words)));
  assert.match(prompt, /\nMikkel: I'm bored\.\nYou: Good, I've been saving one\./);
  assert.match(prompt, /- vera, a reviewer: reviews what the others send to review, and merges what's good\.\n- moss, a companion: someone to talk to\. Paused\./);
  assert.doesNotMatch(prompt, /- pip,/, "it isn't on its own team");
  assert.doesNotMatch(prompt, /Reach a phone/);
  assert.match(prompt, /Reaching Mikkel: what you say waits in munin until they look\. Once they turn on notifications in munin's Settings, what you say reaches their phone too\./);

  await runtime.updateAgent('pip', { examples: 'You: Hi.\npip: Hello, you.' });
  assert.equal((await runtime.agent('pip')).examples, 'You: Hi.\npip: Hello, you.');
  await runtime.send('pip', 'Hi');
  await runtime.waitForIdle();
  assert.match(prompts[1], /\nMikkel: Hi\.\nYou: Hello, you\./);
  await runtime.updateAgent('pip', { examples: '' });
  await runtime.send('pip', 'Hi again');
  await runtime.waitForIdle();
  assert.doesNotMatch(prompts[2], /How you sound/);
  await runtime.close();
});
