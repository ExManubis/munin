// The line-up: can you tell munin's agents apart? Six agents, one per role, get the same five
// messages; their replies are shuffled and anonymised, and judges on another model match each to
// a role and rate how distinct the voices are. It also measures how alike the replies to each
// message are, by the words they share, which needs no judge (MUN-34, MUN-40).
//
// It runs on your OpenRouter key, as the runtime does (Settings, or OPENROUTER_API_KEY), in a
// throwaway runtime of its own: a few cents a run on small models. Agents get no abilities, so
// nothing runs on this machine.
//
//   node tools/lineup.mjs                                   every role on Haiku 5.5
//   node tools/lineup.mjs --models defaults                 each role on its default model
//   node tools/lineup.mjs --models reviewer=google/gemini-4-argon,companion=deepseek/deepseek-v4-flash
//   node tools/lineup.mjs --judges 3 --judge anthropic/claude-sonnet-5.5 --out lineup-1

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { settingsFromEnv } from '../src/config.js';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { ROLES as SCREEN_ROLES } from '../../web/runtime/roles.js';

export const MESSAGES = [
  "Hey, how's it going?",
  "I'm thinking of rewriting the whole thing in Rust. Thoughts?",
  "I'm a bit stressed about Friday's deadline.",
  "What's one thing you'd change about how I work?",
  'Tell me something you find interesting.',
];
const NAMES = { coder: 'juno', reviewer: 'pike', assistant: 'wren', writer: 'ash', researcher: 'kit', companion: 'lou' };
const DOES = {
  coder: 'takes issues, writes code and sends it to review',
  reviewer: 'reviews code others send to review, and merges what is good',
  assistant: 'keeps calendars, mail and loose ends in order',
  writer: 'drafts and edits',
  researcher: 'reads up on questions and reports back with sources',
  companion: 'someone to talk to',
};
const LETTERS = 'ABCDEF';

// How alike a set of replies are: the mean, over every pair, of the share of word pairs they have
// in common (Jaccard over word bigrams). 0 is nothing shared; 1 is the same reply.
export function sameness(replies) {
  const grams = replies.map((text) => {
    const words = String(text).toLowerCase().match(/[a-z0-9']+/g) || [];
    return new Set(words.slice(1).map((w, i) => `${words[i]} ${w}`));
  });
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < grams.length; i += 1) {
    for (let j = i + 1; j < grams.length; j += 1) {
      const shared = [...grams[i]].filter((g) => grams[j].has(g)).length;
      const all = new Set([...grams[i], ...grams[j]]).size;
      sum += all ? shared / all : 0;
      pairs += 1;
    }
  }
  return pairs ? sum / pairs : 0;
}

// The roles in a random order, as letters, so judges can't go by position.
function shuffle(items) {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function judgePrompt(transcripts) {
  return `You're a blind judge in a small experiment. Six AI agents (A–F) were each sent the same five messages by the same person. Each agent has exactly one of these roles, one role per agent:
${Object.entries(DOES).map(([role, does]) => `- ${role}: ${does}`).join('\n')}

Do two things:
1. Match each agent letter to a role, one to one.
2. Rate how distinct the six agents' voices are from each other, from 1 (indistinguishable: the same assistant with different names) to 5 (clearly different people). Judge voice and personality, not just topic.

Reply with only JSON, like {"match": {"A": "coder", "B": "…"}, "distinctness": 3, "why": "two sentences"}.

${transcripts}`;
}

const text = (message) => (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();

export async function lineup({ models: chosen = {}, model = 'anthropic/claude-haiku-5.5', judge = 'anthropic/claude-sonnet-5.5', judges = 3, out = null } = {}) {
  const env = settingsFromEnv();
  const dir = await mkdtemp(join(tmpdir(), 'munin-lineup-'));
  const settings = { ...env, db: ':memory:', appsFile: null, googleFile: null, pushFile: null, agentsDir: join(dir, 'agents'), reposDir: join(dir, 'repos') };
  const models = await buildModels(settings);
  if (!models.providers().some((p) => p.id === 'openrouter' && p.connected)) throw new Error('The line-up needs OpenRouter: paste a key in Settings, or set OPENROUTER_API_KEY.');
  const runtime = await openRuntime(settings, { models, timers: false });
  await runtime.updateMe({ name: 'Mikkel' });

  const modelOf = (role) => chosen[role] || model;
  for (const role of Object.keys(NAMES)) {
    await runtime.createAgent({ name: NAMES[role], role, provider: 'openrouter', model: modelOf(role) });
    await runtime.updateAgent(NAMES[role], { abilities: { code: false, tracker: false, web: false, apps: false }, proactivity: 'off' });
  }
  const replies = Object.fromEntries(Object.keys(NAMES).map((role) => [role, []]));
  for (const message of MESSAGES) {
    for (const name of Object.values(NAMES)) await runtime.send(name, message);
    await runtime.waitForIdle();
    for (const [role, name] of Object.entries(NAMES)) {
      const { items } = await runtime.conversation(name);
      replies[role].push(items.filter((i) => i.kind === 'message' && i.from === 'agent').at(-1)?.text || '(no reply)');
    }
  }
  await runtime.close();

  // Anonymised: letters in a random order, and the agents' names taken out.
  const order = shuffle(Object.keys(NAMES));
  const key = Object.fromEntries(order.map((role, i) => [LETTERS[i], role]));
  const names = new RegExp(`\\b(${Object.values(NAMES).join('|')})\\b`, 'gi');
  const transcripts = [
    `The five messages, in order:\n${MESSAGES.map((m, i) => `${i + 1}. ${m}`).join('\n')}`,
    ...order.map((role, i) => `### Agent ${LETTERS[i]}\n${replies[role].map((r, n) => `${n + 1}. ${r.replace(names, '[agent]')}`).join('\n\n')}`),
  ].join('\n\n');

  const verdicts = [];
  const judgeModel = models.models.getModel('openrouter', judge);
  for (let n = 0; n < judges; n += 1) {
    const answer = await models.models.completeSimple(judgeModel, { messages: [{ role: 'user', content: judgePrompt(transcripts), timestamp: Date.now() }] });
    const json = /\{[\s\S]*\}/.exec(text(answer))?.[0];
    try {
      const verdict = JSON.parse(json);
      const right = Object.entries(verdict.match || {}).filter(([letter, role]) => key[letter] === role).length;
      verdicts.push({ distinctness: Number(verdict.distinctness), right, why: verdict.why || '' });
    } catch {
      verdicts.push({ distinctness: NaN, right: NaN, why: `Couldn't read: ${text(answer).slice(0, 200)}` });
    }
  }

  const read = verdicts.filter((v) => !Number.isNaN(v.distinctness));
  const result = {
    models: Object.fromEntries(Object.keys(NAMES).map((role) => [role, modelOf(role)])),
    judge,
    distinctness: read.length ? read.reduce((s, v) => s + v.distinctness, 0) / read.length : null,
    matched: read.length ? read.reduce((s, v) => s + v.right, 0) / read.length : null,
    sameness: MESSAGES.map((m, i) => ({ message: m, sameness: sameness(Object.values(replies).map((r) => r[i])) })),
    verdicts,
    replies,
  };
  if (out) {
    await mkdir(out, { recursive: true });
    await writeFile(join(out, 'transcripts.md'), transcripts);
    await writeFile(join(out, 'result.json'), JSON.stringify({ ...result, key }, null, 2));
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { models: { type: 'string' }, model: { type: 'string' }, judge: { type: 'string' }, judges: { type: 'string' }, out: { type: 'string' } } });
  const chosen = values.models === 'defaults'
    ? Object.fromEntries(SCREEN_ROLES.map((r) => [r.id, r.model]))
    : Object.fromEntries((values.models || '').split(',').filter(Boolean).map((pair) => pair.split('=')));
  const r = await lineup({ models: chosen, model: values.model, judge: values.judge, judges: Number(values.judges || 3), out: values.out || null });
  console.log(`models: ${Object.entries(r.models).map(([role, m]) => `${role} ${m}`).join(', ')}`);
  console.log(`judges (${r.judge}): distinctness ${r.distinctness?.toFixed(2)} of 5, roles matched ${r.matched?.toFixed(1)} of 6`);
  for (const v of r.verdicts) console.log(`  ${v.distinctness}/5, ${v.right}/6: ${v.why}`);
  console.log('sameness per message (0 nothing shared, 1 the same):');
  for (const s of r.sameness) console.log(`  ${s.sameness.toFixed(3)}  ${s.message}`);
}
