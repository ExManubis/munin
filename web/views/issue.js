// One issue: title and description (editable), status and assignee, what it waits for and
// blocks, and one timeline of comments and history.

import { api } from '../api.js';
import { store, liveAgents, displayName, quietAgent } from '../store.js';
import { markdown } from '../markdown.js';
import { condense, describe, eventIcon } from '../history.js';
import { issuePicker } from '../search.js';
import {
  h, kbd, MOD, avatar, agentAvatar, personAvatar, statusIcon, statusLabel, STATUSES, time, parseTime, topbar,
  bindDraft, drafts, onModEnter, toast, changeIssue, agentPrompts,
} from '../ui.js';

let editing = null; // id of the issue whose title and description are being edited
let picking = null; // { id, which: 'waits' | 'blocks' } while adding a dependency
let depError = null; // { id, text } from the server, like a cycle
let releasing = null; // id of the issue whose "Release" is waiting for a confirm

export const view = {
  title: (data) => `${data.issue.id} ${data.issue.title}`,

  async load({ id }) {
    return { issue: await api.issue(id) };
  },

  leave() {
    picking = depError = releasing = null;
  },

  render({ issue }, ctx) {
    const project = store.projects.find((p) => p.key === issue.project);
    const open = openQuestions(issue);
    const asker = open.length ? open[open.length - 1].author : null;

    return h('div', { class: 'issue-wrap' },
      h('div', { class: 'issue-head' },
        topbar(
          h('nav', { class: 'crumbs', 'aria-label': 'Breadcrumb' },
            h('a', { href: `#/projects/${encodeURIComponent(issue.project)}` }, project ? project.name : issue.project),
            h('span', {}, '/'),
            h('span', { class: 'here' }, issue.id)),
          [
            issue.waiting_on_human
              ? h('button', { type: 'button', class: 'chip', onclick: () => focusReply() }, 'Waiting on you')
              : null,
            editing === issue.id ? null : h('button', { type: 'button', class: 'action', onclick: () => startEdit(issue, ctx) }, h('span', { class: 'label link' }, 'Edit'), kbd('E')),
          ]),
        h('div', { class: 'props-top' }, h('span', { class: 'label' }, 'Properties'))),
      h('div', { class: 'issue' },
        h('article', { class: 'issue-body' },
          statusLine(issue, ctx),
          editing === issue.id ? editor(issue, ctx) : [
            h('h1', { class: 'h1' }, issue.title),
            issue.description
              ? markdown(issue.description, 'description')
              : h('p', { class: 'muted description' }, 'No description.'),
          ],
          dependencies(issue, ctx),
          timeline(issue, open),
          reply(issue, asker, ctx),
          prompts(issue, 'body-prompts')),
        properties(issue, project, ctx)));
  },

  onKey(e, { issue }, ctx) {
    if (e.key === 'e' && editing !== issue.id) startEdit(issue, ctx);
    else if (e.key === 'r') focusReply();
    else return false;
    return true;
  },
};

// Questions no human has replied to yet, like the server's inbox.
function openQuestions(issue) {
  if (issue.status === 'done' || issue.status === 'cancelled') return [];
  const lastHuman = Math.max(-1, ...issue.comments.filter((c) => c.author_kind === 'human').map((c) => c.id));
  return issue.comments.filter((c) => c.asks_human && c.id > lastHuman);
}

function focusReply() {
  const box = document.querySelector('[data-keep^="reply:"]');
  box?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  box?.focus({ preventScroll: true });
}

function startEdit(issue, ctx) {
  editing = issue.id;
  ctx.rerender();
  document.querySelector(`[data-keep="title:${issue.id}"]`)?.focus();
}

// "In progress · 14m", and a nudge when the agent on it has gone quiet.
function statusLine(issue, ctx) {
  const quiet = quietAgent(issue);
  return h('div', { class: 'status-line issue-status' },
    statusIcon(issue.status),
    h('span', {}, statusLabel(issue.status)),
    time(issue.status_changed_at, { prefix: '· ', cls: 'mono muted' }),
    issue.blocked_by.length
      ? h('a', { class: 'chip quiet', href: `#/issues/${issue.blocked_by[0]}` }, `Waits for ${issue.blocked_by.join(', ')}`)
      : null,
    quiet ? quietNotice(issue, quiet, ctx) : null);
}

function quietNotice(issue, { agent, since }, ctx) {
  const name = agent.name;
  if (releasing === issue.id) {
    return h('span', { class: 'quiet-note' },
      h('span', {}, `Put ${issue.id} back on the pile, unassigned?`),
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          releasing = null;
          changeIssue(issue, { status: 'todo', assignee: '' }, ctx.reload);
        },
      }, 'Release'),
      h('button', { type: 'button', class: 'link', onclick: () => { releasing = null; ctx.rerender(); } }, 'Cancel'));
  }
  return h('span', { class: 'quiet-note' },
    agentAvatar(name, { size: 14 }),
    since ? time(since, { prefix: `No word from ${name} for ` }) : h('span', {}, `${name} hasn't connected yet`),
    h('button', { type: 'button', class: 'link', onclick: () => { releasing = issue.id; ctx.rerender(); } }, 'Release'));
}

function editor(issue, ctx) {
  const title = bindDraft(h('input', { class: 'input title-edit', 'aria-label': 'Title' }), `title:${issue.id}`, issue.title);
  const description = bindDraft(h('textarea', {
    class: 'textarea description-edit',
    rows: 10,
    'aria-label': 'Description',
    placeholder: 'What needs doing, and what does done look like?',
  }), `description:${issue.id}`, issue.description);
  const stop = () => {
    editing = null;
    drafts.delete(`title:${issue.id}`);
    drafts.delete(`description:${issue.id}`);
  };
  const save = async () => {
    const changes = {};
    if (title.value.trim() !== issue.title) changes.title = title.value;
    if (description.value !== issue.description) changes.description = description.value;
    try {
      if (Object.keys(changes).length) await api.updateIssue(issue.id, changes);
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
  for (const input of [title, description]) {
    onModEnter(input, save);
    input.addEventListener('keydown', (e) => e.key === 'Escape' && (e.preventDefault(), cancel()));
  }
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      save();
    }
  });
  return h('div', { class: 'editor' },
    title,
    description,
    h('div', { class: 'edit-actions' },
      h('button', { type: 'button', class: 'btn small', onclick: save }, 'Save', h('span', { class: 'key' }, `${MOD}↵`)),
      h('button', { type: 'button', class: 'link', onclick: cancel }, 'Cancel'),
      kbd('Esc')));
}

// Dependencies -------------------------------------------------------------------------

function dependencies(issue, ctx) {
  return h('section', { class: 'deps', 'aria-label': 'Dependencies' },
    depList(issue, 'waits', ctx),
    depList(issue, 'blocks', ctx),
    depError && depError.id === issue.id ? h('p', { class: 'form-error deps-error', role: 'alert' }, depError.text) : null);
}

function depList(issue, which, ctx) {
  const items = which === 'waits' ? issue.waits_for : issue.blocks;
  const isPicking = picking && picking.id === issue.id && picking.which === which;
  const set = (value) => {
    picking = value;
    depError = null;
    ctx.rerender();
    if (value) document.querySelector('.deps .picker-input')?.focus();
  };
  return h('div', { class: 'dep-list' },
    h('div', { class: 'dep-head' },
      h('span', { class: 'label' }, which === 'waits' ? 'Waits for' : 'Blocks'),
      items.length ? h('span', { class: 'mono muted' }, items.length) : null,
      h('span', { class: 'spacer' }),
      isPicking ? null : h('button', { type: 'button', class: 'link', onclick: () => set({ id: issue.id, which }) }, '+ Add')),
    items.map((dep) => h('div', { class: ['dep', (dep.status === 'done' || dep.status === 'cancelled') && 'closed'] },
      statusIcon(dep.status, true),
      h('a', { class: 'dep-id', href: `#/issues/${dep.id}` }, dep.id),
      h('a', { class: 'dep-title', href: `#/issues/${dep.id}` }, dep.title),
      h('button', {
        type: 'button',
        class: 'dep-remove',
        title: 'Remove',
        'aria-label': `Remove ${dep.id}`,
        onclick: () => changeDeps(issue, which, dep.id, false, ctx),
      }, '×'))),
    !items.length && !isPicking
      ? h('p', { class: 'dep-empty' }, which === 'waits' ? 'Nothing. It can start any time.' : 'Nothing waits for it.')
      : null,
    isPicking
      ? issuePicker({
        key: `dep:${issue.id}:${which}`,
        placeholder: which === 'waits' ? 'Waits for… (id or title)' : 'Blocks… (id or title)',
        exclude: (i) => i.id === issue.id || items.some((d) => d.id === i.id),
        onPick: (picked) => changeDeps(issue, which, picked.id, true, ctx),
        onCancel: () => set(null),
      })
      : null);
}

// "waits": edit this issue's list. "blocks": edit the other issue's list.
async function changeDeps(issue, which, otherId, add, ctx) {
  try {
    if (which === 'waits') {
      const ids = issue.waits_for.map((d) => d.id).filter((id) => id !== otherId);
      await api.updateIssue(issue.id, { blocked_by: add ? [...ids, otherId] : ids });
    } else {
      const other = await api.issue(otherId);
      const ids = other.waits_for.map((d) => d.id).filter((id) => id !== issue.id);
      await api.updateIssue(otherId, { blocked_by: add ? [...ids, issue.id] : ids });
    }
    picking = null;
    depError = null;
  } catch (err) {
    depError = { id: issue.id, text: err.message };
  }
  ctx.reload();
}

// Timeline: comments and history, oldest first --------------------------------------------

function timeline(issue, open) {
  const openIds = new Set(open.map((c) => c.id));
  const entries = [
    ...issue.comments.map((comment) => ({ at: parseTime(comment.created_at), comment })),
    ...condense(issue.events).map((event) => ({ at: parseTime(event.created_at), event })),
  ].sort((a, b) => a.at - b.at || (a.event ? -1 : 1));
  return h('section', { class: 'thread', 'aria-label': 'Activity' },
    h('div', { class: 'label' }, issue.comments.length ? `Activity · ${issue.comments.length} comment${issue.comments.length === 1 ? '' : 's'}` : 'Activity'),
    entries.map((entry) => (entry.comment ? comment(entry.comment, openIds) : eventLine(entry.event))));
}

function eventLine(event) {
  return h('div', { class: 'event' },
    h('span', { class: 'event-icon' }, eventIcon(event)),
    h('span', { class: 'event-text' }, h('span', { class: 'event-actor' }, displayName(event.actor)), ' ', describe(event)),
    time(event.created_at, { cls: 'event-time' }));
}

function comment(c, openIds) {
  const isOpen = openIds.has(c.id);
  return h('div', { class: ['comment', c.asks_human && 'question', isOpen && 'open'], id: `comment-${c.id}` },
    c.author_kind === 'agent' ? agentAvatar(c.author) : avatar(c.author, { kind: 'human' }),
    h('div', { class: 'comment-main' },
      h('div', { class: 'meta' },
        h('span', { class: 'author' }, displayName(c.author)),
        time(c.created_at, { cls: 'mono muted' }),
        c.asks_human ? h('span', { class: 'label' }, isOpen ? 'asks you' : 'asked you') : null,
        isOpen ? h('button', { type: 'button', class: 'chip', onclick: focusReply }, 'Waiting on you') : null),
      markdown(c.body)));
}

function reply(issue, asker, ctx) {
  const box = bindDraft(h('textarea', {
    class: 'textarea',
    rows: 2,
    placeholder: asker ? `Answer ${asker}…` : 'Leave a comment…',
    'aria-label': 'Comment',
  }), `reply:${issue.id}`);
  const send = h('button', { type: 'button', class: 'btn primary' }, asker ? `Send to ${asker}` : 'Comment', h('span', { class: 'key' }, `${MOD}↵`));
  const submit = async () => {
    const body = box.value.trim();
    if (!body) return box.focus();
    send.disabled = true;
    try {
      await api.comment(issue.id, body);
      drafts.delete(`reply:${issue.id}`);
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
      send.disabled = false;
    }
  };
  send.addEventListener('click', submit);
  onModEnter(box, submit);
  return h('div', { class: 'reply' },
    box,
    h('div', { class: 'reply-actions' },
      send,
      h('p', { class: 'hint' }, asker
        ? `Your comment answers ${asker} and clears the question from your inbox.`
        : 'Agents see new comments the next time they read the issue.')));
}

// Properties -------------------------------------------------------------------------------

function properties(issue, project, ctx) {
  const status = h('select', { class: 'select', 'aria-label': 'Status' },
    STATUSES.map(([value, label]) => h('option', { value }, label)));
  status.value = issue.status;
  status.addEventListener('change', () => changeIssue(issue, { status: status.value }, ctx.reload));

  // Free text with suggestions. Empty means unassigned. The draft only lives while typing.
  const key = `assignee:${issue.id}`;
  const assignee = h('input', {
    class: 'input bare',
    list: 'assignee-options',
    placeholder: 'Unassigned',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Assignee',
  });
  assignee.dataset.keep = key;
  assignee.value = drafts.get(key) ?? issue.assignee ?? '';
  assignee.addEventListener('input', () => drafts.set(key, assignee.value));
  assignee.addEventListener('change', () => {
    drafts.delete(key);
    changeIssue(issue, { assignee: assignee.value.trim() }, ctx.reload);
  });
  assignee.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') assignee.blur();
    if (e.key === 'Escape') {
      drafts.delete(key);
      assignee.value = issue.assignee || '';
      assignee.blur();
    }
  });
  const names = [...new Set([...liveAgents().map((a) => a.name), store.me.name])];

  const prop = (label, ...value) => h('div', { class: 'prop' }, h('span', { class: 'prop-key' }, label), h('span', { class: 'prop-value' }, value));
  return h('aside', { class: 'props', 'aria-label': 'Properties' },
    prop('Status', statusIcon(issue.status), h('span', { class: 'select-wrap' }, status)),
    prop('Assignee', personAvatar(issue.assignee), assignee,
      issue.assignee ? h('button', { type: 'button', class: 'link unassign', onclick: () => changeIssue(issue, { assignee: '' }, ctx.reload) }, 'Clear') : null,
      h('datalist', { id: 'assignee-options' }, names.map((n) => h('option', { value: n })))),
    prop('Project', h('a', { href: `#/projects/${encodeURIComponent(issue.project)}` }, project ? project.name : issue.project)),
    prop('Created', h('span', {}, `${displayName(issue.created_by)}, `, time(issue.created_at, { long: true }))),
    prop('Updated', time(issue.updated_at, { long: true })),
    prompts(issue, 'props-prompts'));
}

// Shown in the side panel when there's room, and after the thread when there isn't.
function prompts(issue, cls) {
  if (issue.status === 'done' || issue.status === 'cancelled') return null;
  return h('div', { class: ['props-section', cls] },
    h('div', { class: 'label' }, 'Put an agent on it'),
    agentPrompts(`/mcp__munin__work_on ${issue.id}`,
      `You have access to munin, an issue tracker. Work on ${issue.id}: take it, do it, and move it to review when you're done.`));
}
