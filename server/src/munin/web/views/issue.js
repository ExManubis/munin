// One issue: title and description (editable), status, assignee, and the comment thread.

import { api } from '../api.js';
import { store, liveAgents, kindOf } from '../store.js';
import { markdown } from '../markdown.js';
import {
  h, kbd, MOD, avatar, agentAvatar, statusIcon, STATUSES, time, topbar, bindDraft, drafts, onModEnter, toast,
} from '../ui.js';

let editing = null; // id of the issue whose title and description are being edited

export const view = {
  title: (data) => `${data.issue.id} ${data.issue.title}`,

  async load({ id }) {
    return { issue: await api.issue(id) };
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
          editing === issue.id ? editor(issue, ctx) : [
            h('h1', { class: 'h1' }, issue.title),
            issue.description
              ? markdown(issue.description, 'description')
              : h('p', { class: 'muted description' }, 'No description.'),
          ],
          thread(issue, open),
          reply(issue, asker, ctx)),
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

function thread(issue, open) {
  const openIds = new Set(open.map((c) => c.id));
  return h('section', { class: 'thread', 'aria-label': 'Comments' },
    h('div', { class: 'label' }, issue.comments.length ? `Thread · ${issue.comments.length}` : 'Thread'),
    issue.comments.length
      ? issue.comments.map((c) => h('div', { class: ['comment', c.asks_human && 'question', openIds.has(c.id) && 'open'], id: `comment-${c.id}` },
        c.author_kind === 'agent' ? agentAvatar(c.author) : avatar(c.author, { kind: 'human' }),
        h('div', { class: 'comment-main' },
          h('div', { class: 'meta' },
            h('span', { class: 'author' }, c.author),
            time(c.created_at, { cls: 'mono muted' }),
            c.asks_human ? h('span', { class: 'label' }, openIds.has(c.id) ? 'asks you' : 'asked you') : null,
            openIds.has(c.id) ? h('button', { type: 'button', class: 'chip', onclick: focusReply }, 'Waiting on you') : null),
          markdown(c.body))))
      : h('p', { class: 'muted' }, 'No comments yet.'));
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

function properties(issue, project, ctx) {
  const status = h('select', { class: 'select', 'aria-label': 'Status' },
    STATUSES.map(([value, label]) => h('option', { value }, label)));
  status.value = issue.status;
  status.addEventListener('change', async () => {
    try {
      await api.updateIssue(issue.id, { status: status.value });
    } catch (err) {
      toast(err.message, { error: true });
    }
    ctx.reload();
  });

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
  assignee.addEventListener('change', async () => {
    drafts.delete(key);
    const value = assignee.value.trim();
    if (value === (issue.assignee || '')) return;
    try {
      await api.updateIssue(issue.id, { assignee: value });
    } catch (err) {
      toast(err.message, { error: true });
    }
    ctx.reload();
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
  const who = issue.assignee
    ? (kindOf(issue.assignee) === 'agent' ? agentAvatar(issue.assignee) : avatar(issue.assignee))
    : avatar(null);

  const prop = (label, ...value) => h('div', { class: 'prop' }, h('span', { class: 'prop-key' }, label), h('span', { class: 'prop-value' }, value));
  return h('aside', { class: 'props', 'aria-label': 'Properties' },
    prop('Status', statusIcon(issue.status), h('span', { class: 'select-wrap' }, status)),
    prop('Assignee', who, assignee,
      issue.assignee ? h('button', { type: 'button', class: 'link unassign', onclick: () => { assignee.value = ''; assignee.dispatchEvent(new Event('change')); } }, 'Clear') : null,
      h('datalist', { id: 'assignee-options' }, names.map((n) => h('option', { value: n })))),
    prop('Project', h('a', { href: `#/projects/${encodeURIComponent(issue.project)}` }, project ? project.name : issue.project)),
    prop('Created', h('span', {}, `${issue.created_by}, `, time(issue.created_at, { long: true }))),
    prop('Updated', time(issue.updated_at, { long: true })),
    h('p', { class: 'hint props-hint' }, 'Agents take Todo issues from the top of the pile, and move finished work to In review.'));
}
