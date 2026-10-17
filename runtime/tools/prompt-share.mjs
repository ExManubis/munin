// How much of each role's system prompt is the agent's own soul (its brief and examples), and how
// much is munin's: who it is, what it can do, its team, its skills. A soul that's a small share of
// what an agent reads is easy to drown out (MUN-40). Free to run: the model is a stand-in.
//
//   node tools/prompt-share.mjs

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { ROLES } from '../src/roles.js';

const NAMES = { coder: 'forge', reviewer: 'vera', assistant: 'hugin', writer: 'quill', researcher: 'atlas', companion: 'pip' };
const dir = await mkdtemp(join(tmpdir(), 'munin-share-'));
const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false });
await runtime.updateMe({ name: 'Mikkel' });
for (const role of Object.keys(ROLES)) await runtime.createAgent({ name: NAMES[role], role, provider: 'scripted', model: 'model' });

export async function shares() {
  const out = [];
  for (const [role, name] of Object.entries(NAMES)) {
    let sections = {};
    faux.setResponses([(context) => {
      sections = context.messages.find((m) => m.role === 'system').sections;
      return fauxAssistantMessage([fauxText('Hi.')]);
    }]);
    await runtime.send(name, 'Hi');
    await runtime.waitForIdle();
    const agent = await runtime.agent(name);
    const soul = agent.brief.length + (agent.examples || '').length;
    const total = Object.values(sections).reduce((sum, s) => sum + (s || '').length, 0);
    out.push({ role, total, soul, share: soul / total, sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, (v || '').length])) });
  }
  return out;
}

const rows = await shares();
await runtime.close();
for (const r of rows) {
  const parts = Object.entries(r.sections).map(([k, n]) => `${k} ${n}`).join(', ');
  console.log(`${r.role.padEnd(11)} soul ${String(r.soul).padStart(5)} of ${String(r.total).padStart(6)} characters (${Math.round(r.share * 100)}%) · ${parts}`);
}
