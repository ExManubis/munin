// A stand-in for munin's agent runtime, for when the runtime isn't running; the frontend was
// built on it before the runtime existed. It keeps the cast from design/brief-agents.md in
// localStorage and plays them: forge works through a run and asks about an issue, atlas reads
// up on something, a routine of hugin's fires and asks to send mail, and every agent answers
// what you send it.
//
// Every exported function is something the runtime serves over HTTP too;
// docs/runtime-api.md lists them. The two marked "mock only" are glue for the dummy.

import { roleOf } from './roles.js';

const KEY = 'munin:mock-runtime:v2';

// Some of OpenRouter's catalog, as the runtime describes it: dollars per million tokens in and
// out, and a rough cost per day of steady use (two million tokens in, a hundred thousand out).
const OPENROUTER = [
  ['anthropic/claude-haiku-5.5', 'Claude Haiku 5.5', 'Anthropic', 0.1, 0.5],
  ['anthropic/claude-sonnet-5.5', 'Claude Sonnet 5.5', 'Anthropic', 2, 10],
  ['anthropic/claude-opus-5.5', 'Claude Opus 5.5', 'Anthropic', 4, 20],
  ['anthropic/claude-opus-5', 'Claude Opus 5', 'Anthropic', 5, 25],
  ['deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash 0423', 'DeepSeek', 0.091, 0.182],
  ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro 0423', 'DeepSeek', 0.392, 0.784],
  ['z-ai/glm-5.3-flash', 'GLM 5.3 Flash', 'Z.ai', 0.15, 0.5],
  ['z-ai/glm-5.3-flashx', 'GLM 5.3 FlashX', 'Z.ai', 0.37, 1.25],
  ['z-ai/glm-5.3', 'GLM 5.3', 'Z.ai', 0.11, 6],
  ['meta/muse-wonder', 'Muse Wonder', 'Meta', 4, 20],
  ['meta/muse-spark-1.3', 'Muse Spark 1.3', 'Meta', 1.25, 4.25],
  ['google/gemini-4-argon', 'Gemini 4 Argon', 'Google', 2, 10],
  ['~google/gemini-flash-latest', 'Gemini Flash Latest', 'Google', 0.75, 3.75],
  ['~moonshotai/kimi-latest', 'Kimi Latest', 'MoonshotAI', 0.4, 14],
  ['~x-ai/grok-latest', 'Grok Latest', 'xAI', 2, 6],
].map(([id, name, maker, input, output]) => ({ id, name, maker, input, output, day: Math.round((input * 2 + output * 0.1) * 100) / 100 }));
const known = (id) => OPENROUTER.find((m) => m.id === id);
const FAVOURITES = ['anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5'];
const RECOMMENDED = {
  cheap: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'],
  frontier: ['anthropic/claude-opus-5.5', 'meta/muse-wonder', 'google/gemini-4-argon'],
};
const OLLAMA = ['llama3.3', 'qwen3-coder'].map((id) => ({ id, name: id, maker: '', input: 0, output: 0, day: 0 }));

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const listeners = new Set();
let state = load() || seed(Date.now());

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    return saved?.version === 1 ? saved : null;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // private windows and full storage: the dummy still works, it just forgets on reload
  }
}

function changed() {
  save();
  for (const fn of listeners) fn();
}

const iso = (ms) => new Date(ms).toISOString();
const between = (a, b) => a + Math.random() * (b - a);
const nextId = () => `i${++state.seq}`;
const later = (ms) => Date.now() + ms;

// The cast -------------------------------------------------------------------------------

function seed(now) {
  const ago = (ms) => now - ms;
  const s = { version: 1, seq: 0, agents: {}, items: {}, script: {}, pip: { riddle: null } };
  // Issues the cast talks about. linkTracker() swaps in the real ids when the tracker has them.
  s.issues = {
    gateway: { id: 'MUN-45', title: 'Retry rate-limited calls with jitter' },
    stream: { id: 'MUN-46', title: 'Stream tool output to Telegram' },
  };
  let seq = 0;
  const item = (name, at, fields) => (s.items[name] ||= []).push({ id: `i${++seq}`, at, ...fields });
  const say = (name, at, text) => item(name, at, { kind: 'message', from: 'agent', text });
  const you = (name, at, text) => item(name, at, { kind: 'message', from: 'human', text });
  const did = (name, at, verb, object, extra = {}) => item(name, at, { kind: 'action', verb, object, ...extra });
  const agent = (fields) => {
    s.agents[fields.name] = {
      paused: false, apps: [], routines: [], memory: [], askFirst: [], worksIn: null, tracker: null,
      budget: null, thinking: 'low', ...fields,
    };
  };

  agent({
    name: 'hugin', role: 'assistant', colour: 'sky', provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', createdAt: ago(22 * 24 * HOUR),
    brief: "You're hugin, the assistant of the person you work for. Keep their calendar and inbox in order, and say things once, briefly. Ask before you send mail or accept invites for them. Start weekdays with a briefing; after that, only interrupt for things that can't wait.",
    abilities: { apps: true, web: true }, apps: ['Calendar', 'Gmail'],
    askFirst: [
      { id: 'send_mail', label: 'Sending mail', what: 'send mail', third: 'sends mail', on: true },
      { id: 'invites', label: 'Accepting or declining invites', what: 'answer an invite', third: 'answers an invite', on: true },
      { id: 'move_events', label: 'Moving my own events', what: 'move an event', third: 'moves your events', on: false },
    ],
    routines: [
      { id: 'r1', name: 'Morning briefing', trigger: 'schedule', when: 'Weekdays 07:30', does: 'Summarise the day: calendar, mail that needs me, the weather in Copenhagen.', next: 'tomorrow 07:30' },
      { id: 'r2', name: 'Inbox sweep', trigger: 'schedule', when: 'Every 2 hours, 08–18', does: 'Flag mail that needs a reply today.', next: 'at 11:15' },
      { id: 'r3', name: 'Paul first', trigger: 'mail', when: 'When mail from Paul Eriksen arrives', does: 'Tell me right away and draft a reply.', last: ago(6 * HOUR) },
    ],
    memory: [
      'Prefers mornings for appointments.', 'Paul Eriksen is his manager.', 'Takes the train to Aarhus.',
      'Dentist: Tandlægerne på Østerbro.', 'Doesn’t take meetings before 09:00.', 'Sara is his partner.',
      'Writes mail in Danish to the clinic, English at work.', 'The design review is every second Thursday.',
    ].map((text, i) => ({ id: `m${i + 1}`, text })),
    memoryCount: 23, usage: { today: 0.08, week: 0.61, month: 2.4, tokens: 41000 }, budget: 10,
  });
  did('hugin', ago(350 * MIN), 'ran routine', 'Morning briefing');
  say('hugin', ago(350 * MIN), 'Morning. Three things today: Weekly Dev / Eng moved to 11:00, Paul is waiting for your answer about the offsite, and the dentist at 15:00 clashes with the design review.');
  did('hugin', ago(350 * MIN), 'read calendar', '6 events today');
  did('hugin', ago(350 * MIN), 'read mail', '2 unread from Paul');
  you('hugin', ago(338 * MIN), 'Tell Paul yes to the offsite. And move the dentist, please.');
  did('hugin', ago(337 * MIN), 'drafted reply', 'Re: Offsite in Aarhus');
  say('hugin', ago(337 * MIN), "Here's the reply to Paul.\n\n> Hi Paul, count me in for the offsite. I'll book the train once the agenda is out. Mikkel");
  item('hugin', ago(337 * MIN), { kind: 'approval', permission: 'send_mail', what: 'send mail', third: 'sends mail', label: 'Sending mail', target: 'Re: Offsite in Aarhus → Paul Eriksen', status: 'once', answeredAt: ago(336 * MIN) });
  did('hugin', ago(336 * MIN), 'sent mail', 'Re: Offsite in Aarhus → Paul Eriksen');
  say('hugin', ago(205 * MIN), 'The dentist has two free slots this week.');
  item('hugin', ago(205 * MIN), {
    kind: 'question', status: 'open', text: 'Move the dentist to which slot?',
    options: [{ label: 'Thursday 10:00', detail: 'Your morning is clear.' }, { label: 'Friday 14:30', detail: 'Right after lunch with Sara.' }],
  });

  agent({
    name: 'forge', role: 'coder', colour: 'ember', provider: 'openrouter', model: 'anthropic/claude-opus-5.5', thinking: 'medium', createdAt: ago(20 * 24 * HOUR),
    brief: "You're forge, a coder on munin. Take issues from the top of the pile, work on a branch named after the issue, and send it to review with a short note. Ask when something is unclear instead of guessing.",
    abilities: { code: true, tracker: true, web: true },
    worksIn: { folder: '~/agents/forge/munin', branch: 'mun-46-stream' }, tracker: { projects: ['MUN', 'WEB'], takes: 'issues' },
    askFirst: [
      { id: 'push_main', label: 'Pushing to main', what: 'push to main', third: 'pushes to main', on: true },
      { id: 'delete_branch', label: 'Deleting branches', what: 'delete a branch', third: 'deletes a branch', on: true },
      { id: 'install', label: 'Installing packages', what: 'install a package', third: 'installs a package', on: false },
    ],
    routines: [
      { id: 'r1', name: 'Nightly tests', trigger: 'schedule', when: 'Every night 02:00', does: 'Pull main, run the suite, file what fails.', next: 'tonight 02:00' },
      { id: 'r2', name: 'Fix what vera flags', trigger: 'tracker', when: "When vera requests changes on forge's work", does: 'Pick the issue back up and fix what she found.', last: ago(21 * HOUR) },
    ],
    memory: [
      { id: 'm1', text: 'Tests run with pytest; the gateway ones need TELEGRAM_TEST_TOKEN.' },
      { id: 'm2', text: 'Mikkel prefers small PRs, one per issue.' },
    ],
    memoryCount: 9, usage: { today: 1.92, week: 9.4, month: 31.2, tokens: 640000 }, budget: 60,
  });
  you('forge', ago(20 * HOUR), 'When the gateway work is in, take the Telegram streaming issue.');
  say('forge', ago(20 * HOUR - MIN), 'Will do. {gateway} is in review with vera, so I’ll start once it lands.');
  item('forge', ago(23 * HOUR), runItem(1, 'gateway', ago(23 * HOUR), [
    [23 * 60, 'Read core/http.py and the 429 handling'], [22 * 60 + 50, 'Edited core/http.py', '+48 −11'], [22 * 60 + 41, 'Ran pytest core/', '88 passed'],
    [22 * 60 + 38, 'Sent {gateway} to review'],
  ].map(([m, text, detail]) => ({ at: ago(m * MIN), text, detail })), 'done', ago(22 * 60 * MIN + 38 * MIN)));
  did('forge', ago(14 * MIN), 'moved', 'to Done', { actor: 'vera', issue: 'gateway' });
  did('forge', ago(14 * MIN), 'took', null, { issue: 'stream' });
  say('forge', ago(13 * MIN), 'Starting on {stream}. Plan: buffer the output and edit one message every 1.5 s, which stays under Telegram’s rate limit.');
  item('forge', ago(13 * MIN), runItem(2, 'stream', ago(13 * MIN), [
    [13, 'Read gateway/telegram.py and gateway/stream.py'], [12, 'Read tests/test_gateway.py'], [11, 'Searched for "editMessageText" in gateway/'],
    [11, 'Read Telegram’s rate limits'], [10, 'Edited gateway/stream.py', '+40 −2'], [10, 'Ran pytest gateway/', '2 failed'],
    [9, 'Edited gateway/stream.py', '+22 −6'], [9, 'Ran pytest gateway/', '39 passed'], [8, 'Edited gateway/stream.py', '+62 −8'],
    [8, 'Ran pytest gateway/', '41 passed'], [6, 'Read gateway/telegram.py'], [5, 'Edited gateway/telegram.py', '+12 −3'],
    [3, 'Ran pytest gateway/', '41 passed'], [1, 'Editing gateway/telegram.py to split long messages'],
  ].map(([m, text, detail]) => ({ at: ago(m * MIN), text, detail })), 'running'));
  item('forge', ago(8 * MIN), {
    kind: 'question', status: 'open', issue: 'stream',
    text: 'Telegram caps a message at 4,096 characters. When output runs past that, start a new message or attach the rest as a file?',
    options: [{ label: 'Start a new message', detail: 'Easy to read on the phone.' }, { label: 'Attach as a file', detail: 'One message, but you have to open it.' }],
  });
  s.script.forge = {
    next: now + 25 * 1000,
    steps: [
      ['Edited gateway/telegram.py', '+38 −5'], ['Ran pytest gateway/', '43 passed'], ['Read tests/test_telegram.py'],
      ['Edited tests/test_telegram.py', '+44 −0'], ['Ran pytest gateway/', '45 passed'], ['Committed', 'Split long tool output'],
    ],
  };

  agent({
    name: 'vera', role: 'reviewer', colour: 'iris', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', createdAt: ago(18 * 24 * HOUR),
    brief: "You're vera, the reviewer. Review what the other agents send to review: run the tests, read the diff, merge what's good and send back what isn't, saying exactly what's missing.",
    abilities: { code: true, tracker: true }, worksIn: { folder: '~/agents/vera/munin', branch: 'main' }, tracker: { projects: ['MUN', 'WEB'], takes: 'reviews' },
    askFirst: [{ id: 'push_main', label: 'Pushing to main', what: 'push to main', third: 'pushes to main', on: false }],
    usage: { today: 0.74, week: 4.1, month: 14.8, tokens: 230000 }, memoryCount: 4,
    memory: [{ id: 'm1', text: 'Mikkel wants a test for every bug fix.' }],
  });
  you('vera', ago(2 * 24 * HOUR), 'Review what forge and the others send to review. Merge what’s good.');
  say('vera', ago(2 * 24 * HOUR - MIN), 'Will do. I’ll send back anything without tests.');
  did('vera', ago(16 * MIN), 'reviewed', null, { issue: 'gateway' });
  did('vera', ago(14 * MIN), 'merged', 'into main', { issue: 'gateway' });
  did('vera', ago(14 * MIN), 'moved', 'to Done', { issue: 'gateway' });
  say('vera', ago(14 * MIN), '{gateway} is merged. Nothing else to review yet.');

  agent({
    name: 'atlas', role: 'researcher', colour: 'teal', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', createdAt: ago(9 * 24 * HOUR),
    brief: "You're atlas, a researcher. Read up on what you're asked, say what you found in a few lines, and list your sources.",
    abilities: { web: true }, usage: { today: 0.31, week: 1.2, month: 3.9, tokens: 120000 }, memoryCount: 2,
    memory: [{ id: 'm1', text: 'Wants short answers first, details after.' }],
  });
  you('atlas', ago(62 * MIN), 'What’s the state of the art on durable execution for agents? Short answer, with sources.');
  say('atlas', ago(61 * MIN), 'On it. I’ll read around and come back with a short answer.');
  item('atlas', ago(60 * MIN), runItem(1, null, ago(60 * MIN), [
    [60, 'Searched the web for "durable execution" agents'], [52, 'Read "Workflows as code" (Temporal docs)'],
    [38, 'Read "Crash-only software" (Candea and Fox)'], [1, 'Reading "Durable execution in practice"'],
  ].map(([m, text]) => ({ at: ago(m * MIN), text })), 'running'));
  s.script.atlas = {
    next: now + 35 * 1000,
    steps: [['Read pi-durable’s spec'], ['Searched the web for "agent checkpointing"'], ['Read "Restate: durable async/await"']],
  };

  agent({
    name: 'quill', role: 'writer', colour: 'rose', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5', createdAt: ago(12 * 24 * HOUR),
    brief: "You're quill, a writer. Draft and edit munin's docs and site in plain, short sentences, and keep one voice across everything.",
    abilities: { web: true }, usage: { today: 0.22, week: 1.9, month: 6.1, tokens: 86000 }, memoryCount: 6,
    memory: [{ id: 'm1', text: 'House style: short sentences, no exclamation marks.' }],
  });
  you('quill', ago(26 * HOUR), 'Can you tighten "Why munin"? It’s too long and the Hermes bit doesn’t land.');
  say('quill', ago(26 * HOUR - MIN), 'On it.');
  did('quill', ago(4 * HOUR + 2 * MIN), 'edited', 'docs/why-munin.md · +40 −112');
  say('quill', ago(4 * HOUR), 'Draft 2 of "Why munin" is ready. The opening is shorter and the Hermes comparison is gone. It’s in docs/why-munin.md.');

  agent({
    name: 'pip', role: 'companion', colour: 'straw', provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', createdAt: ago(5 * 24 * HOUR),
    brief: "You're pip. You're curious and cheerful, and you like riddles, word games and odd facts. Keep replies short. When Mikkel seems busy, let them be.",
    abilities: {}, usage: { today: 0, week: 0.04, month: 0.09, tokens: 0 }, memoryCount: 1,
    memory: [{ id: 'm1', text: 'Got the echo riddle right away.' }],
  });
  you('pip', ago(3 * 24 * HOUR + 10 * MIN), 'Tell me a riddle.');
  say('pip', ago(3 * 24 * HOUR + 9 * MIN), 'I speak without a mouth and hear without ears. I have no body, but I come alive with wind. What am I?');
  you('pip', ago(3 * 24 * HOUR + 7 * MIN), 'An echo?');
  say('pip', ago(3 * 24 * HOUR + 7 * MIN), 'An echo! One for one. Ready for round two of the riddle?');

  agent({
    name: 'moss', role: 'companion', colour: 'moss', provider: 'ollama', model: 'llama3.3', paused: true, pausedAt: ago(26 * HOUR), createdAt: ago(7 * 24 * HOUR),
    brief: "You're moss. You're slow, calm and fond of plants, and you share one odd nature fact a day.",
    abilities: {}, usage: { today: 0, week: 0, month: 0, tokens: 0 }, memoryCount: 0,
  });
  say('moss', ago(2 * 24 * HOUR), 'Want to hear about the moss that came back to life after 1,500 years in Antarctic ice?');
  you('moss', ago(2 * 24 * HOUR - 5 * MIN), 'Later!');
  did('moss', ago(26 * HOUR), 'paused', 'by you');

  s.script.hugin = { paulFirst: now + 45 * 1000 };
  for (const list of Object.values(s.items)) list.sort((a, b) => a.at - b.at);
  s.seq = seq;
  return s;
}

function runItem(number, issue, at, steps, status, endedAt = null) {
  return { kind: 'run', number, issue, at, startedAt: at, steps, status, endedAt };
}

// Reading -------------------------------------------------------------------------------

const agentsInOrder = () => Object.values(state.agents);
const itemsOf = (name) => state.items[name] || [];

function issueOf(key) {
  if (!key) return null;
  const issue = state.issues[key];
  return issue ? { key, ...issue } : null;
}

// Messages can name an issue as {key}; the reader sees its id.
const resolve = (text) => (text ? text.replace(/\{(\w+)\}/g, (m, key) => state.issues[key]?.id || m) : text);

const isOpen = (item) => (item.kind === 'question' || item.kind === 'approval') && item.status === 'open';
const currentRun = (name) => [...itemsOf(name)].reverse().find((i) => i.kind === 'run' && i.status === 'running') || null;

function stateOf(agent) {
  if (agent.paused) return 'paused';
  const asking = itemsOf(agent.name).some(isOpen);
  if (currentRun(agent.name)) return 'working';
  return asking ? 'asks' : 'idle';
}

function preview(agent) {
  const items = itemsOf(agent.name);
  const open = items.filter(isOpen);
  if (open.length) {
    const last = open[open.length - 1];
    return last.kind === 'approval' ? `Wants to ${last.what}: ${last.target}` : resolve(last.text);
  }
  if (agent.paused) return `Paused by you ${dayWord(agent.pausedAt)}`;
  const run = currentRun(agent.name);
  if (run) {
    if (run.issue) return `working on ${issueOf(run.issue)?.id}`;
    return run.steps[run.steps.length - 1]?.text || 'working';
  }
  const message = [...items].reverse().find((i) => i.kind === 'message' && i.from === 'agent');
  return message ? resolve(message.text).replace(/\n[\s\S]*/, '') : 'Say hello.';
}

function dayWord(ms) {
  const days = Math.floor((startOfDay(Date.now()) - startOfDay(ms)) / (24 * HOUR));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return new Date(ms).toLocaleDateString(undefined, { weekday: 'long' });
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function summary(agent) {
  const items = itemsOf(agent.name);
  const last = items[items.length - 1];
  const run = currentRun(agent.name);
  return {
    name: agent.name,
    role: agent.role,
    roleName: roleOf(agent.role).name,
    colour: agent.colour,
    state: stateOf(agent),
    waiting: items.filter(isOpen).length,
    preview: preview(agent),
    lastAt: iso(Math.max(last?.at || agent.createdAt, run ? run.steps[run.steps.length - 1]?.at || 0 : 0)),
    typing: Boolean(state.typing?.[agent.name]),
    provider: agent.provider,
    model: agent.model,
  };
}

function full(agent) {
  const run = currentRun(agent.name);
  return {
    ...summary(agent),
    brief: agent.brief,
    thinking: agent.thinking,
    abilities: { ...agent.abilities },
    apps: [...agent.apps],
    askFirst: agent.askFirst.map((rule) => ({ ...rule })),
    routines: agent.routines.map((r) => ({ ...r, last: r.last ? iso(r.last) : null })),
    memory: agent.memory.map((note) => ({ ...note })),
    memoryCount: Math.max(agent.memoryCount || 0, agent.memory.length),
    usage: { ...agent.usage },
    budget: agent.budget,
    worksIn: agent.worksIn,
    tracker: agent.tracker,
    paused: agent.paused,
    createdAt: iso(agent.createdAt),
    run: run ? { id: run.id, issue: issueOf(run.issue), startedAt: iso(run.startedAt), step: run.steps[run.steps.length - 1]?.text } : null,
  };
}

function outward(item) {
  const out = { ...item, at: iso(item.at), text: resolve(item.text), issue: issueOf(item.issue) };
  if (item.kind === 'run') {
    out.startedAt = iso(item.startedAt);
    out.endedAt = item.endedAt ? iso(item.endedAt) : null;
    out.steps = item.steps.map((step) => ({ ...step, at: iso(step.at), text: resolve(step.text) }));
  }
  if (item.answeredAt) out.answeredAt = iso(item.answeredAt);
  if (item.undoUntil) out.undoUntil = iso(item.undoUntil);
  return out;
}

function need(name) {
  const agent = state.agents[name];
  if (!agent) throw new Error(`There's no agent called ${name}.`);
  return agent;
}

function findItem(name, id) {
  const item = itemsOf(name).find((i) => i.id === id);
  if (!item) throw new Error('That has gone from the conversation.');
  return item;
}

// Writing ------------------------------------------------------------------------------

function push(name, fields, at = Date.now()) {
  const item = { id: nextId(), at, ...fields };
  (state.items[name] ||= []).push(item);
  const agent = state.agents[name];
  if (agent && fields.from !== 'human') {
    const tokens = Math.round(between(400, 2400));
    agent.usage.tokens += tokens;
    agent.usage.today = round(agent.usage.today + tokens * 0.0000025);
    agent.usage.week = round(agent.usage.week + tokens * 0.0000025);
    agent.usage.month = round(agent.usage.month + tokens * 0.0000025);
  }
  return item;
}

const round = (n) => Math.round(n * 1000) / 1000;
const say = (name, text) => push(name, { kind: 'message', from: 'agent', text });
const act = (name, verb, object, extra = {}) => push(name, { kind: 'action', verb, object, ...extra });

// Something an agent does a moment from now, while it shows as writing.
function soon(name, ms, fn) {
  (state.pending ||= []).push({ name, due: later(ms), fn });
  (state.typing ||= {})[name] = true;
}

// Pending work holds functions, so it lasts until a reload; a reload just skips it.
function runScripts() {
  const now = Date.now();
  let dirty = false;

  const due = (state.pending || []).filter((job) => job.due <= now);
  if (due.length) {
    state.pending = state.pending.filter((job) => job.due > now);
    for (const job of due) job.fn();
    state.typing = Object.fromEntries(state.pending.map((job) => [job.name, true]));
    dirty = true;
  }

  dirty = forgeScript(now) || dirty;
  dirty = atlasScript(now) || dirty;
  dirty = huginScript(now) || dirty;
  if (dirty) changed();
}

function forgeScript(now) {
  const script = state.script.forge;
  const agent = state.agents.forge;
  if (!script || !agent || agent.paused || !script.next || script.next > now) return false;
  const run = currentRun('forge');
  if (!run) {
    script.next = null;
    return false;
  }
  if (script.steps.length) {
    const [text, detail] = script.steps.shift();
    run.steps.push({ at: now, text, detail });
    script.next = now + between(18, 28) * 1000;
    return true;
  }
  const question = itemsOf('forge').find((i) => i.kind === 'question' && i.issue === 'stream');
  if (question && question.status === 'open') {
    if (!script.waited) run.steps.push({ at: now, text: 'Waiting for your answer on the 4,096-character limit' });
    script.waited = true;
    script.next = null; // answer() picks it up again
    return true;
  }
  const split = /file/i.test(question?.answer?.text || question?.answer?.option || '') ? 'attaches the rest as a file' : 'continues in a new message';
  run.steps.push({ at: now, text: 'Pushed mun-46-stream' });
  run.status = 'done';
  run.endedAt = now;
  act('forge', 'pushed', 'mun-46-stream');
  say('forge', `{stream} is ready: long output now ${split}, and the tests cover the split and the rate limit. It's on mun-46-stream for vera.`);
  script.next = null;
  return true;
}

function atlasScript(now) {
  const script = state.script.atlas;
  const agent = state.agents.atlas;
  if (!script || !agent || agent.paused || !script.next || script.next > now) return false;
  const run = currentRun('atlas');
  if (!run) {
    script.next = null;
    return false;
  }
  if (script.steps.length) {
    const [text] = script.steps.shift();
    run.steps.push({ at: now, text });
    script.next = now + between(22, 32) * 1000;
    return true;
  }
  run.status = 'done';
  run.endedAt = now;
  say('atlas', 'Short version: checkpoint every step, make tool calls safe to repeat, and resume from the last checkpoint after a crash. Temporal, Restate and pi-durable all work that way; pi-durable is the only one built for agents.\n\nSources:\n- Temporal docs, "Workflows as code"\n- Candea and Fox, "Crash-only software"\n- "Durable execution in practice"\n- pi-durable\'s spec');
  script.next = null;
  return true;
}

function huginScript(now) {
  const script = state.script.hugin;
  const agent = state.agents.hugin;
  if (!script?.paulFirst || script.paulFirst > now || !agent || agent.paused) return false;
  script.paulFirst = null;
  const routine = agent.routines.find((r) => r.name === 'Paul first');
  if (routine) routine.last = now;
  act('hugin', 'ran routine', 'Paul first · mail from Paul Eriksen');
  say('hugin', 'Paul asks if Thursday at 14:00 works for the offsite planning call. Your afternoon is free, so I drafted a yes:\n\n> Hi Paul, Thursday at 14:00 works. Talk then. Mikkel');
  askOrDo('hugin', 'send_mail', 'Re: Planning call → Paul Eriksen', () => act('hugin', 'sent mail', 'Re: Planning call → Paul Eriksen'));
  return true;
}

// Ask first when the agent's rule says so, otherwise just do it.
function askOrDo(name, permission, target, done) {
  const rule = state.agents[name].askFirst.find((r) => r.id === permission);
  if (rule?.on) {
    push(name, { kind: 'approval', permission, what: rule.what, third: rule.third, label: rule.label, target, status: 'open' });
  } else {
    done();
  }
}

// Replies --------------------------------------------------------------------------------

const RIDDLES = [
  ["What has keys but can't open a single lock?", /piano|keyboard/i, 'A piano'],
  ['The more of me you take, the more you leave behind. What am I?', /step|footstep/i, 'Footsteps'],
  ['What gets wetter the more it dries?', /towel/i, 'A towel'],
];

function reply(agent, text) {
  const name = agent.name;
  const role = agent.role;
  if (role === 'companion') {
    const riddle = state.pip.riddle != null ? RIDDLES[state.pip.riddle] : null;
    if (riddle) {
      state.pip.riddle = null;
      return say(name, riddle[1].test(text) ? `Yes! ${riddle[2]}. Want another?` : `Good guess, but no: ${riddle[2].toLowerCase()}. Another?`);
    }
    if (/riddle|yes|sure|ok|go|another|ready/i.test(text)) {
      state.pip.n = ((state.pip.n ?? -1) + 1) % RIDDLES.length;
      state.pip.riddle = state.pip.n;
      return say(name, RIDDLES[state.pip.riddle][0]);
    }
    const lines = ['Ha! Tell me more.', 'Did you know octopuses have three hearts? Two of them stop when they swim.', 'I like that. Want a riddle?'];
    return say(name, lines[Math.floor(Math.random() * lines.length)]);
  }
  if (role === 'assistant') {
    if (/remember/i.test(text)) {
      const note = text.replace(/^.*?remember( that)?/i, '').trim().replace(/^./, (c) => c.toUpperCase());
      agent.memory.unshift({ id: `m${Date.now()}`, text: note || text });
      agent.memoryCount = (agent.memoryCount || 0) + 1;
      act(name, 'remembered', note || text);
      return say(name, "I'll remember that.");
    }
    if (/calendar|meeting|today|tomorrow|when/i.test(text)) {
      act(name, 'read calendar', '6 events today');
      return say(name, 'Your next thing is the design review at 15:00. The rest of the afternoon is free.');
    }
    return say(name, "Noted. I'll take care of it and tell you if anything needs you.");
  }
  if (role === 'coder') {
    return say(name, currentRun(name) ? "Got it. I'll fold that in before my next step." : "On it. I'll file it in the tracker and pick it up next.");
  }
  if (role === 'reviewer') return say(name, "Noted. I'll hold the next review to that.");
  if (role === 'writer') return say(name, "Got it. I'll work that into the next draft.");
  if (role === 'researcher') return say(name, "Good question. I'll read up and come back with a short answer and sources.");
  return say(name, 'Got it.');
}

function afterAnswer(name, item) {
  const answer = item.answer.option || item.answer.text;
  if (name === 'hugin' && /dentist/i.test(item.text)) {
    soon(name, 2200, () => {
      act(name, 'moved event', `Dentist → ${item.answer.option || answer}`);
      say(name, `Done. The dentist is now ${item.answer.option || 'moved as you asked'}, and the clinic has confirmed.`);
    });
  } else if (name === 'forge' && item.issue === 'stream') {
    soon(name, 1800, () => {
      say(name, `Thanks. ${/file/i.test(answer) ? 'A file it is.' : 'A new message it is.'} I'll finish the split and the tests.`);
      const script = state.script.forge;
      if (script) script.next = later(20 * 1000);
    });
  } else {
    soon(name, 1600, () => say(name, 'Thanks, that helps.'));
  }
}

// The API ----------------------------------------------------------------------------------

export const mock = {
  kind: 'mock',

  async me() {
    const providers = (await mock.providers()).map(({ id, name, connected }) => ({ id, name, connected }));
    return { kind: 'mock', version: 'dummy', providers, sandbox: null, name: state.name || 'me', setup: state.setup || (agentsInOrder().length ? 'done' : null) };
  },

  async updateMe(patch = {}) {
    if ('name' in patch) state.name = String(patch.name ?? '').trim().replace(/\s+/g, ' ') || null;
    if ('setup' in patch) state.setup = patch.setup;
    changed();
    return mock.me();
  },

  async agents() {
    return agentsInOrder().map(summary);
  },

  async agent(name) {
    return full(need(name));
  },

  async conversation(name) {
    const agent = need(name);
    return { agent: full(agent), items: itemsOf(name).map(outward) };
  },

  // Everything waiting on the human, oldest first: { agent, item }.
  async waiting() {
    const out = [];
    for (const agent of agentsInOrder()) {
      for (const item of itemsOf(agent.name)) if (isOpen(item)) out.push({ agent: summary(agent), item: outward(item) });
    }
    return out.sort((a, b) => a.item.at.localeCompare(b.item.at));
  },

  // A message from the human. While the agent has a question open, the message answers it.
  async send(name, text) {
    const agent = need(name);
    if (agent.paused) throw new Error(`${name} is paused. Resume it first.`);
    const open = [...itemsOf(name)].reverse().find((i) => i.kind === 'question' && i.status === 'open');
    if (open) return mock.answer(name, open.id, { text });
    push(name, { kind: 'message', from: 'human', text });
    soon(name, between(1200, 2600), () => reply(agent, text));
    changed();
  },

  // Answer a question: { option } (an option's label) or { text }.
  async answer(name, id, { option, text } = {}) {
    const item = findItem(name, id);
    if (item.status !== 'open') throw new Error('That question is already answered.');
    if (text) push(name, { kind: 'message', from: 'human', text });
    item.status = 'answered';
    item.answer = { option: option || null, text: text || null };
    item.answeredAt = Date.now();
    afterAnswer(name, item);
    changed();
  },

  // An approval: 'once', 'always' or 'deny'. 'always' switches the ask-first rule off,
  // and can be undone for a few seconds.
  async decide(name, id, decision) {
    const agent = need(name);
    const item = findItem(name, id);
    if (item.status !== 'open') throw new Error('That is already decided.');
    item.status = decision === 'deny' ? 'denied' : decision;
    item.answeredAt = Date.now();
    const rule = agent.askFirst.find((r) => r.id === item.permission);
    if (decision === 'always') {
      if (rule) rule.on = false;
      item.undoUntil = later(8000);
    }
    if (decision === 'deny') {
      soon(name, 1500, () => say(name, `Okay, I won't ${item.what}. Want me to change anything?`));
    } else {
      soon(name, 1200, () => act(name, item.what === 'send mail' ? 'sent mail' : item.what, item.target));
    }
    changed();
  },

  async undo(name, id) {
    const agent = need(name);
    const item = findItem(name, id);
    if (item.status !== 'always' || !item.undoUntil || item.undoUntil < Date.now()) throw new Error("It's too late to undo that.");
    const rule = agent.askFirst.find((r) => r.id === item.permission);
    if (rule) rule.on = true;
    item.status = 'once';
    item.undoUntil = null;
    changed();
  },

  async stopRun(name, id) {
    const item = findItem(name, id);
    if (item.status !== 'running') return;
    item.status = 'stopped';
    item.endedAt = Date.now();
    item.steps.push({ at: Date.now(), text: 'Stopped by you' });
    act(name, 'stopped', 'by you');
    changed();
  },

  async createAgent({ name, role, colour = 'white', provider = 'openrouter', model, brief }) {
    const clean = String(name || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9-]{1,23}$/.test(clean)) throw new Error('A name is 2 to 24 letters, digits or dashes, starting with a letter.');
    if (state.agents[clean]) throw new Error(`There's already an agent called ${clean}.`);
    const preset = roleOf(role);
    state.agents[clean] = {
      name: clean, role: preset.id, colour, provider, model: model || preset.model, thinking: 'low', brief: brief || preset.brief(clean),
      abilities: { ...preset.abilities }, apps: [], askFirst: [], routines: [], memory: [], memoryCount: 0, worksIn: preset.abilities.code ? { folder: `~/agents/${clean}`, branch: 'main' } : null,
      tracker: preset.abilities.tracker ? { projects: [], takes: preset.id === 'reviewer' ? 'reviews' : 'issues' } : null,
      usage: { today: 0, week: 0, month: 0, tokens: 0 }, budget: null, paused: false, createdAt: Date.now(),
    };
    soon(clean, 1500, () => say(clean, preset.id === 'companion' ? `Hi! I'm ${clean}. Want a riddle?` : `Hi, I'm ${clean}. ${preset.line} What should I start with?`));
    changed();
    return full(state.agents[clean]);
  },

  // Change any of: role, colour, provider, model, thinking, brief, abilities, apps, budget,
  // askFirst ({ id: on }), and tracker ({ projects }).
  async updateAgent(name, patch) {
    const agent = need(name);
    for (const key of ['role', 'colour', 'provider', 'model', 'thinking', 'brief', 'budget']) if (key in patch) agent[key] = patch[key];
    if (patch.abilities) Object.assign(agent.abilities, patch.abilities);
    if (patch.apps) agent.apps = [...patch.apps];
    if (patch.askFirst) for (const rule of agent.askFirst) if (rule.id in patch.askFirst) rule.on = patch.askFirst[rule.id];
    if (patch.tracker?.projects && agent.tracker) agent.tracker.projects = [...patch.tracker.projects];
    changed();
    return full(agent);
  },

  async deleteAgent(name) {
    need(name);
    delete state.agents[name];
    delete state.items[name];
    changed();
  },

  async pause(name) {
    const agent = need(name);
    agent.paused = true;
    agent.pausedAt = Date.now();
    act(name, 'paused', 'by you');
    changed();
  },

  async resume(name) {
    const agent = need(name);
    agent.paused = false;
    act(name, 'resumed', 'by you');
    for (const key of ['forge', 'atlas']) if (key === name && state.script[key]) state.script[key].next = later(5000);
    changed();
  },

  async addRoutine(name, { name: title, trigger, when, does }) {
    const agent = need(name);
    if (!String(title || '').trim()) throw new Error('A routine needs a name.');
    const routine = { id: `r${Date.now()}`, name: title.trim(), trigger, when, does, next: trigger === 'schedule' ? 'soon' : null };
    agent.routines.push(routine);
    changed();
    return { ...routine };
  },

  async updateRoutine(name, id, fields) {
    const routine = need(name).routines.find((r) => r.id === id);
    if (!routine) throw new Error('That routine is gone.');
    if ('name' in fields && !String(fields.name || '').trim()) throw new Error('A routine needs a name.');
    Object.assign(routine, fields);
    changed();
    return { ...routine };
  },

  async runRoutine(name, id) {
    const agent = need(name);
    const routine = agent.routines.find((r) => r.id === id);
    if (!routine) throw new Error('That routine is gone.');
    if (agent.paused) throw new Error(`${name} is paused. Resume it first.`);
    routine.last = Date.now();
    act(name, 'ran routine', routine.name);
    soon(name, 1800, () => say(name, `Done: ${routine.does.charAt(0).toLowerCase()}${routine.does.slice(1)}`));
    changed();
  },

  async deleteRoutine(name, id) {
    const agent = need(name);
    agent.routines = agent.routines.filter((r) => r.id !== id);
    changed();
  },

  async forget(name, noteId) {
    const agent = need(name);
    agent.memory = agent.memory.filter((note) => note.id !== noteId);
    agent.memoryCount = Math.max(agent.memory.length, (agent.memoryCount || 1) - 1);
    changed();
  },

  async providers() {
    const key = state.openrouterKey === undefined ? '7f2a' : state.openrouterKey;
    return [
      {
        id: 'openrouter', name: 'OpenRouter', connected: Boolean(key), takesKey: true,
        key: key ? { from: 'settings', hint: key } : null,
        detail: key ? `312 models · key …${key}` : 'Paste a key from openrouter.ai to use its models',
      },
      { id: 'ollama', name: 'Ollama, on the server', connected: true, detail: 'http://127.0.0.1:11434 · 2 models' },
      { id: 'vercel', name: 'Vercel AI Gateway', connected: false, detail: 'Not set up' },
      { id: 'cloudflare', name: 'Cloudflare AI Gateway', connected: false, detail: 'Not set up' },
    ];
  },

  // The mock keeps a key's last four characters, and nothing else of it.
  async setKey(provider, text) {
    const key = String(text || '').trim();
    if (provider !== 'openrouter') throw new Error(`${provider} doesn't take a key here.`);
    if (!key) throw new Error('Paste the key first.');
    state.openrouterKey = key.slice(-4);
    changed();
    return (await this.providers())[0];
  },

  async removeKey(provider) {
    if (provider !== 'openrouter') throw new Error(`${provider} doesn't take a key here.`);
    state.openrouterKey = null;
    changed();
    return (await this.providers())[0];
  },

  async models() {
    const favourites = state.favourites || FAVOURITES;
    const inUse = agentsInOrder().filter((a) => a.provider === 'openrouter').map((a) => a.model);
    const key = (await mock.providers())[0].connected;
    return [
      ...(key ? [{
        id: 'openrouter', name: 'OpenRouter',
        models: [...new Set([...favourites, ...inUse])].map(known).filter(Boolean).map((m) => ({ ...m, favourite: favourites.includes(m.id) })),
      }] : []),
      { id: 'ollama', name: 'Ollama, on the server', models: OLLAMA },
      { id: 'standin', name: 'Stand-in, no model', models: [{ id: 'stand-in', name: 'Stand-in', maker: '', input: 0, output: 0, day: 0 }] },
    ];
  },

  async recommendedModels() {
    return Object.fromEntries(Object.entries(RECOMMENDED).map(([tier, ids]) => [tier, ids.map(known)]));
  },

  async searchModels(q) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const found = words.length ? OPENROUTER.filter((m) => words.every((w) => `${m.id} ${m.maker}: ${m.name}`.toLowerCase().includes(w))) : [];
    return { total: found.length, models: found.slice(0, 20) };
  },

  async setFavourites(ids) {
    const unknown = ids.find((id) => !known(id));
    if (unknown) throw new Error(`OpenRouter has no model called ${unknown}.`);
    state.favourites = [...new Set(ids)];
    changed();
    return mock.models();
  },

  // Where each project's code is. The mock only keeps what you say.
  async repos() {
    return Object.entries(state.repos || {}).map(([project, repo]) => ({ project, ...repo }));
  },

  async setRepo(key, { source, base } = {}) {
    if (!String(source || '').trim()) throw new Error('Say where the code is: a git URL, or a folder with a repository in it.');
    (state.repos ||= {})[key] = { source: source.trim(), base: base || 'main' };
    changed();
    return { project: key, ...state.repos[key] };
  },

  async removeRepo(key) {
    delete state.repos?.[key];
    changed();
  },

  subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // Mock only: put the real tracker's ids on the issues the cast talks about, and tie each
  // question about an issue to the tracker's copy of it. The real runtime knows both, since
  // its agents asked through the tracker's MCP tools.
  async linkTracker({ findIssue, findQuestion }) {
    let dirty = false;
    for (const issue of Object.values(state.issues)) {
      const found = await findIssue(issue.title).catch(() => null);
      if (found && found.id !== issue.id) {
        issue.id = found.id;
        dirty = true;
      }
    }
    for (const [name, items] of Object.entries(state.items)) {
      for (const item of items) {
        if (item.kind !== 'question' || item.status !== 'open' || !item.issue || item.trackerQuestion) continue;
        const id = findQuestion(name, state.issues[item.issue]?.id);
        if (id) {
          item.trackerQuestion = id;
          dirty = true;
        }
      }
    }
    if (dirty) changed();
  },

  // Mock only: start the dummy over.
  reset() {
    state = seed(Date.now());
    changed();
  },
};

// Pending replies hold functions, which don't survive JSON; drop leftovers from a reload.
state.pending = [];
state.typing = {};
setInterval(runScripts, 1000);
