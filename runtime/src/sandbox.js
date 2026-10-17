// Where coders' tools run. Without a sandbox they run on this machine, as the runtime's own
// user, and their shell gets a short list of harmless variables instead of the runtime's
// environment. That keeps keys like OPENROUTER_API_KEY out of casual reach, but it isn't a
// boundary: the runtime's user can still read the runtime's files.
//
// With MUNIN_AGENT_SANDBOX=docker, each coder gets a container of its own, and pi-env runs all
// of its tools there, shell and files alike. The container sees the agent's folder at the same
// path as here, and nothing else: not the runtime's databases, its keys, munin's clones, the
// other agents' folders or tokens.
//
// Nor can it reach munin over the network. Docker Desktop lets a container reach the Mac's
// 127.0.0.1 through host.docker.internal, and any machine can reach its own tailnet address,
// where tailscale serve says the caller is the machine's owner: either way a coder would be
// let in as you. So each coder's container shares the network of a small one that holds
// firewall rules (FIREWALL): the internet is open, this machine and the tailnet aren't. Only
// that one may change firewall rules, and the coder's container runs as your user without it.

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

// What a container is made with; one with another layout is made again. 2: only the agent's
// folder. 3: behind a firewall container.
const LAYOUT = '3';

// The firewall container's image and rules: no way to this machine (the gateway, and Docker
// Desktop's names for the Mac) or the tailnet (100.64.0.0/10 and fd7a:115c:a1e0::/48), where
// munin listens. The coder's container joins its network once the rules are in.
export const FIREWALL_IMAGE = 'alpine:3.20';
const FIREWALL = String.raw`set -e
apk add --no-cache iptables ip6tables >/dev/null
block() { case "$1" in *:*) ip6tables -A OUTPUT -d "$1" -j REJECT ;; *) iptables -A OUTPUT -d "$1" -j REJECT ;; esac; }
for name in host.docker.internal gateway.docker.internal; do
  for address in $(getent ahosts "$name" | cut -d' ' -f1 | sort -u); do block "$address"; done
done
block "$(ip route | awk '/^default/ { print $3; exit }')"
block 100.64.0.0/10
ip6tables -A OUTPUT -d fd7a:115c:a1e0::/48 -j REJECT 2>/dev/null || true
touch /tmp/munin-firewall
exec sleep infinity`;

// Docker is there and answers.
export const dockerWorks = () => run('info', '--format', '{{.ServerVersion}}').then(() => true, () => false);

// The agent's own folder is all a container sees, mounted at its own path, so worktrees and the
// runtime's idea of the folder hold inside it too. The agent's clones are in that folder
// (workspace.js); munin's own clones and the other agents' folders aren't. `network` "none"
// takes the internet away too, with no firewall needed.
export function createDockerSandbox({ image, network = null, agentsDir, firewallImage = FIREWALL_IMAGE }) {
  // Containers are named after this munin, so two on one machine don't share them.
  const home = createHash('sha256').update(agentsDir).digest('hex').slice(0, 6);
  const nameOf = (agent) => `munin-${home}-${agent.name}`;
  const daemon = packagedDaemon({ platform: 'linux', arch: process.arch });
  const user = typeof process.getuid === 'function' ? `${process.getuid()}:${process.getgid()}` : null;
  const connections = new Map(); // agent name → Connection
  const starting = new Map();

  const stateOf = async (name) => {
    const found = await run('inspect', '--format', `{{.State.Running}} {{index .Config.Labels "munin.layout"}}`, name).catch(() => null);
    const [state, layout] = found ? found.split(' ') : [null, null];
    return { state, layout };
  };
  const labels = (agent, role) => ['--label', `munin.agent=${agent.name}`, '--label', `munin.home=${home}`, '--label', `munin.layout=${LAYOUT}`, '--label', `munin.role=${role}`];

  // The agent's firewall container, running with its rules in. Says whether it had to be made,
  // since a coder's container joined to an old one has no network to share any more.
  async function guard(agent) {
    const name = `${nameOf(agent)}-net`;
    const { state, layout } = await stateOf(name);
    let made = false;
    // A stopped one is made again rather than started, so "the rules are in" is never left over.
    if (state !== 'true' || layout !== LAYOUT) {
      if (state) await run('rm', '--force', name);
      await run('run', '--detach', '--init', '--name', name, ...labels(agent, 'firewall'), '--cap-add', 'NET_ADMIN',
        ...(network ? ['--network', network] : []), firewallImage, 'sh', '-c', FIREWALL);
      made = true;
    }
    for (let tries = 0; ; tries++) {
      if (await run('exec', name, 'test', '-f', '/tmp/munin-firewall').then(() => true, () => false)) return { name, made };
      if ((await stateOf(name)).state !== 'true' || tries > 120) {
        const log = await run('logs', '--tail', '5', name).catch(() => '');
        throw new Error(`munin couldn't put ${agent.name}'s container behind its firewall${log ? `: ${log.split('\n').at(-1)}` : ''}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  // The agent's container, running: started again if it stopped, made if it's gone, and made
  // again if it's from an older layout or its firewall had to be made again.
  function ensure(agent) {
    const name = nameOf(agent);
    if (starting.has(name)) return starting.get(name);
    const ready = (async () => {
      const wall = network === 'none' ? null : await guard(agent);
      const { state, layout } = await stateOf(name);
      if (state && (layout !== LAYOUT || wall?.made)) {
        await run('rm', '--force', name);
      } else if (state === 'true') {
        return name;
      } else if (state === 'false') {
        await run('start', name);
        return name;
      }
      await mkdir(agent.folder, { recursive: true });
      await run('run', '--detach', '--init', '--name', name, ...labels(agent, 'coder'),
        ...(user ? ['--user', user] : []),
        '--network', wall ? `container:${wall.name}` : 'none',
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
      await run('rm', '--force', nameOf(agent), `${nameOf(agent)}-net`).catch(() => {});
    },
    containerOf: nameOf,
    close() {
      for (const connection of connections.values()) connection.close();
      connections.clear();
    },
  };
}
