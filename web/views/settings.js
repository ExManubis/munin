// Settings, behind your square in the topbar: updates, GitHub, the agents that connect over MCP
// (a token each), and notifications.

import { api } from '../api.js';
import { store, isWorking } from '../store.js';
import { h, PROVIDERS, providerMark, agentAvatar, statusIcon, time, topbar, bindDraft, drafts, toast, copyButton, toggle } from '../ui.js';
import { notificationsSupported, notificationsOn, pushSupported, toggleNotifications } from '../notify.js';

let created = null; // { name, token } for the token just created; shown once
let updating = null; // the commit munin ran when you asked for an update, until it's back on a new one
let checking = false; // while asking GitHub what's new
let provider = 'claude'; // the harness picked for the next agent; null for another one

export const view = {
  title: () => 'Settings',

  async load() {
    // GitHub can be slow to say what's new; Settings doesn't wait long for it.
    const update = Promise.race([api.updateStatus(), new Promise((resolve) => setTimeout(resolve, 2500, null))]).catch(() => null);
    const [agents, github, updates] = await Promise.all([api.agents(), api.github(), update]);
    return { agents, github, updates, me: store.me };
  },

  leave() {
    created = null; // the token is only ever shown on the screen that created it
  },

  render({ agents, github, updates, me }, ctx) {
    const live = agents.filter((a) => !a.revoked);
    return h('div', { class: 'page' },
      topbar([h('span', { class: 'title' }, 'Settings')]),
      h('div', { class: 'agents-page' },
        updatesSection(updates, ctx),
        githubSection(github, ctx),
        h('section', { class: 'section', id: 'outside-agents' },
          h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Agents'), h('span', { class: 'mono muted' }, `${live.length} connected`)),
          h('p', { class: 'lead' },
            'Any MCP client can work in the tracker: Claude Code, Codex, a local model. Each connects with its own token, ',
            'so you can revoke one without touching the others, and shows up under the name you give it here.'),
          h('div', { class: 'mcp-url' },
            h('span', { class: 'label' }, 'MCP URL'),
            h('code', {}, me.mcp_url),
            copyButton(() => me.mcp_url))),
        table(agents, ctx),
        connect(agents, me, ctx),
        notifications(ctx)));
  },
};

// What munin runs, what's newer, and a button that updates it. munin restarts on the way, so the
// page waits for it to come back on the new version, then reloads.
function updatesSection(updates, ctx) {
  const head = (note) => h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Updates'), note ? h('span', { class: 'mono muted' }, note) : null);
  if (updating) {
    return h('section', { class: 'section first', id: 'updates' }, head(),
      h('p', { class: 'lead' }, 'Updating. munin restarts on its way and is back in a minute or so; this page reloads when it is.'));
  }
  if (!updates) {
    return h('section', { class: 'section first', id: 'updates' }, head(), h('p', { class: 'muted' }, "Couldn't check for updates just now."));
  }
  if (!updates.can_update) {
    return h('section', { class: 'section first', id: 'updates' }, head(),
      h('p', { class: 'muted' }, "This munin wasn't set up by its install script, so it can't update itself: pull and restart it."));
  }
  const check = async () => {
    checking = true;
    ctx.rerender();
    await api.updateStatus(true).catch(() => toast("Couldn't reach GitHub just now.", { error: true }));
    checking = false;
    ctx.reload();
  };
  const checkButton = h('button', { type: 'button', class: 'link', onclick: check, disabled: checking }, checking ? 'Checking…' : 'Check for updates');
  const start = async () => {
    try {
      await api.updateNow();
    } catch (err) {
      toast(err.message, { error: true });
      return;
    }
    updating = updates.commit;
    ctx.rerender();
    waitForUpdate();
  };
  return h('section', { class: 'section first', id: 'updates' },
    head(updates.commit),
    updates.behind
      ? [
        h('p', { class: 'lead' }, updates.releases.length
          ? `${updates.releases.length === 1 ? 'A release is' : `${updates.releases.length} releases are`} out since this one:`
          : 'There are changes on GitHub since this one.'),
        updates.releases.length ? h('ul', { class: 'releases' }, updates.releases.map((r) => h('li', {}, r[0].toUpperCase() + r.slice(1)))) : null,
        h('div', { class: 'setting' },
          h('div', { class: 'setting-main' },
            h('div', {}, 'Update munin'),
            h('div', { class: 'hint' }, 'Takes a minute; munin restarts on the way. Or on the machine: munin update (with sudo on Linux).')),
          h('button', { type: 'button', class: 'btn small primary', onclick: start }, 'Update now')),
      ]
      : null,
    h('div', { class: 'update-check' }, updates.behind ? null : h('span', { class: 'muted' }, 'munin is up to date.'), checkButton));
}

// Ask until munin answers on a new version, then load the new page. Gives up after ten minutes.
async function waitForUpdate() {
  const until = Date.now() + 10 * 60 * 1000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const now = await api.updateStatus().catch(() => null);
    if (now?.commit && now.commit !== updating) return location.reload();
  }
  updating = null;
  toast("munin hasn't come back on a new version. See update.log next to its database.", { error: true });
}

function githubSection(github, ctx) {
  const input = bindDraft(h('input', { class: 'input', type: 'password', placeholder: 'ghp_… or github_pat_…', autocomplete: 'off', spellcheck: false, 'aria-label': 'GitHub token' }), 'github:token');
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.setGithubToken(input.value.trim() || null);
      drafts.delete('github:token');
      toast(input.value.trim() ? 'Saved. munin reads pull requests with it.' : 'Token removed.');
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h('section', { class: 'section', id: 'github' },
    h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'GitHub'), h('span', { class: 'mono muted' }, github.token ? `token …${github.token.hint}` : 'no token')),
    h('p', { class: 'lead' }, "Pull requests linked to issues show their title and whether they've merged. Public repositories need no token; private ones, and more than 60 checks an hour, do."),
    h('form', { class: 'key-form', onsubmit: save },
      h('div', { class: 'key-fields' }, input, h('button', { type: 'submit', class: 'btn small primary' }, github.token ? 'Replace' : 'Save'),
        github.token ? h('button', { type: 'button', class: 'link', onclick: async () => { await api.setGithubToken(null); ctx.reload(); } }, 'Remove') : null),
      h('p', { class: 'hint' }, 'A fine-grained token with read access to pull requests is enough. munin keeps it on the machine it runs on and never shows it again.')));
}

function table(agents, ctx) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connected'), h('span', { class: 'mono muted' }, agents.length)),
    agents.length
      ? h('div', { class: 'agent-table', role: 'table', 'aria-label': 'Agents' },
        h('div', { class: 'agent-row head', role: 'row' },
          h('span', { class: 'label', role: 'columnheader' }, 'Agent'),
          h('span', { class: 'label', role: 'columnheader' }, 'Doing'),
          h('span', { class: 'label', role: 'columnheader' }, 'Token'),
          h('span', { role: 'columnheader' })),
        agents.map((a) => h('div', { class: 'agent-row', role: 'row' },
          h('span', { class: 'agent-name', role: 'cell' }, agentAvatar(a.name), h('span', {}, a.name)),
          h('span', { class: 'agent-seen', role: 'cell' }, doing(a)),
          h('span', { class: 'mono muted', role: 'cell' }, `mun_…${a.token_hint}`),
          h('span', { class: 'agent-action', role: 'cell' },
            h('button', { type: 'button', class: 'link', onclick: () => revoke(a.name, ctx) }, 'Revoke')))))
      : h('p', { class: 'muted' }, 'No agents yet. Add one below, then paste the command into its terminal.'));
}

// Working on what, idle since when, or never connected.
function doing(agent) {
  const seen = agent.last_seen_at ? time(agent.last_seen_at, { long: true, prefix: 'seen ', cls: 'muted' }) : null;
  if (!agent.last_seen_at) return h('span', { class: 'agent-state muted' }, 'Never connected');
  if (!isWorking(agent)) return h('span', { class: 'agent-state' }, h('span', { class: 'state' }, 'Idle'), ' · ', seen);
  return h('span', { class: 'agent-state' },
    h('span', { class: 'state working' }, 'Working'), ' · ', seen,
    agent.working_on.map((issue) => h('a', { class: 'working-on', href: `#/issues/${issue.id}` },
      statusIcon(issue.status), h('span', { class: 'mono' }, issue.id), h('span', { class: 'working-title' }, issue.title))));
}

function notifications(ctx) {
  if (!notificationsSupported) return null;
  const on = notificationsOn();
  const denied = Notification.permission === 'denied';
  return h('section', { class: 'section', id: 'notifications' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Notifications')),
    h('div', { class: 'setting' },
      h('div', { class: 'setting-main' },
        h('div', {}, 'Notify me when an agent asks something'),
        h('div', { class: 'hint' }, denied
          ? 'Your browser blocks notifications from munin. Allow them in the site settings first.'
          : pushSupported
            ? ['On this device, even with munin closed: when an agent asks something, and when work is ready for review. ',
              /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? 'On an iPhone, add munin to your home screen first (Share → Add to Home Screen) and turn this on from there.' : null]
            : 'A notification for each new question, and when an agent moves work to In review, while munin is open in a tab. This browser can\'t get notifications with munin closed.')),
      toggle(on, 'Notify me when an agent asks something', async () => {
        await toggleNotifications();
        ctx.rerender();
      })));
}

async function revoke(name, ctx) {
  if (!confirm(`Revoke ${name}? Its token stops working right away and it's removed from munin. Its issues and comments stay.`)) return;
  try {
    await api.revokeAgent(name);
    if (created && created.name === name) created = null;
    toast(`Revoked ${name}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

async function issueToken(name, ctx, pick = null) {
  try {
    const agent = await api.addAgent(name, pick);
    created = { name: agent.name, token: agent.token };
    drafts.delete('agent:name');
  } catch (err) {
    toast(err.message, { error: true });
  }
  await ctx.reload();
  document.querySelector('.token')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function connect(agents, me, ctx) {
  const name = bindDraft(h('input', {
    class: 'input',
    placeholder: 'claude-code',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Agent name',
  }), 'agent:name');
  const add = async (e) => {
    e.preventDefault();
    const value = name.value.trim();
    if (!value) return name.focus();
    const existing = agents.find((a) => a.name === value && !a.revoked);
    if (existing && !confirm(`${value} already has a token. Replace it? The old one stops working.`)) return;
    await issueToken(value, ctx, provider);
  };
  // Picking a harness suggests its name, unless you've written one of your own.
  const pick = (id) => () => {
    const suggested = PROVIDERS.find((p) => p.id === provider)?.name || '';
    provider = id;
    if (!name.value.trim() || name.value.trim() === suggested) {
      name.value = PROVIDERS.find((p) => p.id === id)?.name || '';
      drafts.set('agent:name', name.value);
    }
    ctx.rerender();
  };
  const choice = (id, label) => h('button', {
    type: 'button',
    class: ['provider', provider === id && 'active'],
    role: 'radio',
    'aria-checked': String(provider === id),
    onclick: pick(id),
  }, id ? providerMark(id, { size: 14 }) : null, h('span', {}, label));

  const token = created ? created.token : 'mun_…';
  const command = `claude mcp add --transport http munin ${me.mcp_url} --header "Authorization: Bearer ${token}"`;
  const json = JSON.stringify({ mcpServers: { munin: { type: 'http', url: me.mcp_url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const snippet = provider === 'claude' ? command : json;

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connect an outside agent')),
    h('p', { class: 'muted section-lead' }, 'Pick what it runs in, and name it. You get a token for it, shown once.'),
    h('div', { class: 'providers', role: 'radiogroup', 'aria-label': 'What it runs in' },
      PROVIDERS.map((p) => choice(p.id, p.label)),
      choice(null, 'Other')),
    h('form', { class: 'add-agent', onsubmit: add },
      name,
      h('button', { type: 'submit', class: 'btn primary' }, 'Create token')),
    created
      ? h('div', { class: 'token', role: 'status' },
        h('div', { class: 'token-head' },
          h('span', { class: 'label' }, `Token for ${created.name}`),
          copyButton(() => created.token)),
        h('code', { class: 'token-value' }, created.token),
        h('p', { class: 'hint' }, 'Shown once: munin only keeps a hash. If you lose it, create a new token for the same name.'))
      : null,
    h('div', { class: 'snippet' },
      h('pre', {}, h('code', {}, snippet)),
      copyButton(() => snippet)),
    h('p', { class: 'hint' }, created
      ? (provider === 'claude' ? `Run this where ${created.name} works.` : 'Add this to its MCP config.')
      : 'The token fills into the command once you create it.'));
}
