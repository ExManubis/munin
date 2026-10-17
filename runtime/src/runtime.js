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
import { ROLES, SOULS, ROUTINES_RULE, SKILLS_RULE, roleName, askFirstFor, ruleMatches, upgradeBrief, examplesFor } from './roles.js';
import { STALE_MS, SkillError, checkSkill, hasSkill, parseSkill, skillText, skillsSection } from './skills.js';
import { SoulError, checkSoul, withVersion } from './soul.js';
import { toItems, summarize } from './items.js';
import { AppError, describeAppCall, openApps } from './apps.js';
import { GoogleError, openGoogle } from './google.js';
import { PushError, openPush } from './push.js';
import { googleApps } from './googleapps.js';
import { readPageTool, webSearchTool } from './web.js';
import { identity, about, capabilities, team, reminder } from './prompt.js';
import { PROACTIVITY, dayOf, heartbeatDue, heartbeatText, isQuiet, journalDue, journalText, proactivityFor } from './rhythm.js';
import { MemoryError, addNote, changeNote, forgetNote, kindOf, room } from './memory.js';
import { createTracker } from './tracker.js';
import { createScheduler, prepareRoutine, routineNote, RoutineError } from './routines.js';
import { createWorkspace, WorkspaceError } from './workspace.js';
import { QUIET_GIT, createDockerSandbox, localShellEnv, passedThrough } from './sandbox.js';
import { KeyError } from './keys.js';
import { FAVOURITES } from './models.js';
import { MeetingError, isQuiet as meetingQuiet, speech, speechOf, nextSpeaker, waitingOn, meetingOut, meetingSummary, turnText, parseMeeting, meetingOfTurn } from './meetings.js';

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
const AgentsDoc = defineDoc({ kind: 'munin.agents', version: 1, scope: 'session', initial: () => ({ agents: {}, repos: {}, prefs: {}, skills: {} }) });
// Meetings (meetings.js), transcripts and who's been asked to speak included: { id: meeting }.
const MeetingsDoc = defineDoc({ kind: 'munin.meetings', version: 1, scope: 'session', initial: () => ({ meetings: {} }) });
// What model responses cost while an agent worked on an issue: { 'MUN-12': { cost, tokens, agents: { forge: cost } } }.
const CostsDoc = defineDoc({ kind: 'munin.costs', version: 1, scope: 'session', initial: () => ({ issues: {} }) });

const NAME = /^[a-z][a-z0-9-]{1,23}$/;
const COLOURS = ['white', 'ember', 'coral', 'rose', 'iris', 'sky', 'teal', 'moss', 'straw'];
const THINKING = ['off', 'low', 'medium', 'high'];
const UNDO_MS = 8000;
const REMIND_AFTER = 40; // messages in a conversation before who the agent is gets repeated at the end
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

// `now`, `timers`, `costOf`, `google` and `push` are for tests: a clock to run routines and
// budgets by, whether a timer runs routines, what a model response cost (the test model's are
// all free), Google's endpoints and fetch, and how pushes are sent.
const costOfResponse = (message) => message.usage?.cost?.total || 0;
export async function openRuntime(settings, { models, storage, now = Date.now, timers = true, costOf = costOfResponse, google: googleTest = {}, push: pushTest = {} } = {}) {
  storage ||= settings.db === ':memory:' ? new MemoryStorage() : await openNodeSqliteStorage(settings.db);
  const meetings = new Map(); // id → meeting (meetings.js)
  const meetingNow = new Map(); // conversation id → the meeting whose turn it's answering right now
  const meetingSessions = new Map(); // conversation id → agent name, for each agent's session in a meeting
  const agents = new Map(); // name → settings
  const skills = new Map(); // id → skill (skills.js), each with its owner and who it's shared with
  const turns = new Map(); // agent name → 'heartbeat' or 'journal', while munin's own input is being answered (rhythm.js)
  const expressions = new Map(); // agent name → { pose, until }: how the work is going, on its face for a minute
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

  // An agent's own conversation, or one of its meeting sessions (each its own conversation, so a
  // meeting never sees its chats with you): either way, the agent.
  const agentFor = (conversationId) => [...agents.values()].find((a) => a.conversationId === conversationId)
    || agents.get(meetingSessions.get(conversationId)) || null;
  const conversationOf = async (agent) => harness.conversation(agent.conversationId, ctx);
  // Push notifications (push.js): questions, approvals, and what agents that don't code say.
  const push = await openPush({ file: settings.pushFile || null, subject: settings.publicUrl || 'mailto:munin@localhost', ...pushTest });
  const write = async (agent, kind, data) => {
    const written = await (await conversationOf(agent)).submit({ type: 'write', entry: { kind, data: { at: now(), ...data } } }, ctx);
    if (kind === 'munin.question') push.notify(agent, 'question', data).catch(() => {});
    if (kind === 'munin.approval') push.notify(agent, 'approval', data).catch(() => {});
    return written;
  };

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
  const say = (text, isError = false) => ({ output: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) });
  // Memory (memory.js): notes in three kinds, each with room for so many characters. When a kind
  // is full, the agent makes room by changing or forgetting notes, one at a time.
  const KIND = Type.Union([Type.Literal('you'), Type.Literal('work'), Type.Literal('self'), Type.Literal('team')], {
    description: 'you: about the person you work for (a preference, a fact, a habit). work: how the work is done here (commands, conventions, where things live). self: how you work best (what works, what to avoid). team: about one of your teammates (how they work, what to check in their work); say which in about.',
  });
  const memoryCall = (run) => async (args, toolApi) => {
    const agent = agentFor(toolApi.conversationId);
    try {
      return say(await run(agent, args));
    } catch (err) {
      if (err instanceof MemoryError) return say(err.message, true);
      throw err;
    }
  };
  const remember = defineTool({
    name: 'remember',
    description: 'Remember something for every later conversation, as one short sentence. Say it as what works ("Mikkel likes small PRs", "Run the gateway tests with TELEGRAM_TEST_TOKEN set"), not as what went wrong.',
    parameters: Type.Object({ note: Type.String(), kind: KIND, about: Type.Optional(Type.String({ description: 'For a team note: the teammate it is about' })) }),
    execute: memoryCall(async (agent, args) => {
      const about = String(args.about || '').trim().toLowerCase();
      const others = [...agents.keys()].filter((n) => n !== agent.name);
      if (args.kind === 'team' && !others.includes(about)) throw new MemoryError(others.length ? `Say which teammate the note is about, in about: one of ${others.join(', ')}.` : "You have no teammates to keep notes on yet.");
      const { notes, note } = addNote(agent.memory, { kind: args.kind, text: args.note, about: args.kind === 'team' ? about : null });
      agent.memory = notes;
      await saveAgents();
      await write(agent, 'munin.action', { verb: 'remembered', object: note.text });
      return `Remembered, as ${note.id}.`;
    }),
  });
  const changeNoteTool = defineTool({
    name: 'change_note',
    description: 'Change one of your notes by its id: say it better, say two notes in one, or move it to another kind. Only what you give changes.',
    parameters: Type.Object({ note: Type.String({ description: 'Its id, like m3fa9c1' }), text: Type.Optional(Type.String()), kind: Type.Optional(KIND) }),
    execute: memoryCall(async (agent, args) => {
      const { notes, note } = changeNote(agent.memory, args.note, { text: args.text, kind: args.kind });
      agent.memory = notes;
      await saveAgents();
      await write(agent, 'munin.action', { verb: 'changed a note', object: note.text });
      return `Changed ${note.id}.`;
    }),
  });
  const forgetNoteTool = defineTool({
    name: 'forget_note',
    description: "Forget one of your notes by its id, when it's no longer true or matters less than what you need room for.",
    parameters: Type.Object({ note: Type.String({ description: 'Its id, like m3fa9c1' }) }),
    execute: memoryCall(async (agent, args) => {
      const { notes, old } = forgetNote(agent.memory, args.note);
      agent.memory = notes;
      await saveAgents();
      await write(agent, 'munin.action', { verb: 'forgot', object: old.text });
      return `Forgot ${old.id}.`;
    }),
  });
  // A passing expression: the agent's Figbot shows how the work is going for a minute, in one of
  // the poses it already has, then goes back to showing its status. Each change is an entry, so
  // the frontend hears of it; status still wins whenever you're needed (web/figbot.js, faceOf).
  const PASSING = ['excited', 'happy', 'worried'];
  const EXPRESSION_MS = 60 * 1000;
  async function express(agent, pose) {
    const until = now() + EXPRESSION_MS;
    expressions.set(agent.name, { pose, until });
    await write(agent, 'munin.expression', { pose, until });
    if (!timers) return;
    setTimeout(async () => {
      if (expressions.get(agent.name)?.until !== until || !agents.has(agent.name)) return;
      expressions.delete(agent.name);
      await write(agent, 'munin.expression', { pose: null }).catch(() => {});
    }, EXPRESSION_MS).unref?.();
  }
  const setExpression = defineTool({
    name: 'set_expression',
    description: 'Let your face show how the work is going, for a minute: excited when something finally works, happy when something went well, worried when something broke or you are stuck. Use it when something real happens, not for small talk.',
    parameters: Type.Object({ expression: Type.Union(PASSING.map((p) => Type.Literal(p))) }),
    execute: async (args, toolApi) => {
      const agent = agentFor(toolApi.conversationId);
      await express(agent, args.expression);
      return say(`Your face shows ${args.expression} for a minute.`);
    },
  });

  // Its soul (soul.js): the agent may propose a change to its brief or examples, which always asks
  // you, with the change on the card; allowing it applies it and keeps a version.
  const proposeSoul = defineTool({
    name: 'propose_soul_change',
    description: "Propose a change to your own brief or examples, when you've noticed they get you wrong: how you work, what you care about, how you sound. Give the whole new text of what changes; what you leave out stays. It always asks first, so in your reply say in a sentence or two why you want it.",
    parameters: Type.Object({
      why: Type.String({ description: 'Why, in a sentence or two' }),
      brief: Type.Optional(Type.String({ description: 'Your whole new brief' })),
      examples: Type.Optional(Type.String({ description: 'Your whole new examples, with "You:" for the person and your name for you' })),
    }),
    execute: async (args, toolApi) => {
      const agent = agentFor(toolApi.conversationId);
      try {
        const why = String(args.why || '').trim();
        if (!why) throw new SoulError('Say why you want the change.');
        const { items } = await readItems(agent);
        if (items.some((i) => i.kind === 'approval' && i.soul && i.status === 'open')) throw new SoulError(`You've proposed a change already; wait for ${them()}'s answer.`);
        const next = checkSoul({ brief: args.brief, examples: args.examples }, agent);
        const parts = [next.brief !== agent.brief && 'its brief', next.examples !== (agent.examples || '') && 'how it talks'].filter(Boolean);
        await write(agent, 'munin.approval', {
          rule: 'soul', label: 'Changing who it is', what: 'change who it is', third: 'changes who it is', target: parts.join(' and '),
          soul: { why: why.slice(0, 300), brief: next.brief, examples: next.examples, was: { brief: agent.brief, examples: agent.examples || '' } },
        });
        return say(`Asked ${them()} to look at the change. Their answer comes as a message; carry on meanwhile.`);
      } catch (err) {
        if (err instanceof SoulError) return say(err.message, true);
        throw err;
      }
    },
  });

  // Meetings (meetings.js): speak_in_meeting, the tool an agent answers a meeting turn with.
  // Text is the speech; calling it with none passes. Which meeting: the one it was given, else the
  // one whose turn it's answering, else the only one that asked it.
  const speakInMeeting = defineTool({
    name: 'speak_in_meeting',
    description: 'Say your turn in a munin meeting. A few sentences at most, spoken to the others in the room. With nothing to add, call it with no text to pass.',
    parameters: Type.Object({
      text: Type.Optional(Type.String({ description: 'What you say, or left out to pass' })),
      meeting: Type.Optional(Type.String({ description: 'The meeting id from your turn, when you were asked in more than one' })),
    }),
    execute: async (args, toolApi) => {
      const agent = agentFor(toolApi.conversationId);
      const asking = [...meetings.values()].filter((m) => m.status === 'open' && m.asked?.agent === agent.name);
      const id = args.meeting || meetingNow.get(toolApi.conversationId) || (asking.length === 1 ? asking[0].id : null);
      const meeting = id ? meetings.get(id) : null;
      if (!meeting || meeting.status !== 'open' || meeting.asked?.agent !== agent.name) {
        return say(asking.length > 1 ? `Say which meeting: ${asking.map((m) => `${m.id} ("${m.title}")`).join(', ')}.` : "You haven't been asked to speak in a meeting.", true);
      }
      meetingNow.delete(toolApi.conversationId);
      const text = args.text == null ? null : String(args.text);
      const spoke = await recordTurn(meeting.id, agent.name, text);
      return say(spoke ? 'Said in the meeting.' : 'You passed.');
    },
  });

  // Skills (skills.js): what the agent knows how to do here. It reads one when it fits, and saves
  // one when it has learned something it'll do again; SKILLS_RULE makes each save ask you first,
  // with the skill on the approval card, and saves it when you allow it.
  const skillCall = (run) => async (args, toolApi) => {
    const agent = agentFor(toolApi.conversationId);
    try {
      return say(await run(agent, args));
    } catch (err) {
      if (err instanceof SkillError) return say(err.message, true);
      throw err;
    }
  };
  const readSkill = defineTool({
    name: 'read_skill',
    description: 'Read one of your skills by its name: when to use it, the steps, the pitfalls and how to check. Read it before you start what it covers.',
    parameters: Type.Object({ name: Type.String() }),
    execute: skillCall(async (agent, { name }) => {
      const key = String(name || '').trim().toLowerCase();
      const theirs = [...skills.values()].filter((s) => hasSkill(agent, s));
      const skill = theirs.find((s) => s.name === key && s.owner === agent.name) || theirs.find((s) => s.name === key);
      if (!skill) throw new SkillError(`You have no skill called ${name}.${theirs.length ? ` Yours: ${theirs.map((s) => s.name).join(', ')}.` : ''}`);
      skill.uses += 1;
      skill.lastUsed = now();
      await saveAgents();
      return skillText(skill);
    }),
  });
  const saveSkill = defineTool({
    name: 'save_skill',
    description: 'Save a skill: how to do something you\'ll do again, as a lesson for next time. The body has When to use, Steps, Pitfalls and How to check, in Markdown. Saving one with the name of one of yours changes it.',
    parameters: Type.Object({
      name: Type.String({ description: 'Lowercase words joined by dashes, like run-gateway-tests' }),
      description: Type.String({ description: 'What it does and when to use it, in a sentence or two' }),
      body: Type.String({ description: 'Markdown: When to use, Steps, Pitfalls, How to check' }),
    }),
    execute: skillCall(async (agent, args) => {
      const skill = checkSkill(args);
      const changes = [...skills.values()].some((s) => s.owner === agent.name && s.name === skill.name);
      if (agent.askFirst.some((r) => r.id === SKILLS_RULE.id && r.on)) {
        await write(agent, 'munin.approval', { rule: SKILLS_RULE.id, label: SKILLS_RULE.label, what: changes ? 'change a skill' : SKILLS_RULE.what, third: SKILLS_RULE.third, target: skill.name, skill });
        return `Asked ${them()} to look at the skill ${skill.name}. When they allow it, munin saves it and tells you; carry on meanwhile.`;
      }
      const saved = await storeSkill(agent, skill);
      return `Saved the skill ${saved.name}.`;
    }),
  });
  // A skill the agent saved, or that you allowed: its own one of that name changes, or a new one.
  async function storeSkill(agent, skill) {
    const old = [...skills.values()].find((s) => s.owner === agent.name && s.name === skill.name);
    const saved = old
      ? Object.assign(old, { description: skill.description, body: skill.body, updatedAt: now() })
      : { id: `s${randomUUID().slice(0, 8)}`, owner: agent.name, ...skill, sharedWith: [], uses: 0, lastUsed: null, createdAt: now(), updatedAt: now() };
    skills.set(saved.id, saved);
    await saveAgents();
    await write(agent, 'munin.action', { verb: old ? 'changed skill' : 'saved skill', object: saved.name });
    return saved;
  }
  const skillFrom = (text) => {
    try {
      return checkSkill(parseSkill(text));
    } catch (err) {
      if (err instanceof SkillError) throw invalid(err.message);
      throw err;
    }
  };
  const skillOut = (skill, agent) => ({
    id: skill.id, name: skill.name, description: skill.description, body: skill.body, text: skillText(skill),
    owner: skill.owner, mine: skill.owner === agent.name, sharedWith: [...skill.sharedWith],
    uses: skill.uses, lastUsed: skill.lastUsed ? new Date(skill.lastUsed).toISOString() : null,
    stale: now() - (skill.lastUsed || skill.createdAt) > STALE_MS,
    createdAt: new Date(skill.createdAt).toISOString(), updatedAt: new Date(skill.updatedAt).toISOString(),
  });

  // Routines the agent sets up for itself, when you ask it to: the same as on its profile, and
  // each change an action line in its conversation. ROUTINES_RULE can make them ask first.
  const routineSchema = {
    name: Type.Optional(Type.String({ description: 'What to call it, like Morning brief' })),
    when: Type.Optional(Type.String({ description: "When it runs, like 'Weekdays 07:30', 'Every 30 minutes, 08–18', or for the tracker 'When an issue moves to In review'" })),
    does: Type.Optional(Type.String({ description: 'What to do each time, as you would say it to yourself' })),
    trigger: Type.Optional(Type.Union([Type.Literal('schedule'), Type.Literal('tracker'), Type.Literal('mail'), Type.Literal('calendar')], { description: 'schedule (the default), tracker, mail or calendar' })),
  };
  const routineLine = (r) => `${r.id} · ${r.name} · ${r.when}${r.next ? ` · next ${new Date(r.next).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}${r.note ? ` · ${r.note}` : ''}\n  does: ${r.does}`;
  const findRoutine = (agent, which) => {
    const key = String(which || '').trim().toLowerCase();
    return agent.routines.find((r) => r.id === which || r.name.toLowerCase() === key);
  };
  const routineCall = (run) => async (args, toolApi) => {
    const agent = agentFor(toolApi.conversationId);
    try {
      return say(await run(agent, args));
    } catch (err) {
      if (err instanceof RuntimeError) return say(err.message, true);
      throw err;
    }
  };
  const routineTools = [
    defineTool({
      name: 'list_routines',
      description: 'Your routines: work you do on your own, on a schedule or when something happens in the tracker.',
      parameters: Type.Object({}),
      execute: routineCall(async (agent) => (agent.routines.length ? agent.routines.map((r) => routineLine(routineOut(r, agent))).join('\n') : 'No routines yet.')),
    }),
    defineTool({
      name: 'add_routine',
      description: 'Set up a routine for yourself when you are asked to: a name, when it runs, and what to do each time.',
      parameters: Type.Object({ ...routineSchema, name: Type.String(), when: Type.String(), does: Type.String() }),
      execute: routineCall(async (agent, args) => {
        const made = await api.addRoutine(agent.name, { trigger: 'schedule', ...args });
        await write(agent, 'munin.action', { verb: 'added routine', object: `${made.name}: ${made.when}` });
        return `Added: ${routineLine(made)}`;
      }),
    }),
    defineTool({
      name: 'change_routine',
      description: 'Change one of your routines, by its name or id: only what you give changes.',
      parameters: Type.Object({ routine: Type.String({ description: 'Its name or id' }), ...routineSchema }),
      execute: routineCall(async (agent, { routine, ...fields }) => {
        const found = findRoutine(agent, routine);
        if (!found) throw new RuntimeError(404, `You have no routine called ${routine}. list_routines shows them.`);
        const changed = await api.updateRoutine(agent.name, found.id, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)));
        await write(agent, 'munin.action', { verb: 'changed routine', object: `${changed.name}: ${changed.when}` });
        return `Changed: ${routineLine(changed)}`;
      }),
    }),
    defineTool({
      name: 'remove_routine',
      description: 'Stop one of your routines, by its name or id.',
      parameters: Type.Object({ routine: Type.String({ description: 'Its name or id' }) }),
      execute: routineCall(async (agent, { routine }) => {
        const found = findRoutine(agent, routine);
        if (!found) throw new RuntimeError(404, `You have no routine called ${routine}. list_routines shows them.`);
        await api.deleteRoutine(agent.name, found.id);
        await write(agent, 'munin.action', { verb: 'removed routine', object: found.name });
        return `Removed ${found.name}.`;
      }),
    }),
  ];

  const Munin = defineExtension({
    name: 'munin',
    tools: [askHuman, remember, changeNoteTool, forgetNoteTool, readSkill, saveSkill, setExpression, proposeSoul, speakInMeeting, ...routineTools],
    sections: [
      // Who the agent is, who it's talking with and how it talks, then what it can do, who else
      // is on the team and what it knows about you (prompt.js). The brief and the examples are
      // part of the first section, so they come before munin's own notes.
      section('munin', (input) => {
        const agent = agentFor(input.conversationId);
        return agent ? identity(agent, named()) : undefined;
      }, { tag: false }),
      // What the agent can do right now (prompt.js), so it can say so when it's asked.
      section('capabilities', (input) => {
        const agent = agentFor(input.conversationId);
        if (!agent) return undefined;
        return capabilities(agent, named(), {
          search: models.resolve(agent.provider, agent.model).provider === 'openrouter',
          apps: apps.capabilitiesFor(agent),
          tracker: agent.abilities.tracker ? { reachable: tracker.reachable() && Boolean(agent.tracker?.token), projects: agent.tracker?.projects || [] } : null,
          repos: Object.keys(repos),
          routines: agent.routines.length,
          watches: { mail: Boolean(googleFor(agent, 'mail')), calendar: Boolean(googleFor(agent, 'calendar')) },
          devices: push.status().devices,
        });
      }, { tag: false }),
      // Its skills (skills.js): each by name and description, and how to save one.
      section('skills', (input) => {
        const agent = agentFor(input.conversationId);
        return agent ? skillsSection(agent, [...skills.values()], agent.askFirst.some((r) => r.id === SKILLS_RULE.id && r.on)) : undefined;
      }, { tag: false }),
      // Who else is on the team (prompt.js), so the agent can say whose job something is.
      section('team', (input) => {
        const agent = agentFor(input.conversationId);
        return agent ? team([...agents.values()].filter((a) => a !== agent), agent.memory) : undefined;
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
        // Which meeting's turn this request answers, if any: the turn's text is the last thing
        // munin said to it, so a turn queued behind other work isn't mistaken for that work.
        if (agent) {
          const said = request.messages.findLast((m) => m.role === 'user');
          const turn = meetingOfTurn(typeof said?.content === 'string' ? said.content : (said?.content || []).map((c) => c.text || '').join(''));
          const asked = turn && meetings.get(turn.id)?.asked;
          if (asked?.agent === agent.name && asked.turn === turn.turn) meetingNow.set(api.conversationId, turn.id);
          else meetingNow.delete(api.conversationId);
        }
        // In a long conversation, who the agent is gets repeated at the end, for this request
        // only: a persona drifts as attention leaves the system prompt (prompt.js, reminder).
        if (!agent || request.messages.filter((m) => m.role !== 'system').length < REMIND_AFTER) return undefined;
        return { messages: [...request.messages, { role: 'system', content: reminder(agent), timestamp: now() }] };
      },
      afterResponse: async (message, api) => {
        const agent = agentFor(api.conversationId);
        if (!agent) return;
        const spent = await spentThisMonth(agent);
        spent.total += costOf(message);
        if (agent.onIssue) await countFor(agent.onIssue, agent, message);
        if (agent.budget && spent.total >= agent.budget) await pauseForBudget(agent);
        // A meeting turn the agent ended without speak_in_meeting (it answered in plain words,
        // failed or was stopped): what it said is its speech, nothing is a pass. The meeting
        // moves on either way, and its words aren't pushed as a message to you.
        const answering = message.stopReason !== 'toolUse' ? meetingNow.get(api.conversationId) : null;
        if (answering) {
          meetingNow.delete(api.conversationId);
          const words = message.stopReason === 'stop' ? (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') : null;
          if (meetings.get(answering)?.asked?.agent === agent.name) await recordTurn(answering, agent.name, words);
          return;
        }
        // A finished answer (not a step towards one) reaches your devices. A journal entry goes
        // on the profile instead, and a heartbeat with nothing to say goes nowhere (rhythm.js).
        const text = message.stopReason === 'stop' ? (message.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim() : '';
        const turn = message.stopReason === 'stop' ? turns.get(agent.name) : null;
        if (turn) turns.delete(agent.name);
        if (turn === 'journal' && text) {
          agent.journal = [{ at: now(), text }, ...(agent.journal || [])].slice(0, 60);
          await saveAgents();
          return;
        }
        if (turn === 'heartbeat') {
          if (isQuiet(text)) return;
          agent.rhythm = { ...agent.rhythm, spoke: now() };
          await saveAgents();
        }
        if (text) push.notify(agent, 'message', { text }).catch(() => {});
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
    agent.onIssue = opened.issue?.id || agent.onIssue || null; // a review costs the issue too
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

  // Which issue an agent's model responses count towards: the one it took or opened, until it
  // moves it on (to review, done, back to the pile). Responses on no issue are only the agent's.
  async function onStatus(agent, issue, status) {
    const next = status === 'in_progress' ? issue.id : agent.onIssue === issue.id ? null : agent.onIssue;
    if (next === (agent.onIssue || null)) return;
    agent.onIssue = next;
    await saveAgents();
  }
  const issueCosts = {};
  let costWrites = Promise.resolve();
  function countFor(id, agent, message) {
    const cost = costOf(message);
    const entry = issueCosts[id] ||= { cost: 0, tokens: 0, agents: {} };
    entry.cost += cost;
    entry.tokens += message.usage?.totalTokens || 0;
    entry.agents[agent.name] = (entry.agents[agent.name] || 0) + cost;
    const saved = structuredClone(entry);
    costWrites = costWrites.then(() => harness.commit(async (tx) => {
      (await tx.doc(CostsDoc)).issues[id] = saved;
    }, ctx)).catch(() => {});
    return costWrites;
  }
  const rounded = (n) => Math.round(n * 10000) / 10000;

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
  const tracker = createTracker({ registry, agents: () => agents.values(), agentFor, write, user: who, onTake, onStatus, mcpUrl: settings.trackerMcp || null });
  // When apps change, or one starts or stops answering, every agent's conversation gets its tools.
  const reconfigure = async () => {
    if (!harness) return;
    for (const agent of agents.values()) await (await conversationOf(agent)).configure(change(agent), ctx).catch(() => {});
  };
  const google = await openGoogle({ file: settings.googleFile || null, now, ...googleTest });
  const googleTools = googleApps({ google, ...googleTest.apis });
  const apps = await openApps({
    file: settings.appsFile || null, registry, onChange: () => { reconfigure(); },
    builtins: googleTools, // Gmail and Google Calendar, once you sign in
  });
  // An agent's Gmail or Google Calendar for routines to watch (googlewatch.js), while it has
  // the app and it answers.
  const googleFor = (agent, kind) => {
    const id = kind === 'mail' ? 'gmail' : 'google-calendar';
    const ready = kind === 'mail' ? googleTools.watch.gmailReady() : googleTools.watch.calendarReady();
    return agent.abilities.apps && ready && apps.idsFor(agent).includes(id) ? googleTools.watch : null;
  };
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
  for (const agent of Object.values(saved?.agents || {})) {
    const brief = upgradeBrief(agent.brief);
    // An agent from before examples gets its role's, while its brief is still the role's soul.
    // Notes from before memory had kinds are about you.
    const memory = (agent.memory || []).map((n) => ({ ...n, kind: kindOf(n) }));
    // Agents from before heartbeats don't start speaking up on their own: you switch it on.
    // Its soul's history starts with the version from before munin kept one, and a role's newer
    // words are a version of their own, by munin.
    const loaded = {
      ...structuredClone(agent), brief, examples: agent.examples ?? examplesFor({ ...agent, brief }), memory,
      proactivity: agent.proactivity || 'off', rhythm: agent.rhythm || {}, journal: agent.journal || [],
    };
    loaded.soulHistory = agent.soulHistory || withVersion([], { brief: agent.brief, examples: agent.examples ?? loaded.examples }, null, now());
    loaded.soulHistory = withVersion(loaded.soulHistory, loaded, 'munin', now());
    agents.set(agent.name, loaded);
  }
  for (const agent of agents.values()) {
    syncAppRules(agent);
    if (!agent.askFirst.some((rule) => rule.id === ROUTINES_RULE.id)) agent.askFirst.push({ ...ROUTINES_RULE });
    if (!agent.askFirst.some((rule) => rule.id === SKILLS_RULE.id)) agent.askFirst.push({ ...SKILLS_RULE });
  }
  Object.assign(repos, structuredClone(saved?.repos || {}));
  Object.assign(prefs, structuredClone(saved?.prefs || {}));
  for (const skill of Object.values(saved?.skills || {})) skills.set(skill.id, structuredClone(skill));
  Object.assign(issueCosts, structuredClone((await harness.snapshot(CostsDoc, ctx))?.issues || {}));
  for (const meeting of Object.values((await harness.snapshot(MeetingsDoc, ctx))?.meetings || {})) {
    meetings.set(meeting.id, structuredClone(meeting));
    for (const [name, id] of Object.entries(meeting.sessions || {})) meetingSessions.set(id, name);
  }
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
      doc.skills = Object.fromEntries([...skills].map(([id, skill]) => [id, structuredClone(skill)]));
    }, ctx);
  }

  // Meetings in their own doc, so a long transcript isn't written again with every agent setting.
  async function saveMeetings() {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(MeetingsDoc);
      doc.meetings = Object.fromEntries([...meetings].map(([id, meeting]) => [id, structuredClone(meeting)]));
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

  // The agent's passing expression while it lasts: { pose, until }, or null.
  const expressionOf = (agent) => {
    const e = expressions.get(agent.name);
    return e && e.until > now() ? { pose: e.pose, until: new Date(e.until).toISOString() } : null;
  };

  async function summaryOf(agent) {
    const { items, busy } = await readItems(agent);
    const s = summarize(items, { busy, paused: agent.paused });
    return {
      name: agent.name, role: agent.role, roleName: roleName(agent.role), colour: agent.colour,
      state: s.state, waiting: s.waiting, preview: agent.paused ? (agent.pausedFor === 'budget' ? 'Paused at its budget' : 'Paused') : s.preview, lastAt: s.lastAt || new Date(agent.createdAt).toISOString(),
      typing: s.typing, provider: agent.provider, model: agent.model, expression: expressionOf(agent),
    };
  }

  async function fullOf(agent, read) {
    const { items, entries, busy } = read || await readItems(agent);
    const s = summarize(items, { busy, paused: agent.paused });
    return {
      ...await summaryOf(agent),
      brief: agent.brief, examples: agent.examples || '', thinking: agent.thinking, proactivity: agent.proactivity,
      journal: agent.journal.map((e) => ({ at: new Date(e.at).toISOString(), text: e.text })),
      soulHistory: (agent.soulHistory || []).map((v) => ({ ...v, at: new Date(v.at).toISOString() })),
      abilities: { ...agent.abilities }, apps: [...agent.apps],
      askFirst: agent.askFirst.map(({ match, tool, tools, ...rule }) => rule),
      routines: agent.routines.map((r) => routineOut(r, agent)),
      memory: agent.memory.map((n) => ({ ...n, kind: kindOf(n) })), memoryCount: agent.memory.length, memoryRoom: room(agent.memory),
      skills: [...skills.values()].filter((s) => hasSkill(agent, s)).toSorted((a, b) => a.name.localeCompare(b.name)).map((s) => skillOut(s, agent)),
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
  // What munin tells the agent about your decision on an approval. The card shows the decision,
  // so this goes in as an entry of munin's own kind and doesn't show as a message from you.
  const decided = (agent, content, approval) => input(agent, content, { kind: 'munin.decided', data: { approval, at: now() } });

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

    // What each issue cost, in model responses while agents worked on it. `ids` narrows it down.
    issueCosts(ids = null) {
      const wanted = ids ? new Set(ids.map((id) => String(id).toUpperCase())) : null;
      return Object.fromEntries(Object.entries(issueCosts)
        .filter(([id]) => !wanted || wanted.has(id))
        .map(([id, c]) => [id, { cost: rounded(c.cost), tokens: c.tokens, agents: Object.fromEntries(Object.entries(c.agents).map(([name, cost]) => [name, rounded(cost)])) }]));
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
      // A change to its soul is on its card too: allowing it applies it and keeps a version. It
      // always asks, so there's no always.
      if (approval.soul) {
        if (decision === 'deny') {
          await decided(agent, `${them({ start: true })} wants your brief and examples to stay as they are, so they do. If they say why, take that on.`, id);
          return;
        }
        agent.brief = approval.soul.brief;
        agent.examples = approval.soul.examples;
        agent.soulHistory = withVersion(agent.soulHistory || [], agent, agent.name, now(), approval.soul.why);
        await saveAgents();
        await write(agent, 'munin.action', { verb: 'changed who it is', object: approval.soul.why });
        await decided(agent, `${them({ start: true })} accepted the change: your brief and examples are the new ones from now on.`, id);
        return;
      }
      // A skill is on its card, so allowing it saves it, and the agent doesn't send it again.
      if (approval.skill) {
        if (decision === 'deny') {
          await decided(agent, `${them({ start: true })} doesn't want the skill ${approval.skill.name} saved, so it isn't. If they say why, take that on.`, id);
          return;
        }
        if (decision === 'always' && rule) rule.on = false;
        await storeSkill(agent, checkSkill(approval.skill));
        await decided(agent, `${them({ start: true })} allowed the skill ${approval.skill.name}, and munin saved it${decision === 'always' ? '. From now on your skills save without asking' : ''}.`, id);
        return;
      }
      if (decision === 'deny') {
        await decided(agent, `${them({ start: true })} doesn't want you to ${approval.what} (${approval.target}). Don't; find another way or ask.`, id);
        return;
      }
      if (decision === 'always' && rule) rule.on = false;
      else agent.allowances.push(approval.permission);
      await saveAgents();
      await decided(agent, `${them({ start: true })} allowed you to ${approval.what} (${approval.target})${decision === 'always' ? ', from now on without asking' : ', this once'}. Go ahead.`, id);
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

    // A brief left empty is the role's soul. Examples left out are the role's while the brief is
    // its soul, or else none yet (null), which the next start fills in once the brief has been
    // brought up to its role's soul (upgradeBrief); examples given empty stay empty.
    async createAgent({ name, role, colour = 'white', provider, model, brief, examples, tracker: link } = {}) {
      const clean = String(name || '').trim().toLowerCase();
      if (!NAME.test(clean)) throw invalid('A name is 2 to 24 letters, digits or dashes, starting with a letter.');
      if (agents.has(clean)) throw conflict(`There's already an agent called ${clean}.`);
      if (!ROLES[role]) throw invalid(`There's no role called ${role}.`);
      if (!COLOURS.includes(colour)) throw invalid(`There's no colour called ${colour}.`);
      const abilities = { ...ROLES[role].abilities };
      const agent = {
        name: clean, role, colour, provider: provider || 'standin', model: model || 'stand-in', thinking: 'low',
        brief: String(brief || '').trim() || SOULS[role].brief(), examples: null, proactivity: proactivityFor(role), rhythm: {}, journal: [], abilities, apps: [], askFirst: [...askFirstFor(abilities), { ...ROUTINES_RULE }, { ...SKILLS_RULE }], allowances: [],
        routines: [], memory: [], budget: null, paused: false, createdAt: Date.now(), folder: join(settings.agentsDir, clean), conversationId: null,
        tracker: link ? trackerLink(link, null) : null,
      };
      agent.examples = examples === undefined ? examplesFor(agent) || null : String(examples || '').trim();
      agent.soulHistory = withVersion([], agent, 'you', now());
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
      if ('proactivity' in patch && !PROACTIVITY.includes(patch.proactivity)) throw invalid(`Speaking up is one of ${PROACTIVITY.join(', ')}.`);
      if ('role' in patch && !ROLES[patch.role]) throw invalid(`There's no role called ${patch.role}.`);
      for (const key of ['role', 'colour', 'provider', 'model', 'thinking', 'budget', 'proactivity']) if (key in patch) agent[key] = patch[key];
      if ('brief' in patch) agent.brief = String(patch.brief || '').trim() || agent.brief;
      if ('examples' in patch) agent.examples = String(patch.examples || '').trim();
      if ('brief' in patch || 'examples' in patch) agent.soulHistory = withVersion(agent.soulHistory || [], agent, 'you', now(), patch.why ? String(patch.why).slice(0, 300) : null);
      if (patch.abilities) {
        Object.assign(agent.abilities, patch.abilities);
        if (agent.abilities.code && !agent.askFirst.some((rule) => rule.id === 'push')) agent.askFirst = [...askFirstFor(agent.abilities), ...agent.askFirst];
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
      // Its skills go with it, it's no longer on anyone else's, and nobody keeps notes on it.
      for (const skill of [...skills.values()]) {
        if (skill.owner === name) skills.delete(skill.id);
        else skill.sharedWith = skill.sharedWith.filter((n) => n !== name);
      }
      for (const other of agents.values()) other.memory = other.memory.filter((n) => !(n.kind === 'team' && n.about === name));
      await saveAgents();
    },

    // Skills you write or change yourself, as a SKILL.md (`text`), and who an agent's own skill is
    // shared with: ['*'] for every agent, or their names.
    async addSkill(name, { text } = {}) {
      const agent = need(name);
      const skill = skillFrom(text);
      if ([...skills.values()].some((s) => s.owner === name && s.name === skill.name)) throw conflict(`${name} already has a skill called ${skill.name}.`);
      await storeSkill(agent, skill);
      return fullOf(agent);
    },

    async updateSkill(name, id, { text, sharedWith } = {}) {
      const agent = need(name);
      const skill = skills.get(id);
      if (!skill || skill.owner !== name) throw new RuntimeError(404, `${name} has no skill ${id}.`);
      if (text !== undefined) {
        const changed = skillFrom(text);
        if (changed.name !== skill.name && [...skills.values()].some((s) => s.owner === name && s.name === changed.name)) throw conflict(`${name} already has a skill called ${changed.name}.`);
        Object.assign(skill, changed, { updatedAt: now() });
      }
      if (sharedWith !== undefined) {
        if (!Array.isArray(sharedWith)) throw invalid('Share a skill with ["*"] for every agent, or with their names.');
        skill.sharedWith = sharedWith.includes('*') ? ['*'] : [...new Set(sharedWith.filter((n) => n !== name && agents.has(n)))];
      }
      await saveAgents();
      return fullOf(agent);
    },

    async deleteSkill(name, id) {
      const agent = need(name);
      const skill = skills.get(id);
      if (!skill || skill.owner !== name) throw new RuntimeError(404, `${name} has no skill ${id}.`);
      skills.delete(id);
      await saveAgents();
      return fullOf(agent);
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
    tick: async () => {
      await scheduler.tick();
      await rhythm();
    },

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

    // A note changed by you: its text, its kind, or both. It has to fit, like the agent's own.
    async changeNote(name, noteId, { text, kind } = {}) {
      const agent = need(name);
      try {
        agent.memory = changeNote(agent.memory, noteId, { text, kind }).notes;
      } catch (err) {
        if (err instanceof MemoryError) throw (/There's no note/.test(err.message) ? new RuntimeError(404, err.message) : invalid(err.message));
        throw err;
      }
      await saveAgents();
      return fullOf(agent);
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

    // Push notifications (push.js): the key a device subscribes with, and its devices.
    push: () => push.status(),

    async subscribePush(subscription) {
      try {
        await push.subscribe(subscription);
        return push.status();
      } catch (err) {
        if (err instanceof PushError) throw invalid(err.message);
        throw err;
      }
    },

    async forgetPush(endpoint) {
      await push.forget(endpoint);
      return push.status();
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

    // Meetings (meetings.js): figbots talking in turns, with you able to join.
    async meetings() {
      const agentFor = (name) => {
        const agent = agents.get(name);
        return agent ? { name: agent.name, colour: agent.colour, role: agent.role, roleName: roleName(agent.role) } : { name, gone: true };
      };
      return [...meetings.values()].sort((a, b) => b.createdAt - a.createdAt).map((m) => meetingSummary(m, agentFor));
    },

    async meeting(id) {
      return meetingOut(needMeeting(id), meetingAgentFor);
    },

    async createMeeting(fields = {}) {
      const parsed = parseMeeting(fields);
      for (const name of parsed.participants) if (name && !agents.has(name)) throw invalid(`There's no agent called ${name}.`);
      if (!parsed.participants.some((p) => p)) throw invalid('Invite at least one agent, or join yourself.');
      const meeting = {
        id: randomUUID().slice(0, 8), title: parsed.title, participants: parsed.participants,
        status: 'open', speeches: [], createdAt: now(), turns: 0,
      };
      if (parsed.first) speech(meeting, { from: null, text: parsed.first, at: now() });
      meetings.set(meeting.id, meeting);
      await saveMeetings();
      changed();
      await driveMeeting(meeting.id);
      return meetingOut(meeting, meetingAgentFor);
    },

    // You speak in a meeting. It also reopens a meeting that was waiting on you.
    async speakInMeetingAsHuman(id, text) {
      const meeting = needMeeting(id);
      const said = speechOf(text);
      if (!said) throw invalid('Say something, or close the meeting.');
      if (meeting.status !== 'open') throw conflict('That meeting is closed.');
      meeting.turns = 0;
      meeting.lastPasses = 0; // your word breaks a silence, as it breaks a run of turns
      // A turn asked long ago whose answer never came (its input was lost) doesn't hold you up.
      if (meeting.asked && now() - meeting.asked.at > STALE_TURN) meeting.asked = null;
      speech(meeting, { from: null, text: said, at: now() });
      await saveMeetings();
      changed();
      await driveMeeting(meeting.id);
      return meetingOut(meeting, meetingAgentFor);
    },

    async closeMeeting(id) {
      const meeting = needMeeting(id);
      if (meeting.status !== 'open') throw conflict('That meeting is already closed.');
      meeting.status = 'closed';
      meeting.asked = null; // a turn still being answered finishes, and says nothing
      await saveMeetings();
      changed();
      return meetingOut(meeting, meetingAgentFor);
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

  // Meetings ----------------------------------------------------------------------------

  const needMeeting = (id) => {
    const meeting = meetings.get(id);
    if (!meeting) throw new MeetingError(404, `There's no meeting with the id ${id}.`);
    return meeting;
  };
  const meetingAgentFor = (name) => {
    const agent = agents.get(name);
    return agent ? { name: agent.name, colour: agent.colour, role: agent.role, roleName: roleName(agent.role) } : { name, gone: true };
  };

  const STALE_TURN = 10 * 60 * 1000;

  // One agent's turn is done: its speech (or a pass, for no words, blank ones or NO_REPLY) joins
  // the transcript, then the next turn is asked. Says whether it spoke.
  async function recordTurn(meetingId, agentName, text) {
    const meeting = needMeeting(meetingId);
    if (meeting.status !== 'open') return false;
    if (meeting.asked?.agent === agentName) meeting.asked = null;
    const said = speechOf(text);
    const pass = !said || meetingQuiet(said);
    meeting.turns = (meeting.turns || 0) + 1;
    speech(meeting, { from: agentName, text: pass ? null : said, at: now(), pass });
    meeting.lastPasses = pass ? (meeting.lastPasses || 0) + 1 : 0;
    await saveMeetings();
    changed();
    await driveMeeting(meeting.id);
    return !pass;
  }

  // Ask the next participant to speak, unless the meeting should wait. One turn at a time per
  // meeting (`asked`, kept with it, so a restart doesn't lose it), and a paused agent's turn is
  // skipped to the next. An agent in two meetings answers each in turn.
  async function driveMeeting(meetingId) {
    const meeting = needMeeting(meetingId);
    if (meeting.status !== 'open' || closed) return;
    if (meeting.asked && agents.has(meeting.asked.agent)) return; // its answer drives the next turn
    meeting.asked = null; // asked an agent that's gone since
    const names = meeting.participants.filter(Boolean);
    const sinceHuman = meeting.turns || 0;
    const passed = meeting.lastPasses || 0;
    const wait = waitingOn(meeting, { agentsCount: names.length, sinceHuman, passed });
    if (wait) return;
    const next = nextSpeaker(meeting, agents);
    if (!next) return;
    const agent = agents.get(next);
    if (!agent) return;
    if (agent.paused) {
      // Skip a paused agent: record a pass so the round-robin moves on and the guards still hold.
      meeting.lastPasses = (meeting.lastPasses || 0) + 1;
      speech(meeting, { from: next, text: null, at: now(), pass: true });
      await saveMeetings();
      return driveMeeting(meetingId);
    }
    meeting.asked = { agent: next, at: now(), turn: meeting.speeches.length };
    const text = turnText(meeting, next, them(), meeting.seen?.[next] || 0);
    meeting.seen = { ...meeting.seen, [next]: meeting.speeches.length };
    const session = await sessionFor(meeting, agent);
    await saveMeetings();
    await session.submit({ type: 'input', content: text, whenBusy: 'followUp', entry: { kind: 'munin.meeting', data: { meeting: meeting.id, title: meeting.title, at: now() } } }, ctx);
  }

  // A meeting session talks, nothing else: the agent's model and who it is (munin's own
  // extension), without its code, tracker, apps or the web.
  const meetingChange = (agent) => ({ ...change(agent), extensions: [Munin], cwd: null });

  // The agent's session for a meeting, made the first time it's asked to speak there; its own
  // conversation gets one line saying it went, not a line per turn.
  async function sessionFor(meeting, agent) {
    const id = meeting.sessions?.[agent.name];
    if (id) {
      const session = await harness.conversation(id, ctx);
      await session.configure(meetingChange(agent), ctx).catch(() => {}); // its model may have changed since
      return session;
    }
    const session = await harness.createConversation({ ownership: { kind: 'ownerless' }, agent: meetingChange(agent) }, ctx);
    meeting.sessions = { ...meeting.sessions, [agent.name]: session.id };
    meetingSessions.set(session.id, agent.name);
    await write(agent, 'munin.action', { verb: 'went to a meeting', object: meeting.title });
    return session;
  }

  // An agent answers its turn with speak_in_meeting, or by ending the turn without it (the
  // afterResponse hook): either way recordTurn drives the next one. The tool call itself isn't a
  // run step (items.js keeps it quiet).

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
    next: iso(r.next), last: iso(r.last), note: routineNote(r, agent, { mail: Boolean(googleFor(agent, 'mail')), calendar: Boolean(googleFor(agent, 'calendar')) }),
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
    google: googleFor,
    save: saveAgents,
    now,
  });
  // Heartbeats and journals (rhythm.js), for agents that aren't doing anything: munin's own input,
  // of its own kind so the conversation shows it as itself rather than as a message from you.
  async function rhythm() {
    const t = now();
    for (const agent of agents.values()) {
      if (agent.paused || turns.has(agent.name)) continue;
      const { items, busy } = await readItems(agent);
      if (busy) continue;
      const said = items.filter((i) => i.kind === 'message');
      const lastAt = items.length ? Date.parse(items.at(-1).at) : null;
      const lastHumanAt = Date.parse(said.findLast((i) => i.from === 'human')?.at) || null;
      const workedToday = said.some((i) => dayOf(Date.parse(i.at)) === dayOf(t));
      let turn = null;
      if (journalDue(agent, { now: t, workedToday, lastAt })) {
        turn = ['journal', journalText(them()), { kind: 'munin.journal', data: { at: t } }];
        agent.rhythm = { ...agent.rhythm, journal: dayOf(t) };
      } else if (heartbeatDue(agent, { now: t, lastAt, lastHumanAt })) {
        turn = ['heartbeat', heartbeatText(agent, them(), t), { kind: 'munin.heartbeat', data: { at: t, proactivity: agent.proactivity } }];
        agent.rhythm = { ...agent.rhythm, heartbeat: t };
      }
      if (!turn) continue;
      turns.set(agent.name, turn[0]);
      await saveAgents();
      await (await conversationOf(agent)).submit({ type: 'input', content: turn[1], whenBusy: 'followUp', entry: turn[2] }, ctx);
    }
  }

  let closed = false;
  let timer = null;
  const loop = async () => {
    try {
      await scheduler.tick();
    } catch (err) {
      console.error('routines:', err);
    }
    try {
      await rhythm();
    } catch (err) {
      console.error('heartbeats:', err);
    }
    if (!closed) {
      timer = setTimeout(loop, scheduler.wait());
      timer.unref?.();
    }
  };
  if (timers) loop();

  return api;
}
