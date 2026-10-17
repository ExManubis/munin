// A conversation with one of munin's agents: messages, what it did as quiet lines between
// them, its runs, and its questions and approvals as cards. A question about an issue is
// the tracker's too, so answering it here answers it there. While a question is open, the
// message box answers it.

import { api } from '../api.js';
import { runtime } from '../runtime/index.js';
import { store } from '../store.js';
import { h, kbd, statusIcon, svg, avatar, bindDraft, drafts, toast, topbar, onEnterSend, SEND_KEY } from '../ui.js';
import { markdown } from '../markdown.js';
import { optionRow } from '../cards.js';
import { agentFace, roleTag, hhmm } from './agents.js';
import { workMessage } from '../runtime/tracker-link.js';

const picks = new Map(); // question id → the option picked, before sending
const runs = new Map(); // run id → 'open', 'closed' or 'all'
// How many of each agent's newest items the thread shows; "Show earlier" adds a page. Reading by
// count rather than by page keeps live updates simple: every reload reads the newest this many.
const PAGE = 100;
const shown = new Map(); // agent name → items shown

export const view = {
  title: (data) => data.agent.name,
  scope: (params) => `/agents/${params.name}`,

  async load({ name }) {
    const { agent, items, more } = await runtime.conversation(name, { limit: shown.get(name) || PAGE });
    return { name, agent, items, more };
  },

  render(data, ctx) {
    const { agent, items } = data;
    const open = items.filter((i) => i.kind === 'question' && i.status === 'open');
    return h('div', { class: 'convo-wrap' }, h('div', { class: 'convo-grid' },
      h('section', { class: 'convo' },
        topbar([
          h('a', { class: 'back phone-only', href: '#/agents', 'aria-label': 'All agents' }, '‹'),
          agentFace(agent, 18),
          h('span', { class: 'title' }, agent.name),
          roleTag(agent),
        ], [h('a', { class: 'link narrow-only', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Profile')], 'convo-head'),
        workStrip(agent, items, ctx),
        h('div', { class: 'thread-scroll', dataset: { scroll: 'thread', stick: '' } },
          h('div', { class: 'thread-items' },
            data.more ? h('button', { type: 'button', class: 'link show-earlier', onclick: () => showEarlier(agent, ctx) }, 'Show earlier') : null,
            thread(agent, items, ctx),
            agent.typing ? h('div', { class: 'writing' }, agentFace(agent, 18, { state: 'working' }), h('span', {}, `${agent.name} is writing…`)) : null)),
        composer(agent, open[open.length - 1], ctx)),
      about(agent, ctx)));
  },

  onKey(e, data, ctx) {
    const { agent, items } = data;
    const question = [...items].reverse().find((i) => i.kind === 'question' && i.status === 'open');
    if (question && /^[1-9]$/.test(e.key) && question.options[Number(e.key) - 1]) {
      picks.set(question.id, Number(e.key) - 1);
      ctx.rerender();
      return true;
    }
    if (e.key === 'p' || e.key === 'P') {
      location.hash = `#/agents/${encodeURIComponent(agent.name)}/profile`;
      return true;
    }
    if ((e.key === 'r' || e.key === 'R') && agent.run) {
      runs.set(agent.run.id, 'open');
      ctx.rerender();
      document.getElementById(`run-${agent.run.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    }
    if ((e.key === 's' || e.key === 'S') && agent.run) {
      stopRun(agent, ctx);
      return true;
    }
    return false;
  },

  // ⌘↵ outside the message box sends the option picked on the open question.
  onSubmit(e, data, ctx) {
    const question = [...data.items].reverse().find((i) => i.kind === 'question' && i.status === 'open');
    if (question && picks.has(question.id)) {
      answerOption(data.agent, question, ctx);
      return true;
    }
    return false;
  },
};

// The tracker's side of a question about an issue: its inbox entry, while it's unanswered.
function trackerQuestion(agent, item) {
  if (!item.trackerQuestion) return null;
  return store.inbox.find((q) => q.question.id === item.trackerQuestion) || null;
}

// Thread ---------------------------------------------------------------------------------

function thread(agent, items, ctx) {
  const out = [];
  let prev = null;
  for (const item of items) {
    const at = new Date(item.at);
    if (!prev || at - new Date(prev.at) > 45 * 60 * 1000 || at.toDateString() !== new Date(prev.at).toDateString()) {
      out.push(timeRule(at));
      prev = null;
    }
    out.push(render(agent, item, prev, ctx));
    prev = item;
  }
  if (!items.length) out.push(h('p', { class: 'hint pad' }, `Say hello to ${agent.name}.`));
  return out;
}

function timeRule(at) {
  const today = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  let day;
  if (at.toDateString() === today.toDateString()) day = 'Today';
  else if (at.toDateString() === yesterday.toDateString()) day = 'Yesterday';
  else if (Date.now() - at < 6 * 86400000) day = at.toLocaleDateString(undefined, { weekday: 'long' });
  else day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return h('div', { class: 'time-rule' }, h('span', { class: 'label' }, `${day} · ${hhmm(at)}`));
}

function render(agent, item, prev, ctx) {
  if (item.kind === 'message') return message(agent, item, prev);
  if (item.kind === 'action') return actionLine(agent, item);
  if (item.kind === 'run') return run(agent, item, ctx);
  if (item.kind === 'question') return question(agent, item, ctx);
  if (item.kind === 'approval') return approval(agent, item, ctx);
  return null;
}

const human = () => store.human || (store.me.name && store.me.name !== 'me' ? store.me.name : 'You');

function message(agent, item, prev) {
  const mine = item.from === 'human';
  const sameAuthor = prev && prev.kind === 'message' && prev.from === item.from && new Date(item.at) - new Date(prev.at) < 5 * 60 * 1000;
  return h('div', { class: ['msg', sameAuthor && 'cont'] },
    sameAuthor ? null : h('div', { class: 'msg-head' },
      mine ? avatar(human(), { kind: 'human' }) : agentFace(agent, 18, { animate: false, state: 'idle' }),
      h('span', { class: 'author' }, mine ? human() : agent.name),
      h('span', { class: 'mono muted' }, hhmm(item.at))),
    markdown(item.text, 'msg-body'));
}

// The 4 × 4 pixel for things an agent did that don't move an issue.
const pixel = () => svg(12, '0 0 12 12', [['rect', { x: 4, y: 4, width: 4, height: 4, fill: '#7A7A7A' }]]);

const ISSUE_ICON = { took: 'in_progress', moved: 'done', merged: 'done', 'sent to review': 'in_review', reviewed: 'in_review' };

function actionLine(agent, item) {
  const status = item.issue && (item.object === 'to Done' ? 'done' : ISSUE_ICON[item.verb]);
  const joined = item.object && /^(to|into|from|by)\b/.test(item.object);
  return h('div', { class: 'action-line' },
    status ? statusIcon(status) : pixel(),
    h('span', { class: 'action-text' },
      item.actor && item.actor !== agent.name ? `${item.actor} ` : null,
      item.verb,
      item.issue ? [' ', h('a', { class: 'issue-link', href: `#/issues/${encodeURIComponent(item.issue.id)}` }, item.issue.id)] : null,
      item.object ? (joined ? ` ${item.object}` : [' · ', h('span', { class: 'action-object' }, item.object)]) : null,
      item.issue && !item.object && item.verb === 'took' ? [' · ', h('span', { class: 'action-object' }, item.issue.title)] : null));
}

function minutes(from, to) {
  return Math.max(1, Math.round((new Date(to || Date.now()) - new Date(from)) / 60000));
}

function run(agent, item, ctx) {
  const running = item.status === 'running';
  const mode = runs.get(item.id) || (running ? 'open' : 'closed');
  const set = (m) => () => {
    runs.set(item.id, m);
    ctx.rerender();
  };
  const steps = mode === 'all' ? item.steps : item.steps.slice(-4);
  const last = item.steps[item.steps.length - 1];
  return h('div', { class: ['run', running && 'running'], id: `run-${item.id}` },
    h('div', { class: 'run-head' },
      h('span', { class: 'label' }, `Run ${item.number} · ${item.steps.length} step${item.steps.length === 1 ? '' : 's'} · ${minutes(item.startedAt, item.endedAt)} min`),
      item.status === 'stopped' ? h('span', { class: 'label' }, '· stopped') : null,
      h('button', { type: 'button', class: 'link', onclick: set(mode === 'closed' ? 'open' : 'closed') }, mode === 'closed' ? 'Expand' : 'Collapse'),
      mode === 'open' && item.steps.length > 4 ? h('button', { type: 'button', class: 'link', onclick: set('all') }, `All ${item.steps.length} steps`) : null),
    mode === 'closed' ? null : h('ol', { class: 'run-steps' },
      steps.map((step) => h('li', { class: ['run-step', running && step === last && 'now'] },
        h('span', { class: 'run-step-time' }, running && step === last ? 'now' : hhmm(step.at)),
        h('span', { class: 'run-step-text' }, step.text),
        step.detail ? h('span', { class: 'run-step-detail' }, step.detail) : null,
        running && step === last ? h('span', { class: 'cursor', 'aria-hidden': 'true' }) : null))));
}

function question(agent, item, ctx) {
  const label = item.issue ? `${agent.name} asks on ${item.issue.id}` : `${agent.name} asks`;
  if (item.status !== 'open') {
    const chosen = item.options.findIndex((o) => o.label === item.answer?.option);
    return h('div', { class: 'ask-card question answered' },
      h('div', { class: 'label' }, label),
      h('p', { class: 'ask-q' }, item.text),
      chosen >= 0
        ? h('div', { class: 'options' }, optionRow(chosen, item.options[chosen], { answered: true }))
        : h('p', { class: 'hint' }, 'You answered in your own words, below.'),
      h('div', { class: 'mono muted' }, `You · ${hhmm(item.answeredAt || item.at)}`));
  }
  const picked = picks.get(item.id);
  const live = trackerQuestion(agent, item);
  return h('div', { class: 'ask-card question' },
    h('div', { class: 'label' }, label),
    h('p', { class: 'ask-q' }, item.text),
    h('div', { class: 'options' }, item.options.map((option, i) => optionRow(i, option, {
      selected: picked === i,
      onclick: () => {
        picks.set(item.id, i);
        ctx.rerender();
      },
    }))),
    h('div', { class: 'ask-actions' },
      h('button', {
        type: 'button',
        class: 'btn primary',
        disabled: picked === undefined,
        onclick: () => answerOption(agent, item, ctx),
      }, `Send to ${agent.name}`, h('span', { class: 'key' }, SEND_KEY)),
      h('span', { class: 'hint' }, live
        ? "Also in the tracker's inbox. Answering here answers there."
        : 'Pick an option, or answer in your own words below.')));
}

async function answerOption(agent, item, ctx) {
  const index = picks.get(item.id);
  const option = item.options[index];
  if (!option) return;
  try {
    const live = trackerQuestion(agent, item);
    if (live) await api.comment(item.issue.id, option.label);
    await runtime.answer(agent.name, item.id, { option: option.label });
    picks.delete(item.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

function approval(agent, item, ctx) {
  const rows = item.skill
    ? [
      ['once', 'Save it', `Save this skill. Ask again for the next one.`],
      ['always', 'Always allow', `Stop asking before ${agent.name} ${item.third || item.what}.`],
      ['deny', "Don't save it", `Tell ${agent.name} why below.`],
    ]
    : [
      ['once', 'Allow once', 'Just this once. Ask again next time.'],
      ['always', 'Always allow', `Stop asking before ${agent.name} ${item.third || item.what}.`],
      ['deny', 'Deny', `Don't ${item.what}. Tell ${agent.name} why below.`],
    ];
  const head = [
    h('div', { class: 'label' }, `${agent.name} wants to ${item.what}`),
    h('div', { class: 'ask-target' }, item.target),
  ];
  // A skill is on its card: what it's for, then the skill itself, so you read what you allow.
  const skill = item.skill && item.status === 'open'
    ? h('div', { class: 'quote skill-card' }, h('p', { class: 'hint' }, item.skill.description), markdown(item.skill.body))
    : null;
  if (item.status !== 'open') {
    const decided = item.status === 'denied' ? 'deny' : item.status;
    const index = rows.findIndex(([d]) => d === decided);
    const undoable = item.undoUntil && new Date(item.undoUntil) > Date.now();
    if (undoable) setTimeout(() => ctx.rerender(), new Date(item.undoUntil) - Date.now() + 50);
    return h('div', { class: 'ask-card approval answered' },
      head,
      h('div', { class: 'options' }, optionRow(index, { label: rows[index][1] }, { answered: true })),
      h('div', { class: 'mono muted' }, `You · ${hhmm(item.answeredAt || item.at)}`),
      decided === 'always'
        ? h('p', { class: 'hint ask-note' },
          `${item.label || capital(item.what)} no longer asks first. Turn it back on in ${agent.name}'s profile. `,
          h('a', { class: 'link', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Profile'),
          undoable ? [' ', h('button', { type: 'button', class: 'link', onclick: () => undo(agent, item, ctx) }, 'Undo')] : null)
        : null);
  }
  return h('div', { class: 'ask-card approval' },
    head,
    skill,
    h('div', { class: 'options' }, rows.map(([decision, label, detail], i) => optionRow(i, { label, detail }, {
      onclick: () => decide(agent, item, decision, ctx),
    }))));
}

const capital = (text) => text.charAt(0).toUpperCase() + text.slice(1);

async function decide(agent, item, decision, ctx) {
  try {
    await runtime.decide(agent.name, item.id, decision);
    if (decision === 'deny') setTimeout(() => document.querySelector('.composer textarea')?.focus(), 50);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

async function undo(agent, item, ctx) {
  try {
    await runtime.undo(agent.name, item.id);
    toast(`${item.label || capital(item.what)} asks first again.`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

// Work strip, message box, about ------------------------------------------------------------

function workStrip(agent, items, ctx) {
  if (!agent.run) return null;
  const run = items.find((i) => i.id === agent.run.id);
  const step = agent.run.step ? agent.run.step.charAt(0).toLowerCase() + agent.run.step.slice(1) : '';
  return h('div', { class: 'work-strip' },
    statusIcon('in_progress'),
    agent.run.issue
      ? [h('a', { class: 'mono issue-link', href: `#/issues/${encodeURIComponent(agent.run.issue.id)}` }, agent.run.issue.id),
        h('span', { class: 'strip-title' }, agent.run.issue.title)]
      : h('span', { class: 'strip-title' }, 'Working'),
    h('span', { class: 'strip-meta' }, ` · ${minutes(agent.run.startedAt)} min${step ? ` · ${step}` : ''}`),
    h('span', { class: 'grow' }),
    h('button', {
      type: 'button',
      class: 'link wide-only',
      onclick: () => {
        runs.set(agent.run.id, 'open');
        ctx.rerender();
        document.getElementById(`run-${agent.run.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      },
    }, 'View run', h('span', { class: 'key-inline' }, 'R')),
    run ? h('button', { type: 'button', class: 'link', onclick: () => stopRun(agent, ctx) }, 'Stop', h('span', { class: 'key-inline wide-only' }, 'S')) : null);
}

async function stopRun(agent, ctx) {
  if (!confirm(`Stop ${agent.name}'s run? It stops after the step it's on.`)) return;
  try {
    await runtime.stopRun(agent.name, agent.run.id);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

function composer(agent, openQuestion, ctx) {
  const key = `convo:${agent.name}`;
  if (agent.paused && agent.pausedFor === 'budget') {
    return h('footer', { class: 'composer' },
      h('div', { class: 'composer-box disabled' }, h('span', { class: 'muted' }, `${agent.name} is paused: it reached its $${agent.budget} budget for this month.`)),
      h('p', { class: 'hint' }, 'It does nothing until you resume it, which takes a bigger budget or a new month. ',
        h('a', { class: 'link', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Budget'), ' · ',
        h('button', { type: 'button', class: 'link', onclick: () => resume(agent, ctx) }, 'Resume')));
  }
  if (agent.paused) {
    return h('footer', { class: 'composer' },
      h('div', { class: 'composer-box disabled' }, h('span', { class: 'muted' }, `${agent.name} is paused.`)),
      h('p', { class: 'hint' }, 'It reads nothing and does nothing until you resume it. ',
        h('button', { type: 'button', class: 'link', onclick: () => resume(agent, ctx) }, 'Resume')));
  }
  const placeholder = openQuestion
    ? `Answer ${agent.name}, or pick an option…`
    : agent.run ? `Steer ${agent.name}…` : `Message ${agent.name}…`;
  const box = bindDraft(h('textarea', { class: 'composer-input', rows: 1, placeholder, 'aria-label': placeholder }), key);
  const send = async () => {
    const text = box.value.trim();
    if (!text) return box.focus();
    try {
      if (openQuestion && trackerQuestion(agent, openQuestion)) await api.comment(openQuestion.issue.id, text);
      await runtime.send(agent.name, text);
      drafts.delete(key);
      box.value = '';
    } catch (err) {
      toast(err.message, { error: true });
    }
    ctx.reload();
  };
  onEnterSend(box, send);
  const hint = openQuestion
    ? `Your message answers ${agent.name}'s question.`
    : agent.run ? `${agent.name} reads your message before its next step.` : null;
  return h('footer', { class: 'composer' },
    h('div', { class: 'composer-box' },
      box,
      h('button', { type: 'button', class: 'send', onclick: send, 'aria-label': 'Send' }, h('span', { class: 'wide-only' }, kbd(SEND_KEY)), h('span', { class: 'phone-only send-up' }, '↑'))),
    hint ? h('p', { class: 'hint' }, hint) : null);
}

// Older items arrive above, so keep what was in view where it was.
async function showEarlier(agent, ctx) {
  const before = document.querySelector('[data-scroll="thread"]');
  const fromBottom = before ? before.scrollHeight - before.scrollTop : 0;
  shown.set(agent.name, (shown.get(agent.name) || PAGE) + PAGE);
  await ctx.reload();
  const after = document.querySelector('[data-scroll="thread"]');
  if (after) after.scrollTop = after.scrollHeight - fromBottom;
}

async function resume(agent, ctx) {
  try {
    await runtime.resume(agent.name);
  } catch (err) {
    toast(err.message, { error: true }); // over its budget, say
  }
  ctx.reload();
}

async function pause(agent, ctx) {
  await runtime.pause(agent.name);
  toast(`Paused ${agent.name}. It does nothing until you resume it.`);
  ctx.reload();
}

function about(agent, ctx) {
  const prop = (key, ...value) => h('div', { class: 'prop' }, h('span', { class: 'prop-key' }, key), h('span', { class: 'prop-value' }, value));
  const provider = { openrouter: 'OpenRouter', ollama: 'Ollama' }[agent.provider] || agent.provider;
  const model = agent.provider === 'standin' ? 'Stand-in, no model' : `${agent.model} · ${provider}`;
  return h('aside', { class: 'about' },
    h('div', { class: 'about-head' }, h('span', { class: 'label' }, 'About')),
    h('div', { class: 'about-body' },
      h('div', { class: 'props-list' },
        prop('Role', agent.roleName),
        prop('Model', h('span', { class: 'mono' }, model)),
        prop('Today', `$${agent.usage.today.toFixed(2)} · ${tokens(agent.usage.tokens)} tokens`),
        agent.worksIn ? prop('Works in', h('span', { class: 'stack' }, h('span', { class: 'mono' }, agent.worksIn.folder), agent.worksIn.branch ? h('span', { class: 'mono muted' }, `${agent.worksIn.detached ? 'reviewing' : 'branch'} ${agent.worksIn.branch}`) : null,
          agent.worksIn.sandbox ? h('span', { class: 'muted' }, 'in a container of its own') : null)) : null),
      agent.tracker ? trackerSection(agent, ctx) : null,
      agent.routines.length ? h('div', { class: 'about-section' },
        h('div', { class: 'label' }, 'Routines'),
        agent.routines.map((r) => h('div', { class: 'routine-mini' },
          h('div', {}, r.name),
          h('div', { class: 'mono muted' }, [r.when, routineWhen(r)].filter(Boolean).join(' · ')),
          r.does && agent.role === 'coder' ? h('div', { class: 'hint' }, `"${r.does}"`) : null))) : null,
      agent.apps.length ? h('div', { class: 'about-section' },
        h('div', { class: 'label' }, 'Apps'),
        agent.apps.map((app) => h('div', { class: 'app-row' }, pixel(), h('span', {}, app)))) : null,
      h('div', { class: 'about-actions' },
        h('a', { class: 'btn', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Profile', h('span', { class: 'key' }, 'P')),
        agent.paused
          ? h('button', { type: 'button', class: 'link', onclick: () => resume(agent, ctx) }, 'Resume')
          : h('button', { type: 'button', class: 'link', onclick: () => pause(agent, ctx) }, 'Pause'))),
    // drawn at the panel's width; CSS fits it to the frame
    h('div', { class: 'about-bot', 'aria-hidden': 'true' },
      h('div', { class: 'about-bot-frame' }, agentFace(agent, 311))));
}

// The projects an agent works on in the tracker, each with a way to start it there.
function trackerSection(agent, ctx) {
  const { projects, connected, reachable } = agent.tracker;
  let status = null;
  if (connected === false) status = ['Not connected to the tracker yet. ', h('a', { class: 'link', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Connect')];
  else if (reachable === false) status = "Can't reach the tracker right now. The runtime tries again every half minute.";
  else if (!projects.length) status = ['No projects yet. ', h('a', { class: 'link', href: `#/agents/${encodeURIComponent(agent.name)}/profile` }, 'Pick some')];
  const free = !agent.paused && !agent.run && !agent.typing && connected !== false;
  return h('div', { class: 'about-section' },
    h('div', { class: 'label' }, agent.tracker.takes === 'reviews' ? 'Reviews in' : 'Works on'),
    projects.map((key) => h('div', { class: 'tracker-row' },
      h('a', { class: 'mono issue-link', href: `#/projects/${encodeURIComponent(key)}` }, key),
      h('span', { class: 'muted grow' }, store.projects.find((p) => p.key === key)?.name || ''),
      free ? h('button', { type: 'button', class: 'link', onclick: () => startOn(agent, key, ctx) }, agent.role === 'reviewer' ? 'Review' : 'Work on it') : null)),
    status ? h('p', { class: 'hint' }, status) : null);
}

async function startOn(agent, key, ctx) {
  try {
    await runtime.send(agent.name, workMessage(agent, key));
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

export function tokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

// "today 09:00", "tomorrow 07:30", "Mon 09:00", for a routine's last and next run. Text
// that isn't a time (the mock's "soon") shows as it is.
export function dayTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const day = (offset) => new Date(Date.now() + offset * 86400000).toDateString();
  const names = { [day(0)]: 'today', [day(1)]: 'tomorrow', [day(-1)]: 'yesterday' };
  return `${names[date.toDateString()] || date.toLocaleDateString(undefined, { weekday: 'short' })} ${hhmm(date)}`;
}

// When a routine runs next, or last ran, or why it doesn't.
export function routineWhen(r) {
  if (r.note) return r.note;
  if (r.next) return `next ${dayTime(r.next)}`;
  if (r.last) return `last ${dayTime(r.last)}`;
  return r.trigger === 'tracker' ? 'watching the tracker' : '';
}
