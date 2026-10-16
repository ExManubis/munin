// Finding issues: search by id or words, and a small picker built on it.

import { api } from './api.js';
import { h, statusIcon, bindDraft, drafts } from './ui.js';

const ID = /^\s*([a-z][a-z0-9]*)-(\d+)\s*$/i;

// Issues matching `q`, with an exact id ("mun-12") first.
export async function searchIssues(q, limit = 20) {
  const found = await api.issues({ q, status: 'all', limit });
  const m = q.match(ID);
  if (!m) return found;
  const id = `${m[1]}-${m[2]}`.toUpperCase();
  const exact = found.find((i) => i.id === id) || (await api.issue(id).catch(() => null));
  return exact ? [exact, ...found.filter((i) => i.id !== id)] : found;
}

export function issueOption(issue, { active, onpick }) {
  return h('button', {
    type: 'button',
    class: ['option', active && 'active'],
    role: 'option',
    'aria-selected': String(Boolean(active)),
    onmousedown: (e) => e.preventDefault(), // keep focus in the input
    onclick: onpick,
  }, statusIcon(issue.status, true), h('span', { class: 'option-id' }, issue.id), h('span', { class: 'option-text' }, issue.title));
}

// A search box with results below it. onPick(issue) when one is chosen; onCancel on Esc.
// `key` keeps what's typed across redraws.
export function issuePicker({ key, exclude = () => false, onPick, onCancel, placeholder = 'Search by id or title…' }) {
  const input = h('input', { class: 'input picker-input', placeholder, autocomplete: 'off', spellcheck: false, 'aria-label': placeholder });
  if (key) bindDraft(input, key);
  const list = h('div', { class: 'picker-results', role: 'listbox' });
  let results = [];
  let active = 0;
  let timer;
  let seq = 0;

  const draw = () => {
    list.replaceChildren(...results.map((issue, i) => issueOption(issue, { active: i === active, onpick: () => pick(issue) })));
    if (!results.length && input.value.trim() && seq) list.append(h('p', { class: 'option-empty' }, 'No matching issues.'));
  };
  const run = async () => {
    const q = input.value.trim();
    const mine = ++seq;
    const found = q ? await searchIssues(q, 8).catch(() => []) : [];
    if (mine !== seq) return;
    results = found.filter((i) => !exclude(i));
    active = 0;
    draw();
  };
  const pick = (issue) => {
    if (key) drafts.delete(key);
    input.value = '';
    results = [];
    draw();
    onPick(issue);
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (results.length) active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      draw();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[active]) pick(results[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't close a surrounding dialog
      if (key) drafts.delete(key);
      onCancel?.();
    }
  });
  if (input.value) run();
  return h('div', { class: 'picker' }, input, list);
}
