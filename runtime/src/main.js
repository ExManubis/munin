// Start the runtime: `npm start` in runtime/, next to the tracker's `munin serve`.

import { settingsFromEnv } from './config.js';
import { buildModels } from './models.js';
import { openRuntime } from './runtime.js';
import { createRuntimeServer } from './server.js';

let settings;
try {
  settings = settingsFromEnv();
} catch (err) {
  console.error(`munin runtime: ${err.message}`);
  process.exit(2);
}
const models = await buildModels(settings);
const runtime = await openRuntime(settings, { models });
const server = createRuntimeServer(runtime, settings);

server.listen(settings.port, settings.host, () => {
  const connected = models.providers().filter((p) => p.connected && p.id !== 'standin').map((p) => p.name);
  console.log(`munin runtime · http://${settings.host}:${settings.port}/runtime/api${settings.publicUrl ? ` · ${settings.publicUrl}/runtime/api for ${settings.users.join(', ')}` : ''}`);
  console.log(`  agents in ${settings.db}`);
  console.log(`  models: ${connected.length ? connected.join(', ') : 'only the stand-in (set OPENROUTER_API_KEY or MUNIN_OLLAMA_URL)'}`);
  console.log(`  coders: ${settings.sandbox === 'docker' ? `a container each, from ${settings.agentImage}` : "on this machine, as this user (MUNIN_AGENT_SANDBOX=docker gives each a container)"}`);
});

const stop = async () => {
  server.close();
  await runtime.close();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
