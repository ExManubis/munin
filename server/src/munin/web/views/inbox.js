// Inbox: questions agents asked the human, oldest first. A list on the left and the selected
// question on the right; when the screen is narrow, one question at a time.

import { api } from '../api.js';
import { store } from '../store.js';
import { markdown } from '../markdown.js';
import {
  h, kbd, MOD, avatar, agentAvatar, statusIcon, statusLabel, time, topbar, logoMark,
  bindDraft, drafts, onModEnter, firstLine, toast,
} from '../ui.js';

let showContext = false; // narrow layout: is the issue context expanded?

const go = (hash) => location.replace(hash);
const itemHash = (item) => (item ? `#/inbox/${item.question.id}` : '#/inbox');

export const view = {
  scope: () => 'inbox',
  title: (data) => (data.items.length ? `Inbox (${data.items.length})` : 'Inbox'),

  async load({ qid }) {
    const items = store.inbox;
    const selected = items.find((i) => String(i.question.id) === qid) || items[0] || null;
    const issue = selected ? await api.issue(selected.issue.id) : null;
    return { items, selectedId: selected ? selected.question.id : null, issue };
  },

  render(data, ctx) {
    if (!data.items.length) return empty();
    const index = data.items.findIndex((i) => i.question.id === data.selectedId);
    return h('div', { class: 'inbox-wrap' },
      h('div', { class: 'inbox' }, list(data.items, index), detail(data, index, ctx)));
  },

  onKey(e, data) {
    const index = data.items.findIndex((i) => i.question.id === data.selectedId);
    if (e.key === 'j' || e.key === 'ArrowDown') go(itemHash(data.items[Math.min(index + 1, data.items.length - 1)]));
    else if (e.key === 'k' || e.key === 'ArrowUp') go(itemHash(data.items[Math.max(index - 1, 0)]));
    else if ((e.key === 'Enter' || e.key === 'o') && data.issue) location.hash = `#/issues/${data.issue.id}`;
    else if (e.key === 'r') document.querySelector('[data-keep^="answer:"]')?.focus();
    else return false;
    return true;
  },
};

function empty() {
  return h('div', { class: 'page' },
    topbar([h('span', { class: 'title' }, 'Inbox'), h('span', { class: 'mono muted' }, '0 open')]),
    h('div', { class: 'empty-state' },
      h('div', { class: 'viewfinder' }, h('span', { class: 'mark-frame' }, logoMark())),
      h('h2', {}, 'Nothing is waiting on you'),
      h('p', {}, 'When an agent needs a decision it asks with a comment, and the question lands here, oldest first.')));
}

function list(items, selected) {
  return h('section', { class: 'inbox-list', 'aria-label': 'Questions' },
    topbar([h('span', { class: 'title' }, 'Inbox'), h('span', { class: 'mono muted' }, `${items.length} open`)]),
    h('div', { class: 'list-head' }, h('span', { class: 'label' }, 'Waiting on you'), h('span', { class: 'label' }, 'Oldest first')),
    h('div', { class: 'q-items', 'data-scroll': 'inbox-items' },
      items.map((item, i) => {
        const q = item.question;
        return h('a', { class: ['q-row', i === selected && 'selected'], href: itemHash(item), 'aria-current': i === selected ? 'true' : null },
          agentAvatar(q.author),
          h('div', { class: 'q-main' },
            h('div', { class: 'q-head' },
              h('span', { class: 'q-who' }, h('span', { class: 'q-agent' }, q.author), h('span', { class: 'label' }, 'asks')),
              time(q.created_at, { cls: 'q-age' })),
            h('div', { class: 'q-text' }, firstLine(q.body) || '(empty question)'),
            h('div', { class: 'q-meta' }, `${item.issue.id} · ${item.issue.title}`)));
      })),
    h('footer', { class: 'keys' },
      h('span', {}, kbd('J'), kbd('K'), 'Move'),
      h('span', {}, kbd('↵'), 'Open issue'),
      h('span', {}, kbd('R'), 'Reply')));
}

function detail(data, index, ctx) {
  const { items, issue } = data;
  const item = items[index];
  const q = item.question;
  const agent = q.author;
  const project = store.projects.find((p) => p.key === issue.project);

  // Answering is a human comment, which answers every open question on the issue.
  const others = items.filter((i) => i !== item && i.issue.id === issue.id).length;
  const next = items.slice(index + 1).find((i) => i.issue.id !== issue.id)
    || items.slice(0, index).find((i) => i.issue.id !== issue.id);

  const answer = bindDraft(h('textarea', {
    class: 'textarea answer',
    rows: 2,
    placeholder: 'Answer in your own words…',
    'aria-label': `Answer ${agent}`,
  }), `answer:${q.id}`);
  const send = h('button', { type: 'button', class: 'btn primary' }, `Send to ${agent}`, h('span', { class: 'key' }, `${MOD}↵`));
  const submit = async () => {
    const body = answer.value.trim();
    if (!body) return answer.focus();
    send.disabled = true;
    try {
      await api.comment(issue.id, body);
      drafts.delete(`answer:${q.id}`);
      toast(`Sent to ${agent} on ${issue.id}`);
      const target = itemHash(next);
      if (location.hash === target) ctx.reload();
      else go(target);
    } catch (err) {
      toast(err.message, { error: true });
      send.disabled = false;
    }
  };
  send.addEventListener('click', submit);
  onModEnter(answer, submit);

  const before = issue.comments.filter((c) => c.id < q.id);
  const after = issue.comments.filter((c) => c.id > q.id);
  const earlier = before.slice(-3);
  const contextCount = issue.comments.length - 1;

  return h('section', { class: 'inbox-detail', 'aria-label': 'Question' },
    topbar(
      [
        h('nav', { class: 'crumbs split-only', 'aria-label': 'Breadcrumb' },
          h('a', { href: `#/projects/${encodeURIComponent(issue.project)}` }, project ? project.name : issue.project),
          h('span', {}, '/'),
          h('a', { class: 'here', href: `#/issues/${issue.id}` }, issue.id)),
        h('span', { class: 'single-only title' }, 'Inbox'),
        h('span', { class: 'single-only mono muted' }, `${index + 1} of ${items.length}`),
      ],
      h('a', { class: 'action split-only', href: `#/issues/${issue.id}` }, h('span', { class: 'label' }, 'Open issue'), kbd('↵'))),
    h('div', { class: 'detail-scroll', 'data-scroll': `question-${q.id}` },
      h('article', { class: 'detail-body' },
        h('div', { class: 'status-line' },
          h('span', { class: 'split-only status-line' }, statusIcon(issue.status), statusLabel(issue.status), h('span', { class: 'divider-v' })),
          agentAvatar(agent),
          h('span', { class: 'asker' }, h('span', { class: 'single-only' }, `${agent} asks`), h('span', { class: 'split-only' }, `${agent} is waiting for you`)),
          time(q.created_at, { cls: 'waited split-only' }),
          time(q.created_at, { prefix: 'waiting ', cls: 'waited single-only' })),
        h('h1', { class: 'h1 split-only' }, issue.title),
        h('a', { class: 'q-meta single-only', href: `#/issues/${issue.id}` }, `${issue.id} · ${issue.title}`),
        h('div', { class: 'label section-label split-only' }, `${agent} asks`),
        markdown(q.body, 'question-body'),
        contextCount > 0 || issue.description
          ? h('button', { type: 'button', class: 'link single-only context-toggle', onclick: () => { showContext = !showContext; ctx.rerender(); } },
            showContext ? 'Hide the issue' : `The issue${contextCount > 0 ? ` and ${contextCount} comment${contextCount === 1 ? '' : 's'}` : ''}`)
          : null,
        h('div', { class: ['context', !showContext && 'collapsed'] },
          h('div', { class: 'label section-label' }, `The issue · ${issue.id}`),
          issue.description ? markdown(issue.description, 'quote') : h('p', { class: 'muted quote' }, 'No description.'),
          earlier.length ? commentBlock(before.length > earlier.length ? `Latest ${earlier.length} of ${before.length} earlier comments` : 'Earlier comments', earlier, issue) : null,
          after.length ? commentBlock('Since the question', after, issue) : null),
        h('div', { class: 'reply' },
          answer,
          h('div', { class: 'reply-actions' },
            send,
            h('p', { class: 'hint' },
              `Saved to ${issue.id} as your comment. ${agent} reads it the next time it checks the issue.`,
              others ? ` It also answers ${others} other question${others === 1 ? '' : 's'} on ${issue.id}.` : ''))))),
    next ? h('div', { class: 'next single-only' },
      h('a', { class: 'next-main', href: itemHash(next) },
        h('span', { class: 'label' }, 'Next · ', time(next.question.created_at)),
        h('span', { class: 'next-text' }, `${next.question.author}: ${firstLine(next.question.body)}`)),
      h('a', { class: 'link', href: itemHash(next) }, 'Skip')) : null);
}

function commentBlock(label, comments, issue) {
  return h('div', { class: 'context-comments' },
    h('div', { class: 'label section-label' }, label),
    comments.map((c) => h('div', { class: 'mini-comment' },
      c.author_kind === 'agent' ? agentAvatar(c.author) : avatar(c.author, { kind: 'human' }),
      h('div', { class: 'mini-main' },
        h('div', { class: 'meta' }, h('span', { class: 'author' }, c.author), time(c.created_at, { cls: 'mono muted' }), c.asks_human ? h('span', { class: 'label' }, 'asked') : null),
        markdown(c.body)))),
    h('a', { class: 'link', href: `#/issues/${issue.id}` }, `Open ${issue.id}`));
}
