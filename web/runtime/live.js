// What one of munin's own agents is doing on an issue, from its conversation in the runtime: the
// latest run on that issue and its steps. The tracker knows nothing of the runtime, so the issue
// page joins the two here. The runtime's live stream (numbered events, picked up where it left off
// after a reconnect) reloads the page as the agent works, so this stays current.

import { runtime } from './index.js';
import { store } from '../store.js';

// { agent, run } for an in-progress issue held by one of munin's own agents; null for outside
// agents (Claude Code, Codex…), whose work munin can't see, or without a runtime.
export async function liveWork(issue) {
  if (runtime.kind === 'none' || issue.status !== 'in_progress' || !issue.assignee) return null;
  const agent = store.runtimeAgents.find((a) => a.name === issue.assignee);
  if (!agent) return null;
  const { items } = await runtime.conversation(agent.name, { limit: 80 }).catch(() => ({ items: [] }));
  const run = items.filter((item) => item.kind === 'run' && item.issue?.id === issue.id).pop() || null;
  return { agent: agent.name, run };
}
