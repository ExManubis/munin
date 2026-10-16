// Settings come from the environment, like the tracker's.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function settingsFromEnv(env = process.env) {
  const home = join(homedir(), '.munin');
  return {
    db: env.MUNIN_RUNTIME_DB || join(home, 'runtime.sqlite'),
    host: env.MUNIN_RUNTIME_HOST || '127.0.0.1',
    port: Number(env.MUNIN_RUNTIME_PORT || 7779),
    // Each agent that can code gets a folder of its own under here.
    agentsDir: env.MUNIN_AGENTS_DIR || join(home, 'agents'),
    // An Ollama (or any OpenAI-compatible) server, like http://127.0.0.1:11434
    ollamaUrl: env.MUNIN_OLLAMA_URL || null,
    // The name your messages get, as in the tracker.
    user: env.MUNIN_USER || 'me',
  };
}
