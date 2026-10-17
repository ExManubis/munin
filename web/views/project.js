// A project's issues, as a list grouped by status or as a board, with its brief and the
// reorderable Todo pile. Also the plain list of projects that the phone tab bar opens.

import { withCosts, dollars } from '../runtime/costs.js';
import { api, ApiError } from '../api.js';
import { store, openCount, quietAgent, remember } from '../store.js';
import { markdown } from '../markdown.js';
import { openNewIssue, openNewProject } from '../dialogs.js';
import {
  h, kbd, MOD, icon, svg, personAvatar, statusIcon, time, parseTime, topbar, logoMark, bindDraft, drafts, onModEnter, toast, firstLine, changeIssue, agentPrompts, priorityChip,
} from '../ui.js';

const GROUPS = [
  { status: 'in_progress', label: 'In progress' },
  { status: 'in_review', label: 'In review' },
  { status: 'todo', label: 'Todo', hint: 'The pile. Agents take from the top.' },
  { status: 'done', label: 'Done', collapsible: true },
  { status: 'cancelled', label: 'Cancelled', collapsible: true },
];

const expanded = new Set(); // "KEY:done" when a collapsed group is open
const handoff = new Set(); // keys of projects whose "Put an agent on it" panel is open
const reopened = new Set(); // finished projects whose list the human asked to see anyway
let editing = null; // key of the project whose brief is being edited
let drag = null; // { pile, from } while a Todo row is being dragged
let cardDrag = null; // { issue, pile, from } while a board card is being dragged

// List or board, remembered per project.
const layoutKey = (key) => `munin:layout:${key}`;
const layoutOf = (key) => (remember(layoutKey(key)) === 'board' ? 'board' : 'list');

export const view = {
  title: (data) => data.project.name,

  async load({ key }) {
    const project = store.projects.find((p) => p.key === key);
    if (!project) throw new ApiError(`No project with key ${key}.`, 404);
    const issues = await withCosts(await api.issues({ project: key, status: 'all' }));
    return { project, issues };
  },

  render({ project, issues }, ctx) {
    const groups = Object.fromEntries(GROUPS.map((g) => [g.status, []]));
    for (const issue of issues) groups[issue.status]?.push(issue);
    groups.todo.sort((a, b) => a.position - b.position || number(a) - number(b));

    const open = groups.in_progress.length + groups.in_review.length + groups.todo.length;
    const finished = !open && groups.done.length > 0 && !reopened.has(project.key);
    const layout = layoutOf(project.key);
    const setLayout = (value) => () => {
      remember(layoutKey(project.key), value);
      ctx.rerender();
    };
    const showingHandoff = handoff.has(project.key);
    return h('div', { class: ['page', 'project', layout === 'board' && 'boarded'] },
      topbar(
        [
          h('span', { class: 'title' }, project.name),
          h('span', { class: 'mono muted wide-only' }, project.key),
          progress(groups, 'wide-only'),
          h('span', { class: 'tabs layout-tabs', role: 'tablist', 'aria-label': 'Layout' },
            h('button', { type: 'button', role: 'tab', 'aria-selected': String(layout === 'list'), onclick: setLayout('list') }, 'List'),
            h('button', { type: 'button', role: 'tab', 'aria-selected': String(layout === 'board'), onclick: setLayout('board') }, 'Board')),
        ],
        [
          h('button', {
            type: 'button',
            class: 'link handoff-toggle',
            'aria-expanded': String(showingHandoff),
            onclick: () => {
              if (showingHandoff) handoff.delete(project.key);
              else handoff.add(project.key);
              ctx.rerender();
            },
          }, h('span', { class: 'wide-only' }, 'Put an agent on it'), h('span', { class: 'phone-only' }, 'Agent')),
          h('button', { type: 'button', class: 'btn primary small', onclick: openNewIssue }, 'New issue', h('span', { class: 'key' }, 'C')),
        ]),
      brief(project, ctx, progress(groups, 'phone-only')),
      showingHandoff
        ? h('section', { class: 'handoff-panel' },
          h('div', { class: 'brief-head' },
            h('span', { class: 'label' }, 'Put an agent on it'),
            h('span', { class: 'hint' }, 'Paste one of these into an agent that has munin connected.')),
          agentPrompts(`/mcp__munin__continue ${project.key}`,
            `You have access to munin, an issue tracker. Continue the ${project.key} project. Keep going until there is nothing left for you to do.`,
            [['From a terminal in the repo', `munin run ${project.key} --agents 2`, 'Starts two Claude Code agents on this project. munin serve must be running.']]))
        : null,
      finished ? allDone(project, groups, ctx) : null,
      finished ? null : !issues.length
        ? h('div', { class: 'empty-state small' },
          h('h2', {}, 'No issues yet'),
          h('p', {}, 'Create the first one and it goes on the pile, where agents pick it up.'),
          h('button', { type: 'button', class: 'btn', onclick: openNewIssue }, 'New issue', h('span', { class: 'key' }, 'C')))
        : layout === 'board'
          ? board(project, groups, ctx)
          : h('div', { class: 'groups' }, GROUPS.map((g) => group(g, groups[g.status], project, ctx))));
  },

  onKey(e, { project }, ctx) {
    if (e.key === 'e') {
      document.querySelector('.brief .edit')?.click();
      return true;
    }
    if (e.key === 'b') {
      remember(layoutKey(project.key), layoutOf(project.key) === 'board' ? 'list' : 'board');
      ctx.rerender();
      return true;
    }
    return false;
  },
};

const number = (issue) => Number(issue.id.split('-').pop());

// Progress: a row of pixel segments (done, in review, in progress, todo) and "6 of 10 done".
// Cancelled issues don't count.
const SHADES = [['done', '#EDEDED', 'done'], ['in_review', '#7A7A7A', 'in review'], ['in_progress', '#4E4E4E', 'in progress'], ['todo', '#2A2A2A', 'todo']];
const CELLS = 20;

function progress(groups, cls) {
  const counts = SHADES.map(([status]) => groups[status].length);
  const total = counts.reduce((a, b) => a + b, 0);
  if (!total) return null;
  // Largest remainder, so the cells always add up to CELLS.
  const exact = counts.map((n) => (n * CELLS) / total);
  const cells = exact.map(Math.floor);
  const order = exact.map((x, i) => [x - cells[i], i]).sort((a, b) => b[0] - a[0]);
  const short = CELLS - cells.reduce((a, b) => a + b, 0);
  for (let k = 0; k < short; k++) cells[order[k][1]] += 1;
  const shapes = [];
  let x = 0;
  SHADES.forEach(([, fill], i) => {
    for (let n = 0; n < cells[i]; n++, x += 5) shapes.push(['rect', { x, y: 0, width: 4, height: 8, fill }]);
  });
  const bar = svg(CELLS * 5 - 1, `0 0 ${CELLS * 5 - 1} 8`, shapes, { cls: 'progress-bar' });
  bar.setAttribute('height', 8);
  const summary = SHADES.map(([, , label], i) => `${counts[i]} ${label}`).join(' · ');
  return h('span', { class: ['progress', cls], title: summary },
    bar, h('span', { class: 'mono muted' }, `${counts[0]} of ${total} done`));
}

// Nothing open and something done: a calm finished state instead of an empty list.
function allDone(project, groups, ctx) {
  const cancelled = groups.cancelled.length;
  return h('div', { class: 'empty-state finished' },
    h('div', { class: 'viewfinder' }, h('span', { class: 'mark-frame' }, logoMark())),
    h('h2', {}, `Nothing left in ${project.key}`),
    h('p', { class: 'mono' }, `${groups.done.length} done${cancelled ? ` · ${cancelled} cancelled` : ''}`),
    h('p', {}, 'To plan the next round, add issues or put an agent on it.'),
    h('div', { class: 'finished-actions' },
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          handoff.add(project.key);
          ctx.rerender();
          document.querySelector('.handoff-panel')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        },
      }, 'Put an agent on it'),
      h('button', {
        type: 'button',
        class: 'link',
        onclick: () => {
          reopened.add(project.key);
          expanded.add(`${project.key}:done`);
          ctx.rerender();
        },
      }, 'Show what was done')));
}

// The brief --------------------------------------------------------------------

const briefKey = (key) => `munin:brief:${key}`;
const BRIEF_LINES = 5;

function brief(project, ctx, phoneProgress) {
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
  // Long briefs are clamped to about five lines; the choice is remembered per project.
  const expanded = remember(briefKey(key)) === 'open';
  const text = project.description
    ? markdown(project.description, 'brief-text')
    : h('p', { class: 'muted brief-text' }, 'No brief yet. Tell agents what this project is, where its code lives and how to check their work.');
  const body = h('div', { class: ['brief-body', !expanded && 'clamped'] }, text);
  const more = h('button', {
    type: 'button',
    class: 'link brief-more',
    hidden: true,
    onclick: () => {
      remember(briefKey(key), expanded ? 'closed' : 'open');
      ctx.rerender();
    },
  }, expanded ? 'Show less' : 'Show all');
  // Measured before the next paint, so the button doesn't flicker on redraws.
  requestAnimationFrame(() => {
    const overflows = body.scrollHeight > BRIEF_LINES * 22 + 4;
    more.hidden = !overflows;
    body.classList.toggle('overflows', overflows);
  });
  return h('section', { class: 'brief' },
    phoneProgress,
    h('div', { class: 'brief-head' },
      h('span', { class: 'label' }, 'Brief'),
      h('span', { class: 'hint wide-only' }, 'What agents read about this project'),
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', class: 'link edit', onclick: () => { editing = key; ctx.rerender(); document.querySelector('[data-keep^="project-brief:"]')?.focus(); } }, 'Edit'),
      kbd('E')),
    body,
    more);
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

// "Waits for MUN-1", linking to the first open blocker.
function waitsChip(issue) {
  const ids = issue.blocked_by;
  if (!ids.length || issue.status === 'done' || issue.status === 'cancelled') return null;
  return h('a', { class: 'chip quiet', href: `#/issues/${ids[0]}`, title: `Waits for ${ids.join(', ')}` },
    `Waits for ${ids[0]}${ids.length > 1 ? ` +${ids.length - 1}` : ''}`);
}

function waitingChip(issue) {
  if (!issue.waiting_on_human) return null;
  const asked = store.inbox.find((i) => i.issue.id === issue.id);
  return h('a', { class: 'chip', href: asked ? `#/inbox/${asked.question.id}` : `#/issues/${issue.id}`, title: 'An agent asked you something on this issue' }, 'Waiting on you');
}

// "quiet 2h" when the agent on it hasn't been heard from for a while.
function quietHint(issue) {
  const quiet = quietAgent(issue);
  if (!quiet) return null;
  const title = quiet.since ? `${quiet.agent.name} hasn't called munin since then` : `${quiet.agent.name} has never connected`;
  return quiet.since ? time(quiet.since, { prefix: 'quiet ', cls: 'quiet-hint' }) : h('span', { class: 'quiet-hint', title }, 'quiet');
}

// How long it has been in progress or in review; otherwise when it last changed.
function when(issue) {
  const active = issue.status === 'in_progress' || issue.status === 'in_review';
  return time(active ? issue.status_changed_at : issue.updated_at, { cls: 'when' });
}

function row(issue, pile) {
  const href = `#/issues/${issue.id}`;
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
    priorityChip(issue),
    waitingChip(issue),
    waitsChip(issue),
    h('span', { class: 'spacer' }),
    pile ? moveButtons(pile) : null,
    quietHint(issue),
    issue.cost?.cost ? h('span', { class: 'cost mono muted', title: 'What its agents\' models cost while they worked on it' }, dollars(issue.cost.cost)) : null,
    h('span', { class: 'who', title: issue.assignee ? `Assigned to ${issue.assignee}` : 'Unassigned' },
      personAvatar(issue.assignee),
      h('span', { class: 'who-name' }, issue.assignee || '')),
    when(issue));
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

// Board ----------------------------------------------------------------------------------
// Columns by status. Dragging a card to another column changes its status; dragging it within
// Todo reorders the pile.

function board(project, groups, ctx) {
  const done = groups.done.slice().sort((a, b) => parseTime(b.status_changed_at) - parseTime(a.status_changed_at));
  const columns = [
    ['todo', 'Todo', groups.todo],
    ['in_progress', 'In progress', groups.in_progress],
    ['in_review', 'In review', groups.in_review],
    ['done', 'Done', done.slice(0, 10)],
  ];
  return h('div', { class: 'board', 'data-scroll': `board-${project.key}` },
    columns.map(([status, label, issues]) => column(status, label, issues, status === 'done' ? done.length : issues.length, ctx)));
}

function column(status, label, issues, total, ctx) {
  const cards = h('div', { class: 'cards' },
    issues.length
      ? issues.map((issue, i) => card(issue, status === 'todo' ? { pile: issues, index: i } : null))
      : h('p', { class: 'cards-empty' }, status === 'todo' ? 'The pile is empty.' : 'Nothing here.'));
  const col = h('section', { class: 'column', 'aria-label': label },
    h('div', { class: 'column-head' },
      statusIcon(status),
      h('span', { class: 'group-label' }, label),
      h('span', { class: 'mono muted' }, total),
      status === 'done' && total > issues.length ? h('span', { class: 'hint' }, `· latest ${issues.length}`) : null),
    cards);

  // Where in this column a drop at y lands, counted without the card being dragged.
  const slot = (y) => {
    const others = [...cards.querySelectorAll('.card:not(.dragging)')];
    const index = others.findIndex((c) => y < c.getBoundingClientRect().top + c.offsetHeight / 2);
    return { others, index: index === -1 ? others.length : index };
  };
  const clear = () => {
    col.classList.remove('drop');
    for (const c of cards.querySelectorAll('.drop-before, .drop-after')) c.classList.remove('drop-before', 'drop-after');
  };
  const reordering = () => cardDrag && status === 'todo' && cardDrag.issue.status === 'todo';
  col.addEventListener('dragover', (e) => {
    if (!cardDrag || (cardDrag.issue.status === status && !reordering())) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    clear();
    col.classList.add('drop');
    if (reordering()) {
      const { others, index } = slot(e.clientY);
      if (others[index]) others[index].classList.add('drop-before');
      else others[others.length - 1]?.classList.add('drop-after');
    }
  });
  col.addEventListener('dragleave', (e) => {
    if (!col.contains(e.relatedTarget)) clear();
  });
  col.addEventListener('drop', (e) => {
    if (!cardDrag) return;
    e.preventDefault();
    clear();
    const { issue, pile, from } = cardDrag;
    if (reordering()) {
      const { index } = slot(e.clientY);
      move(pile, from, index, ctx);
    } else if (issue.status !== status) {
      changeIssue(issue, { status }, ctx.reload);
    }
  });
  return col;
}

function card(issue, pile) {
  const href = `#/issues/${issue.id}`;
  const el = h('div', {
    class: ['card', issue.status === 'done' && 'closed'],
    draggable: true,
    onclick: (e) => {
      if (!e.target.closest('a, button')) location.hash = href;
    },
  },
    h('div', { class: 'card-top' }, h('span', { class: 'id' }, issue.id), priorityChip(issue), h('span', { class: 'spacer' }), quietHint(issue), when(issue)),
    h('a', { class: 'card-title', href, draggable: false }, issue.title),
    issue.waiting_on_human || issue.blocked_by.length ? h('div', { class: 'card-chips' }, waitingChip(issue), waitsChip(issue)) : null,
    h('div', { class: 'card-foot' }, personAvatar(issue.assignee, { size: 14 }), h('span', { class: 'who-name' }, issue.assignee || 'Anyone')));
  el.addEventListener('dragstart', (e) => {
    cardDrag = { issue, pile: pile?.pile, from: pile?.index };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', issue.id);
    el.classList.add('dragging');
    document.body.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    cardDrag = null;
    el.classList.remove('dragging');
    document.body.classList.remove('dragging');
  });
  return el;
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
