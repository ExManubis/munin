// Agents: who can connect over MCP, with a token each. Add one, copy its setup, revoke it.

import { api } from '../api.js';
import { store } from '../store.js';
import { h, agentAvatar, time, topbar, bindDraft, drafts, toast, copyButton, isActive } from '../ui.js';

let created = null; // { name, token } for the token just created; shown once
let tab = 'claude';

export const view = {
  title: () => 'Agents',

  async load() {
    return { agents: store.agents, me: store.me };
  },

  leave() {
    created = null; // the token is only ever shown on the screen that created it
  },

  render({ agents, me }, ctx) {
    const live = agents.filter((a) => !a.revoked);
    return h('div', { class: 'page' },
      topbar([h('span', { class: 'title' }, 'Agents'), h('span', { class: 'mono muted' }, `${live.length} connected`)]),
      h('div', { class: 'agents-page' },
        h('h1', { class: 'h1' }, 'Agents & MCP'),
        h('p', { class: 'lead' },
          'Agents connect to munin over MCP, each with its own token, so you can revoke one without touching the others. ',
          'An agent shows up in issues and comments under the name you give it here.'),
        h('div', { class: 'mcp-url' },
          h('span', { class: 'label' }, 'MCP URL'),
          h('code', {}, me.mcp_url),
          copyButton(() => me.mcp_url)),
        table(agents, ctx),
        connect(agents, me, ctx)));
  },
};

function table(agents, ctx) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connected agents'), h('span', { class: 'mono muted' }, agents.length)),
    agents.length
      ? h('div', { class: 'agent-table', role: 'table', 'aria-label': 'Agents' },
        h('div', { class: 'agent-row head', role: 'row' },
          h('span', { class: 'label', role: 'columnheader' }, 'Agent'),
          h('span', { class: 'label', role: 'columnheader' }, 'Last seen'),
          h('span', { class: 'label', role: 'columnheader' }, 'Token'),
          h('span', { role: 'columnheader' })),
        agents.map((a) => h('div', { class: ['agent-row', a.revoked && 'revoked'], role: 'row' },
          h('span', { class: 'agent-name', role: 'cell' }, agentAvatar(a.name), h('span', {}, a.name)),
          h('span', { class: 'agent-seen', role: 'cell' },
            a.revoked ? h('span', { class: 'label' }, 'Revoked')
              : a.last_seen_at ? [time(a.last_seen_at, { long: true }), isActive(a) ? h('span', { class: 'muted' }, ' · active') : null]
                : h('span', { class: 'muted' }, 'Never connected')),
          h('span', { class: 'mono muted', role: 'cell' }, `mun_…${a.token_hint}`),
          h('span', { class: 'agent-action', role: 'cell' },
            a.revoked
              ? h('button', { type: 'button', class: 'link', onclick: () => issueToken(a.name, ctx) }, 'New token')
              : h('button', { type: 'button', class: 'link', onclick: () => revoke(a.name, ctx) }, 'Revoke')))))
      : h('p', { class: 'muted' }, 'No agents yet. Add one below, then paste the command into its terminal.'));
}

async function revoke(name, ctx) {
  if (!confirm(`Revoke ${name}'s token? It stops working right away.`)) return;
  try {
    await api.revokeAgent(name);
    if (created && created.name === name) created = null;
    toast(`Revoked ${name}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

async function issueToken(name, ctx) {
  try {
    const agent = await api.addAgent(name);
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
    await issueToken(value, ctx);
  };

  const token = created ? created.token : 'mun_…';
  const command = `claude mcp add --transport http munin ${me.mcp_url} --header "Authorization: Bearer ${token}"`;
  const json = JSON.stringify({ mcpServers: { munin: { type: 'http', url: me.mcp_url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const snippet = tab === 'claude' ? command : json;
  const setTab = (t) => () => {
    tab = t;
    ctx.rerender();
  };

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Add an agent')),
    h('p', { class: 'muted section-lead' }, 'Name it after the client, like claude-code or codex. You get a token for it, shown once.'),
    h('form', { class: 'add-agent', onsubmit: add },
      name,
      h('button', { type: 'submit', class: 'btn primary' }, 'Create token')),
    created
      ? h('div', { class: 'token', role: 'status' },
        h('div', { class: 'token-head' },
          h('span', { class: 'label' }, `Token for ${created.name} · shown once`),
          copyButton(() => created.token)),
        h('code', { class: 'token-value' }, created.token),
        h('p', { class: 'hint' }, 'munin only keeps a hash. If you lose it, create a new token for the same name.'))
      : null,
    h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'claude'), onclick: setTab('claude') }, 'Claude Code'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'json'), onclick: setTab('json') }, 'Any MCP client')),
    h('div', { class: 'snippet' },
      h('pre', {}, h('code', {}, snippet)),
      copyButton(() => snippet)),
    h('p', { class: 'hint' }, created
      ? (tab === 'claude' ? `Run this where ${created.name} works.` : 'Add this to the client\'s MCP config.')
      : 'The token fills into the command once you create it.'));
}
