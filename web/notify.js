// Telling the human something needs them: a count in the tab title, a dot on the favicon,
// and (opt-in) notifications. Where the browser can, they're push notifications that reach this
// device with munin closed: questions and work for review, through push/tracker/sw.js.
// Elsewhere munin shows notifications itself, while it's open in a tab.

import { api } from './api.js';
import { store, remember } from './store.js';
import { firstLine, toast } from './ui.js';
import { waitingItems } from './waiting.js';

const SETTING = 'munin:notify';
export const notificationsSupported = 'Notification' in window;
export const pushSupported = notificationsSupported && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

export function notificationsOn() {
  return notificationsSupported && remember(SETTING) === '1' && Notification.permission === 'granted';
}

// The services that push, as this page reaches them.
const pushers = () => [
  { name: 'tracker', status: () => api.push(), save: (s) => api.subscribePush(s), forget: (e) => api.forgetPush(e) },
];
const keyBytes = (key) => Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (key.length % 4)) % 4)), (c) => c.charCodeAt(0));
const sameKey = (buffer, bytes) => Boolean(buffer) && new Uint8Array(buffer).every((b, i) => b === bytes[i]) && buffer.byteLength === bytes.length;

async function activated(registration) {
  if (registration.active) return registration;
  const worker = registration.installing || registration.waiting;
  await new Promise((resolve) => worker.addEventListener('statechange', () => worker.state === 'activated' && resolve()));
  return registration;
}

// This device, subscribed to every service that pushes, with each one's current key.
async function subscribeAll() {
  for (const pusher of pushers()) {
    const { key } = await pusher.status();
    if (!key) continue;
    const registration = await activated(await navigator.serviceWorker.register(`push/${pusher.name}/sw.js`, { scope: `push/${pusher.name}/` }));
    const wanted = keyBytes(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !sameKey(subscription.options.applicationServerKey, wanted)) {
      await subscription.unsubscribe(); // the service has new keys
      subscription = null;
    }
    subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wanted });
    await pusher.save(subscription.toJSON());
  }
}

async function unsubscribeAll() {
  for (const pusher of pushers()) {
    const registration = await navigator.serviceWorker.getRegistration(`push/${pusher.name}/`);
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) continue;
    await pusher.forget(subscription.endpoint).catch(() => {});
    await subscription.unsubscribe();
  }
}

// Returns the resulting permission ("granted", "denied", "default"), "off", or "failed".
export async function setNotifications(on) {
  if (!on || !notificationsSupported) {
    remember(SETTING, '0');
    if (pushSupported) await unsubscribeAll().catch(() => {});
    return 'off';
  }
  const permission = await Notification.requestPermission();
  if (permission === 'granted' && pushSupported) {
    try {
      await subscribeAll();
    } catch (err) {
      remember(SETTING, '0');
      lastFailure = err.message;
      return 'failed';
    }
  }
  remember(SETTING, permission === 'granted' ? '1' : '0');
  lastEventId = null; // start from now, not from old history
  return permission;
}
let lastFailure = null;

// Flip the setting, saying what happened.
export async function toggleNotifications() {
  const result = await setNotifications(!notificationsOn());
  if (result === 'granted') toast(pushSupported ? 'Notifications on for this device: questions and work for review reach it, even with munin closed.' : 'Notifications on. munin tells you when an agent asks something or finishes work, while it\'s open in a tab.');
  else if (result === 'denied') toast('Your browser blocks notifications from munin. Allow them in the site settings, then try again.', { error: true });
  else if (result === 'failed') toast(`munin couldn't set up notifications on this device: ${lastFailure}`, { error: true });
  else if (result === 'off') toast('Notifications off.');
  return result;
}

// On start: keep this device's subscription current (the tracker may have new keys), drop the
// one munin's agent runtime had before it moved out (figbots), and go where a tapped
// notification points.
if (pushSupported) {
  if (notificationsOn()) subscribeAll().catch(() => {});
  navigator.serviceWorker.getRegistration('push/runtime/')
    .then((old) => old && old.scope.endsWith('/push/runtime/') && old.unregister()).catch(() => {});
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.munin === 'open') location.hash = event.data.hash || '#/';
  });
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
  if (pushSupported) return; // the services push it, so it isn't shown twice
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
