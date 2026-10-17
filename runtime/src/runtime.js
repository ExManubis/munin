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
  GenerationTask, Harness, LiveDoc, MemoryStorage, ToolTask, configure, createRegistry, defineDoc, defineExtension, defineTool, hook, section,
} from '@earendil-works/pi-durable';
import { createBashTool, createCodingTools } from '@earendil-works/pi-durable/tools';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { ROLES, roleName, askFirstFor, ruleMatches, upgradeBrief } from './roles.js';
import { toItems, summarize } from './items.js';
import { AppError, describeAppCall, openApps } from './apps.js';
import { GoogleError, openGoogle } from './google.js';
import { googleApps } from './googleapps.js';
import { readPageTool, webSearchTool } from './web.js';
import { identity, about } from './prompt.js';
import { createTracker } from './tracker.js';
import { createScheduler, prepareRoutine, routineNote, RoutineError } from './routines.js';
import { createWorkspace, WorkspaceError } from './workspace.js';
import { QUIET_GIT, createDockerSandbox, localShellEnv, passedThrough } from './sandbox.js';
import { KeyError } from './keys.js';
import { FAVOURITES } from './models.js';

export class RuntimeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = (name) => new RuntimeError(404, `There's no agent called ${name}.`);
const invalid = (message) => new RuntimeError(422, message);
const conflict = (message) => new RuntimeError(409, message);

// Every agent's settings, where each project's code is, and what setup asked (your name, your
// favourite models, whether it's done), in one session document next to the conversations.
const AgentsDoc = defineDoc({ kind: 'munin.agents', version: 1, scope: 'session', initial: () => ({ agents: {}, repos: {}, prefs: {} }) });

const NAME = /^[a-z][a-z0-9-]{1,23}$/;
const COLOURS = ['white', 'ember', 'coral', 'rose', 'iris', 'sky', 'teal', 'moss', 'straw'];
const THINKING = ['off', 'low', 'medium', 'high'];
const UNDO_MS = 8000;
const JOURNAL = 1000; // numbered events kept for reconnecting streams
const DAY = 24 * 60 * 60 * 1000;
const PROJECT = /^[A-Z][A-Z0-9]{0,9}$/;
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

// `now`, `timers`, `costOf` and `google` are for tests: a clock to run routines and budgets by,
// whether a timer runs routines, what a model response cost (the test model's are all free), and
// Google's endpoints and fetch.
const costOfResponse = (message) => message.usage?.cost?.total || 0;
export async function openRuntime(settings, { models, storage, now = Date.now, timers = true, costOf = costOfResponse, google: googleTest = {} } = {}) {
  storage ||= settings.db === ':memory:' ? new MemoryStorage() : await openNodeSqliteStorage(settings.db);
  const agents = new Map(); // name → settings
  const listeners = new Set();
  let harness = null;
  // From setup: what agents call you, your favourite OpenRouter models, and where setup is:
  // 'started', 'done', or null when it hasn't asked.
  const prefs = { name: null, favourites: null, setup: null };
  const who = () => prefs.name || settings.user;
  // What agents call you: your name, or "the person you work for" while munin has none.
  // MUNIN_USER's default, "me", is no name: "me answered your question" reads as nonsense.
  const named = () => prefs.name || (settings.user && settings.user !== 'me' ? settings.user : null);
  const them = ({ start = false } = {}) => named() || (start ? 'The person you work for' : 'the person you work for');
  const favourites = () => prefs.favourites || FAVOURITES;

  const agentFor = (conversationId) => [...agents.values()].find((a) => a.conversationId === conversationId) || null;
  const conversationOf = async (agent) => harness.conversation(agent.conversationId, ctx);
  const write = async (agent, kind, data) => (await conversationOf(agent)).submit({ type: 'write', entry: { kind, data: { at: now(), ...data } } }, ctx);

  // munin's extension: who the agent is and what it remembers, asking the human, remembering
  // things, and asking first before what its rules say.
  const askHuman = defineTool({
    name: 'ask_human',
    description: `Ask the person you work for something you can't decide yourself. With a few clear answers, offer them as options. Their answer comes back as a message, so carry on with something else meanwhile.`,
    parameters: Type.Object({
      question: Type.String({ description: 'The question, in a sentence or two' }),
      options: Type.Optional(Type.Array(Type.Object({ label: Type.String(), detail: Type.Optional(Type.String()) }), { maxItems: 6 })),
    }),
    execute: async (args, api) => {
      const agent = agentFor(api.conversationId);
      const options = (args.options || []).map((o) => ({ label: o.label, detail: o.detail || '' }));
      await write(agent, 'munin.question', { text: args.question, options });
      return { output: [{ type: 'text', text: `Asked ${them()}. Their answer comes as a message.` }] };
    },
  });
  const remember = defineTool({
    name: 'remember',
    description: 'Remember something about the person you work for, for every later conversation: a preference, a fact, a habit. One short sentence.',
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
      // Who the agent is, who it's talking with and how it talks, then what it knows about you
      // (prompt.js). The brief is part of the first section, so it comes before munin's own notes.
      section('munin', (input) => {
        const agent = agentFor(input.conversationId);
        return agent ? identity(agent, named(), { apps: apps.namesFor(agent) }) : undefined;
      }, { tag: false }),
      section('about', (input) => {
        const agent = agentFor(input.conversationId);
        return agent ? about(agent, named()) : undefined;
      }, { tag: false }),
    ],
    hooks: [hook(GenerationTask, {
      // Before a request, so this month's spend is known before the response adds to it.
      beforeRequest: async (request, api) => {
        const agent = agentFor(api.conversationId);
        if (agent?.budget) await spentThisMonth(agent);
        return undefined;
      },
      afterResponse: async (message, api) => {
        const agent = agentFor(api.conversationId);
        if (!agent) return;
        const spent = await spentThisMonth(agent);
        spent.total += costOf(message);
        if (agent.budget && spent.total >= agent.budget) await pauseForBudget(agent);
      },
    }), hook(ToolTask, {
      beforeTool: async (call, api) => {
        const agent = agentFor(api.conversationId);
        if (agent?.pausedFor === 'budget' && agent.paused) {
          return { block: "You've reached your budget for this month, so munin has paused you. Don't call any more tools: say in a line or two where you got to, and stop." };
        }
        // An app's rule covers its tools that change something; the others match by tool and command.
        const rule = agent?.askFirst.find((r) => r.on && (r.app ? apps.changing(r.app, call.name, r.kind) : ruleMatches(r, call.name, call.arguments)));
        if (!rule) return undefined;
        const allowed = agent.allowances.indexOf(rule.id);
        if (allowed >= 0) {
          agent.allowances.splice(allowed, 1);
          await saveAgents();
          return undefined;
        }
        const target = rule.app ? describeAppCall(apps.changing(rule.app, call.name, rule.kind).name, call.arguments)
          : call.name === 'bash' ? String(call.arguments.command || '').slice(0, 160) : String(call.arguments.path || call.name);
        await write(agent, 'munin.approval', { rule: rule.id, label: rule.label, what: rule.what, third: rule.third, target });
        return { block: `${them({ start: true })} hasn't allowed this yet (${rule.label.toLowerCase()}). They've been asked; their answer comes as a message. Don't try again before it does.` };
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
        + (opened.kept ? 'munin moved it into your own clone, and committed what you hadn\'t yet as "Work in progress"; amend or undo that as you like. ' : '')
        + "Commit your work there; the project's brief says how to deliver it.";
    } catch (err) {
      return `munin couldn't open a worktree for ${issue.id} (${err.message}), so you're still in ${agent.work?.folder || agent.folder}.`;
    }
  }

  // Where coders' tools run (sandbox.js): in a container of their own, or on this machine with
  // a shell that doesn't inherit the runtime's environment and its keys.
  const reposDir = settings.reposDir || join(dirname(settings.agentsDir), 'repos');
  const sandbox = settings.sandbox === 'docker'
    ? createDockerSandbox({ image: settings.agentImage, network: settings.agentNetwork, agentsDir: settings.agentsDir })
    : null;
  const passthrough = settings.agentEnv || [];
  // pi-durable's coding tools, under their own name so conversations keep selecting them, with
  // the shell's environment chosen here rather than inherited.
  const base = createCodingTools();
  const bash = createBashTool({
    prepare: (execution) => {
      if (sandbox) {
        execution.inheritEnv = true; // the container's own environment, which never had the keys
        execution.env = { ...QUIET_GIT, ...passedThrough(process.env, passthrough), ...execution.env };
      } else {
        execution.inheritEnv = false;
        execution.env = { ...localShellEnv(process.env, passthrough), ...execution.env };
      }
    },
  });
  const CodingTools = defineExtension({ name: base.name, tools: base.tools.map((tool) => (tool.name === 'bash' ? bash : tool)) });

  const registry = createRegistry();
  registry.install(CodingTools);
  // The web (web.js): reading pages for every agent with the Web ability, and searching for those
  // on OpenRouter, whose requests swap web_search for OpenRouter's own search.
  const WebRead = defineExtension({ name: 'web-read', tools: [readPageTool()] });
  const WebSearch = defineExtension({ name: 'web-search', tools: [webSearchTool] });
  registry.install(WebRead);
  registry.install(WebSearch);
  registry.install(Munin);
  registry.install(Workspace);
  const tracker = createTracker({ registry, agents: () => agents.values(), agentFor, write, user: who, onTake, mcpUrl: settings.trackerMcp || null });
  // When apps change, or one starts or stops answering, every agent's conversation gets its tools.
  const reconfigure = async () => {
    if (!harness) return;
    for (const agent of agents.values()) await (await conversationOf(agent)).configure(change(agent), ctx).catch(() => {});
  };
  const google = await openGoogle({ file: settings.googleFile || null, now, ...googleTest });
  const apps = await openApps({
    file: settings.appsFile || null, registry, onChange: () => { reconfigure(); },
    builtins: googleApps({ google, ...googleTest.apis }), // Gmail and Google Calendar, once you sign in
  });
  harness = await Harness.open(storage, {
    models: models.models,
    registry,
    env: ({ conversationId, cwd }) => {
      if (!cwd) return undefined;
      const agent = agentFor(conversationId);
      return sandbox && agent ? sandbox.envFor(agent, cwd) : new NodeExecutionEnv({ cwd });
    },
  }, ctx);

  const saved = await harness.snapshot(AgentsDoc, ctx);
  for (const agent of Object.values(saved?.agents || {})) agents.set(agent.name, { ...structuredClone(agent), brief: upgradeBrief(agent.brief) });
  for (const agent of agents.values()) syncAppRules(agent);
  Object.assign(repos, structuredClone(saved?.repos || {}));
  Object.assign(prefs, structuredClone(saved?.prefs || {}));
  workspace = createWorkspace({ dir: reposDir, agentsDir: settings.agentsDir, repos });
  tracker.connect(); // in the background: until the tracker answers, agents are told it's away

  const googleCall = async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GoogleError) throw invalid(err.message);
      throw err;
    }
  };

  // Each app an agent has gets its ask-first rules (apps.rulesFor), on or off as the app says
  // until you change them; an app it no longer has, or that's gone, takes its rules with it, and
  // so does a rule the app no longer has (Gmail's one rule became one per kind of change).
  function syncAppRules(agent) {
    const wanted = apps.idsFor(agent).flatMap((id) => apps.rulesFor(id));
    const ids = new Set(wanted.map((rule) => rule.id));
    agent.askFirst = agent.askFirst.filter((rule) => !rule.app || ids.has(rule.id));
    for (const rule of wanted) if (!agent.askFirst.some((r) => r.id === rule.id)) agent.askFirst.push(rule);
  }

  async function saveAgents() {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(AgentsDoc);
      for (const name of Object.keys(doc.agents)) if (!agents.has(name)) delete doc.agents[name];
      for (const [name, agent] of agents) doc.agents[name] = structuredClone(agent);
      doc.repos = structuredClone(repos);
      doc.prefs = structuredClone(prefs);
    }, ctx);
  }

  const change = (agent) => {
    const { provider, model } = models.resolve(agent.provider, agent.model);
    return {
      model: { provider, modelId: model },
      thinkingLevel: agent.thinking,
      extensions: [Munin, ...(agent.abilities.code ? [CodingTools, Workspace] : []), ...(agent.abilities.tracker ? [tracker.extension()] : []), ...apps.extensionsFor(agent),
        ...(agent.abilities.web ? [WebRead, ...(provider === 'openrouter' ? [WebSearch] : [])] : [])],
      cwd: agent.abilities.code ? (agent.work?.folder || agent.folder) : null,
    };
  };

  // Every commit is a numbered event for the stream, naming the agents it was about. Ids are
  // "<boot>.<n>": a client that reconnects with one from before a restart, or one older than the
  // last JOURNAL events, is told to reload everything instead of being sent what it missed.
  const boot = randomUUID().slice(0, 8);
  const journal = []; // { id, n, agents }, oldest first
  let numbered = 0;
  const changed = (publication) => {
    const names = new Set();
    for (const change of publication?.changes || []) {
      const conversation = change.conversationId ?? change.entry?.conversationId ?? change.record?.conversationId;
      const agent = conversation && agentFor(conversation);
      if (agent) names.add(agent.name);
    }
    numbered += 1;
    const event = { id: `${boot}.${numbered}`, n: numbered, agents: [...names] };
    journal.push(event);
    if (journal.length > JOURNAL) journal.shift();
    for (const fn of listeners) fn(event);
  };
  harness.subscribeCommits(changed);
  harness.resume(); // carry on with anything the last process left unfinished

  // Reading ------------------------------------------------------------------------------

  // Each conversation's entries, kept as they're read: a read asks pi-durable only for entries
  // after the last one it has (entries never change once written), and one agent's reads go one
  // at a time so two can't both append the same new entries. Its items are rebuilt only when
  // there's something new.
  const kept = new Map(); // conversationId → { entries, items, key, queue }
  async function readItems(agent) {
    let held = kept.get(agent.conversationId);
    if (!held) kept.set(agent.conversationId, held = { entries: [], items: [], key: null, queue: Promise.resolve() });
    const read = held.queue.then(async () => {
      const conversation = await conversationOf(agent);
      const last = held.entries.at(-1)?.id;
      let cursor;
      do {
        const page = await conversation.entries({ order: 'ascending', ...(last ? { minEntryId: last } : {}) }, 500, cursor, ctx);
        for (const entry of page.items) if (entry.id !== last) held.entries.push(entry); // the bound is inclusive
        cursor = page.next;
      } while (cursor);
      const live = await harness.snapshot(LiveDoc, agent.conversationId, ctx);
      const busy = Boolean(live?.run);
      const key = `${held.entries.length}/${busy}`;
      if (held.key !== key) Object.assign(held, { items: toItems(held.entries, { busy }), key });
      return { entries: held.entries, items: held.items, busy };
    });
    held.queue = read.catch(() => {});
    return read;
  }

  // `month` is this calendar month, the period a budget covers.
  function usageOf(entries) {
    const at = now();
    const out = { today: 0, week: 0, month: 0, tokens: 0 };
    const today = new Date(at);
    today.setHours(0, 0, 0, 0);
    const month = new Date(today);
    month.setDate(1);
    for (const entry of entries) {
      const message = entry.kind === 'pi.assistant' ? entry.model?.[0] : null;
      if (!message?.usage) continue;
      const cost = costOf(message);
      if (message.timestamp >= today.getTime()) {
        out.today += cost;
        out.tokens += message.usage.totalTokens || 0;
      }
      if (at - message.timestamp < 7 * DAY) out.week += cost;
      if (message.timestamp >= month.getTime()) out.month += cost;
    }
    for (const key of ['today', 'week', 'month']) out[key] = Math.round(out[key] * 1000) / 1000;
    return out;
  }

  // What each agent's model responses cost this calendar month: read from its conversation the
  // first time it's needed in a month, then added to as responses arrive.
  const spend = new Map(); // name → { month: 'YYYY-MM', total }
  const monthOf = (at) => { const d = new Date(at); return `${d.getFullYear()}-${d.getMonth() + 1}`; }; // local, like usageOf
  async function spentThisMonth(agent) {
    const month = monthOf(now());
    let spent = spend.get(agent.name);
    if (!spent || spent.month !== month) {
      spent = { month, total: usageOf((await readItems(agent)).entries).month };
      spend.set(agent.name, spent);
    }
    return spent;
  }

  // An agent pauses itself at its budget and says why. The turn it's in ends rather than being
  // cut off: its next tool calls are blocked (beforeTool), so it answers once more and stops.
  // It stays paused until you resume it, which takes a bigger budget or a new month.
  async function pauseForBudget(agent) {
    if (agent.paused) return;
    agent.paused = true;
    agent.pausedFor = 'budget';
    await saveAgents();
    const month = new Date(now()).toLocaleString('en', { month: 'long' });
    await write(agent, 'munin.action', { verb: 'paused', object: `at its $${agent.budget} budget for ${month}` });
  }

  async function summaryOf(agent) {
    const { items, busy } = await readItems(agent);
    const s = summarize(items, { busy, paused: agent.paused });
    return {
      name: agent.name, role: agent.role, roleName: roleName(agent.role), colour: agent.colour,
      state: s.state, waiting: s.waiting, preview: agent.paused ? (agent.pausedFor === 'budget' ? 'Paused at its budget' : 'Paused') : s.preview, lastAt: s.lastAt || new Date(agent.createdAt).toISOString(),
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
        sandbox: sandbox ? sandbox.kind : null,
      } : null,
      tracker: agent.abilities.tracker ? {
        projects: [...(agent.tracker?.projects || [])], takes: agent.role === 'reviewer' ? 'reviews' : 'issues',
        connected: Boolean(agent.tracker?.token), reachable: tracker.reachable(),
      } : null,
      paused: agent.paused, pausedFor: agent.paused ? agent.pausedFor || 'you' : null, createdAt: new Date(agent.createdAt).toISOString(),
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
    // `setup` is 'started' while you're in it and 'done' once it's over (or skipped). A runtime
    // that has agents without setup having asked came before setup, so it counts as done.
    async me() {
      return {
        kind: 'runtime', version: '0.1.0', providers: models.providers(), sandbox: sandbox ? { kind: sandbox.kind, image: sandbox.image } : null,
        name: who(), setup: prefs.setup || (agents.size ? 'done' : null),
      };
    },

    // What agents call you, and where setup is: { name, setup: 'started' | 'done' }.
    async updateMe(patch = {}) {
      if ('name' in patch) {
        const name = String(patch.name ?? '').trim().replace(/\s+/g, ' ');
        if (name.length > 60) throw invalid('That name is too long: 60 letters at most.');
        prefs.name = name || null;
      }
      if ('setup' in patch) {
        if (!['started', 'done'].includes(patch.setup)) throw invalid('Setup is "started" or "done".');
        prefs.setup = patch.setup;
      }
      await saveAgents();
      changed();
      return api.me();
    },

    async agents() {
      return Promise.all([...agents.values()].map(summaryOf));
    },

    async agent(name) {
      return fullOf(need(name));
    },

    // A page of the conversation: the newest `limit` items, or those just before the item
    // `before`. `more` says whether there are older ones.
    async conversation(name, { before = null, limit = 100 } = {}) {
      const agent = need(name);
      const read = await readItems(agent);
      const size = Math.max(1, Math.min(Number(limit) || 100, 500));
      let end = read.items.length;
      if (before) {
        end = read.items.findIndex((item) => item.id === before);
        if (end < 0) throw invalid(`There's no item ${before} in ${name}'s conversation.`);
      }
      const start = Math.max(0, end - size);
      return { agent: await fullOf(agent, read), items: read.items.slice(start, end), more: start > 0 };
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
      await input(agent, `${them({ start: true })} answered your question "${question.text}": ${answer}`,
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
        await input(agent, `${them({ start: true })} doesn't want you to ${approval.what} (${approval.target}). Don't; find another way or ask.`);
        return;
      }
      if (decision === 'always' && rule) rule.on = false;
      else agent.allowances.push(approval.permission);
      await saveAgents();
      await input(agent, `${them({ start: true })} allowed you to ${approval.what} (${approval.target})${decision === 'always' ? ', from now on without asking' : ', this once'}. Go ahead.`);
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
      if (patch.apps) {
        agent.apps = [...patch.apps];
        syncAppRules(agent);
      }
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
      await sandbox?.remove(agent);
      kept.delete(agent.conversationId);
      agents.delete(name);
      await saveAgents();
    },

    async pause(name) {
      const agent = need(name);
      agent.paused = true;
      agent.pausedFor = 'you';
      await saveAgents();
      await (await conversationOf(agent)).abort(ctx);
      await write(agent, 'munin.action', { verb: 'paused', object: 'by you' });
    },

    async resume(name) {
      const agent = need(name);
      if (agent.budget) {
        const { total } = await spentThisMonth(agent);
        if (total >= agent.budget) throw conflict(`${name} has spent $${total.toFixed(2)} of its $${agent.budget} budget this month. Raise the budget on its profile to resume it, or wait for next month.`);
      }
      agent.paused = false;
      agent.pausedFor = null;
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

    // A provider's key, pasted in Settings. It's never shown again, only its last four characters.
    async setKey(provider, key) {
      try {
        await models.setKey(provider, key);
      } catch (err) {
        if (err instanceof KeyError) throw invalid(err.message);
        throw err;
      }
      changed();
      return models.providers().find((p) => p.id === provider);
    },

    async removeKey(provider) {
      try {
        await models.removeKey(provider);
      } catch (err) {
        if (err instanceof KeyError) throw invalid(err.message);
        throw err;
      }
      changed();
      return models.providers().find((p) => p.id === provider);
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

    // Google (google.js): your OAuth client, and signing in for Gmail and Calendar. `redirect` is
    // the runtime's callback as the browser reaches it; the server works it out.
    google: (redirect) => google.status(redirect),

    async setGoogleClient(input) {
      const status = await googleCall(() => google.setClient(input?.json ?? input));
      apps.changed(); // a new client signs the old account out
      return status;
    },

    async googleSignIn(fields) {
      return googleCall(() => google.signIn(fields));
    },

    // Google's redirect back. Never throws: the page to go back to, and how it went.
    async googleFinish(query) {
      try {
        const { back, email } = await google.finish(query);
        apps.changed();
        return { back, ok: true, message: `Signed in with Google as ${email || 'your account'}.` };
      } catch (err) {
        return { back: err.back || null, ok: false, message: err.message };
      }
    },

    async googleSignOut() {
      await google.signOut();
      apps.changed();
    },

    // Apps (apps.js): MCP servers agents use, which you add in Settings.
    apps: () => apps.list(),

    async addApp(fields) {
      try {
        return await apps.add(fields);
      } catch (err) {
        if (err instanceof AppError) throw invalid(err.message);
        throw err;
      }
    },

    async removeApp(id) {
      try {
        await apps.remove(id);
        for (const agent of agents.values()) syncAppRules(agent);
        await saveAgents();
      } catch (err) {
        if (err instanceof AppError) throw new RuntimeError(404, err.message);
        throw err;
      }
    },

    async models() {
      const inUse = [...agents.values()].filter((a) => a.provider === 'openrouter').map((a) => a.model);
      return models.catalog({ favourites: favourites(), inUse });
    },

    // What setup recommends from OpenRouter, key or not: { cheap: [model], frontier: [model] }.
    async recommendedModels() {
      return models.recommended();
    },

    // OpenRouter's models matching `q`, from its whole catalog: { total, models }.
    async searchModels(q) {
      return models.search(q);
    },

    // The OpenRouter models agents pick from, in your order.
    async setFavourites(ids) {
      if (!Array.isArray(ids)) throw invalid('Favourites are a list of model ids.');
      const clean = [...new Set(ids.map((id) => String(id).trim()))];
      const unknown = clean.find((id) => !models.known(id));
      if (unknown) throw invalid(`OpenRouter has no model called ${unknown}.`);
      prefs.favourites = clean;
      await saveAgents();
      changed();
      return api.models();
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    // The newest event's id, to number a fresh stream from.
    lastEventId: () => `${boot}.${numbered}`,

    // What a stream that last saw `id` missed: the events since, or reset when they're gone.
    eventsSince(id) {
      const [from, at] = String(id || '').split('.');
      const n = Number(at);
      if (from !== boot || !Number.isInteger(n) || n > numbered) return { reset: true, events: [] };
      if (n < numbered && (journal[0]?.n ?? Infinity) > n + 1) return { reset: true, events: [] };
      return { reset: false, events: journal.filter((event) => event.n > n) };
    },

    async waitForIdle() {
      await harness.waitForIdle(ctx);
    },

    async close() {
      closed = true;
      sandbox?.close();
      clearTimeout(timer);
      listeners.clear();
      tracker.close();
      apps.close();
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
