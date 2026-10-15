// munin web UI: routing, the 5-second refresh, the sidebar and keyboard shortcuts.
// Each view exports { load(params), render(data, ctx), title(data) } and optionally
// onKey(e, data, ctx), leave() and scope(params).

import { api, ApiError } from './api.js';
import { store, liveAgents, openCount } from './store.js';
import { h, kbd, icon, avatar, agentAvatar, isActive, updateTimes, toast } from './ui.js';
import { openNewIssue, openNewProject, onCreated } from './dialogs.js';
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
}

// Load the current route and draw it. A poll only redraws when the data changed, and
// holds off while the human is in the middle of something.
async function refresh({ poll = false } = {}) {
  const mine = ++seq;
  const route = parseRoute();
  if (!route) return location.replace('#/inbox');
  try {
    await refreshShared();
    const data = await route.view.load(route.params);
    if (mine !== seq) return;
    setOnline(true);
    const key = JSON.stringify([route.path, data, store.agents.map((a) => a.name)]);
    const sameScope = route.scope === current.scope;
    renderChrome(route, data);
    if (poll && sameScope && (key === current.key || holding())) return updateTimes();
    if (!sameScope) current.view?.leave?.();
    current = { ...route, data, key };
    paint(!sameScope);
  } catch (err) {
    if (mine !== seq) return;
    if (!(err instanceof ApiError)) console.error(err);
    setOnline(!(err instanceof ApiError && !err.status));
    if (poll && route.scope === current.scope) return;
    current.view?.leave?.();
    current = { ...route, view: null, data: null, key: null };
    main.replaceChildren(errorPage(err));
    renderChrome(route, null);
  }
}

function holding() {
  const active = document.activeElement;
  if (active && active.tagName === 'SELECT' && main.contains(active)) return true;
  if (document.body.classList.contains('dragging')) return true;
  const selection = getSelection();
  return Boolean(selection && !selection.isCollapsed && main.contains(selection.anchorNode));
}

// Redraw the view, keeping focus, caret, and scroll positions (keyed by data-keep / data-scroll).
function paint(fresh) {
  const { view, data } = current;
  if (!view) return;
  store.projectKey = data.project?.key || data.issue?.project || null;
  document.title = `${view.title(data)} · munin`;
  if (fresh) {
    main.replaceChildren(view.render(data, ctx));
    main.scrollTop = 0;
    return;
  }
  const active = document.activeElement;
  const keep = active && main.contains(active) ? active.dataset.keep : null;
  const caret = keep && typeof active.selectionStart === 'number'
    ? [active.selectionStart, active.selectionEnd, active.selectionDirection, active.scrollTop] : null;
  const scrolls = [main, ...main.querySelectorAll('[data-scroll]')].map((el) => [el.dataset.scroll || '', el.scrollTop]);

  main.replaceChildren(view.render(data, ctx));

  for (const [name, top] of scrolls) {
    const el = name ? main.querySelector(`[data-scroll="${CSS.escape(name)}"]`) : main;
    if (el) el.scrollTop = top;
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
  const activeAgents = live.filter(isActive);
  const key = JSON.stringify([route.view === inboxView, route.view === agentsView, route.view === projectsView, activeProject,
    store.projects, store.inbox.length, live.map((a) => [a.name, isActive(a)]), store.me]);
  if (key === chromeKey) return;
  chromeKey = key;

  const navItem = (href, lead, label, count, active) => h('a', { class: ['nav-item', active && 'active'], href, 'aria-current': active ? 'page' : null },
    lead, h('span', { class: 'nav-label' }, label), count ? h('span', { class: 'count' }, count) : null);
  const onAgents = route.view === agentsView;

  sidebar.replaceChildren(
    h('a', { class: 'logo', href: '#/inbox', 'aria-label': 'munin inbox' },
      h('img', { src: 'munin-lockup-dither-on-dark.svg', alt: 'munin', width: 122, height: 26 })),
    h('button', { type: 'button', class: 'quick', onclick: openNewIssue }, icon('plus'), h('span', {}, 'New issue'), kbd('C')),
    h('nav', { class: 'nav', 'aria-label': 'Main' },
      navItem('#/inbox', icon('inbox', { color: route.view === inboxView ? '#EDEDED' : '#7A7A7A' }), 'Inbox', store.inbox.length, route.view === inboxView)),
    h('div', { class: 'label nav-heading' }, 'Projects'),
    h('nav', { class: 'nav', 'aria-label': 'Projects' },
      store.projects.map((p) => navItem(`#/projects/${encodeURIComponent(p.key)}`, h('span', { class: 'bullet' }), p.name, openCount(p), p.key === activeProject)),
      h('button', { type: 'button', class: 'nav-item new-project', onclick: openNewProject },
        icon('plus'), h('span', { class: 'nav-label' }, 'New project'))),
    h('div', { class: 'grow' }),
    h('a', { class: ['agents-summary', onAgents && 'active'], href: '#/agents' },
      live.length ? h('span', { class: 'faces' }, live.slice(0, 8).map((a) => agentAvatar(a.name))) : null,
      h('span', { class: 'summary', title: 'Active means it called munin in the last 10 minutes.' },
        live.length ? `${activeAgents.length} agent${activeAgents.length === 1 ? '' : 's'} active, ${live.length - activeAgents.length} idle` : 'No agents connected yet')),
    h('div', { class: 'me' },
      avatar(store.me.name, { kind: 'human' }),
      h('span', { class: 'me-name' }, store.me.name),
      h('a', { class: ['label', 'me-link', onAgents && 'active'], href: '#/agents' }, 'Agents')));

  const tab = (href, iconName, label, active, badge) => h('a', { class: ['tab', active && 'active'], href, 'aria-current': active ? 'page' : null },
    iconName === 'agent' ? avatar('agent', { kind: 'agent', idle: !active, size: 16 }) : icon(iconName, { size: 16, color: active ? '#EDEDED' : '#7A7A7A' }),
    h('span', {}, label),
    badge ? h('span', { class: 'badge' }, badge) : null);
  tabbar.replaceChildren(
    tab('#/inbox', 'inbox', 'Inbox', route.view === inboxView, store.inbox.length),
    tab('#/projects', 'list', 'Projects', route.view === projectsView || route.view === projectView || route.view === issueView),
    h('button', { type: 'button', class: 'tab', onclick: openNewIssue }, icon('plus', { size: 16 }), h('span', {}, 'New')),
    tab('#/agents', 'agent', 'Agents', onAgents));
}

// Keyboard ---------------------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return;
  if (e.key === 'c' || e.key === 'C') {
    e.preventDefault();
    openNewIssue();
  } else if (current.view?.onKey?.(e, current.data, ctx)) {
    e.preventDefault();
  }
});

// Start ------------------------------------------------------------------------

onCreated(() => refresh());
window.addEventListener('hashchange', () => {
  // Leaving a screen ends its one-off state (like a freshly shown token) even if we come straight back.
  const next = parseRoute();
  if (!next || next.scope !== current.scope) current.view?.leave?.();
  refresh();
});

let polling = false;
async function poll() {
  if (document.hidden || polling) return;
  polling = true;
  try {
    await refresh({ poll: true });
  } finally {
    polling = false;
  }
}
setInterval(poll, 5000);
document.addEventListener('visibilitychange', poll);

(async () => {
  try {
    store.me = await api.me();
  } catch (err) {
    toast(err.message, { error: true });
  }
  await refresh();
})();
