// Inbox: questions agents asked the human, oldest first. A list on the left and the selected
// question on the right; when the screen is narrow, one question at a time. Below the
// questions, what happened lately. Before munin is set up, a "Get started" checklist.

import { api } from '../api.js';
import { store, remember, displayName } from '../store.js';
import { markdown } from '../markdown.js';
import { condense, describe, eventIcon } from '../history.js';
import { openNewProject } from '../dialogs.js';
import {
  h, kbd, MOD, avatar, agentAvatar, statusIcon, statusLabel, time, topbar, logoMark,
  bindDraft, drafts, onModEnter, firstLine, toast, copyButton,
} from '../ui.js';

let showContext = false; // narrow layout: is the issue context expanded?
let baseline = null; // the newest event id seen before this visit; newer ones get a dot
const SEEN = 'munin:seen-event';
const ONBOARDING = 'munin:onboarding'; // "active" once the checklist showed, "done" when finished

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

  // An agent connecting isn't announced on the event stream, so check while setup waits for it.
  poll: (data) => !data.items.length && store.agents.some((a) => !a.revoked) && !store.agents.some((a) => a.last_seen_at),

  render(data, ctx) {
    const feed = lately(data.activity);
    if (!data.items.length) {
      const steps = gettingStarted(data.activity);
      return steps ? checklist(steps, feed) : empty(feed);
    }
    const index = data.items.findIndex((i) => i.question.id === data.selectedId);
    return h('div', { class: 'inbox-wrap' },
      h('div', { class: 'inbox' }, list(data.items, index, feed), detail(data, index, ctx, lately(data.activity))));
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

// Get started -------------------------------------------------------------------------------

// The setup steps and whether each is done, or null once munin is set up.
function gettingStarted(activity) {
  const project = store.projects.length > 0;
  const token = store.agents.some((a) => !a.revoked);
  const connected = store.agents.some((a) => a.last_seen_at);
  const working = store.projects.some((p) => (p.counts.in_progress || 0) > 0)
    || store.agents.some((a) => a.working_on.length > 0)
    || activity.some((e) => e.kind === 'created' && e.actor_kind === 'agent');
  const state = remember(ONBOARDING);
  if (project && token && connected && working) {
    if (state === 'active') remember(ONBOARDING, 'done');
    return null;
  }
  // Show it to new setups, and keep showing it until every step is done.
  if (state === 'done' || (state !== 'active' && project && connected)) return null;
  remember(ONBOARDING, 'active');
  return { project, token, connected, working };
}

function checklist(steps, feed) {
  const key = store.projects[0]?.key || 'KEY';
  const command = `claude mcp add --transport http munin ${store.me.mcp_url} --header "Authorization: Bearer <token>"`;
  const slash = `/mcp__munin__continue ${key}`;
  const next = ['project', 'token', 'connected', 'working'].find((s) => !steps[s]);
  const code = (text) => h('div', { class: 'step-code' }, h('code', {}, text), copyButton(() => text));
  const step = (name, title, body, action) => h('li', { class: ['step', steps[name] && 'done', name === next && 'next'] },
    statusIcon(steps[name] ? 'done' : 'todo', true),
    h('div', { class: 'step-main' }, h('div', { class: 'step-title' }, title), h('div', { class: 'step-body' }, body)),
    steps[name] ? null : action);
  const primaryIf = (name) => (name === next ? 'btn primary small' : 'btn small');
  return h('div', { class: 'page' },
    topbar([h('span', { class: 'title' }, 'Inbox'), h('span', { class: 'mono muted' }, '0 open')]),
    h('div', { class: 'getting-started' },
      h('div', { class: 'label' }, 'Get started'),
      h('h1', { class: 'h1' }, 'Set up munin'),
      h('p', { class: 'lead' }, 'Four steps. Each one ticks itself off as you go, and then this becomes your inbox.'),
      h('ol', { class: 'steps' },
        step('project', 'Create a project', 'A project holds a pile of issues and a brief that agents read before they start.',
          h('button', { type: 'button', class: primaryIf('project'), onclick: openNewProject }, 'New project')),
        step('token', 'Add an agent token', 'Each agent gets its own token, so you can revoke one without touching the others.',
          h('a', { class: primaryIf('token'), href: '#/agents' }, 'Open Agents')),
        step('connected', 'Connect it', ['Run this where the agent works, with its token in place of <token>:', code(command)]),
        step('working', 'Put it to work', ['In Claude Code, run this and the agent takes the top of the pile:', code(slash)])),
      feed));
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
