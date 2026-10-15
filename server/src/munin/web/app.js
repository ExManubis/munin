// munin web UI: routing, live updates, the sidebar and keyboard shortcuts.
// Each view exports { load(params), render(data, ctx), title(data) } and optionally
// onKey(e, data, ctx), leave(), scope(params) and poll(data), which asks for polling
// while it waits on something the event stream doesn't announce.

import { api, ApiError } from './api.js';
import { store, liveAgents, openCount, isWorking } from './store.js';
import { h, kbd, MOD, icon, avatar, agentAvatar, updateTimes, toast } from './ui.js';
import { openNewIssue, openNewProject, openShortcuts, onCreated, dialogOpen, closeDialog } from './dialogs.js';
import { openPalette } from './palette.js';
import { setTitle, updateBadges, checkNotifications } from './notify.js';
import { view as inboxView } from './views/inbox.js';
import { view as projectView, indexView as projectsView } from './views/project.js';
import { view as issueView } from './views/issue.js';
import { view as agentsView } from './views/agents.js';

const ROUTES = [
  [/^\/inbox(?:\/(\d+))?$/, inboxView, (m) => ({ qid: m[1] })],
  [/^\/projects$/, projectsView, () => ({})],
  [/^\/projects\/([^/]+)$/, projectView, (m) => ({ key: decodeURIComponent(m[1]).toUpperCase() })],
  [/^\/issues\/([^/]+)$/, issueView, (m) => ({ id: decodeURIComponent(m[1]).toUpperCase() })],
  [/^\/agents$/, agentsView, () => ({})],
];

const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');
const offline = document.getElementById('offline');

let current = { path: null, scope: null, view: null, params: null, data: null, key: null };
let seq = 0;
let stale = false; // a live update arrived while the human was in the middle of something

function parseRoute() {
  const path = location.hash.replace(/^#/, '') || '/inbox';
  for (const [pattern, view, params] of ROUTES) {
    const m = path.match(pattern);
    if (m) {
      const p = params(m);
      return { path, view, params: p, scope: view.scope ? view.scope(p) : path };
    }
  }
  return null;
}

const ctx = {
  rerender: () => paint(false),
  reload: () => refresh(),
};

async function refreshShared() {
  const [projects, inbox, agents] = await Promise.all([api.projects(), api.inbox(), api.agents()]);
  Object.assign(store, { projects, inbox, agents });
  updateBadges();
  checkNotifications();
}

// Load the current route and draw it. A live update (`live`) only redraws when the data
// changed, and holds off while the human is in the middle of something.
async function refresh({ live = false } = {}) {
  const mine = ++seq;
  const route = parseRoute();
  if (!route) return location.replace('#/inbox');
  try {
    await refreshShared();
    const data = await route.view.load(route.params);
    if (mine !== seq) return;
    setOnline(true);
    const key = JSON.stringify([route.path, data, sharedState()]);
    const sameScope = route.scope === current.scope;
    renderChrome(route, data);
    if (live && sameScope && key === current.key) return updateTimes();
    if (live && sameScope && holding()) {
      stale = true;
      return updateTimes();
    }
    if (!sameScope) current.view?.leave?.();
    current = { ...route, data, key };
    stale = false;
    paint(!sameScope);
  } catch (err) {
    if (mine !== seq) return;
    if (!(err instanceof ApiError)) console.error(err);
    setOnline(!(err instanceof ApiError && !err.status));
    if (live && route.scope === current.scope) return;
    current.view?.leave?.();
    current = { ...route, view: null, data: null, key: null };
    main.replaceChildren(errorPage(err));
    setTitle('munin');
    renderChrome(route, null);
  }
}

// What of the shared data screens show besides their own: agents (connected, quiet, busy)
// and projects. Raw last-seen times are left out so every agent call doesn't redraw.
function sharedState() {
  return [
    store.agents.map((a) => [a.name, a.revoked, a.working_on.map((w) => w.id + w.status),
      !a.last_seen_at ? 'never' : Date.now() - Date.parse(a.last_seen_at) < 30 * 60 * 1000 ? 'live' : 'quiet']),
    store.projects,
  ];
}

// The human is choosing from a dropdown or a picker, dragging, or selecting text.
function holding() {
  const active = document.activeElement;
  if (active && main.contains(active) && (active.tagName === 'SELECT' || active.closest('.picker'))) return true;
  if (document.body.classList.contains('dragging')) return true;
  const selection = getSelection();
  return Boolean(selection && !selection.isCollapsed && main.contains(selection.anchorNode));
}

// Redraw the view, keeping focus, caret, and scroll positions (keyed by data-keep / data-scroll).
function paint(fresh) {
  const { view, data } = current;
  if (!view) return;
  store.projectKey = data.project?.key || data.issue?.project || null;
  setTitle(`${view.title(data)} · munin`);
  if (fresh) {
    main.replaceChildren(view.render(data, ctx));
    main.scrollTop = 0;
    return;
  }
  const active = document.activeElement;
  const keep = active && main.contains(active) ? active.dataset.keep : null;
  const caret = keep && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection, active.scrollTop] : null;
  const scrolls = [main, ...main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll || '', el.scrollTop, el.scrollLeft]);

  main.replaceChildren(view.render(data, ctx));

  for (const [name, top, left] of scrolls) {
    const el = name ? main.querySelector(`[data-scroll="${CSS.escape(name)}"]`) : main;
    if (el) {
      el.scrollTop = top;
      el.scrollLeft = left;
    }
  }
  if (keep) {
    const el = main.querySelector(`[data-keep="${CSS.escape(keep)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      if (caret && typeof el.setSelectionRange === 'function') {
        el.setSelectionRange(caret[0], caret[1], caret[2]);
        el.scrollTop = caret[3];
      }
    }
  }
}

function errorPage(err) {
  return h('div', { class: 'page' },
    h('header', { class: 'topbar' }, h('div', { class: 'topbar-left' }, h('span', { class: 'title' }, err.status === 404 ? 'Not found' : 'Something went wrong'))),
    h('div', { class: 'empty-state small' },
      h('h2', {}, err.message),
      h('p', {}, h('a', { class: 'link', href: '#/inbox' }, 'Back to the inbox'))));
}

function setOnline(ok) {
  offline.hidden = ok;
}

// Sidebar and phone tab bar ---------------------------------------------------------

let chromeKey = null;

function renderChrome(route, data) {
  const activeProject = route.view === projectView ? route.params.key
    : route.view === issueView && data ? data.issue.project : null;
  const live = liveAgents();
  const working = live.filter(isWorking);
  const key = JSON.stringify([route.view === inboxView, route.view === agentsView, route.view === projectsView, activeProject,
    store.projects, store.inbox.length, live.map((a) => [a.name, isWorking(a)]), store.me]);
  if (key === chromeKey) return;
  chromeKey = key;

  const navItem = (href, lead, label, count, active) => h('a', { class: ['nav-item', active && 'active'], href, 'aria-current': active ? 'page' : null },
    lead, h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'count' }, count) : null);
  const onAgents = route.view === agentsView;
  const onInbox = route.view === inboxView;

  sidebar.replaceChildren(
    h('a', { class: 'logo', href: '#/inbox', 'aria-label': 'munin inbox' },
      h('img', { src: 'munin-lockup-dither-on-dark.svg', alt: 'munin', width: 122, height: 26 })),
    h('button', { type: 'button', class: 'quick', onclick: openPalette }, icon('search'), h('span', {}, 'Search or jump to…'), kbd(`${MOD}K`)),
    h('nav', { class: 'nav', 'aria-label': 'Main' },
      navItem('#/inbox', icon('inbox', { color: onInbox ? '#EDEDED' : '#7A7A7A' }), 'Inbox', store.inbox.length, onInbox),
      h('button', { type: 'button', class: 'nav-item', onclick: openNewIssue }, icon('plus'), h('span', { class: 'nav-label' }, 'New issue'), kbd('C'))),
    h('div', { class: 'label nav-heading' }, 'Projects'),
    h('nav', { class: 'nav', 'aria-label': 'Projects' },
      store.projects.map((p) => navItem(`#/projects/${encodeURIComponent(p.key)}`, h('span', { class: 'bullet' }), p.name, openCount(p), p.key === activeProject)),
      h('button', { type: 'button', class: 'nav-item new-project', onclick: openNewProject },
        icon('plus'), h('span', { class: 'nav-label' }, 'New project'))),
    h('div', { class: 'grow' }),
    h('a', { class: ['agents-summary', onAgents && 'active'], href: '#/agents' },
      live.length ? h('span', { class: 'faces' }, live.slice(0, 8).map((a) => agentAvatar(a.name))) : null,
      h('span', { class: 'summary' },
        live.length
          ? `${working.length} agent${working.length === 1 ? '' : 's'} working, ${live.length - working.length} idle`
          : 'No agents connected yet')),
    h('div', { class: 'me' },
      avatar(store.me.name, { kind: 'human' }),
      h('span', { class: 'me-name' }, store.me.name),
      h('a', { class: ['label', 'me-link', onAgents && 'active'], href: '#/agents' }, 'Agents')));

  const tab = (href, iconName, label, active, badge) => h('a', { class: ['tab', active && 'active'], href, 'aria-current': active ? 'page' : null },
    iconName === 'agent' ? avatar('agent', { kind: 'agent', idle: !active, size: 16 }) : icon(iconName, { size: 16, color: active ? '#EDEDED' : '#7A7A7A' }),
    h('span', {}, label),
    badge ? h('span', { class: 'badge' }, badge) : null);
  const action = (iconName, label, onclick) => h('button', { type: 'button', class: 'tab', onclick }, icon(iconName, { size: 16 }), h('span', {}, label));
  tabbar.replaceChildren(
    tab('#/inbox', 'inbox', 'Inbox', onInbox, store.inbox.length),
    tab('#/projects', 'list', 'Projects', route.view === projectsView || route.view === projectView || route.view === issueView),
    action('plus', 'New', openNewIssue),
    action('search', 'Search', openPalette),
    tab('#/agents', 'agent', 'Agents', onAgents));
}

// Keyboard ---------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (dialogOpen('palette')) closeDialog();
    else if (!dialogOpen()) openPalette();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (dialogOpen()) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    openNewIssue();
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  } else if (current.view?.onKey?.(e, current.data, ctx)) {
    e.preventDefault();
  }
});

// Live updates -----------------------------------------------------------------------
// The server says "changed" over /api/stream; we refresh shortly after. Polling only
// runs while the stream is down.

let running = false;
let again = false;
async function liveRefresh() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    await refresh({ live: true });
  } finally {
    running = false;
    if (again) {
      again = false;
      liveRefresh();
    }
  }
}

let streamUp = false;
let debounce;
function connect() {
  const stream = new EventSource('/api/stream');
  stream.addEventListener('open', () => {
    if (!streamUp) liveRefresh(); // catch up on anything missed while it was down
    streamUp = true;
  });
  stream.addEventListener('changed', () => {
    clearTimeout(debounce);
    debounce = setTimeout(liveRefresh, 150);
  });
  stream.addEventListener('error', () => {
    streamUp = false; // EventSource reconnects by itself
  });
}

setInterval(() => {
  if (!streamUp && !document.hidden) liveRefresh();
}, 15000);
setInterval(() => {
  if (streamUp && !document.hidden && current.view?.poll?.(current.data)) liveRefresh();
}, 5000);
let ticks = 0;
setInterval(() => {
  if (++ticks % 15 === 0) updateTimes();
  if (stale && !holding()) liveRefresh();
}, 1000);
document.addEventListener('visibilitychange', () => !document.hidden && liveRefresh());

// Start ------------------------------------------------------------------------

onCreated(() => refresh());
window.addEventListener('hashchange', () => {
  // Leaving a screen ends its one-off state (like a freshly shown token) even if we come straight back.
  const next = parseRoute();
  if (!next || next.scope !== current.scope) current.view?.leave?.();
  refresh();
});

(async () => {
  try {
    store.me = await api.me();
  } catch (err) {
    toast(err.message, { error: true });
  }
  await refresh();
  connect();
})();
