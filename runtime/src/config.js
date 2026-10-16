// Settings come from the environment, like the tracker's.

import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export function settingsFromEnv(env = process.env) {
  const home = join(homedir(), '.munin');
  if (env.MUNIN_AGENT_SANDBOX && env.MUNIN_AGENT_SANDBOX !== 'docker') {
    throw new Error(`MUNIN_AGENT_SANDBOX is "docker" or unset, not "${env.MUNIN_AGENT_SANDBOX}".`);
  }
  const publicUrl = (env.MUNIN_PUBLIC_URL || '').trim().replace(/\/+$/, '') || null;
  const users = (env.MUNIN_USERS || '').split(',').map((u) => u.trim().toLowerCase()).filter(Boolean);
  if (publicUrl && !users.length) throw new Error('MUNIN_PUBLIC_URL is set, so say who may use munin through it: MUNIN_USERS=you@example.com.');
  const db = env.MUNIN_RUNTIME_DB || join(home, 'runtime.sqlite');
  return {
    db,
    // Model keys pasted in Settings (keys.js), next to the database.
    keysFile: db === ':memory:' ? null : join(dirname(db), 'keys.json'),
    host: env.MUNIN_RUNTIME_HOST || '127.0.0.1',
    port: Number(env.MUNIN_RUNTIME_PORT || 7779),
    // Each agent that can code gets a folder of its own under here.
    agentsDir: env.MUNIN_AGENTS_DIR || join(home, 'agents'),
    // The runtime's clone of each project's repository; agents get worktrees of them.
    reposDir: env.MUNIN_REPOS_DIR || join(home, 'repos'),
    // An Ollama (or any OpenAI-compatible) server, like http://127.0.0.1:11434
    ollamaUrl: env.MUNIN_OLLAMA_URL || null,
    // The name your messages get, as in the tracker.
    user: env.MUNIN_USER || 'me',
    // Behind the edge: munin's address there, and the Tailscale logins allowed in through it.
    publicUrl,
    users,
    // Where agents' tracker calls go, when the address the frontend passes on (the public one,
    // behind the edge) is a detour: on the server, the tracker at http://127.0.0.1:7777/mcp.
    trackerMcp: env.MUNIN_TRACKER_MCP || null,
    // Where coders' tools run: "docker" gives each a container of its own (sandbox.js); unset,
    // they run on this machine as the runtime's user.
    sandbox: env.MUNIN_AGENT_SANDBOX || null,
    agentImage: env.MUNIN_AGENT_IMAGE || 'buildpack-deps:bookworm-scm',
    agentNetwork: env.MUNIN_AGENT_NETWORK || null,
    // Variables agents' shells get from the runtime's environment, like GH_TOKEN for pushing.
    agentEnv: (env.MUNIN_AGENT_ENV || '').split(',').map((name) => name.trim()).filter(Boolean),
  };
}
