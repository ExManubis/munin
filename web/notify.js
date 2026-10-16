// Telling the human something needs them: a count in the tab title, a dot on the favicon,
// and (opt-in) desktop notifications for new questions and work ready for review.

import { api } from './api.js';
import { store, remember } from './store.js';
import { firstLine, toast } from './ui.js';
import { waitingItems } from './waiting.js';

const SETTING = 'munin:notify';
export const notificationsSupported = 'Notification' in window;

export function notificationsOn() {
  return notificationsSupported && remember(SETTING) === '1' && Notification.permission === 'granted';
}

// Returns the resulting permission ("granted", "denied", "default") or "off".
export async function setNotifications(on) {
  if (!on || !notificationsSupported) {
    remember(SETTING, '0');
    return 'off';
  }
  const permission = await Notification.requestPermission();
  remember(SETTING, permission === 'granted' ? '1' : '0');
  lastEventId = null; // start from now, not from old history
  return permission;
}

// Flip the setting, saying what happened.
export async function toggleNotifications() {
  const result = await setNotifications(!notificationsOn());
  if (result === 'granted') toast('Notifications on. munin tells you when an agent asks something or finishes work.');
  else if (result === 'denied') toast('Your browser blocks notifications from munin. Allow them in the site settings, then try again.', { error: true });
  else if (result === 'off') toast('Notifications off.');
  return result;
}

// Title and favicon -----------------------------------------------------------------

let baseTitle = 'munin';

export function setTitle(title) {
  baseTitle = title;
  updateBadges();
}

let badged = null;
// The raven from favicon.svg, on its 16-unit grid.
const RAVEN = 'M2 3H9V4H12V5H14V6H15V7H16V8H14V7H9V8H13V9H8V10H7V11H6V12H5V14H4V13H3V12H2V11H1V9H0V6H1V4H2ZM7 4H6V5H7ZM8 10H9V11H8ZM7 11H8V12H7ZM6 12H7V13H6Z';

export function updateBadges() {
  const waiting = waitingItems().length;
  document.title = waiting ? `(${waiting}) ${baseTitle}` : baseTitle;
  if (badged === waiting > 0) return;
  badged = waiting > 0;
  const link = document.getElementById('favicon');
  if (!badged) {
    link.type = 'image/svg+xml';
    link.href = 'favicon.svg';
    return;
  }
  // The mark in the tab's colour, with a square dot in its empty top-right corner.
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 32;
  const g = canvas.getContext('2d');
  g.fillStyle = matchMedia('(prefers-color-scheme: dark)').matches ? '#f4f4f4' : '#0a0a0a';
  g.scale(2, 2);
  g.fill(new Path2D(RAVEN));
  g.fillRect(12, 0, 4, 4);
  link.type = 'image/png';
  link.href = canvas.toDataURL('image/png');
}

// Desktop notifications --------------------------------------------------------------

let knownQuestions = null;
let lastEventId = null;

function show(title, body, hash) {
  if (document.visibilityState === 'visible' && document.hasFocus()) return; // they're looking already
  const note = new Notification(title, { body, tag: hash, icon: 'android-chrome-192.png' });
  note.onclick = () => {
    window.focus();
    location.hash = hash;
    note.close();
  };
}

// Called after every refresh of the shared data.
export async function checkNotifications() {
  const questions = new Map(store.inbox.map((item) => [item.question.id, item]));
  const fresh = knownQuestions ? [...questions.keys()].filter((id) => !knownQuestions.has(id)) : [];
  knownQuestions = new Set(questions.keys());
  if (!notificationsOn()) return;

  for (const id of fresh) {
    const { question, issue } = questions.get(id);
    show(`${question.author} asks about ${issue.id}`, firstLine(question.body) || issue.title, `#/inbox/${id}`);
  }

  const events = await api.activity({ limit: 20 }).catch(() => []);
  const newest = Math.max(0, ...events.map((e) => e.id));
  if (lastEventId !== null) {
    for (const e of events.reverse()) {
      if (e.id > lastEventId && e.kind === 'status' && e.new === 'in_review' && e.actor_kind === 'agent') {
        show(`${e.issue.id} is ready for review`, `${e.actor}: ${e.issue.title}`, `#/issues/${e.issue.id}`);
      }
    }
  }
  lastEventId = Math.max(lastEventId || 0, newest);
}
