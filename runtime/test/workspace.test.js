// A worktree per issue, on real git repositories: coders side by side on branches of their
// own, a reviewer on a detached copy, and worktrees tidied once their branch is merged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { branchFor } from '../src/workspace.js';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=me', '-c', 'user.email=me@example.com', ...args], { cwd, encoding: 'utf8' }).trim();
const TITLES = { 'MUN-5': 'Retry rate-limited calls', 'MUN-6': 'Stream tool output', 'MUN-7': 'Load skills from git', 'WEB-1': 'Dark mode' };

async function fakeTracker() {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
    const token = (req.headers.authorization || '').replace(/^Bearer tok-/, '');
    const reply = (result) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
    if (method === 'initialize') return reply({ protocolVersion: '2025-06-18', capabilities: {}, instructions: 'The tracker.' });
    if (method === 'tools/list') {
      return reply({ tools: [{ name: 'update_issue', description: 'Change an issue.', inputSchema: { type: 'object', properties: { issue: { type: 'string' }, status: { type: 'string' } }, required: ['issue'] } }] });
    }
    const { issue, status } = params.arguments;
    return reply({ content: [{ type: 'text', text: `Updated ${issue} [${status}] ${TITLES[issue]} (assignee: ${token})` }], isError: false });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, close: () => new Promise((resolve) => server.close(resolve)) };
}

// Everything a test opens is closed after it, pass or fail: a failed assertion used to leave
// the runtime and the stand-in tracker running, and the test file never finished.
async function setup(t) {
  // The real path: on a Mac the temp folder is behind a symlink, and a shell's pwd says the real one.
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'munin-workspace-')));
  const origin = join(dir, 'origin');
  await mkdir(origin);
  git(origin, 'init', '--quiet', '-b', 'main');
  await writeFile(join(origin, 'README.md'), '# munin\n');
  git(origin, 'add', '.');
  git(origin, 'commit', '--quiet', '-m', 'Start');

  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), reposDir: join(dir, 'repos'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const heard = []; // what tools answered, as the model saw it
  const models = await buildModels(settings, { extra: [faux.provider], env: {} });
  const runtime = await openRuntime(settings, { models, timers: false });
  const tracker = await fakeTracker();
  t.after(() => Promise.all([runtime.close(), tracker.close()]));
  const seen = new Set();
  const say = (...steps) => faux.setResponses(steps.map((step) => (context) => {
    // A moved folder adds a system message after the tool's answer, so look back for it.
    const last = [...context.messages].reverse().find((m) => m.role === 'toolResult');
    if (last && !seen.has(last.toolCallId)) {
      seen.add(last.toolCallId);
      heard.push(last.content.map((c) => c.text).join(''));
    }
    return typeof step === 'string'
      ? fauxAssistantMessage([fauxText(step)])
      : fauxAssistantMessage([fauxToolCall(step[0], step[1])], { stopReason: 'toolUse' });
  }));
  const coder = (name, role = 'coder') => runtime.createAgent({ name, role, provider: 'scripted', model: 'model', tracker: { url: tracker.url, token: `tok-${name}` } });
  const turn = async (name, ...steps) => {
    say(...steps);
    await runtime.send(name, 'Go.');
    await runtime.waitForIdle();
  };
  return { dir, origin, settings, runtime, tracker, heard, coder, turn };
}

test('coders get a worktree per issue, on a branch named after it, and work side by side', async (t) => {
  const { origin, settings, runtime, tracker, heard, coder, turn } = await setup(t);
  await assert.rejects(runtime.setRepo('MUN', { source: join(origin, 'nope') }), /no git repository/);
  assert.deepEqual(await runtime.setRepo('mun', { source: origin }), { project: 'MUN', source: origin, base: 'main' });
  assert.deepEqual(await runtime.repos(), [{ project: 'MUN', source: origin, base: 'main' }]);
  await coder('forge');
  await coder('anvil');

  await turn('forge',
    ['update_issue', { issue: 'MUN-5', status: 'in_progress' }],
    ['bash', { command: 'pwd; git branch --show-current; echo retry > retry.txt; git add retry.txt; git commit -qm "Retry on 429"; git log -1 --format=%an' }],
    'Committed.');
  const forgeTree = join(settings.agentsDir, 'forge', 'MUN-5');
  const branch = branchFor({ id: 'MUN-5', title: TITLES['MUN-5'] });
  assert.equal(branch, 'mun-5-retry-rate-limited-calls');
  assert.match(heard[0], new RegExp(`Your worktree for MUN-5 is ready.*${forgeTree}, on a new branch, ${branch}, from main`));
  assert.deepEqual(heard[1].trim().split('\n'), [forgeTree, branch, 'forge'], 'the shell runs in the worktree, and commits are the agent\'s');
  const forge = await runtime.agent('forge');
  assert.equal(forge.worksIn.branch, branch);
  assert.deepEqual(forge.worksIn.issue, { id: 'MUN-5', title: TITLES['MUN-5'] });

  await turn('anvil', ['update_issue', { issue: 'MUN-6', status: 'in_progress' }], ['bash', { command: 'pwd; ls' }], 'Looking.');
  assert.deepEqual(heard[3].trim().split('\n'), [join(settings.agentsDir, 'anvil', 'MUN-6'), 'README.md'], "anvil's checkout has none of forge's work");

  await turn('forge', ['update_issue', { issue: 'WEB-1', status: 'in_progress' }], 'No repo.');
  assert.match(heard[4], /munin has no repository for WEB, so you're working in your own folder/);
});

test("a reviewer opens someone's branch detached, a retake picks up the branch, and merged worktrees go", async (t) => {
  const { dir, origin, settings, runtime, tracker, heard, coder, turn } = await setup(t);
  await runtime.setRepo('MUN', { source: origin });
  await coder('forge');
  await coder('vera', 'reviewer');
  const branch = 'mun-5-retry-rate-limited-calls';
  await turn('forge',
    ['update_issue', { issue: 'MUN-5', status: 'in_progress' }],
    ['bash', { command: 'echo retry > retry.txt && git add retry.txt && git commit -qm "Retry on 429"' }],
    ['update_issue', { issue: 'MUN-5', status: 'in_review' }],
    'In review.');

  await turn('vera', ['open_worktree', { issue: 'MUN-7' }], 'Nothing there.');
  assert.match(heard.at(-1), /MUN-7 has no branch yet\. To work on it, take it/);
  await turn('vera', ['open_worktree', { issue: '../../forge' }], 'Nope.');
  assert.match(heard.at(-1), /isn't an issue id like MUN-46/);
  await assert.rejects(runtime.setRepo('WEB', { source: '--upload-pack=touch x' }), /isn't a git URL or a folder/);
  await turn('vera',
    ['open_worktree', { issue: 'MUN-5' }],
    ['bash', { command: 'cat retry.txt; git branch --show-current; echo nit >> retry.txt; git commit -qam "Nit"' }],
    'Reviewed.');
  assert.match(heard.at(-2), new RegExp(`detached copy of ${branch} to review MUN-5: ${join(settings.agentsDir, 'vera', 'MUN-5')}`));
  assert.equal(heard.at(-1).trim(), 'retry', 'detached: no branch to commit onto');
  const repo = join(dir, 'repos', 'MUN');
  assert.equal(git(repo, 'log', '-1', '--format=%s', branch), 'Retry on 429', "vera's commit didn't land on forge's branch");
  assert.equal((await runtime.agent('vera')).worksIn.detached, true);

  // Sent back: forge takes it again and finds its branch as it left it.
  await turn('forge', ['update_issue', { issue: 'MUN-5', status: 'in_progress' }], 'Back on it.');
  assert.match(heard.at(-1), new RegExp(`on ${branch}, as you left it`));

  // Merged upstream: the next issue tidies MUN-5's worktree away.
  git(origin, 'pull', '--quiet', '--no-rebase', repo, branch);
  await turn('forge', ['update_issue', { issue: 'MUN-7', status: 'in_progress' }], 'Next.');
  assert.ok(!existsSync(join(settings.agentsDir, 'forge', 'MUN-5')), 'merged and clean, so it went');
  assert.ok(existsSync(join(settings.agentsDir, 'forge', 'MUN-7', 'README.md')));
  assert.equal(readFileSync(join(settings.agentsDir, 'forge', 'MUN-7', 'retry.txt'), 'utf8'), 'retry\n', 'new branches start from the fetched base');

  await turn('forge', ['open_worktree', {}], 'Home.');
  assert.match(heard.at(-1), /You're in your own folder again/);
  assert.equal((await runtime.agent('forge')).worksIn.branch, null);
});
