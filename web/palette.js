// The ⌘K command palette: actions, places and issues in one list.

import { store } from './store.js';
import { h, kbd, icon, avatar } from './ui.js';
import { figbot } from './figbot.js';
import { searchIssues, issueOption } from './search.js';
import { openDialog, closeDialog, openNewIssue, openNewProject, openShortcuts } from './dialogs.js';
import { notificationsSupported, notificationsOn, toggleNotifications } from './notify.js';

const ID = /^[a-z][a-z0-9]*-\d+$/i;
const go = (hash) => () => (location.hash = hash);

function fixedItems() {
  return [
    { group: 'Actions', label: 'New figbot', icon: icon('plus'), key: 'N', run: go('#/agents/new') },
    { group: 'Actions', label: 'New issue', icon: icon('plus'), key: 'C', run: openNewIssue },
    { group: 'Actions', label: 'New project', icon: icon('plus'), run: openNewProject },
    notificationsSupported && {
      group: 'Actions',
      label: notificationsOn() ? 'Stop notifying me' : 'Notify me when an agent asks something',
      icon: icon('inbox'),
      run: toggleNotifications,
    },
    { group: 'Actions', label: 'Keyboard shortcuts', icon: icon('list'), key: '?', run: openShortcuts },
    ...store.runtimeAgents.map((a) => ({
      group: 'Figbots',
      label: a.name,
      icon: figbot({ colour: a.colour, size: 12, state: 'idle', animate: false }),
      hint: a.waiting ? 'asks you' : a.roleName,
      run: go(`#/agents/${encodeURIComponent(a.name)}`),
    })),
    { group: 'Go to', label: 'Tracker inbox', icon: icon('inbox'), hint: store.inbox.length ? `${store.inbox.length} waiting` : '', run: go('#/inbox') },
    { group: 'Go to', label: 'Settings', icon: avatar(store.me.name, { kind: 'human', size: 12 }), run: go('#/settings') },
    ...store.projects.map((p) => ({
      group: 'Go to',
      label: p.name,
      icon: h('span', { class: 'bullet' }),
      hint: p.key,
      run: go(`#/projects/${encodeURIComponent(p.key)}`),
    })),
  ].filter(Boolean);
}

export function openPalette() {
  const input = h('input', { class: 'palette-input', placeholder: 'Search or jump to…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Search or jump to' });
  const list = h('div', { class: 'palette-list', role: 'listbox' });
  let items = [];
  let nodes = [];
  let issues = [];
  let active = 0;
  let timer;
  let seq = 0;

  const choose = (item) => {
    closeDialog();
    item.run();
  };
  const setActive = (i) => {
    nodes[active]?.classList.remove('active');
    active = i;
    nodes[active]?.classList.add('active');
    nodes[active]?.scrollIntoView({ block: 'nearest' });
  };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    const matches = fixedItems().filter((it) => !q || `${it.label} ${it.hint || ''}`.toLowerCase().includes(q));
    const found = issues.map((issue) => ({ group: 'Issues', issue, run: go(`#/issues/${issue.id}`) }));
    // Typing an exact id puts that issue first.
    if (ID.test(q) && found[0] && found[0].issue.id.toLowerCase() === q) {
      items = [{ ...found[0], group: 'Best match' }, ...matches, ...found.slice(1)];
    } else {
      items = [...matches, ...found];
    }
    active = 0;
    nodes = [];
    const rows = [];
    let group = null;
    items.forEach((item, i) => {
      if (item.group !== group) {
        group = item.group;
        rows.push(h('div', { class: 'label palette-group' }, group));
      }
      const pick = () => choose(item);
      const node = item.issue
        ? issueOption(item.issue, { active: i === 0, onpick: pick })
        : h('button', { type: 'button', class: ['option', i === 0 && 'active'], role: 'option', onmousedown: (e) => e.preventDefault(), onclick: pick },
          item.icon, h('span', { class: 'option-text' }, item.label),
          item.hint ? h('span', { class: 'option-hint' }, item.hint) : null,
          item.key ? kbd(item.key) : null);
      node.addEventListener('mousemove', () => active !== i && setActive(i));
      nodes.push(node);
      rows.push(node);
    });
    if (!items.length) rows.push(h('p', { class: 'option-empty' }, q ? 'Nothing matches.' : ''));
    list.replaceChildren(...rows);
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (!q) {
      seq++;
      issues = [];
      draw();
      return;
    }
    draw();
    timer = setTimeout(async () => {
      const mine = ++seq;
      const found = await searchIssues(q, 20).catch(() => []);
      if (mine !== seq) return;
      issues = found;
      draw();
    }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (items.length) setActive((active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) choose(items[active]);
    }
  });

  draw();
  openDialog(h('div', { class: 'palette' },
    h('div', { class: 'palette-head' }, icon('search'), input, kbd('Esc'),
      h('button', { type: 'button', class: 'link phone-only', onclick: closeDialog }, 'Close')),
    list,
    h('footer', { class: 'palette-foot' },
      h('span', {}, kbd('↑'), kbd('↓'), 'Move'),
      h('span', {}, kbd('↵'), 'Open'),
      h('span', {}, kbd('Esc'), 'Close'))), input, 'palette');
}
