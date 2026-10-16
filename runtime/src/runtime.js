// munin's agent runtime: each agent is a pi-durable conversation, so its work survives a crash
// or a restart. What munin adds on top lives here: the agents' settings, questions and
// approvals as entries in their conversations, and the API the frontend reads
// (docs/runtime-api.md).

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { Type } from '@earendil-works/pi-ai';
import {
  Harness, LiveDoc, MemoryStorage, ToolTask, configure, createRegistry, defineDoc, defineExtension, defineTool, hook, section,
} from '@earendil-works/pi-durable';
import { CodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ROLES, roleName, askFirstFor, ruleMatches } from './roles.js';
import { toItems, summarize } from './items.js';
import { createTracker } from './tracker.js';
import { createScheduler, prepareRoutine, routineNote, RoutineError } from './routines.js';
import { createWorkspace, WorkspaceError } from './workspace.js';

export class RuntimeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = (name) => new RuntimeError(404, `There's no agent called ${name}.`);
const invalid = (message) => new RuntimeError(422, message);
const conflict = (message) => new RuntimeError(409, message);

// Every agent's settings, and where each project's code is, in one session document next
// to the conversations.
const AgentsDoc = defineDoc({ kind: 'munin.agents', version: 1, scope: 'session', initial: () => ({ agents: {}, repos: {} }) });

const NAME = /^[a-z][a-z0-9-]{1,23}$/;
const COLOURS = ['white', 'ember', 'coral', 'rose', 'iris', 'sky', 'teal', 'moss', 'straw'];
const THINKING = ['off', 'low', 'medium', 'high'];
const UNDO_MS = 8000;
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = /^[A-Z][A-Z0-9]{0,9}$/;
// Nobody is at an agent's terminal, so git mustn't wait for a pager, an editor or a password.
const SHELL_ENV = { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };
const HOME = homedir();
const tilde = (path) => (path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path);

// Where an agent reaches the tracker, with the token the tracker gave it. The frontend gets
// the token from the tracker and hands it over; the runtime never shows it again.
function trackerLink(value, current) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('The tracker link is {url, token, projects}.');
  const link = { url: current?.url || null, token: current?.token || null, projects: current?.projects || [] };
  if ('url' in value) {
    let url;
    try {
      url = new URL(value.url);
    } catch {
      throw invalid("The tracker's address isn't a URL.");
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw invalid("The tracker's address isn't an http one.");
    link.url = url.href;
  }
  if ('token' in value) {
    if (typeof value.token !== 'string' || !value.token.trim()) throw invalid('The tracker token is empty.');
    link.token = value.token.trim();
  }
  if ('projects' in value) {
    const keys = [...new Set((value.projects || []).map((k) => String(k).trim().toUpperCase()))];
    if (keys.some((k) => !PROJECT.test(k))) throw invalid('Projects are keys like MUN.');
    link.projects = keys;
  }
  if (link.token && !link.url) throw invalid('A tracker token needs the tracker’s address too.');
  return link;
}

// `now` and `timers` are for tests: a clock to run routines by, and whether a timer runs them.
export async function openRuntime(settings, { models, storage, now = Date.now, timers = true } = {}) {
  storage ||= settings.db === ':memory:' ? new MemoryStorage() : await openNodeSqliteStorage(settings.db);
  const agents = new Map(); // name → settings
  const listeners = new Set();
  let harness = null;

  const agentFor = (conversationId) => [...agents.values()].find((a) => a.conversationId === conversationId) || null;
  const conversationOf = async (agent) => harness.conversation(agent.conversationId, ctx);
  const write = async (agent, kind, data) => (await conversationOf(agent)).submit({ type: 'write', entry: { kind, data: { at: now(), ...data } } }, ctx);

  // munin's extension: who the agent is and what it remembers, asking the human, remembering
  // things, and asking first before what its rules say.
  const askHuman = defineTool({
    name: 'ask_human',
    description: `Ask ${settings.user} something you can't decide yourself. With a few clear answers, offer them as options. Their answer comes back as a message, so carry on with something else meanwhile.`,
    parameters: Type.Object({
      question: Type.String({ description: 'The question, in a sentence or two' }),
      options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), detail: Type.Optional(Type.String()) }), { maxItems: 6 })),
    }),
    execute: async (args, api) => {
      const agent = agentFor(api.conversationId);
      const options = (args.options || []).map((o) => ({ label: o.label, detail: o.detail || '' }));
      await write(agent, 'munin.question', { text: args.question, options });
      return { output: [{ type: 'text', text: `Asked ${settings.user}. Their answer comes as a message.` }] };
    },
  });
  const remember = defineTool({
    name: 'remember',
    description: `Remember something about ${settings.user} for every later conversation: a preference, a fact, a habit. One short sentence.`,
    parameters: Type.Object({ note: Type.String() }),
    execute: async (args, api) => {
      const agent = agentFor(api.conversationId);
      agent.memory.unshift({ id: `m${Date.now()}`, text: args.note.trim() });
      await saveAgents();
      await write(agent, 'munin.action', { verb: 'remembered', object: args.note.trim() });
      return { output: [{ type: 'text', text: 'Remembered.' }] };
    },
  });
  const Munin = defineExtension({
    name: 'munin',
    tools: [askHuman, remember],
    sections: [
      section('munin', (input) => {
        const agent = agentFor(input.conversationId);
        if (!agent) return undefined;
        return `You are ${agent.name}, one of ${settings.user}'s agents in munin, an app where ${settings.user} works with agents. `
          + `${settings.user} talks to you here, and may be away for hours. Keep replies short. When you need a decision, use ask_human; `
          + `when you learn something about ${settings.user} worth keeping, use remember.`;
      }, { tag: false }),
      section('memory', (input) => {
        const notes = agentFor(input.conversationId)?.memory || [];
        return notes.length ? notes.map((n) => `- ${n.text}`).join('\n') : undefined;
      }),
    ],
    hooks: [hook(ToolTask, {
      beforeTool: async (call, api) => {
        const agent = agentFor(api.conversationId);
        const rule = agent?.askFirst.find((r) => r.on && ruleMatches(r, call.name, call.arguments));
        if (!rule) return undefined;
        const allowed = agent.allowances.indexOf(rule.id);
        if (allowed >= 0) {
          agent.allowances.splice(allowed, 1);
          await saveAgents();
          return undefined;
        }
        const target = call.name === 'bash' ? String(call.arguments.command || '').slice(0, 160) : String(call.arguments.path || call.name);
        await write(agent, 'munin.approval', { rule: rule.id, label: rule.label, what: rule.what, third: rule.third, target });
        return { block: `${settings.user} hasn't allowed this yet (${rule.label.toLowerCase()}). They've been asked; their answer comes as a message. Don't try again before it does.` };
      },
    })],
  });

  // Coders' worktrees: one per issue, on the issue's branch. Taking an issue opens one; this
  // tool goes back to one, or opens someone else's branch to review it.
  let workspace = null;
  const repos = {};
  const moveTo = (api, context) => (cwd) => api.commit((tx) => configure(tx, api.conversationId, { cwd }), context);
  async function enter(agent, opened, move) {
    agent.work = { issue: opened.issue, folder: opened.folder, branch: opened.branch, detached: Boolean(opened.detached) };
    await saveAgents();
    await move(opened.folder);
  }
  const openWorktree = defineTool({
    name: 'open_worktree',
    description: "Work in an issue's code. For an issue you took, this opens your own worktree on its branch again (taking an issue opens it for you). For anyone else's, it opens a detached copy of their branch, to review or try it without changing their branch. Leave out the issue to go back to your own folder. Your shell and file tools work wherever this leaves you.",
    parameters: Type.Object({ issue: Type.Optional(Type.String({ description: 'Issue id, like MUN-12' })) }),
    execute: async (args, api, context) => {
      const agent = agentFor(api.conversationId);
      const say = (text, isError = false) => ({ output: [{ type: 'text', text }], isError });
      if (!args.issue) {
        agent.work = null;
        await saveAgents();
        await moveTo(api, context)(agent.folder);
        return say(`You're in your own folder again: ${agent.folder}.`);
      }
      const id = args.issue.trim().toUpperCase();
      const issue = { id, title: agent.work?.issue?.id === id ? agent.work.issue.title : null };
      try {
        const opened = await workspace.ownsWorktree(agent, issue) ? await workspace.openOwn(agent, issue) : await workspace.openReview(agent, issue);
        await enter(agent, opened, moveTo(api, context));
        return say(opened.detached
          ? `You're in a detached copy of ${opened.branch} to review ${id}: ${opened.folder}. Nothing you commit here lands on their branch.`
          : `You're in your worktree for ${id}: ${opened.folder}, on ${opened.branch}.`);
      } catch (err) {
        if (!(err instanceof WorkspaceError)) throw err;
        const take = /no branch yet/.test(err.message) ? ' To work on it, take it in the tracker and you get a worktree of your own.' : '';
        return say(`${err.message}${take}`, true);
      }
    },
  });
  const Workspace = defineExtension({
    name: 'workspace',
    tools: [openWorktree],
    sections: [section('workspace', (input) => {
      const agent = agentFor(input.conversationId);
      if (!agent?.abilities.code) return undefined;
      const work = agent.work;
      const keys = Object.keys(repos);
      return [
        `Your own folder is ${agent.folder}.`,
        work ? `You're working in ${work.folder}, ${work.detached ? `a detached copy of ${work.branch}` : `on ${work.branch}`}${work.issue ? `, for ${work.issue.id}` : ''}.` : null,
        keys.length ? `munin keeps the code of ${keys.join(', ')}. Taking one of their issues gives you a worktree on a branch of its own, and open_worktree opens someone else's branch to review it.` : null,
      ].filter(Boolean).join(' ');
    })],
  });

  // When a coder takes an issue, its worktree is ready before it reads the tracker's answer.
  async function onTake(agent, issue, move) {
    if (!agent.abilities.code) return null;
    const key = issue.id.split('-')[0];
    if (!workspace.has(key)) return `munin has no repository for ${key}, so you're working in your own folder, ${agent.folder}. The project's brief says where the code is.`;
    try {
      const opened = await workspace.openOwn(agent, issue);
      await enter(agent, opened, move);
      return `Your worktree for ${issue.id} is ready, and your shell and file tools work in it now: ${opened.folder}, on `
        + `${opened.fresh ? `a new branch, ${opened.branch}, from ${opened.base}` : `${opened.branch}, as you left it`}. `
        + "Commit your work there; the project's brief says how to deliver it.";
    } catch (err) {
      return `munin couldn't open a worktree for ${issue.id} (${err.message}), so you're still in ${agent.work?.folder || agent.folder}.`;
    }
  }

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(Munin);
  registry.install(Workspace);
  const tracker = createTracker({ registry, agents: () => agents.values(), agentFor, write, user: settings.user, onTake });
  harness = await Harness.open(storage, {
    models: models.models,
    registry,
    env: ({ cwd }) => (cwd ? new NodeExecutionEnv({ cwd, shellEnv: SHELL_ENV }) : undefined),
  }, ctx);

  const saved = await harness.snapshot(AgentsDoc, ctx);
  for (const agent of Object.values(saved?.agents || {})) agents.set(agent.name, structuredClone(agent));
  Object.assign(repos, structuredClone(saved?.repos || {}));
  workspace = createWorkspace({ dir: settings.reposDir || join(dirname(settings.agentsDir), 'repos'), repos });
  tracker.connect(); // in the background: until the tracker answers, agents are told it's away

  async function saveAgents() {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      for (const name of Object.keys(doc.agents)) if (!agents.has(name)) delete doc.agents[name];
      for (const [name, agent] of agents) doc.agents[name] = structuredClone(agent);
      doc.repos = structuredClone(repos);
    }, ctx);
  }

  const change = (agent) => {
    const { provider, model } = models.resolve(agent.provider, agent.model);
    return {
      model: { provider, modelId: model },
      thinkingLevel: agent.thinking,
      instructions: agent.brief,
      extensions: [Munin, ...(agent.abilities.code ? [CodingTools, Workspace] : []), ...(agent.abilities.tracker ? [tracker.extension()] : [])],
      cwd: agent.abilities.code ? (agent.work?.folder || agent.folder) : null,
    };
  };

  harness.subscribeCommits(() => {
    for (const fn of listeners) fn();
  });
  harness.resume(); // carry on with anything the last process left unfinished

  // Reading ------------------------------------------------------------------------------

  async function readItems(agent) {
    const conversation = await conversationOf(agent);
    const entries = [];
    let cursor;
    do {
      const page = await conversation.entries({ order: 'ascending' }, 500, cursor, ctx);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const live = await harness.snapshot(LiveDoc, agent.conversationId, ctx);
    const busy = Boolean(live?.run);
    return { entries, items: toItems(entries, { busy }), busy };
  }

  function usageOf(entries) {
    const now = Date.now();
    const out = { today: 0, week: 0, month: 0, tokens: 0 };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const entry of entries) {
      const message = entry.kind === 'pi.assistant' ? entry.model?.[0] : null;
      if (!message?.usage) continue;
      const cost = message.usage.cost?.total || 0;
      if (message.timestamp >= today.getTime()) {
        out.today += cost;
        out.tokens += message.usage.totalTokens || 0;
      }
      if (now - message.timestamp < 7 * DAY) out.week += cost;
      if (now - message.timestamp < 30 * DAY) out.month += cost;
    }
    for (const key of ['today', 'week', 'month']) out[key] = Math.round(out[key] * 1000) / 1000;
    return out;
  }

  async function summaryOf(agent) {
    const { items, busy } = await readItems(agent);
    const s = summarize(items, { busy, paused: agent.paused });
    return {
      name: agent.name, role: agent.role, roleName: roleName(agent.role), colour: agent.colour,
      state: s.state, waiting: s.waiting, preview: agent.paused ? 'Paused' : s.preview, lastAt: s.lastAt || new Date(agent.createdAt).toISOString(),
      typing: s.typing, provider: agent.provider, model: agent.model,
    };
  }

  async function fullOf(agent, read) {
    const { items, entries, busy } = read || await readItems(agent);
    const s = summarize(items, { busy, paused: agent.paused });
    return {
      ...await summaryOf(agent),
      brief: agent.brief, thinking: agent.thinking,
      abilities: { ...agent.abilities }, apps: [...agent.apps],
      askFirst: agent.askFirst.map(({ match, tool, tools, ...rule }) => rule),
      routines: agent.routines.map((r) => routineOut(r, agent)),
      memory: agent.memory.map((n) => ({ ...n })), memoryCount: agent.memory.length,
      usage: usageOf(entries), budget: agent.budget,
      worksIn: agent.abilities.code ? {
        folder: tilde(agent.work?.folder || agent.folder), branch: agent.work?.branch || null,
        issue: agent.work?.issue || null, detached: Boolean(agent.work?.detached),
      } : null,
      tracker: agent.abilities.tracker ? {
        projects: [...(agent.tracker?.projects || [])], takes: agent.role === 'reviewer' ? 'reviews' : 'issues',
        connected: Boolean(agent.tracker?.token), reachable: tracker.reachable(),
      } : null,
      paused: agent.paused, createdAt: new Date(agent.createdAt).toISOString(),
      run: s.run ? { id: s.run.id, issue: s.run.issue || null, startedAt: s.run.startedAt, step: s.run.steps[s.run.steps.length - 1]?.text || null } : null,
    };
  }

  const need = (name) => {
    const agent = agents.get(name);
    if (!agent) throw notFound(name);
    return agent;
  };

  async function findItem(agent, id, kind) {
    const { items } = await readItems(agent);
    const item = items.find((i) => i.id === id && i.kind === kind);
    if (!item) throw new RuntimeError(404, 'That has gone from the conversation.');
    return item;
  }

  const input = async (agent, content, entry) => (await conversationOf(agent)).submit({ type: 'input', content, whenBusy: 'steer', ...(entry ? { entry } : {}) }, ctx);

  // The API --------------------------------------------------------------------------------

  const api = {
    async me() {
      return { kind: 'runtime', version: '0.1.0', providers: models.providers() };
    },

    async agents() {
      return Promise.all([...agents.values()].map(summaryOf));
    },

    async agent(name) {
      return fullOf(need(name));
    },

    async conversation(name) {
      const agent = need(name);
      const read = await readItems(agent);
      return { agent: await fullOf(agent, read), items: read.items };
    },

    async waiting() {
      const out = [];
      for (const agent of agents.values()) {
        const { items } = await readItems(agent);
        const summary = await summaryOf(agent);
        for (const item of items) if ((item.kind === 'question' || item.kind === 'approval') && item.status === 'open') out.push({ agent: summary, item });
      }
      return out.sort((a, b) => a.item.at.localeCompare(b.item.at));
    },

    // A message from the human. While a question is open it answers the newest one; while the
    // agent works it steers.
    async send(name, text) {
      const agent = need(name);
      if (!String(text || '').trim()) throw invalid('A message needs some text.');
      if (agent.paused) throw conflict(`${name} is paused. Resume it first.`);
      const { items } = await readItems(agent);
      const open = [...items].reverse().find((i) => i.kind === 'question' && i.status === 'open');
      if (open) return api.answer(name, open.id, { text });
      await input(agent, text.trim());
    },

    async answer(name, id, { option, text } = {}) {
      const agent = need(name);
      const question = await findItem(agent, id, 'question');
      if (question.status !== 'open') throw conflict('That question is already answered.');
      const answer = option || String(text || '').trim();
      if (!answer) throw invalid('Pick an option or write an answer.');
      await input(agent, `${settings.user} answered your question "${question.text}": ${answer}`,
        { kind: 'munin.answer', data: { question: id, option: option || null, text: option ? null : answer, at: now() } });
    },

    async decide(name, id, decision) {
      const agent = need(name);
      if (!['once', 'always', 'deny'].includes(decision)) throw invalid('Decide once, always or deny.');
      const approval = await findItem(agent, id, 'approval');
      if (approval.status !== 'open') throw conflict('That is already decided.');
      await write(agent, 'munin.decision', { approval: id, decision });
      const rule = agent.askFirst.find((r) => r.id === approval.permission);
      if (decision === 'deny') {
        await input(agent, `${settings.user} doesn't want you to ${approval.what} (${approval.target}). Don't; find another way or ask.`);
        return;
      }
      if (decision === 'always' && rule) rule.on = false;
      else agent.allowances.push(approval.permission);
      await saveAgents();
      await input(agent, `${settings.user} allowed you to ${approval.what} (${approval.target})${decision === 'always' ? ', from now on without asking' : ', this once'}. Go ahead.`);
    },

    async undo(name, id) {
      const agent = need(name);
      const approval = await findItem(agent, id, 'approval');
      if (approval.status !== 'always' || !approval.undoUntil || Date.parse(approval.undoUntil) < Date.now()) throw conflict("It's too late to undo that.");
      const rule = agent.askFirst.find((r) => r.id === approval.permission);
      if (rule) rule.on = true;
      await saveAgents();
      await write(agent, 'munin.decision', { approval: id, decision: 'undo' });
    },

    async stopRun(name) {
      const agent = need(name);
      await (await conversationOf(agent)).abort(ctx);
      await write(agent, 'munin.action', { verb: 'stopped', object: 'by you' });
    },

    async createAgent({ name, role, colour = 'white', provider, model, brief, tracker: link } = {}) {
      const clean = String(name || '').trim().toLowerCase();
      if (!NAME.test(clean)) throw invalid('A name is 2 to 24 letters, digits or dashes, starting with a letter.');
      if (agents.has(clean)) throw conflict(`There's already an agent called ${clean}.`);
      if (!ROLES[role]) throw invalid(`There's no role called ${role}.`);
      if (!COLOURS.includes(colour)) throw invalid(`There's no colour called ${colour}.`);
      const abilities = { ...ROLES[role].abilities };
      const agent = {
        name: clean, role, colour, provider: provider || 'standin', model: model || 'stand-in', thinking: 'low',
        brief: String(brief || '').trim() || `You're ${clean}.`, abilities, apps: [], askFirst: askFirstFor(abilities), allowances: [],
        routines: [], memory: [], budget: null, paused: false, createdAt: Date.now(), folder: join(settings.agentsDir, clean), conversationId: null,
        tracker: link ? trackerLink(link, null) : null,
      };
      if (abilities.code) await mkdir(agent.folder, { recursive: true });
      const conversation = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: change(agent) }, ctx);
      agent.conversationId = conversation.id;
      agents.set(clean, agent);
      await saveAgents();
      if (agent.tracker?.token) await tracker.connect();
      return fullOf(agent);
    },

    async updateAgent(name, patch = {}) {
      const agent = need(name);
      if ('colour' in patch && !COLOURS.includes(patch.colour)) throw invalid(`There's no colour called ${patch.colour}.`);
      if ('thinking' in patch && !THINKING.includes(patch.thinking)) throw invalid(`Thinking is one of ${THINKING.join(', ')}.`);
      if ('role' in patch && !ROLES[patch.role]) throw invalid(`There's no role called ${patch.role}.`);
      for (const key of ['role', 'colour', 'provider', 'model', 'thinking', 'budget']) if (key in patch) agent[key] = patch[key];
      if ('brief' in patch) agent.brief = String(patch.brief || '').trim() || agent.brief;
      if (patch.abilities) {
        Object.assign(agent.abilities, patch.abilities);
        if (agent.abilities.code && !agent.askFirst.length) agent.askFirst = askFirstFor(agent.abilities);
        if (agent.abilities.code) await mkdir(agent.folder, { recursive: true });
      }
      if (patch.apps) agent.apps = [...patch.apps];
      if (patch.askFirst) for (const rule of agent.askFirst) if (rule.id in patch.askFirst) rule.on = Boolean(patch.askFirst[rule.id]);
      if ('tracker' in patch) agent.tracker = trackerLink(patch.tracker, agent.tracker);
      await (await conversationOf(agent)).configure(change(agent), ctx);
      await saveAgents();
      if (agent.abilities.tracker && agent.tracker?.token) await tracker.connect();
      return fullOf(agent);
    },

    async deleteAgent(name) {
      const agent = need(name);
      await (await conversationOf(agent)).abort(ctx);
      agents.delete(name);
      await saveAgents();
    },

    async pause(name) {
      const agent = need(name);
      agent.paused = true;
      await saveAgents();
      await (await conversationOf(agent)).abort(ctx);
      await write(agent, 'munin.action', { verb: 'paused', object: 'by you' });
    },

    async resume(name) {
      const agent = need(name);
      agent.paused = false;
      await saveAgents();
      await write(agent, 'munin.action', { verb: 'resumed', object: 'by you' });
    },

    async addRoutine(name, fields = {}) {
      const agent = need(name);
      const routine = { id: `r${randomUUID().slice(0, 8)}`, ...prepared(fields, agent), last: null };
      agent.routines.push(routine);
      await saveAgents();
      return routineOut(routine, agent);
    },

    async updateRoutine(name, id, fields = {}) {
      const agent = need(name);
      const at = agent.routines.findIndex((r) => r.id === id);
      if (at < 0) throw new RuntimeError(404, 'That routine is gone.');
      const old = agent.routines[at];
      agent.routines[at] = { id, ...prepared({ ...old, ...fields }, agent), last: old.last };
      await saveAgents();
      return routineOut(agent.routines[at], agent);
    },

    // Run it now, whatever its schedule.
    async runRoutine(name, id) {
      const agent = need(name);
      const routine = agent.routines.find((r) => r.id === id);
      if (!routine) throw new RuntimeError(404, 'That routine is gone.');
      if (agent.paused) throw conflict(`${name} is paused. Resume it first.`);
      await runRoutine(agent, routine, { why: 'you asked' });
      await saveAgents();
      return routineOut(routine, agent);
    },

    // Whatever routines are due now; the timer calls this, and tests do.
    tick: () => scheduler.tick(),

    async deleteRoutine(name, id) {
      const agent = need(name);
      agent.routines = agent.routines.filter((r) => r.id !== id);
      await saveAgents();
    },

    async forget(name, noteId) {
      const agent = need(name);
      agent.memory = agent.memory.filter((n) => n.id !== noteId);
      await saveAgents();
    },

    async providers() {
      return models.providers();
    },

    // Where each project's code is: [{ project, source, base }].
    async repos() {
      return workspace.list();
    },

    // Clones it, the first time; worktrees for issues in the project come from the clone.
    async setRepo(key, fields = {}) {
      try {
        const repo = await workspace.setRepo(String(key || '').toUpperCase(), fields);
        await saveAgents();
        return repo;
      } catch (err) {
        if (err instanceof WorkspaceError) throw invalid(err.message);
        throw err;
      }
    },

    async removeRepo(key) {
      workspace.removeRepo(String(key || '').toUpperCase());
      await saveAgents();
    },

    async models() {
      return models.catalog();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    async waitForIdle() {
      await harness.waitForIdle(ctx);
    },

    async close() {
      closed = true;
      clearTimeout(timer);
      listeners.clear();
      tracker.close();
      await harness.close(ctx);
    },
  };

  // Routines ------------------------------------------------------------------------------

  function prepared(fields, agent) {
    try {
      return prepareRoutine(fields, agent, now());
    } catch (err) {
      if (err instanceof RoutineError) throw invalid(err.message);
      throw err;
    }
  }

  const iso = (ms) => (ms == null ? null : new Date(ms).toISOString());
  const routineOut = (r, agent) => ({
    id: r.id, name: r.name, trigger: r.trigger, when: r.when, does: r.does,
    next: iso(r.next), last: iso(r.last), note: routineNote(r, agent),
  });

  // A routine's input waits behind whatever the agent is doing; one that's still waiting
  // isn't queued again.
  const queued = new Map();
  async function runRoutine(agent, routine, { why, issue = null }) {
    if (agent.paused) return false;
    const key = `${agent.name}/${routine.id}`;
    if (queued.has(key) && (await queued.get(key).status(ctx)).status === 'queued') return false;
    routine.last = now();
    const text = `Your routine "${routine.name}" runs now, because ${why}.\n\nWhat to do: ${routine.does}`;
    const entry = { kind: 'munin.routine', data: { routine: routine.id, name: routine.name, issue, at: now() } };
    queued.set(key, await (await conversationOf(agent)).submit({ type: 'input', content: text, whenBusy: 'followUp', entry }, ctx));
    return true;
  }

  const scheduler = createScheduler({
    agents: () => agents.values(),
    run: runRoutine,
    feed: (agent, args) => tracker.call(agent, 'events', args),
    issue: (agent, ref) => tracker.call(agent, 'get_issue', { issue: ref }),
    save: saveAgents,
    now,
  });
  let closed = false;
  let timer = null;
  const loop = async () => {
    try {
      await scheduler.tick();
    } catch (err) {
      console.error('routines:', err);
    }
    if (!closed) {
      timer = setTimeout(loop, scheduler.wait());
      timer.unref?.();
    }
  };
  if (timers) loop();

  return api;
}
