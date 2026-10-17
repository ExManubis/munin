// What an agent remembers (memory.js): three kinds, each with room for so many characters, and
// making room one note at a time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { KINDS, MemoryError, addNote, changeNote, forgetNote, kindOf, remembered, room } from '../src/memory.js';
import { MEMORY_KINDS } from '../../web/runtime/roles.js';

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });
const fill = (kind, n) => Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind, text: 'x'.repeat(100) }));

test('notes come in four kinds, and notes from before kinds are about you', () => {
  assert.deepEqual(Object.keys(KINDS), ['you', 'work', 'self', 'team']);
  assert.equal(kindOf({ text: 'Old note.' }), 'you');
  assert.equal(kindOf({ text: 'Odd.', kind: 'gossip' }), 'you');
  const notes = [{ id: 'a', text: 'Mikkel likes small PRs.' }, { id: 'b', kind: 'work', text: 'Tests: uv run pytest.' }];
  assert.deepEqual(room(notes), { you: { used: 23, cap: KINDS.you.cap }, work: { used: 21, cap: KINDS.work.cap }, self: { used: 0, cap: KINDS.self.cap }, team: { used: 0, cap: KINDS.team.cap } });
});

test("the profile names the runtime's kinds, with the same room", () => {
  assert.deepEqual(Object.fromEntries(Object.entries(MEMORY_KINDS).map(([k, v]) => [k, v.cap])), Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.cap])));
});

test('a full kind turns a new note away and says how to make room', () => {
  const notes = fill('self', 10); // 1,000 characters
  assert.throws(() => addNote(notes, { kind: 'self', text: 'One more lesson.' }), (err) => err instanceof MemoryError
    && /Your self notes are full \(1,000 of 1,000 characters, and this needs 16\)\. They're your own notes, so make room yourself, without asking: change_note .* forget_note/.test(err.message));
  const { notes: more } = addNote(notes, { kind: 'work', text: 'Deploys go through staging.' });
  assert.equal(more[0].kind, 'work', 'another kind still has room');
  assert.throws(() => addNote([], { kind: 'you', text: '   ' }), /Say what to remember/);
  assert.throws(() => addNote([], { kind: 'you', text: 'x'.repeat(301) }), /under 300 characters/);
  assert.throws(() => addNote([], { kind: 'diary', text: 'Hi.' }), /about you, work, self or team, not diary/);
});

test('making room: two notes said in one, then one forgotten, one at a time', () => {
  let notes = fill('self', 10);
  const merged = changeNote(notes, 'f0', { text: 'Run the tests before saying they pass, and say what you skipped.' });
  notes = merged.notes;
  assert.equal(merged.note.kind, 'self', 'its kind stays');
  assert.equal(notes.length, 10);
  notes = forgetNote(notes, 'f1').notes;
  assert.equal(notes.length, 9);
  assert.doesNotThrow(() => addNote(notes, { kind: 'self', text: 'Small PRs land faster.' }));
  assert.throws(() => changeNote(notes, 'f2', { text: 'y'.repeat(250) }), /full/, "a change has to fit too, counting the note's old text out");
  assert.deepEqual(changeNote(notes, 'f2', { kind: 'work' }).note, { id: 'f2', kind: 'work', text: 'x'.repeat(100) }, 'moved to another kind');
  assert.throws(() => forgetNote(notes, 'nope'), /There's no note nope/);
});

test('the prompt lists each kind with how full it is and each note with its id', () => {
  const notes = [
    { id: 'm1', kind: 'you', text: 'Mikkel likes small PRs.' },
    { id: 'm2', kind: 'self', text: 'Measure before optimising.' },
    { id: 'm3', kind: 'you', text: 'Mornings are for deep work.' },
  ];
  assert.equal(remembered(notes, 'Mikkel'), [
    'What you know about Mikkel (50 of 1,500 characters):',
    '- Mikkel likes small PRs. [m1]',
    '- Mornings are for deep work. [m3]',
    '',
    "What you've learned about how you work best (26 of 1,000 characters):",
    '- Measure before optimising. [m2]',
  ].join('\n'));
  assert.equal(remembered([], 'Mikkel'), undefined);
});

test('an agent remembers in kinds, makes room itself, and you can change its notes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-memory-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }) });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });

  const heard = [];
  let prompt = '';
  faux.setResponses([
    reply(fauxToolCall('remember', { note: 'Gateway tests need TELEGRAM_TEST_TOKEN.', kind: 'work' })),
    reply(fauxToolCall('remember', { note: 'Mikkel likes one PR per issue.', kind: 'you' })),
    (context) => {
      heard.push(JSON.stringify(context.messages.at(-1)));
      return reply(fauxText('Noted both.'));
    },
  ]);
  await runtime.send('forge', 'Remember how to run the gateway tests, and that I like one PR per issue.');
  await runtime.waitForIdle();
  let agent = await runtime.agent('forge');
  assert.deepEqual(agent.memory.map((n) => [n.kind, n.text]), [['you', 'Mikkel likes one PR per issue.'], ['work', 'Gateway tests need TELEGRAM_TEST_TOKEN.']]);
  assert.deepEqual(agent.memoryRoom.work, { used: 39, cap: KINDS.work.cap });
  const work = agent.memory.find((n) => n.kind === 'work');

  faux.setResponses([
    reply(fauxToolCall('change_note', { note: work.id, text: 'Gateway tests need TELEGRAM_TEST_TOKEN; run them with uv run pytest gateway/.' })),
    reply(fauxToolCall('forget_note', { note: 'm-nope' })),
    (context) => {
      heard.push(JSON.stringify(context.messages.at(-1)));
      prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
      return reply(fauxText('Done.'));
    },
  ]);
  await runtime.send('forge', 'Add how to run them to that note.');
  await runtime.waitForIdle();
  assert.match(heard.at(-1), /There's no note m-nope/, 'a wrong id comes back as an error to the agent');
  assert.match(prompt, /How the work is done here \(77 of 1,500 characters\):\\n- Gateway tests need TELEGRAM_TEST_TOKEN; run them with uv run pytest gateway\/\. \[m\w+\]/);
  assert.match(prompt, /What you know about Mikkel \(30 of 1,500 characters\)/);
  const { items } = await runtime.conversation('forge');
  assert.deepEqual(items.filter((i) => i.kind === 'action').map((i) => i.verb), ['remembered', 'remembered', 'changed a note']);
  assert.ok(!items.some((i) => i.kind === 'run' && i.steps.some((s) => /change_note|forget_note|remember/.test(s.text))), 'memory shows as action lines, not steps');

  agent = await runtime.changeNote('forge', work.id, { kind: 'self' });
  assert.equal(agent.memory.find((n) => n.id === work.id).kind, 'self');
  await assert.rejects(runtime.changeNote('forge', work.id, { text: 'x'.repeat(301) }), /under 300 characters/);
  await assert.rejects(runtime.changeNote('forge', 'nope', { text: 'Hi.' }), (err) => err.status === 404);
  await runtime.close();
});

test("an agent keeps notes on a teammate, which show under them in its team, and go when the teammate does", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-memory-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }) });
  await runtime.createAgent({ name: 'vera', role: 'reviewer', provider: 'scripted', model: 'model' });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });

  const heard = [];
  let prompt = '';
  faux.setResponses([
    reply(fauxToolCall('remember', { note: 'Skips edge-case tests.', kind: 'team' })),
    reply(fauxToolCall('remember', { note: 'Skips edge-case tests; check them first.', kind: 'team', about: 'Forge' })),
    (context) => {
      heard.push(JSON.stringify(context.messages.findLast((m) => m.role === 'toolResult')));
      return reply(fauxText('Noted.'));
    },
    (context) => {
      prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
      return reply(fauxText('Hi.'));
    },
  ]);
  await runtime.send('vera', "Keep in mind that forge's PRs skip edge cases.");
  await runtime.waitForIdle();
  const vera = await runtime.agent('vera');
  assert.deepEqual(vera.memory.map((n) => [n.kind, n.about, n.text]), [['team', 'forge', 'Skips edge-case tests; check them first.']], 'the first, without a teammate, was turned back');
  assert.equal(vera.memoryRoom.team.used, 40);
  await runtime.send('vera', 'Hi');
  await runtime.waitForIdle();
  assert.match(prompt, /- forge, a coder: takes issues, writes code and sends it to review\.\\n  Your note: Skips edge-case tests; check them first\. \[m\w+\]/);
  assert.match(prompt, /Judge their work on evidence, not on how sure they sound\. Your team notes use 40 of 1,000 characters\./);
  assert.doesNotMatch(prompt, /What you've noticed about your teammates/, 'team notes show in the team, not twice');

  await runtime.deleteAgent('forge');
  assert.deepEqual((await runtime.agent('vera')).memory, [], 'notes on a teammate go with it');
  await runtime.close();
});
