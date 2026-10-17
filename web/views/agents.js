// The Agents part: its sidebar (every agent, the ones waiting on you first, and the open
// agent's Figbot peeking in from its bottom-right corner) and #/agents, which opens the top
// agent on a wide screen and lists them all on a phone.

import { store } from '../store.js';
import { h, topbar } from '../ui.js';
import { figbot } from '../figbot.js';
import { waitingItems, openWaiting } from '../waiting.js';

// Waiting on you first, then by last activity.
export function sortedAgents() {
  return [...store.runtimeAgents].sort((a, b) => (b.waiting > 0) - (a.waiting > 0) || b.lastAt.localeCompare(a.lastAt));
}

export function agentFace(agent, size = 18, { state, animate = true } = {}) {
  return figbot({ colour: agent.colour, state: state || agent.state, size, seed: agent.name, label: agent.name, animate });
}

export const roleTag = (agent) => h('span', { class: 'role-tag' }, agent.roleName || agent.role);

const wide = () => matchMedia('(min-width: 721px)').matches;

// A clock time for today, a weekday this week, a date before that; "now" for a minute.
export function clock(value, { now: nowWord = true } = {}) {
  const date = new Date(value);
  const seconds = (Date.now() - date) / 1000;
  if (nowWord && seconds < 60) return 'now';
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return hhmm(date);
  if (seconds < 6 * 86400) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const hhmm = (date) => new Date(date).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

export function agentRow(agent, { selected = false } = {}) {
  const line = agent.typing ? 'writing…' : agent.preview;
  return h('a', {
    class: ['agent-item', selected && 'selected', agent.state === 'paused' && 'paused'],
    href: `#/agents/${encodeURIComponent(agent.name)}`,
    'aria-current': selected ? 'page' : null,
  },
  agentFace(agent),
  h('span', { class: 'agent-item-main' },
    h('span', { class: 'agent-item-head' },
      h('span', { class: 'agent-item-name' }, agent.name),
      roleTag(agent),
      h('span', { class: 'grow' }),
      h('span', { class: 'agent-item-time' }, agent.state === 'working' ? 'now' : clock(agent.lastAt))),
    h('span', { class: 'agent-item-line' },
      h('span', { class: ['agent-item-preview', agent.typing && 'typing'] }, line),
      agent.waiting ? h('span', { class: 'chip row-chip' }, 'Asks') : null)));
}

export function agentsSidebar(route) {
  const agents = sortedAgents();
  const open = agents.find((a) => a.name === route.params.name);
  const button = h('a', { class: ['btn', 'new-agent', route.path === '/agents/new' && 'pressed'], href: '#/agents/new' },
    'New agent', h('span', { class: 'key' }, 'N'));
  return [
    h('div', { class: 'agents-head' }, h('span', { class: 'label' }, 'Agents'), h('span', { class: 'mono muted' }, agents.length)),
    h('nav', { class: 'agent-list', 'aria-label': 'Agents' },
      agents.map((a) => agentRow(a, { selected: route.params.name === a.name }))),
    h('div', { class: 'grow' }),
    open
      ? h('div', { class: 'side-foot' }, button, h('div', { class: 'side-bot', 'aria-hidden': 'true' }, figbot({ colour: open.colour, state: open.state, size: 120, seed: open.name })))
      : button,
  ];
}

export const indexView = {
  title: () => 'Agents',

  async load() {
    const agents = sortedAgents();
    if (wide() && agents.length) location.replace(`#/agents/${encodeURIComponent(agents[0].name)}`);
    return { agents: agents.map((a) => a.name + a.state + a.waiting + a.preview + a.typing) };
  },

  render() {
    const agents = sortedAgents();
    const waiting = waitingItems().length;
    return h('div', { class: 'page agents-index' },
      topbar([h('span', { class: 'title' }, 'Agents'),
        waiting ? h('button', { type: 'button', class: 'mono muted', onclick: openWaiting }, `${waiting} waiting`) : null]),
      agents.length
        ? h('nav', { class: 'agent-list phone-list', 'aria-label': 'Agents' }, agents.map((a) => agentRow(a)))
        : h('div', { class: 'empty-state' },
          figbot({ size: 72, state: 'curious' }),
          h('h2', {}, 'No agents yet'),
          h('p', {}, 'Make one: a coder for your projects, an assistant for your calendar, or someone fun to talk to.'),
          h('a', { class: 'btn primary', href: '#/agents/new' }, 'New agent', h('span', { class: 'key' }, 'N'))));
  },
};
