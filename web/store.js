// Data every screen shares. app.js refreshes it before each view loads.

export const store = {
  me: { name: 'me', mcp_url: '', version: '' },
  projects: [],
  inbox: [],
  agents: [],
  // The project the current screen is about; the new-issue dialog starts there.
  projectKey: null,
};

// The web UI has one human (from /api/me). Any other name is treated as an agent.
export function kindOf(name) {
  return name === store.me.name ? 'human' : 'agent';
}

// "You" for the human, the name for everyone else.
export const displayName = (name) => (name === store.me.name ? 'You' : name);

export function liveAgents() {
  return store.agents.filter((a) => !a.revoked);
}

export const isWorking = (agent) => !agent.revoked && agent.working_on.length > 0;

// Working, and heard from in the last 10 minutes.
export const isBusy = (agent) => isWorking(agent)
  && Boolean(agent.last_seen_at) && Date.now() - new Date(agent.last_seen_at) < 10 * 60 * 1000;

export function openCount(project) {
  const c = project.counts || {};
  return (c.todo || 0) + (c.in_progress || 0) + (c.in_review || 0);
}

const QUIET_MS = 30 * 60 * 1000;

// An in-progress issue whose agent hasn't called munin for 30 minutes (or ever):
// { agent, since } where since is the agent's last_seen_at (null if never).
export function quietAgent(issue) {
  if (issue.status !== 'in_progress' || !issue.assignee) return null;
  const agent = store.agents.find((a) => a.name === issue.assignee);
  if (!agent) return null;
  const seen = agent.last_seen_at ? new Date(agent.last_seen_at) : null;
  if (seen && Date.now() - seen < QUIET_MS) return null;
  return { agent, since: agent.last_seen_at };
}

// localStorage can be missing or throw (private windows, blocked storage).
export function remember(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch {
    return null;
  }
  return value;
}
