// The new-issue and new-project dialogs, both in the one <dialog id="dialog">.

import { api } from './api.js';
import { store, liveAgents } from './store.js';
import { h, kbd, MOD, avatar, agentAvatar, bindDraft, drafts, toast } from './ui.js';

const dialog = document.getElementById('dialog');
let afterChange = () => {};
let lastProject = null;

// app.js passes a function that refreshes the screen after something is created.
export function onCreated(fn) {
  afterChange = fn;
}

dialog.addEventListener('close', () => dialog.replaceChildren());
// A click on the backdrop lands on the <dialog> itself.
dialog.addEventListener('mousedown', (e) => {
  if (e.target === dialog) dialog.close();
});

function open(content, focus) {
  if (dialog.open) dialog.close();
  dialog.replaceChildren(content);
  dialog.showModal();
  focus?.focus();
}

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
    });
    lastProject = project.value;
    for (const key of ['title', 'description', 'assignee']) drafts.delete(`new-issue:${key}`);
    dialog.close();
    toast(`Created ${issue.id} · ${issue.title}`, { href: `#/issues/${issue.id}` });
    afterChange();
  });

  open(sheet({
    head: [h('span', { class: 'label' }, 'New issue in'), h('label', { class: 'select-chip' }, project)],
    body: [title, description, error],
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

  // Suggest a key from the name until the human types one.
  let keyTouched = Boolean(key.value);
  key.addEventListener('input', () => {
    keyTouched = true;
    key.value = key.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    drafts.set('new-project:key', key.value);
  });
  name.addEventListener('input', () => {
    if (keyTouched) return;
    key.value = name.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^[0-9]+/, '').slice(0, 3);
    drafts.set('new-project:key', key.value);
  });

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
    h('span', { class: 'label' }, label), input, hint && h('span', { class: 'hint' }, hint));

  open(sheet({
    head: h('span', { class: 'label' }, 'New project'),
    body: [
      h('div', { class: 'field-row' },
        field('Name', null, name),
        field('Key', 'Prefixes issue ids, like GW-12.', key)),
      field('Brief', 'Agents read this to understand the project.', brief),
      error,
    ],
    foot: [h('span', { class: 'hint' }, 'You can change the name and brief later.'), create],
    submit,
  }), name);
}
