// Inbox: questions agents asked the human, oldest first. A list on the left and the selected
// question on the right; when the screen is narrow, one question at a time. Below the
// questions, what happened lately. (Setting munin up is setup.js's, the first time it opens.)

import { api } from '../api.js';
import { store, remember, displayName } from '../store.js';
import { markdown } from '../markdown.js';
import { optionRow } from '../cards.js';
import { condense, describe, eventIcon } from '../history.js';
import {
  h, kbd, avatar, agentAvatar, statusIcon, statusLabel, time, topbar, logoMark, bindDraft, drafts, firstLine, toast, onEnterSend, SEND_KEY,
} from '../ui.js';

let showContext = false; // narrow layout: is the issue context expanded?
const picks = new Map(); // question id → the option picked, before sending
let baseline = null; // the newest event id seen before this visit; newer ones get a dot
const SEEN = 'munin:seen-event';

const go = (hash) => location.replace(hash);
const itemHash = (item) => (item ? `#/inbox/${item.question.id}` : '#/inbox');

export const view = {
  scope: () => 'inbox',
  title: () => 'Inbox',

  async load({ qid }) {
    const items = store.inbox;
    const selected = items.find((i) => String(i.question.id) === qid) || items[0] || null;
    const [issue, activity] = await Promise.all([
      selected ? api.issue(selected.issue.id) : null,
      api.activity({ limit: 60 }),
    ]);
    return { items, selectedId: selected ? selected.question.id : null, issue, activity };
  },

  leave() {
    baseline = null;
  },

  render(data, ctx) {
    const feed = lately(data.activity);
    if (!data.items.length) return empty(feed);
    const index = data.items.findIndex((i) => i.question.id === data.selectedId);
    return h('div', { class: 'inbox-wrap' },
      h('div', { class: 'inbox' }, list(data.items, index, feed), detail(data, index, ctx, lately(data.activity))));
  },

  onKey(e, data, ctx) {
    const index = data.items.findIndex((i) => i.question.id === data.selectedId);
    if (e.key === 'j' || e.key === 'ArrowDown') go(itemHash(data.items[Math.min(index + 1, data.items.length - 1)]));
    else if (e.key === 'k' || e.key === 'ArrowUp') go(itemHash(data.items[Math.max(index - 1, 0)]));
    else if ((e.key === 'Enter' || e.key === 'o') && data.issue) location.hash = `#/issues/${data.issue.id}`;
    else if (e.key === 'r') document.querySelector('[data-keep^="answer:"]')?.focus();
    else if (/^[1-9]$/.test(e.key) && data.items[index]?.question.options?.[Number(e.key) - 1]) {
      picks.set(data.items[index].question.id, Number(e.key) - 1);
      ctx.rerender();
    } else return false;
    return true;
  },
};

function empty(feed) {
  return h('div', { class: 'page' },
    topbar([h('span', { class: 'title' }, 'Inbox'), h('span', { class: 'mono muted' }, '0 open')]),
    h('div', { class: 'empty-state' },
      h('div', { class: 'viewfinder' }, h('span', { class: 'mark-frame' }, logoMark())),
      h('h2', {}, 'Nothing is waiting on you'),
      h('p', {}, 'When an agent needs a decision it asks with a comment, and the question lands here, oldest first.')),
    h('div', { class: 'empty-feed' }, feed));
}

// Lately ---------------------------------------------------------------------------------

function seenBefore(activity) {
  const newest = Math.max(0, ...activity.map((e) => e.id));
  const stored = remember(SEEN);
  if (baseline === null) baseline = stored === null ? newest : Number(stored) || 0;
  remember(SEEN, String(Math.max(newest, Number(stored) || 0)));
  return baseline;
}

// The last ~15 things that happened, condensed: no description edits, takes as one line.
function lately(activity) {
  const seen = seenBefore(activity);
  const entries = condense(activity.slice().reverse()).filter((e) => e.kind !== 'description').reverse().slice(0, 15);
  return h('section', { class: 'lately', 'aria-label': 'Lately' },
    h('div', { class: 'list-head' }, h('span', { class: 'label' }, 'Lately')),
    entries.length
      ? entries.map((e) => {
        const fresh = Math.max(e.id, e.assigneeEvent ? e.assigneeEvent.id : 0) > seen;
        return h('a', { class: ['feed-row', fresh && 'fresh'], href: `#/issues/${e.issue.id}`, title: e.issue.title },
          h('span', { class: 'feed-dot', title: fresh ? 'New since your last visit' : null }),
          h('span', { class: 'event-icon' }, eventIcon(e)),
          h('span', { class: 'feed-text' },
            h('span', { class: 'event-actor' }, displayName(e.actor)), ' ', describe(e, e.issue.id),
            h('span', { class: 'feed-title' }, ` · ${e.issue.title}`)),
          time(e.created_at, { cls: 'event-time' }));
      })
      : h('p', { class: 'feed-empty' }, 'Nothing has happened yet.'));
}

function list(items, selected, feed) {
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
      }),
      feed), // scrolls with the questions
    h('footer', { class: 'keys' },
      h('span', {}, kbd('J'), kbd('K'), 'Move'),
      h('span', {}, kbd('↵'), 'Open issue'),
      h('span', {}, kbd('R'), 'Reply')));
}

function detail(data, index, ctx, feed) {
  const { items, issue } = data;
  const item = items[index];
  const q = item.question;
  const agent = q.author;
  const project = store.projects.find((p) => p.key === issue.project);

  // Answering is a human comment, which answers every open question on the issue.
  const others = items.filter((i) => i !== item && i.issue.id === issue.id).length;
  const next = items.slice(index + 1).find((i) => i.issue.id !== issue.id)
    || items.slice(0, index).find((i) => i.issue.id !== issue.id);

  const options = q.options || [];
  const picked = picks.get(q.id);
  const answer = bindDraft(h('textarea', {
    class: 'textarea answer',
    rows: 2,
    placeholder: options.length ? 'Or answer in your own words…' : 'Answer in your own words…',
    'aria-label': `Answer ${agent}`,
  }), `answer:${q.id}`);
  const send = h('button', { type: 'button', class: 'btn primary' }, `Send to ${agent}`, h('span', { class: 'key' }, SEND_KEY));
  // What you write wins over the option picked.
  const submit = async () => {
    const body = answer.value.trim() || (picked !== undefined ? options[picked].label : '');
    if (!body) return answer.focus();
    send.disabled = true;
    try {
      await api.comment(issue.id, body);
      drafts.delete(`answer:${q.id}`);
      picks.delete(q.id);
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
  onEnterSend(answer, submit);

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
          options.length ? h('div', { class: 'options' }, options.map((option, n) => optionRow(n, option, {
            selected: picked === n,
            onclick: () => {
              picks.set(q.id, n);
              ctx.rerender();
            },
          }))) : null,
          answer,
          h('div', { class: 'reply-actions' },
            send,
            h('p', { class: 'hint' },
              `Saved to ${issue.id} as your comment. ${agent} reads it the next time it checks the issue.`,
              others ? ` It also answers ${others} other question${others === 1 ? '' : 's'} on ${issue.id}.` : ''))),
        h('div', { class: 'single-only detail-feed' }, feed))),
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
