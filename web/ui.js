// DOM helpers, pixel icons, identities, relative times, drafts and toasts.
// Everything is built with createElement and text nodes; nothing here parses HTML.

import { api } from './api.js';
import { store, kindOf, isBusy } from './store.js';
import { figbot } from './figbot.js';
import { claudeMark, isClaude } from './claude-mark.js';

export const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl ';

// h('a', {class, href, onclick, ...}, ...children). Strings become text nodes.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key in el && key !== 'list' && typeof el[key] !== 'function') el[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false || child === '') continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export const kbd = (key) => h('kbd', {}, key);

// Pixel icons ---------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
const C = { text: '#EDEDED', muted: '#7A7A7A', line: '#2A2A2A', ink: '#0A0A0A' };
const R = (x, y, width, height, fill) => ['rect', { x, y, width, height, fill }];
const frame12 = (stroke, extra) => ['rect', { x: 0.5, y: 0.5, width: 11, height: 11, fill: 'none', stroke, ...extra }];
const frame18 = (stroke, extra) => ['rect', { x: 0.5, y: 0.5, width: 17, height: 17, fill: 'none', stroke, ...extra }];

export function svg(size, viewBox, shapes, { cls, label } = {}) {
  const el = document.createElementNS(NS, 'svg');
  el.setAttribute('width', size);
  el.setAttribute('height', size);
  el.setAttribute('viewBox', viewBox);
  el.setAttribute('class', ['icon', cls].filter(Boolean).join(' '));
  if (label) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', label);
  } else {
    el.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of shapes) {
    const node = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    el.append(node);
  }
  return el;
}

export const STATUSES = [
  ['todo', 'Todo'],
  ['in_progress', 'In progress'],
  ['in_review', 'In review'],
  ['done', 'Done'],
  ['cancelled', 'Cancelled'],
];
export const statusLabel = (status) => (STATUSES.find(([s]) => s === status) || [status, status])[1];

// Squares that fill up as an issue moves forward.
export function statusIcon(status, labelled = false) {
  const shapes = {
    todo: [frame12(C.muted)],
    in_progress: [frame12(C.text), R(3, 3, 3, 6, C.text)],
    in_review: [frame12(C.text), R(3, 3, 6, 6, C.text)],
    done: [R(0, 0, 12, 12, C.muted), ['path', { d: 'M3 6.5 L5 8.5 L9 3.5', fill: 'none', stroke: C.ink, 'stroke-width': 1.5 }]],
    cancelled: [frame12(C.line), ['path', { d: 'M3 9 L9 3', stroke: C.muted }]],
  }[status] || [frame12(C.muted, { 'stroke-dasharray': '1 1' })];
  return svg(12, '0 0 12 12', shapes, { cls: 'status-icon', label: labelled ? statusLabel(status) : null });
}

const ICONS = {
  inbox: (c) => [
    ['path', { d: 'M0.5 0.5 H11.5 V11.5 H0.5 Z', fill: 'none', stroke: c }],
    ['path', { d: 'M0.5 7.5 H4 V9.5 H8 V7.5 H11.5', fill: 'none', stroke: c }],
  ],
  list: (c) => [R(0, 1, 12, 2, c), R(0, 5, 12, 2, c), R(0, 9, 8, 2, c)],
  plus: (c) => [R(5, 0, 2, 12, c), R(0, 5, 12, 2, c)],
  search: (c) => [['rect', { x: 1.5, y: 1.5, width: 6, height: 6, fill: 'none', stroke: c }], R(8, 8, 3, 3, c)],
  board: (c) => [R(0, 0, 3, 12, c), R(4.5, 0, 3, 8, c), R(9, 0, 3, 10, c)],
  up: (c) => [R(5, 1, 2, 10, c), R(3, 3, 2, 2, c), R(7, 3, 2, 2, c), R(1, 5, 2, 2, c), R(9, 5, 2, 2, c)],
  down: (c) => [R(5, 1, 2, 10, c), R(3, 7, 2, 2, c), R(7, 7, 2, 2, c), R(1, 5, 2, 2, c), R(9, 5, 2, 2, c)],
  top: (c) => [R(1, 0, 10, 2, c), R(5, 3, 2, 9, c), R(3, 5, 2, 2, c), R(7, 5, 2, 2, c), R(1, 7, 2, 2, c), R(9, 7, 2, 2, c)],
  grip: (c) => [R(3, 1, 2, 2, c), R(7, 1, 2, 2, c), R(3, 5, 2, 2, c), R(7, 5, 2, 2, c), R(3, 9, 2, 2, c), R(7, 9, 2, 2, c)],
};

export function icon(name, { color = C.muted, size = 12 } = {}) {
  return svg(size, '0 0 12 12', ICONS[name](color));
}

// Agents are Figbots, in their colour when they're munin's own and white when they connect
// from outside, except Claude, which gets its own spark. People are solid squares with an
// initial, and nobody (unassigned) is a dotted square.
export function avatar(name, { kind, idle = false, size = 18, state } = {}) {
  if (!name) return svg(size, '0 0 18 18', [frame18(C.muted, { 'stroke-dasharray': '1 1' })], { cls: 'avatar', label: 'Unassigned' });
  if ((kind || kindOf(name)) === 'agent') {
    if (isClaude(name, ownNames())) return claudeMark({ size });
    return figbot({ size, state: state || (idle ? 'idle' : 'working'), animate: false });
  }
  const style = size === 18 ? null : `width:${size}px;height:${size}px;font-size:${size < 16 ? 9 : 10}px`;
  return h('span', { class: 'avatar person', 'aria-hidden': 'true', style }, (name.trim()[0] || '?').toUpperCase());
}

const ownNames = () => store.runtimeAgents.map((a) => a.name);

// What an agent is doing, for its face: the runtime knows for its own agents; for the rest,
// the tracker does (working on something, or waiting for an answer).
export function agentState(name) {
  const own = store.runtimeAgents.find((a) => a.name === name);
  if (own) return own.state;
  const agent = store.agents.find((a) => a.name === name);
  if (store.inbox.some((item) => item.question.author === name)) return 'asks';
  return agent && isBusy(agent) ? 'working' : 'idle';
}

// An agent's face, in its colour and with the expression for what it's doing.
export function agentAvatar(name, { size = 18, state } = {}) {
  if (isClaude(name, ownNames())) return claudeMark({ size, label: name });
  const own = store.runtimeAgents.find((a) => a.name === name);
  return figbot({ colour: own?.colour || 'white', state: state || agentState(name), size, seed: name, label: name });
}

// Agents, people and nobody, each with the right square.
export function personAvatar(name, opts) {
  if (!name) return avatar(null, opts);
  return kindOf(name) === 'agent' ? agentAvatar(name, opts) : avatar(name, { kind: 'human', ...opts });
}

export const logoMark = () => h('img', { src: 'munin-mark-dither-on-dark.svg', alt: '', width: 36, height: 36 });

// A view's 56 px header bar. On phones it also carries the munin mark.
export function topbar(left, right = [], cls) {
  return h('header', { class: ['topbar', cls] },
    h('div', { class: 'topbar-left' }, left),
    h('div', { class: 'topbar-right' }, right,
      h('a', { class: 'mobile-mark phone-only', href: '#/inbox', 'aria-label': 'munin inbox' }, logoMark())));
}

// Times ------------------------------------------------------------------

// The API sends UTC times without a zone suffix.
export function parseTime(value) {
  if (!value) return null;
  return new Date(/(Z|[+-]\d\d:?\d\d)$/i.test(value) ? value : `${value}Z`);
}

export function ago(value, long = false) {
  const date = parseTime(value);
  if (!date) return '';
  const s = Math.max(0, (Date.now() - date) / 1000);
  const unit = (n, short, word, words = word) => (long ? `${n} ${n === 1 ? word : words} ago` : `${n}${short}`);
  if (s < 45) return long ? 'just now' : 'now';
  if (s < 3600) return unit(Math.max(1, Math.floor(s / 60)), 'm', 'min');
  if (s < 86400) return unit(Math.floor(s / 3600), 'h', 'h');
  if (s < 86400 * 14) return unit(Math.floor(s / 86400), 'd', 'day', 'days');
  if (s < 86400 * 60) return unit(Math.floor(s / 604800), 'w', 'week', 'weeks');
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

// A <time> that app.js keeps current on every refresh.
export function time(value, { long = false, prefix = '', cls } = {}) {
  const date = parseTime(value);
  if (!date) return null;
  return h('time', {
    class: cls,
    datetime: date.toISOString(),
    title: date.toLocaleString(),
    dataset: { ts: value, long: long ? '1' : '', prefix },
  }, prefix + ago(value, long));
}

export function updateTimes(root = document) {
  for (const el of root.querySelectorAll('time[data-ts]')) {
    el.textContent = (el.dataset.prefix || '') + ago(el.dataset.ts, el.dataset.long === '1');
  }
}

// Drafts -------------------------------------------------------------------
// Inputs keep their text in `drafts` under a key, so a refresh (or leaving and coming back)
// never loses what the human typed. app.js also restores focus by that key.

export const drafts = new Map();

export function bindDraft(el, key, initial = '') {
  el.dataset.keep = key;
  el.value = drafts.has(key) ? drafts.get(key) : initial;
  el.addEventListener('input', () => drafts.set(key, el.value));
  return el;
}

export function onModEnter(el, fn) {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      fn();
    }
  });
  return el;
}

// A message box: Return sends and Shift+Return starts a new line, like a chat. Cmd/Ctrl+Return
// sends too. Return that finishes an input method's composition (Japanese, Chinese…) doesn't
// send. On a touch-only device Return adds a line, since its keyboard has no Shift, and the
// send button sends.
export const touchOnly = () => matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
export const SEND_KEY = '↵'; // what the send buttons show
export function onEnterSend(el, fn) {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || e.altKey) return;
    if (e.metaKey || e.ctrlKey || (!e.shiftKey && !touchOnly())) {
      e.preventDefault();
      fn();
    }
  });
  return el;
}

// The first meaningful line of some Markdown, for one-line previews.
export function firstLine(text) {
  const line = String(text || '').split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('```')) || '';
  return line.replace(/^(#+|[-*+]|>|\d+\.)\s+/, '').replace(/[*_`]/g, '');
}

// Toasts and clipboard -----------------------------------------------------------

// A short message in the corner. `action` adds a button, like { label: 'Undo', run }.
export function toast(message, { error = false, href, action } = {}) {
  const el = h(href ? 'a' : 'div', { class: ['toast', error && 'error'], href, role: error ? 'alert' : 'status' }, message);
  if (action) {
    el.append(' · ', h('button', {
      type: 'button',
      class: 'toast-action',
      onclick: () => {
        el.remove();
        action.run();
      },
    }, action.label));
  }
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), error ? 7000 : action ? 9000 : 4000);
}

// Change an issue's status and/or assignee, with a toast that can undo it.
export async function changeIssue(issue, changes, reload) {
  const before = {};
  for (const key of Object.keys(changes)) before[key] = key === 'assignee' ? issue.assignee || '' : issue[key];
  const status = changes.status !== undefined && changes.status !== issue.status;
  const assignee = changes.assignee !== undefined && (changes.assignee || null) !== (issue.assignee || null);
  if (!status && !assignee) return;
  let message;
  if (status && assignee && changes.status === 'todo' && !changes.assignee) message = `Put ${issue.id} back on the pile`;
  else if (status) message = `Moved ${issue.id} to ${statusLabel(changes.status)}`;
  else message = changes.assignee ? `Assigned ${issue.id} to ${changes.assignee}` : `Unassigned ${issue.id}`;
  try {
    await api.updateIssue(issue.id, changes);
    toast(message, {
      action: {
        label: 'Undo',
        run: async () => {
          try {
            await api.updateIssue(issue.id, before);
            toast(`Undone: ${issue.id} is back as it was`);
          } catch (err) {
            toast(err.message, { error: true });
          }
          reload();
        },
      },
    });
  } catch (err) {
    toast(err.message, { error: true });
  }
  reload();
}

// An on/off switch: solid when on, dotted when off.
export function toggle(on, label, onchange) {
  return h('button', { type: 'button', class: ['toggle', on && 'on'], role: 'switch', 'aria-checked': String(on), 'aria-label': label, onclick: onchange },
    h('span', { class: 'toggle-knob' }));
}

// Copyable ways to point an agent at a project or an issue: [label, text, hint?] rows.
export function agentPrompts(slash, prompt, extra = []) {
  const rows = [
    ['Claude Code', slash],
    ['Any agent', prompt],
    ['Headless', `claude -p "${prompt}"`],
    ...extra,
  ];
  return h('div', { class: 'handoff' },
    rows.map(([label, text, hint]) => h('div', { class: 'handoff-row' },
      h('div', { class: 'handoff-head' }, h('span', { class: 'label' }, label), copyButton(() => text)),
      h('code', {}, text),
      hint ? h('p', { class: 'hint' }, hint) : null)));
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { value: text, class: 'offscreen', readOnly: true });
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function copyButton(getText, label = 'Copy') {
  const button = h('button', { type: 'button', class: 'link' }, label);
  button.addEventListener('click', async () => {
    button.textContent = (await copyText(getText())) ? 'Copied' : 'Copy failed';
    setTimeout(() => (button.textContent = label), 1600);
  });
  return button;
}
