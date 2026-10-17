// Where coders' tools run: on this machine, with a shell that doesn't get the runtime's keys,
// or in a container of their own (MUNIN_AGENT_SANDBOX=docker). The container tests run where
// Docker and the image are there, and are skipped elsewhere.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { dockerWorks, localShellEnv } from '../src/sandbox.js';

const IMAGE = process.env.MUNIN_TEST_IMAGE || 'buildpack-deps:bookworm-scm';
const imageThere = () => {
  try {
    execFileSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const docker = (await dockerWorks()) && imageThere();
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=me', '-c', 'user.email=me@example.com', ...args], { cwd, encoding: 'utf8' }).trim();

// A container a failed test left behind, gone; deleting the agent does this when the test passes.
function removeContainers(agent) {
  const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=munin.agent=${agent}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  if (ids.length) execFileSync('docker', ['rm', '-f', ...ids], { stdio: 'ignore' });
}

async function fakeTracker() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    const reply = (result) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'initialize') return reply({ instructions: 'The tracker.' });
    if (method === 'tools/list') return reply({ tools: [{ name: 'update_issue', description: 'Change an issue.', inputSchema: { type: 'object', properties: { issue: { type: 'string' }, status: { type: 'string' } } } }] });
    const { issue, status } = params.arguments;
    return reply({ content: [{ type: 'text', text: `Updated ${issue} [${status}] Retry rate-limited calls (assignee: forge)` }] });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, port: server.address().port, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Everything a test opens is closed after it, pass or fail: a failed assertion used to leave
// the runtime, the stand-in tracker and the agent's container running, and the file never finished.
async function setup(t, extra = {}) {
  // The real path: on a Mac the temp folder is behind a symlink, and a shell's pwd says the real one.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'munin-sandbox-')));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), reposDir: join(dir, 'repos'), ollamaUrl: null, user: 'Mikkel', ...extra };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  const runtime = await openRuntime(settings, { models, timers: false });
  t.after(() => runtime.close());
  const heard = [];
  const seen = new Set();
  const turn = async (name, ...steps) => {
    faux.setResponses(steps.map((step) => (context) => {
      const last = [...context.messages].reverse().find((m) => m.role === 'toolResult');
      if (last && !seen.has(last.toolCallId)) {
        seen.add(last.toolCallId);
        heard.push({ text: last.content.map((c) => c.text).join('').trim(), error: last.isError });
      }
      return typeof step === 'string'
        ? fauxAssistantMessage([fauxText(step)])
        : fauxAssistantMessage([fauxToolCall(step[0], step[1])], { stopReason: 'toolUse' });
    }));
    await runtime.send(name, 'Go.');
    await runtime.waitForIdle();
  };
  return { dir, settings, runtime, heard, turn };
}

test("a shell on this machine gets harmless variables and the ones you name, not the runtime's", async (t) => {
  const env = localShellEnv({ PATH: '/usr/bin', HOME: '/home/me', LC_ALL: 'C.UTF-8', OPENROUTER_API_KEY: 'sk-or', MUNIN_DB: '/x', GH_TOKEN: 'ghp' }, ['GH_TOKEN']);
  assert.deepEqual(Object.keys(env).sort(), ['GH_TOKEN', 'GIT_EDITOR', 'GIT_PAGER', 'GIT_TERMINAL_PROMPT', 'HOME', 'LC_ALL', 'PAGER', 'PATH']);

  process.env.OPENROUTER_API_KEY_TEST = 'sk-or-test';
  process.env.GH_TOKEN_TEST = 'ghp-test';
  t.after(() => { delete process.env.OPENROUTER_API_KEY_TEST; delete process.env.GH_TOKEN_TEST; });
  const { runtime, heard, turn } = await setup(t, { agentEnv: ['GH_TOKEN_TEST'] });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  await turn('forge', ['bash', { command: 'echo key=${OPENROUTER_API_KEY_TEST:-none} gh=${GH_TOKEN_TEST:-none}; git --version > /dev/null && echo git' }], 'Done.');
  assert.equal(heard[0].text, 'key=none gh=ghp-test\ngit');
  assert.equal((await runtime.me()).sandbox, null);
});

test('in a container, a coder reaches its own folder and nothing else of this machine', { skip: !docker && 'needs Docker and the image' }, async (t) => {
  const { dir, settings, runtime, heard, turn } = await setup(t, { sandbox: 'docker', agentImage: IMAGE });
  t.after(() => removeContainers('forge'));
  const outside = join(dir, 'runtime-secret.txt');
  await writeFile(outside, 'the tracker database\n');
  const host = await fakeTracker(); // listens on this machine's 127.0.0.1
  t.after(() => host.close());
  process.env.OPENROUTER_API_KEY_TEST = 'sk-or-test';
  t.after(() => { delete process.env.OPENROUTER_API_KEY_TEST; });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  assert.deepEqual((await runtime.me()).sandbox, { kind: 'docker', image: IMAGE });
  assert.equal((await runtime.agent('forge')).worksIn.sandbox, 'docker');

  await turn('forge',
    ['read', { path: outside }],
    ['bash', { command: `cat ${outside} 2>&1 | head -1; id -u; echo key=\${OPENROUTER_API_KEY_TEST:-none}; curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${host.port}/ || echo ' unreachable'; pwd` }],
    'Done.');
  assert.equal(heard[0].error, true, 'read fails');
  assert.doesNotMatch(heard[0].text, /tracker database/);
  const [cat, uid, key, curl, pwd] = heard[1].text.split('\n');
  assert.match(cat, /No such file or directory/);
  assert.equal(uid, String(process.getuid()), 'files it writes are yours');
  assert.equal(key, 'key=none');
  assert.match(curl, /unreachable/, "this machine's 127.0.0.1 isn't the container's");
  assert.equal(pwd, join(settings.agentsDir, 'forge'));
  await runtime.deleteAgent('forge');
});

test('in a container, a coder takes an issue and commits in its worktree', { skip: !docker && 'needs Docker and the image' }, async (t) => {
  const { dir, settings, runtime, heard, turn } = await setup(t, { sandbox: 'docker', agentImage: IMAGE });
  t.after(() => removeContainers('forge'));
  const origin = join(dir, 'origin');
  await mkdir(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  await writeFile(join(origin, 'README.md'), '# munin\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', 'Start');
  await runtime.setRepo('MUN', { source: origin });
  const tracker = await fakeTracker();
  t.after(() => tracker.close());
  await mkdir(join(settings.agentsDir, 'anvil', '.repos', 'MUN'), { recursive: true }); // another coder's, on this machine
  // forge's container from before, made when containers mounted munin's clones too: it's made again.
  const home = createHash('sha256').update(settings.agentsDir).digest('hex').slice(0, 6);
  execFileSync('docker', ['run', '--detach', '--name', `munin-${home}-forge`, '--label', 'munin.agent=forge',
    '--volume', `${join(dir, 'repos')}:${join(dir, 'repos')}`, IMAGE, 'sleep', 'infinity'], { stdio: 'ignore' });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model', tracker: { url: tracker.url, token: 'tok-forge' } });

  await turn('forge',
    ['update_issue', { issue: 'MUN-5', status: 'in_progress' }],
    ['bash', { command: `pwd; git branch --show-current; echo retry > retry.txt; git add retry.txt; git commit -qm "Retry on 429"; git log -1 --format=%an; ls ${join(dir, 'repos')} 2>&1 | head -1; ls ${join(settings.agentsDir, 'anvil')} 2>&1 | head -1` }],
    'Committed.');
  const tree = join(settings.agentsDir, 'forge', 'MUN-5');
  const [pwd, branch, author, repos, anvil] = heard[1].text.split('\n');
  assert.deepEqual([pwd, branch, author], [tree, 'mun-5-retry-rate-limited-calls', 'forge']);
  assert.match(repos, /No such file or directory/, "munin's own clones aren't in the container");
  assert.match(anvil, /No such file or directory/, "nor are other agents' folders");
  assert.equal(git(join(settings.agentsDir, 'forge', '.repos', 'MUN'), 'log', '-1', '--format=%s', 'mun-5-retry-rate-limited-calls'), 'Retry on 429', "the commit is in forge's own clone");
  const container = execFileSync('docker', ['ps', '--filter', 'label=munin.agent=forge', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split('\n').find((n) => n.endsWith('-forge'));
  await runtime.deleteAgent('forge');
  assert.throws(() => execFileSync('docker', ['inspect', container], { stdio: 'ignore' }), 'deleting the agent removes its container');
});
