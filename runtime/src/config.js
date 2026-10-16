// Settings come from the environment, like the tracker's.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function settingsFromEnv(env = process.env) {
  const home = join(homedir(), '.munin');
  if (env.MUNIN_AGENT_SANDBOX && env.MUNIN_AGENT_SANDBOX !== 'docker') {
    throw new Error(`MUNIN_AGENT_SANDBOX is "docker" or unset, not "${env.MUNIN_AGENT_SANDBOX}".`);
  }
  return {
    db: env.MUNIN_RUNTIME_DB || join(home, 'runtime.sqlite'),
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
    // Where coders' tools run: "docker" gives each a container of its own (sandbox.js); unset,
    // they run on this machine as the runtime's user.
    sandbox: env.MUNIN_AGENT_SANDBOX || null,
    agentImage: env.MUNIN_AGENT_IMAGE || 'buildpack-deps:bookworm-scm',
    agentNetwork: env.MUNIN_AGENT_NETWORK || null,
    // Variables agents' shells get from the runtime's environment, like GH_TOKEN for pushing.
    agentEnv: (env.MUNIN_AGENT_ENV || '').split(',').map((name) => name.trim()).filter(Boolean),
  };
}
