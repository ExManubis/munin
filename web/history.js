// Issue history as short sentences, for the issue timeline and the inbox's "Lately" feed.

import { displayName } from './store.js';
import { h, statusIcon, statusLabel, parseTime } from './ui.js';

// An agent taking an issue is two events a moment apart (status, then assignee); so is
// putting one back on the pile. Merge those pairs into one entry. `events` is oldest first.
export function condense(events) {
  const out = [];
  for (const event of events) {
    const prev = out[out.length - 1];
    const pair = prev && !prev.merged && pairKind(prev, event);
    if (pair) out[out.length - 1] = { ...prev, kind: pair, merged: true, assigneeEvent: event };
    else out.push(event);
  }
  return out;
}

function pairKind(a, b) {
  if (a.actor !== b.actor || (a.issue && b.issue && a.issue.id !== b.issue.id)) return null;
  if (Math.abs(parseTime(b.created_at) - parseTime(a.created_at)) > 1000) return null;
  const status = a.kind === 'status' ? a : b.kind === 'status' ? b : null;
  const assignee = a.kind === 'assignee' ? a : b.kind === 'assignee' ? b : null;
  if (!status || !assignee) return null;
  if (status.new === 'in_progress' && assignee.new === a.actor) return 'take';
  if (status.new === 'todo' && !assignee.new) return 'release';
  return null;
}

// A name in the middle of a sentence: "you" for the human.
const them = (name) => (displayName(name) === 'You' ? 'you' : name);
const refs = (value) => (value ? value.split(',').map((r) => r.trim()).filter(Boolean) : []);

// What happened, after the actor's name: "moved this to In review". `it` names the issue.
export function describe(event, it = 'this') {
  const { kind, old, new: value } = event;
  switch (kind) {
    case 'take': return `took ${it}`;
    case 'release': return `put ${it} back on the pile`;
    case 'created': return `created ${it}`;
    case 'status': return `moved ${it} to ${statusLabel(value)}`;
    case 'assignee':
      if (!value) return `unassigned ${old === event.actor ? (them(old) === 'you' ? 'yourself' : 'themselves') : them(old)} from ${it}`;
      if (value === event.actor) return `assigned ${it} to ${them(value) === 'you' ? 'yourself' : 'themselves'}`;
      return `assigned ${it} to ${them(value)}`;
    case 'title': return `renamed ${it} from “${old}”`;
    case 'description': return it === 'this' ? 'edited the description' : `edited the description of ${it}`;
    case 'blocked_by': {
      const before = refs(old);
      const after = refs(value);
      const added = after.filter((r) => !before.includes(r));
      const removed = before.filter((r) => !after.includes(r));
      if (added.length && removed.length) return `made ${it} wait for ${added.join(', ')} instead of ${removed.join(', ')}`;
      if (added.length) return `made ${it} wait for ${added.join(', ')}`;
      return `made ${it} stop waiting for ${removed.join(', ')}`;
    }
    case 'priority': return value === 'normal' ? `made ${it} normal priority` : `made ${it} ${value}${value === 'urgent' ? '' : ' priority'}`;
    default: return `changed ${kind} on ${it}`;
  }
}

// The pixel icon for an entry: the status it moved to, or a small square.
export function eventIcon(event) {
  if (event.kind === 'take') return statusIcon('in_progress');
  if (event.kind === 'release') return statusIcon('todo');
  if (event.kind === 'status' || event.kind === 'created') return statusIcon(event.new);
  return h('span', { class: 'event-dot', 'aria-hidden': 'true' });
}
