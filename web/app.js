// munin web UI: the topbar, routing, live updates, each part's sidebar and keyboard shortcuts.
// munin has two parts, each with its own sidebar: AGENTS (munin's own agents, from the agent
// runtime) and TRACKER (issues, from the tracker). Settings sits behind your square. Without a
// runtime there's no AGENTS part, until one turns up.
//
// Each view exports { load(params), render(data, ctx), title(data) } and optionally
// onKey(e, data, ctx), leave(), scope(params) and poll(data), which asks for polling
// while it waits on something the event stream doesn't announce.

import { api, ApiError } from './api.js';
import { runtime } from './runtime/index.js';
import { store, liveAgents, openCount, isWorking, isBusy, remember } from './store.js';
import { h, kbd, MOD, icon, agentAvatar, updateTimes, toast } from './ui.js';
import { figbot } from './figbot.js';
import { openNewIssue, openNewProject, openShortcuts, onCreated, dialogOpen, closeDialog } from './dialogs.js';
import { openPalette } from './palette.js';
import { openWaiting, waitingItems, syncTrackerAnswers } from './waiting.js';
import { setTitle, updateBadges, checkNotifications } from './notify.js';
import { view as inboxView } from './views/inbox.js';
import { view as projectView, indexView as projectsView } from './views/project.js';
import { view as issueView } from './views/issue.js';
import { view as settingsView } from './views/settings.js';
import { indexView as agentsIndexView, agentsSidebar } from './views/agents.js';
import { view as conversationView } from './views/conversation.js';
import { view as profileView } from './views/profile.js';
import { view as newAgentView } from './views/new-agent.js';
import { openSetup, setupOpen } from './setup.js';

const ROUTES = [
  [/^\/agents$/, agentsIndexView, () => ({}), 'agents'],
  [/^\/agents\/new$/, newAgentView, () => ({}), 'agents'],
  [/^\/agents\/([^/]+)$/, conversationView, (m) => ({ name: decodeURIComponent(m[1]) }), 'agents'],
  [/^\/agents\/([^/]+)\/profile$/, profileView, (m) => ({ name: decodeURIComponent(m[1]) }), 'agents'],
  [/^\/inbox(?:\/(\d+))?$/, inboxView, (m) => ({ qid: m[1] }), 'tracker'],
  [/^\/projects$/, projectsView, () => ({}), 'tracker'],
  [/^\/projects\/([^/]+)$/, projectView, (m) => ({ key: decodeURIComponent(m[1]).toUpperCase() }), 'tracker'],
  [/^\/issues\/([^/]+)$/, issueView, (m) => ({ id: decodeURIComponent(m[1]).toUpperCase() }), 'tracker'],
  [/^\/settings$/, settingsView, () => ({}), 'settings'],
];
const HOME = { agents: '#/agents', tracker: '#/inbox' };
const hasAgents = () => runtime.kind !== 'none';
const home = () => (hasAgents() ? HOME.agents : HOME.tracker);

const app = document.getElementById('app');
const appbar = document.getElementById('appbar');
const main = document.getElementById('main');
const sidebar = document.getElementById('sidebar');
const tabbar = document.getElementById('tabbar');
const offline = document.getElementById('offline');

let current = { path: null, scope: null, view: null, params: null, data: null, key: null, section: null };
let seq = 0;
let stale = false; // a live update arrived while the human was in the middle of something

function parseRoute() {
  const path = location.hash.replace(/^#/, '') || remember('munin:section-path') || home().slice(1);
  for (const [pattern, view, params, section] of ROUTES) {
    const m = path.match(pattern);
    if (m) {
      const p = params(m);
      return { path, view, params: p, section, scope: view.scope ? view.scope(p) : path };
    }
  }
  return null;
}

const ctx = {
  rerender: () => paint(false),
  reload: () => refresh(),
};

// The tracker's projects, inbox and agents, and the runtime's agents and what's waiting.
// A change in the runtime alone doesn't need the tracker asked again.
async function refreshShared({ tracker = true } = {}) {
  const [runtimeAgents, waiting, ...rest] = await Promise.all([
    runtime.agents(),
    runtime.waiting(),
    ...(tracker ? [api.projects(), api.inbox(), api.agents(), api.snoozed()] : []),
  ]);
  Object.assign(store, { runtimeAgents, waiting });
  if (tracker) {
    const [projects, inbox, agents, snoozed] = rest;
    Object.assign(store, { projects, inbox, agents, snoozed });
    wakeAt(snoozed);
    checkNotifications();
    syncTrackerAnswers();
  }
  updateBadges();
}

// A snoozed question comes back on its own: look again when the first one's time comes.
let wakeTimer;
function wakeAt(snoozed) {
  clearTimeout(wakeTimer);
  const first = Math.min(...snoozed.map((item) => Date.parse(item.issue.snoozed_until)).filter(Number.isFinite));
  if (Number.isFinite(first)) wakeTimer = setTimeout(() => liveRefresh(), Math.min(Math.max(first - Date.now(), 0) + 500, 2 ** 31 - 1));
}

// Load the current route and draw it. A live update (`live`) only redraws when the data
// changed, and holds off while the human is in the middle of something.
async function refresh({ live = false, tracker = true } = {}) {
  const mine = ++seq;
  const route = parseRoute();
  if (!route) return location.replace(home());
  if (route.section === 'agents' && !hasAgents()) return location.replace(sectionHref('tracker'));
  try {
    await refreshShared({ tracker });
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

// What of the shared data screens show besides their own: agents (connected, quiet, busy),
// projects, and the runtime's agents. Raw last-seen times are left out so every agent call
// doesn't redraw.
function sharedState() {
  return [
    store.agents.map((a) => [a.name, a.revoked, isBusy(a), a.working_on.map((w) => w.id + w.status),
      !a.last_seen_at ? 'never' : Date.now() - Date.parse(a.last_seen_at) < 30 * 60 * 1000 ? 'live' : 'quiet']),
    store.projects,
    store.runtimeAgents,
    store.inbox.map((item) => item.question.id),
    store.snoozed.map((item) => [item.question.id, item.issue.snoozed_until]),
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
// A [data-stick] element that was scrolled to the bottom stays at the bottom, like a chat.
function paint(fresh) {
  const { view, data } = current;
  if (!view) return;
  store.projectKey = data.project?.key || data.issue?.project || null;
  setTitle(`${view.title(data)} · munin`);
  if (fresh) {
    main.replaceChildren(view.render(data, ctx));
    main.scrollTop = 0;
    for (const el of main.querySelectorAll('[data-stick]')) el.scrollTop = el.scrollHeight;
    return;
  }
  const active = document.activeElement;
  const keep = active && main.contains(active) ? active.dataset.keep : null;
  const caret = keep && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection, active.scrollTop] : null;
  const scrolls = [main, ...main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll || '', el.scrollTop, el.scrollLeft,
    el.dataset.stick !== undefined && el.scrollHeight - el.scrollTop - el.clientHeight < 48]);

  main.replaceChildren(view.render(data, ctx));

  for (const [name, top, left, bottom] of scrolls) {
    const el = name ? main.querySelector(`[data-scroll="${CSS.escape(name)}"]`) : main;
    if (!el) continue;
    el.scrollTop = bottom ? el.scrollHeight : top;
    el.scrollLeft = left;
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
      h('p', {}, h('a', { class: 'link', href: home() }, hasAgents() ? 'Back to your figbots' : 'Back to the inbox'))));
}

function setOnline(ok) {
  offline.hidden = ok;
}

// Topbar, sidebars and the phone tab bar ---------------------------------------------------

let chromeKey = null;

function renderChrome(route, data) {
  const waiting = waitingItems();
  // Each part's tab goes back to where you were in it.
  if (route.section !== 'settings') {
    remember(`munin:last-${route.section}`, route.path);
    remember('munin:section-path', route.path);
  }
  document.body.dataset.section = route.section;
  document.body.classList.toggle('in-conversation', route.view === conversationView);
  app.className = `app section-${route.section}`;

  const key = JSON.stringify([route.path, route.section, data?.issue?.project, store.projects, store.inbox.length,
    liveAgents().map((a) => [a.name, isWorking(a)]), store.runtimeAgents, waiting.length, store.me, runtime.kind]);
  if (key === chromeKey) return;
  chromeKey = key;

  renderAppbar(route, waiting);
  if (route.section === 'agents') sidebar.replaceChildren(...agentsSidebar(route));
  else if (route.section === 'settings') sidebar.replaceChildren(...settingsSidebar());
  else sidebar.replaceChildren(...trackerSidebar(route, data));
  renderTabbar(route);
}

function sectionHref(section) {
  const last = remember(`munin:last-${section}`);
  return last ? `#${last}` : HOME[section];
}

function renderAppbar(route, waiting) {
  const tab = (section, label) => h('a', {
    class: ['section-tab', route.section === section && 'active'],
    href: sectionHref(section),
    'aria-current': route.section === section ? 'page' : null,
  }, label);
  appbar.replaceChildren(...[
    h('a', { class: 'logo', href: home(), 'aria-label': 'munin' },
      h('img', { src: 'munin-lockup-dither-on-dark.svg', alt: 'munin', width: 122, height: 26 })),
    hasAgents() ? h('nav', { class: 'section-tabs', 'aria-label': 'Parts of munin' }, tab('agents', 'Figbots'), tab('tracker', 'Tracker')) : null,
    h('div', { class: 'grow' }),
    h('button', { type: 'button', class: 'quick', onclick: openPalette }, icon('search'), h('span', {}, 'Search or jump to…'), kbd(`${MOD}K`)),
    waiting.length
      ? h('button', { type: 'button', class: 'chip waiting-chip', onclick: openWaiting, 'aria-haspopup': 'dialog' }, `${waiting.length} waiting on you`)
      : null,
    meSquare(route),
  ].filter(Boolean)); // replaceChildren would write a null out as "null"
}

// Your square: what agents call you (from setup), or who's looking when Tailscale says
// (behind the edge), or else the name your comments get (MUNIN_USER).
function meSquare(route) {
  const { you } = store.me;
  const name = (store.human || you?.name || store.me.name).trim();
  return h('a', {
    class: ['me-square', route.section === 'settings' && 'active'],
    href: '#/settings',
    title: `${you ? `${you.name} (${you.login})` : name} · Settings`,
    'aria-label': 'Settings',
  }, (name[0] || '?').toUpperCase());
}

function trackerSidebar(route, data) {
  const activeProject = route.view === projectView ? route.params.key
    : route.view === issueView && data ? data.issue.project : null;
  const live = liveAgents();
  const working = live.filter(isWorking);
  const onInbox = route.view === inboxView;
  const navItem = (href, lead, label, count, active) => h('a', { class: ['nav-item', active && 'active'], href, 'aria-current': active ? 'page' : null },
    lead, h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'count' }, count) : null);

  return [
    h('nav', { class: 'nav', 'aria-label': 'Tracker' },
      navItem('#/inbox', icon('inbox', { color: onInbox ? '#EDEDED' : '#7A7A7A' }), 'Inbox', store.inbox.length, onInbox),
      h('button', { type: 'button', class: 'nav-item', onclick: openNewIssue }, icon('plus'), h('span', { class: 'nav-label' }, 'New issue'), kbd('C'))),
    h('div', { class: 'label nav-heading' }, 'Projects'),
    h('nav', { class: 'nav', 'aria-label': 'Projects' },
      store.projects.map((p) => navItem(`#/projects/${encodeURIComponent(p.key)}`, h('span', { class: 'bullet' }), p.name, openCount(p), p.key === activeProject)),
      h('button', { type: 'button', class: 'nav-item new-project', onclick: openNewProject },
        icon('plus'), h('span', { class: 'nav-label' }, 'New project'))),
    h('div', { class: 'grow' }),
    h('a', { class: 'agents-summary', href: '#/settings', title: 'Agents connected to the tracker' },
      live.length ? h('span', { class: 'faces' }, live.slice(0, 8).map((a) => agentAvatar(a.name))) : null,
      h('span', { class: 'summary' },
        live.length
          ? `${working.length} agent${working.length === 1 ? '' : 's'} working, ${live.length - working.length} idle`
          : 'No agents connected yet')),
  ];
}

function settingsSidebar() {
  const jump = (id, label) => h('button', {
    type: 'button',
    class: 'nav-item',
    onclick: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }, h('span', { class: 'nav-label' }, label));
  return [
    h('div', { class: 'label nav-heading first' }, 'Settings'),
    h('nav', { class: 'nav', 'aria-label': 'Settings' },
      ...(hasAgents() ? [
        jump('providers', 'Models and providers'),
        jump('google', 'Google'),
        jump('apps', 'Apps'),
        store.projects.length ? jump('code', 'Code') : null,
      ] : [jump('runtime', 'Agent runtime')]),
      jump('github', 'GitHub'),
      jump('outside-agents', 'Outside agents'),
      jump('notifications', 'Notifications'),
      hasAgents() ? jump('setup', 'Setup') : null,
      runtime.kind === 'mock' ? jump('dummy', 'Dummy data') : null),
  ];
}

function renderTabbar(route) {
  const onAgents = route.section === 'agents';
  const onTracker = route.section === 'tracker';
  const tab = (href, lead, label, active, badge) => h('a', { class: ['tab', active && 'active'], href, 'aria-current': active ? 'page' : null },
    lead, h('span', {}, label), badge ? h('span', { class: 'badge' }, badge) : null);
  const action = (iconName, label, onclick) => h('button', { type: 'button', class: 'tab', onclick }, icon(iconName, { size: 16 }), h('span', {}, label));
  const agentsWaiting = store.waiting.length;
  tabbar.replaceChildren(...[
    hasAgents() ? tab(sectionHref('agents'), figbot({ size: 18, state: 'idle', animate: false, cls: onAgents ? null : 'dim' }), 'Figbots', onAgents, agentsWaiting) : null,
    tab(sectionHref('tracker'), icon('inbox', { size: 16, color: onTracker ? '#EDEDED' : '#7A7A7A' }), 'Tracker', onTracker, store.inbox.length),
    action('plus', 'New', () => (onAgents ? (location.hash = '#/agents/new') : openNewIssue())),
    action('search', 'Search', openPalette),
  ].filter(Boolean));
}

// Keyboard ---------------------------------------------------------------------

let pendingG = 0;

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || setupOpen()) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (dialogOpen('palette')) closeDialog();
    else if (!dialogOpen()) openPalette();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !dialogOpen()
    && !(e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]'))) {
    if (current.view?.onSubmit?.(e, current.data, ctx)) e.preventDefault();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (dialogOpen()) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
  // G then F (or A, as it was) or T: go to Figbots or the Tracker.
  if (Date.now() - pendingG < 1200 && (hasAgents() ? /^[aft]$/i : /^t$/i).test(e.key)) {
    e.preventDefault();
    pendingG = 0;
    location.hash = sectionHref(e.key.toLowerCase() === 't' ? 'tracker' : 'agents');
    return;
  }
  if (e.key === 'g' || e.key === 'G') {
    pendingG = Date.now();
    return;
  }
  if (current.view?.onKey?.(e, current.data, ctx)) {
    e.preventDefault();
  } else if ((e.key === 'c' || e.key === 'C') && current.section === 'tracker') {
    e.preventDefault();
    openNewIssue();
  } else if ((e.key === 'n' || e.key === 'N') && current.section === 'agents') {
    e.preventDefault();
    location.hash = '#/agents/new';
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  }
});

// Live updates -----------------------------------------------------------------------
// The tracker says "changed" over /api/stream and the runtime calls back; we refresh shortly
// after. Polling only runs while the tracker's stream is down.

let running = false;
let again = null;
async function liveRefresh(options = {}) {
  if (running) {
    again = { tracker: Boolean(again?.tracker || options.tracker !== false) };
    return;
  }
  running = true;
  try {
    await refresh({ live: true, ...options });
  } finally {
    running = false;
    if (again) {
      const next = again;
      again = null;
      liveRefresh(next);
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
  stream.addEventListener('reset', () => liveRefresh()); // missed too much while away: reload it all
  stream.addEventListener('error', () => {
    streamUp = false; // EventSource reconnects by itself
  });
}

let runtimeDebounce;
runtime.subscribe(() => {
  clearTimeout(runtimeDebounce);
  runtimeDebounce = setTimeout(() => liveRefresh({ tracker: false }), 60);
});

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
addEventListener('munin:setup-closed', () => refresh());
window.addEventListener('hashchange', () => {
  // #/setup opens setup over wherever you were.
  if (location.hash === '#/setup') {
    history.replaceState(null, '', current.path ? `#${current.path}` : home());
    openSetup();
    return;
  }
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
  // Setup, the first time munin opens (with its intro), until it's done; or when #/setup asks.
  const about = await runtime.me().catch(() => null);
  store.human = about?.name && about.name !== 'me' ? about.name : null;
  const asked = location.hash === '#/setup';
  if (asked) history.replaceState(null, '', `#${remember('munin:section-path') || home().slice(1)}`);
  if (!location.hash) location.replace(parseRoute() ? `#${parseRoute().path}` : home());
  if (asked || (about && about.setup !== 'done')) openSetup({ intro: !asked && !about.setup });
  await refresh();
  connect();
  // The dummy's cast talks about issues by title; find them, and its questions, in this tracker.
  runtime.linkTracker?.({
    findIssue: async (title) => (await api.issues({ q: title, status: 'all', limit: 1 }))[0] || null,
    findQuestion: (agent, issueId) => store.inbox.find((q) => q.question.author === agent && q.issue.id === issueId)?.question.id || null,
  });
})();
