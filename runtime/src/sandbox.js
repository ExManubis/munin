// Where coders' tools run. Without a sandbox they run on this machine, as the runtime's own
// user, and their shell gets a short list of harmless variables instead of the runtime's
// environment. That keeps keys like OPENROUTER_API_KEY out of casual reach, but it isn't a
// boundary: the runtime's user can still read the runtime's files.
//
// With MUNIN_AGENT_SANDBOX=docker, each coder gets a container of its own, and pi-env runs all
// of its tools there, shell and files alike. The container sees the agent's folder and munin's
// clones at the same paths as here, and nothing else: not the runtime's databases, its keys,
// the other agents' tokens, or anything listening on this machine's 127.0.0.1.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { Connection, RemoteExecutionEnv, packagedDaemon } from '@earendil-works/pi-env';

// Nobody is at an agent's terminal, so git mustn't wait for a pager, an editor or a password.
export const QUIET_GIT = { GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };
const HARMLESS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LANGUAGE', 'TERM', 'TZ', 'TMPDIR', 'TEMP', 'TMP'];

// What a shell on this machine gets: the harmless variables, LC_*, and the ones you name in
// MUNIN_AGENT_ENV, such as a token the agents need to push.
export function localShellEnv(source, passthrough = []) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && (HARMLESS.includes(key) || key.startsWith('LC_') || passthrough.includes(key))) env[key] = value;
  }
  return { ...env, ...QUIET_GIT };
}

// The variables you named, for a shell in a container, which starts from the image's own.
export function passedThrough(source, passthrough = []) {
  const env = {};
  for (const key of passthrough) if (source[key] !== undefined) env[key] = source[key];
  return env;
}

function run(...args) {
  return new Promise((done, fail) => {
    execFile('docker', args, { timeout: 2 * 60 * 1000 }, (err, stdout, stderr) => {
      if (!err) return done(stdout.trim());
      const lines = String(stderr || err.message).trim().split('\n').filter(Boolean);
      return fail(new Error(lines.at(-1) || 'docker failed.'));
    });
  });
}

// What a container is made with; one with another layout is made again. 2: only the agent's folder.
const LAYOUT = '2';

// Docker is there and answers.
export const dockerWorks = () => run('info', '--format', '{{.ServerVersion}}').then(() => true, () => false);

// The agent's own folder is all a container sees, mounted at its own path, so worktrees and the
// runtime's idea of the folder hold inside it too. The agent's clones are in that folder
// (workspace.js); munin's own clones and the other agents' folders aren't.
export function createDockerSandbox({ image, network = null, agentsDir }) {
  // Containers are named after this munin, so two on one machine don't share them.
  const home = createHash('sha256').update(agentsDir).digest('hex').slice(0, 6);
  const nameOf = (agent) => `munin-${home}-${agent.name}`;
  const daemon = packagedDaemon({ platform: 'linux', arch: process.arch });
  const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
  const connections = new Map(); // agent name → Connection
  const starting = new Map();

  // The agent's container, running: started again if it stopped, made if it's gone, and made
  // again if it's from an older layout (one that mounted munin's clones too).
  function ensure(agent) {
    const name = nameOf(agent);
    if (starting.has(name)) return starting.get(name);
    const ready = (async () => {
      const found = await run('inspect', '--format', `{{.State.Running}} {{index .Config.Labels "munin.layout"}}`, name).catch(() => null);
      const [state, layout] = found ? found.split(' ') : [null, null];
      if (state && layout !== LAYOUT) {
        await run('rm', '--force', name);
      } else if (state === 'true') {
        return name;
      } else if (state === 'false') {
        await run('start', name);
        return name;
      }
      await mkdir(agent.folder, { recursive: true });
      await run('run', '--detach', '--init', '--name', name,
        '--label', `munin.agent=${agent.name}`, '--label', `munin.home=${home}`, '--label', `munin.layout=${LAYOUT}`,
        ...(user ? ['--user', user] : []),
        ...(network ? ['--network', network] : []),
        '--env', `HOME=${agent.folder}`,
        '--volume', `${agent.folder}:${agent.folder}`,
        '--volume', `${daemon}:/usr/local/bin/pi-env:ro`,
        '--workdir', agent.folder,
        image, 'sleep', 'infinity');
      return name;
    })().finally(() => starting.delete(name));
    starting.set(name, ready);
    return ready;
  }

  function connectionOf(agent) {
    if (!connections.has(agent.name)) {
      connections.set(agent.name, new Connection({
        command: async () => ['docker', 'exec', '--interactive', await ensure(agent), '/usr/local/bin/pi-env'],
        onLog: () => {},
      }));
    }
    return connections.get(agent.name);
  }

  return {
    kind: 'docker',
    image,
    // An environment for one tool call: pi-durable builds one per call, and they share the
    // agent's connection to the daemon in its container.
    envFor(agent, cwd) {
      return new RemoteExecutionEnv({ connection: connectionOf(agent), id: `pi-env:${nameOf(agent)}`, cwd });
    },
    async remove(agent) {
      connections.get(agent.name)?.close();
      connections.delete(agent.name);
      await run('rm', '--force', nameOf(agent)).catch(() => {});
    },
    containerOf: nameOf,
    close() {
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}
