// Everything waiting on you: the agents' questions in the tracker's inbox.

import { store } from './store.js';
import { h, agentAvatar, time, firstLine } from './ui.js';
import { openDialog, closeDialog } from './dialogs.js';

export function waitingItems() {
  return store.inbox
    .map((item) => ({
      agent: item.question.author,
      kind: 'Asks',
      text: firstLine(item.question.body),
      at: item.question.created_at,
      issue: item.issue,
      href: `#/inbox/${item.question.id}`,
    }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
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
      h('span', { class: 'q-meta' }, w.issue ? `${w.issue.id} · ${w.issue.title}` : ''))));
  const first = rows[0];
  openDialog(h('div', { class: 'sheet waiting' },
    h('header', { class: 'sheet-head' },
      h('div', { class: 'sheet-title' }, h('span', { class: 'label' }, 'Waiting on you'), h('span', { class: 'mono muted' }, items.length)),
      h('button', { type: 'button', class: 'close link', onclick: closeDialog }, 'Close')),
    h('div', { class: 'waiting-list' }, rows.length ? rows : h('p', { class: 'hint pad' }, 'Nothing is waiting on you.'))), first, 'waiting');
}
