// Data every screen shares. app.js refreshes it before each view loads.

export const store = {
  me: { name: 'me', mcp_url: '' },
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

export const ACTIVE_MS = 10 * 60 * 1000;

export function liveAgents() {
  return store.agents.filter((a) => !a.revoked);
}

export function openCount(project) {
  const c = project.counts || {};
  return (c.todo || 0) + (c.in_progress || 0) + (c.in_review || 0);
}
