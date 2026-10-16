// munin's own agents in the tracker. The frontend joins the two services, acting for you: it
// gets an agent a token from the tracker and hands it to the runtime, so the agent works in
// the tracker like any other MCP client. The tracker never hears of the runtime.

import { api } from '../api.js';
import { store } from '../store.js';
import { runtime } from './index.js';

// Give a runtime agent a tracker token of its own, keeping the projects it works on. Asks first
// when the name already has a live token, since that one stops working. False if you said no.
export async function connectToTracker(name, projects) {
  const taken = (await api.agents()).find((a) => a.name === name && !a.revoked);
  if (taken && !confirm(`${name} already has a token in the tracker. Give the new agent a fresh one? The old one stops working.`)) return false;
  const { token } = await api.addAgent(name);
  await runtime.updateAgent(name, { tracker: { url: store.me.mcp_url, token, ...(projects ? { projects } : {}) } });
  return true;
}

// The agent's token stops working; its issues and comments stay in the tracker.
export async function disconnectFromTracker(name) {
  await runtime.updateAgent(name, { tracker: null });
  await revokeTrackerToken(name);
}

// For an agent that's gone from the runtime already.
export async function revokeTrackerToken(name) {
  await api.revokeAgent(name).catch(() => {}); // already revoked, or never had one
}

// The message that starts an agent on a project, the same as the tracker's own prompts.
export function workMessage(agent, key) {
  return agent.role === 'reviewer'
    ? `Review what's waiting in the ${key} project in munin, until there's nothing left to review.`
    : `Continue the ${key} project in munin: read its brief, then take, do and review issues until there's nothing left for you to do.`;
}

// Whether this agent's tracker part can be set up from here: only on the real runtime.
export const linkable = () => runtime.kind === 'runtime';
