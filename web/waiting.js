// Everything waiting on you, from both parts of munin: questions and approvals in agent
// conversations, and the tracker's inbox. A question an agent asked about an issue shows up
// in both; it's listed once, under the agent's conversation.

import { api } from './api.js';
import { runtime } from './runtime/index.js';
import { store } from './store.js';
import { h, agentAvatar, time, firstLine } from './ui.js';
import { openDialog, closeDialog } from './dialogs.js';

export function waitingItems() {
  const fromRuntime = store.waiting.map(({ agent, item }) => ({
    agent: agent.name,
    kind: item.kind === 'approval' ? `Wants to ${item.what}` : item.kind === 'meeting' ? `Calls you into ${item.meeting.title}` : 'Asks',
    text: item.kind === 'approval' ? item.target : item.text,
    at: item.at,
    issue: item.issue,
    href: item.kind === 'meeting' ? `#/meetings/${encodeURIComponent(item.meeting.id)}` : `#/agents/${encodeURIComponent(agent.name)}`,
  }));
  const asked = new Set(store.waiting.map(({ item }) => item.trackerQuestion).filter(Boolean));
  const fromTracker = store.inbox
    .filter((item) => !asked.has(item.question.id))
    .map((item) => ({
      agent: item.question.author,
      kind: 'Asks',
      text: firstLine(item.question.body),
      at: item.question.created_at,
      issue: item.issue,
      href: `#/inbox/${item.question.id}`,
    }));
  return [...fromRuntime, ...fromTracker].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

export function openWaiting() {
  const items = waitingItems();
  const go = (href) => () => {
    closeDialog();
    location.hash = href;
  };
  const rows = items.map((w) => h('button', { type: 'button', class: 'waiting-row', onclick: go(w.href) },
    agentAvatar(w.agent),
    h('span', { class: 'q-main' },
      h('span', { class: 'q-head' },
        h('span', { class: 'q-who' }, h('span', { class: 'q-agent' }, w.agent), h('span', { class: 'label' }, w.kind)),
        time(w.at, { cls: 'q-age' })),
      h('span', { class: 'q-text' }, w.text),
      h('span', { class: 'q-meta' }, w.issue ? `${w.issue.id} · ${w.issue.title}` : 'In the conversation'))));
  const first = rows[0];
  openDialog(h('div', { class: 'sheet waiting' },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, 'Waiting on you'), h('span', { class: 'mono muted' }, items.length)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'waiting-list' }, rows.length ? rows : h('p', { class: 'hint pad' }, 'Nothing is waiting on you.'))), first, 'waiting');
}

// A question about an issue that's gone from the tracker's inbox was answered there, so the
// agent's conversation gets that answer too: the option you picked, or what you wrote.
const syncing = new Set();
export async function syncTrackerAnswers() {
  const open = new Set(store.inbox.map((item) => item.question.id));
  for (const { agent, item } of store.waiting) {
    if (!item.trackerQuestion || open.has(item.trackerQuestion) || syncing.has(item.id)) continue;
    syncing.add(item.id);
    try {
      const issue = await api.issue(item.issue.id);
      const reply = issue.comments.filter((c) => c.author_kind === 'human' && c.id > item.trackerQuestion).pop();
      const option = item.options?.find((o) => o.label === reply?.body.trim());
      await runtime.answer(agent.name, item.id, option ? { option: option.label } : { text: reply?.body || 'Answered in the tracker.' });
    } catch {
      // try again on the next refresh
    } finally {
      syncing.delete(item.id);
    }
  }
}
