// Dialogs, all in the one <dialog id="dialog">: new issue, new project and the shortcut list.
// The command palette (palette.js) opens in it too.

import { api } from './api.js';
import { store, liveAgents } from './store.js';
import { h, kbd, MOD, avatar, agentAvatar, statusIcon, bindDraft, drafts, toast } from './ui.js';
import { issuePicker } from './search.js';

const dialog = document.getElementById('dialog');
let afterChange = () => {};
let lastProject = null;

// app.js passes a function that refreshes the screen after something is created.
export function onCreated(fn) {
  afterChange = fn;
}

// A dialog opened right after another closed must keep its content when the old close event lands.
dialog.addEventListener('close', () => !dialog.open && dialog.replaceChildren());
// A click on the backdrop lands on the <dialog> itself.
dialog.addEventListener('mousedown', (e) => {
  if (e.target === dialog) dialog.close();
});
// One Esc closes it, wherever focus is: some browsers spend the first press on leaving a text
// field. A picker inside that cancels on Esc stops it first; typing with an IME keeps it.
dialog.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  e.preventDefault();
  dialog.close();
});

export function openDialog(content, focus, kind = '') {
  if (dialog.open) dialog.close();
  dialog.className = kind ? `modal modal-${kind}` : 'modal';
  dialog.dataset.kind = kind;
  dialog.replaceChildren(content);
  dialog.showModal();
  focus?.focus();
}

export const dialogOpen = (kind) => dialog.open && (kind === undefined || dialog.dataset.kind === kind);
export const closeDialog = () => dialog.open && dialog.close();
const open = openDialog;

function sheet({ head, body, foot, submit }) {
  const form = h('form', { class: 'sheet', novalidate: true },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, head),
      h('button', { type: 'button', class: 'close', onclick: () => dialog.close() }, h('span', { class: 'label' }, 'Close'), kbd('Esc'))),
    h('div', { class: 'sheet-body' }, body),
    h('footer', { class: 'sheet-foot' }, foot));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  });
  return form;
}

function primary(label) {
  return h('button', { type: 'submit', class: 'btn primary' }, label, h('span', { class: 'key' }, `${MOD}↵`));
}

async function busy(button, error, work) {
  button.disabled = true;
  error.textContent = '';
  try {
    await work();
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
  }
}

// New issue ---------------------------------------------------------------------

export function openNewIssue() {
  if (!store.projects.length) {
    openNewProject();
    toast('Create a project first. Issues live in projects.');
    return;
  }
  const keys = store.projects.map((p) => p.key);
  const startKey = [store.projectKey, lastProject].find((k) => keys.includes(k)) || keys[0];

  const project = h('select', { 'aria-label': 'Project' },
    store.projects.map((p) => h('option', { value: p.key }, p.name)));
  project.value = startKey;

  // A one-line textarea, so long titles wrap instead of scrolling out of sight.
  const title = bindDraft(h('textarea', { class: 'title-input', rows: 1, placeholder: 'Issue title', 'aria-label': 'Title' }), 'new-issue:title');
  const description = bindDraft(h('textarea', {
    class: 'desc-input',
    rows: 6,
    placeholder: 'What needs doing, and what does done look like? Agents read this before they start.',
    'aria-label': 'Description',
  }), 'new-issue:description');
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      description.focus();
    }
  });

  // Anyone, each agent, or the human.
  let assignee = drafts.get('new-issue:assignee') ?? null;
  const choices = [[null, 'Anyone'], ...liveAgents().map((a) => [a.name, a.name]), [store.me.name, 'Me']];
  if (!choices.some(([value]) => value === assignee)) assignee = null;
  const buttons = choices.map(([value, label]) => {
    const button = h('button', { type: 'button', 'aria-pressed': String(value === assignee), title: value || 'Any agent can take it' },
      value === null ? avatar(null, { size: 14 }) : value === store.me.name ? avatar(value, { kind: 'human', size: 14 }) : agentAvatar(value, { size: 14 }),
      label);
    button.addEventListener('click', () => {
      assignee = value;
      drafts.set('new-issue:assignee', value);
      for (const b of buttons) b.setAttribute('aria-pressed', String(b === button));
    });
    return button;
  });

  // Optional: issues this one waits for.
  const waits = drafts.get('new-issue:waits') || [];
  const waitsBox = h('div', { class: 'waits' });
  let picking = false;
  const drawWaits = () => {
    drafts.set('new-issue:waits', waits);
    waitsBox.replaceChildren(...[
      h('span', { class: 'label' }, 'Waits for'),
      waits.map((issue) => h('span', { class: 'dep-chip' },
        statusIcon(issue.status), h('span', { class: 'mono' }, issue.id), h('span', { class: 'dep-chip-title' }, issue.title),
        h('button', {
          type: 'button',
          class: 'dep-remove',
          'aria-label': `Remove ${issue.id}`,
          onclick: () => {
            waits.splice(waits.indexOf(issue), 1);
            drawWaits();
          },
        }, '×'))),
      picking
        ? issuePicker({
          key: 'new-issue:waits-search',
          exclude: (i) => waits.some((w) => w.id === i.id),
          onPick: (issue) => {
            waits.push({ id: issue.id, title: issue.title, status: issue.status });
            picking = false;
            drawWaits();
            title.focus();
          },
          onCancel: () => {
            picking = false;
            drawWaits();
          },
        })
        : h('button', { type: 'button', class: 'link', onclick: () => { picking = true; drawWaits(); waitsBox.querySelector('input')?.focus(); } },
          waits.length ? '+ Another' : '+ Add'),
    ].flat());
  };
  drawWaits();

  const error = h('p', { class: 'form-error', role: 'alert' });
  const create = primary('Create in Todo');

  const submit = () => busy(create, error, async () => {
    if (!title.value.trim()) {
      title.focus();
      throw new Error('Give the issue a title.');
    }
    const issue = await api.createIssue({
      project: project.value,
      title: title.value.replace(/\s*\n\s*/g, ' ').trim(),
      description: description.value.trim(),
      status: 'todo',
      assignee,
      blocked_by: waits.map((w) => w.id),
    });
    lastProject = project.value;
    for (const key of ['title', 'description', 'assignee', 'waits', 'waits-search']) drafts.delete(`new-issue:${key}`);
    dialog.close();
    toast(`Created ${issue.id} · ${issue.title}`, { href: `#/issues/${issue.id}` });
    afterChange();
  });

  open(sheet({
    head: [h('span', { class: 'label' }, 'New issue in'), h('label', { class: 'select-chip' }, project)],
    body: [title, description, waitsBox, error],
    foot: [
      h('div', { class: 'assign' }, h('span', { class: 'label' }, 'Assign'), h('div', { class: 'seg', role: 'group', 'aria-label': 'Assignee' }, buttons)),
      create,
    ],
    submit,
  }), title);
}

// New project -------------------------------------------------------------------

export function openNewProject() {
  const name = bindDraft(h('input', { class: 'input', placeholder: 'Gateway', autocomplete: 'off' }), 'new-project:name');
  const key = bindDraft(h('input', { class: 'input mono-input', placeholder: 'GW', maxlength: 10, autocomplete: 'off', spellcheck: false }), 'new-project:key');
  const brief = bindDraft(h('textarea', {
    class: 'textarea',
    rows: 5,
    placeholder: 'What this project is, where the code lives, and how to check work is done.',
  }), 'new-project:description');

  // Suggest a key from the name until the human types one; the hint shows it in an id.
  const keyHint = h('span', { class: 'hint' });
  const showKey = () => (keyHint.textContent = `Prefixes issue ids, like ${key.value || 'GW'}-12.`);
  let keyTouched = Boolean(key.value);
  key.addEventListener('input', () => {
    keyTouched = true;
    key.value = key.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    drafts.set('new-project:key', key.value);
    showKey();
  });
  name.addEventListener('input', () => {
    if (keyTouched) return;
    key.value = name.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 3);
    drafts.set('new-project:key', key.value);
    showKey();
  });
  showKey();

  const error = h('p', { class: 'form-error', role: 'alert' });
  const create = primary('Create project');

  const submit = () => busy(create, error, async () => {
    const created = await api.createProject({ key: key.value, name: name.value, description: brief.value.trim() });
    for (const k of ['name', 'key', 'description']) drafts.delete(`new-project:${k}`);
    dialog.close();
    toast(`Created ${created.name}`);
    location.hash = `#/projects/${encodeURIComponent(created.key)}`;
    afterChange();
  });

  const field = (label, hint, input) => h('label', { class: 'field' },
    h('span', { class: 'label' }, label), input, typeof hint === 'string' ? h('span', { class: 'hint' }, hint) : hint);

  open(sheet({
    head: h('span', { class: 'label' }, 'New project'),
    body: [
      h('div', { class: 'field-row' },
        field('Name', null, name),
        field('Key', keyHint, key)),
      field('Brief', 'Agents read this to understand the project.', brief),
      error,
    ],
    foot: [h('span', { class: 'hint' }, 'You can change the name and brief later.'), create],
    submit,
  }), name);
}

// Keyboard shortcuts ------------------------------------------------------------------

const SHORTCUTS = [
  ['Anywhere', [[[`${MOD.trim()} K`], 'Search or jump to anything'], [['G', 'A'], 'Go to Agents'], [['G', 'T'], 'Go to the Tracker'], [['?'], 'This list']]],
  ['Agents', [[['N'], 'New agent'], [['1', '…', '9'], "Pick an option on the agent's question"], [['P'], 'Profile'], [['R'], 'View the run'], [['S'], 'Stop the run']]],
  ['Tracker', [[['C'], 'New issue']]],
  ['Inbox', [[['J', 'K'], 'Next and previous question'], [['↵'], 'Open the issue'], [['R'], 'Write an answer']]],
  ['Issue', [[['E'], 'Edit title and description'], [['R'], 'Write a comment']]],
  ['Project', [[['E'], 'Edit the brief'], [['B'], 'Switch between list and board']]],
  ['Writing', [[[`${MOD.trim()} ↵`], 'Send or save'], [['Esc'], 'Cancel, or close a dialog']]],
  ['Lists and search', [[['↑', '↓'], 'Move'], [['↵'], 'Choose'], [['Esc'], 'Close']]],
];

export function openShortcuts() {
  const sheet = h('div', { class: 'sheet', tabindex: -1 },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, 'Keyboard shortcuts')),
      h('button', { type: 'button', class: 'close', onclick: () => dialog.close() }, h('span', { class: 'label' }, 'Close'), kbd('Esc'))),
    h('div', { class: 'sheet-body shortcuts' },
      SHORTCUTS.map(([group, keys]) => h('section', {},
        h('h2', { class: 'label' }, group),
        keys.map(([combo, what]) => h('div', { class: 'shortcut' }, h('span', { class: 'shortcut-keys' }, combo.map(kbd)), h('span', {}, what)))))));
  open(sheet, sheet, 'small');
}
