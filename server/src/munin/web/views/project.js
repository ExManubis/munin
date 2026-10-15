// A project's issues grouped by status, with its brief and the reorderable Todo pile.
// Also the plain list of projects that the phone tab bar opens.

import { api, ApiError } from '../api.js';
import { store, openCount, kindOf } from '../store.js';
import { markdown } from '../markdown.js';
import { openNewIssue, openNewProject } from '../dialogs.js';
import {
  h, kbd, MOD, icon, avatar, agentAvatar, statusIcon, time, topbar, bindDraft, drafts, onModEnter, toast, firstLine,
} from '../ui.js';

const GROUPS = [
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'todo', label: 'Todo', hint: 'The pile. Agents take from the top.' },
  { status: 'done', label: 'Done', collapsible: true },
  { status: 'cancelled', label: 'Cancelled', collapsible: true },
];

const expanded = new Set(); // "KEY:done" when a collapsed group is open
let editing = null; // key of the project whose brief is being edited
let drag = null; // { pile, from } while a Todo row is being dragged

export const view = {
  title: (data) => data.project.name,

  async load({ key }) {
    const project = store.projects.find((p) => p.key === key);
    if (!project) throw new ApiError(`No project with key ${key}.`, 404);
    const issues = await api.issues({ project: key, status: 'all' });
    return { project, issues };
  },

  render({ project, issues }, ctx) {
    const groups = Object.fromEntries(GROUPS.map((g) => [g.status, []]));
    for (const issue of issues) groups[issue.status]?.push(issue);
    groups.todo.sort((a, b) => a.position - b.position || number(a) - number(b));

    const open = groups.in_progress.length + groups.in_review.length + groups.todo.length;
    return h('div', { class: 'page project' },
      topbar(
        [h('span', { class: 'title' }, project.name), h('span', { class: 'mono muted' }, `${project.key} · ${open} open`)],
        h('button', { type: 'button', class: 'btn primary small', onclick: openNewIssue }, 'New issue', h('span', { class: 'key' }, 'C'))),
      brief(project, ctx),
      issues.length
        ? h('div', { class: 'groups' }, GROUPS.map((g) => group(g, groups[g.status], project, ctx)))
        : h('div', { class: 'empty-state small' },
          h('h2', {}, 'No issues yet'),
          h('p', {}, 'Create the first one and it goes on the pile, where agents pick it up.'),
          h('button', { type: 'button', class: 'btn', onclick: openNewIssue }, 'New issue', h('span', { class: 'key' }, 'C'))));
  },

  onKey(e) {
    if (e.key === 'e') {
      document.querySelector('.brief .edit')?.click();
      return true;
    }
    return false;
  },
};

const number = (issue) => Number(issue.id.split('-').pop());

// The brief --------------------------------------------------------------------

function brief(project, ctx) {
  const key = project.key;
  if (editing === key) {
    const name = bindDraft(h('input', { class: 'input', 'aria-label': 'Project name' }), `project-name:${key}`, project.name);
    const description = bindDraft(h('textarea', {
      class: 'textarea brief-input',
      rows: 8,
      'aria-label': 'Brief',
      placeholder: 'What this project is, where the code lives, and how to check work is done.',
    }), `project-brief:${key}`, project.description);
    const stop = () => {
      editing = null;
      drafts.delete(`project-name:${key}`);
      drafts.delete(`project-brief:${key}`);
    };
    const save = async () => {
      try {
        const changes = {};
        if (name.value.trim() !== project.name) changes.name = name.value;
        if (description.value !== project.description) changes.description = description.value;
        if (Object.keys(changes).length) await api.updateProject(key, changes);
        stop();
        ctx.reload();
      } catch (err) {
        toast(err.message, { error: true });
      }
    };
    const cancel = () => {
      stop();
      ctx.rerender();
    };
    for (const input of [name, description]) {
      onModEnter(input, save);
      input.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), cancel()));
    }
    return h('section', { class: 'brief editing' },
      h('div', { class: 'brief-head' }, h('span', { class: 'label' }, 'Edit project')),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Name'), name),
      h('label', { class: 'field' }, h('span', { class: 'label' }, 'Brief'), description),
      h('div', { class: 'edit-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: save }, 'Save', h('span', { class: 'key' }, `${MOD}↵`)),
        h('button', { type: 'button', class: 'link', onclick: cancel }, 'Cancel'),
        h('span', { class: 'hint' }, 'Markdown works: **bold**, `code`, lists and links.')));
  }
  return h('section', { class: 'brief' },
    h('div', { class: 'brief-head' },
      h('span', { class: 'label' }, 'Brief'),
      h('span', { class: 'hint' }, 'What agents read about this project'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'link edit', onclick: () => { editing = key; ctx.rerender(); document.querySelector('[data-keep^="project-brief:"]')?.focus(); } }, 'Edit'),
      kbd('E')),
    project.description
      ? markdown(project.description, 'brief-text')
      : h('p', { class: 'muted brief-text' }, 'No brief yet. Tell agents what this project is, where its code lives and how to check their work.'));
}

// Groups and rows -----------------------------------------------------------------

function group(g, issues, project, ctx) {
  if (!issues.length && g.status !== 'todo') return null;
  const id = `${project.key}:${g.status}`;
  const open = !g.collapsible || expanded.has(id);
  const toggle = () => {
    if (open) expanded.delete(id);
    else expanded.add(id);
    ctx.rerender();
  };
  return h('section', { class: ['group', `group-${g.status}`], 'aria-label': g.label },
    h('div', { class: 'group-head' },
      statusIcon(g.status),
      h('span', { class: 'group-label' }, g.label),
      h('span', { class: 'mono muted' }, issues.length),
      g.hint ? h('span', { class: 'hint' }, `· ${g.hint}`) : null,
      g.collapsible ? h('button', { type: 'button', class: 'link', 'aria-expanded': String(open), onclick: toggle }, open ? 'Hide' : 'Show') : null),
    open
      ? h('div', { class: 'rows' },
        issues.length
          ? issues.map((issue, i) => row(issue, g.status === 'todo' ? { pile: issues, index: i, ctx } : null))
          : h('p', { class: 'muted pile-empty' }, 'The pile is empty. New issues land here.'))
      : null);
}

function row(issue, pile) {
  const href = `#/issues/${issue.id}`;
  const asked = store.inbox.find((i) => i.issue.id === issue.id);
  const el = h('div', {
    class: ['row', (issue.status === 'done' || issue.status === 'cancelled') && 'closed', pile && 'pile-row'],
    onclick: (e) => {
      if (!e.target.closest('a, button')) location.hash = href;
    },
  },
    h('span', { class: 'grip-slot' }, pile ? icon('grip') : null),
    h('span', { class: 'id' }, issue.id),
    statusIcon(issue.status, true),
    h('span', { class: 'row-title' }, h('a', { href, draggable: false }, issue.title)),
    issue.waiting_on_human
      ? h('a', { class: 'chip', href: asked ? `#/inbox/${asked.question.id}` : href, title: 'An agent asked you something on this issue' }, 'Waiting on you')
      : null,
    h('span', { class: 'spacer' }),
    pile ? moveButtons(pile) : null,
    h('span', { class: 'who', title: issue.assignee ? `Assigned to ${issue.assignee}` : 'Unassigned' },
      issue.assignee ? (kindOf(issue.assignee) === 'agent' ? agentAvatar(issue.assignee) : avatar(issue.assignee)) : avatar(null),
      h('span', { class: 'who-name' }, issue.assignee || '')),
    time(issue.updated_at, { cls: 'when' }));
  if (pile) makeDraggable(el, pile);
  return el;
}

function moveButtons({ pile, index, ctx }) {
  const last = pile.length - 1;
  const button = (name, label, to, disabled) => h('button', {
    type: 'button',
    class: 'move',
    title: label,
    'aria-label': `${label}: ${pile[index].id}`,
    disabled,
    onclick: () => move(pile, index, to, ctx),
  }, icon(name));
  return h('span', { class: 'moves' },
    button('top', 'Move to top', 0, index === 0),
    button('up', 'Move up', index - 1, index === 0),
    button('down', 'Move down', index + 1, index === last));
}

function makeDraggable(el, { pile, index, ctx }) {
  el.draggable = true;
  const clear = () => el.classList.remove('drop-before', 'drop-after');
  const below = (e) => {
    const box = el.getBoundingClientRect();
    return e.clientY > box.top + box.height / 2;
  };
  el.addEventListener('dragstart', (e) => {
    drag = { pile, from: index };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pile[index].id);
    el.classList.add('dragging');
    document.body.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    drag = null;
    el.classList.remove('dragging');
    document.body.classList.remove('dragging');
    for (const r of document.querySelectorAll('.drop-before, .drop-after')) r.classList.remove('drop-before', 'drop-after');
  });
  el.addEventListener('dragover', (e) => {
    if (!drag || drag.pile !== pile) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const after = below(e);
    el.classList.toggle('drop-after', after);
    el.classList.toggle('drop-before', !after);
  });
  el.addEventListener('dragleave', clear);
  el.addEventListener('drop', (e) => {
    if (!drag || drag.pile !== pile) return;
    e.preventDefault();
    clear();
    let to = below(e) ? index + 1 : index;
    if (drag.from < to) to -= 1;
    move(pile, drag.from, to, ctx);
  });
}

// Moves pile[from] to index `to` by giving it a position between its new neighbours.
async function move(pile, from, to, ctx) {
  if (to < 0 || to >= pile.length || to === from) return;
  const order = pile.slice();
  const [issue] = order.splice(from, 1);
  order.splice(to, 0, issue);
  const above = order[to - 1];
  const below = order[to + 1];
  let position;
  if (!above) position = below.position - 1;
  else if (!below) position = above.position + 1;
  else position = (above.position + below.position) / 2;

  // Neighbours with equal positions leave no room in between: renumber the whole pile.
  const roomy = (!above || position > above.position) && (!below || position < below.position);
  const updates = roomy
    ? [[issue, position]]
    : order.map((it, i) => [it, i + 1]).filter(([it, p]) => it.position !== p);

  for (const [it, p] of updates) it.position = p; // show the new order straight away
  ctx.rerender();
  try {
    for (const [it, p] of updates) await api.updateIssue(it.id, { position: p });
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

// The list of projects ---------------------------------------------------------------

export const indexView = {
  title: () => 'Projects',
  async load() {
    return { projects: store.projects };
  },
  render({ projects }) {
    return h('div', { class: 'page' },
      topbar(
        [h('span', { class: 'title' }, 'Projects'), h('span', { class: 'mono muted' }, projects.length)],
        h('button', { type: 'button', class: 'btn primary small', onclick: openNewProject }, 'New project')),
      projects.length
        ? h('div', { class: 'project-list' }, projects.map((p) => h('a', { class: 'project-item', href: `#/projects/${encodeURIComponent(p.key)}` },
          h('span', { class: 'bullet' }),
          h('span', { class: 'project-main' },
            h('span', { class: 'project-name' }, p.name, h('span', { class: 'mono muted' }, ` ${p.key}`)),
            p.description ? h('span', { class: 'project-brief' }, firstLine(p.description)) : null),
          h('span', { class: 'mono muted' }, `${openCount(p)} open`))))
        : h('div', { class: 'empty-state small' },
          h('h2', {}, 'No projects yet'),
          h('p', {}, 'A project groups issues and carries the brief agents read before they start.')));
  },
};
