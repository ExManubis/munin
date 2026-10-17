// Where coders work. The runtime keeps a clone of each project's repository (the hub, in `dir`),
// and each agent gets a clone of its own in its folder, made from the hub, with a git worktree
// per issue on a branch named after the issue. A coder's container sees only its own folder,
// so it can't touch another coder's branches or the hub. The hub fetches the project and
// collects every agent's issue branches, and each agent's clone fetches them from it as
// munin/<branch>, so a reviewer gets someone's branch to look at without being able to change
// it. How work is delivered (push, pull request, merge) is up to the project's brief, not munin.

import { execFile } from 'node:child_process';
import { access, mkdir, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export class WorkspaceError extends Error {}

const PROJECT = /^[A-Z][A-Z0-9]{0,9}$/;
const ISSUE = /^[A-Z][A-Z0-9]{0,9}-\d{1,9}$/;
// Issue ids name folders and branches, so they have to look like one: "MUN-46".
function checkIssue(issue) {
  if (!ISSUE.test(issue?.id || '')) throw new WorkspaceError(`"${issue?.id}" isn't an issue id like MUN-46.`);
}

function git(cwd, ...args) {
  return new Promise((done, fail) => {
    execFile('git', args, { cwd, timeout: 5 * 60 * 1000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (!err) return done(stdout.trim());
      const lines = String(stderr || err.message).trim().split('\n').filter(Boolean);
      return fail(new WorkspaceError(lines.at(-1)?.replace(/^(fatal|error): /, '') || 'git failed.'));
    });
  });
}
const quietly = (promise) => promise.then(() => true, () => false);
const exists = (path) => quietly(access(path));

// "MUN-46" and "Stream tool output to Telegram" → "mun-46-stream-tool-output-to-telegram".
export function branchFor(issue) {
  const slug = String(issue.title || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .split('-').slice(0, 5).join('-');
  return [issue.id.toLowerCase(), slug].filter(Boolean).join('-').slice(0, 60).replace(/-+$/, '');
}

const expand = (path) => (path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
const isRemote = (source) => /^(https?|ssh|git|file):\/\/|^[\w.-]+@[\w.-]+:/.test(source);

// `dir` holds the hubs and `agentsDir` the agents' folders. `repos` is the saved setup,
// { KEY: { source, base } }, which this changes in place; save it after setRepo and removeRepo.
export function createWorkspace({ dir, agentsDir, repos }) {
  const locks = new Map(); // one git operation at a time per repository
  const serial = (key, fn) => {
    const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
    locks.set(key, next.catch(() => {}));
    return next;
  };
  const clonePath = (key) => join(dir, key);
  const ownClone = (folder, key) => join(folder, '.repos', key);
  const issueRefs = (key) => `${key.toLowerCase()}-*`;

  // Every agent's issue branches into the hub, so the others can find them.
  async function collect(key) {
    const hub = clonePath(key);
    const names = await readdir(agentsDir).catch(() => []);
    for (const name of names) {
      const clone = ownClone(join(agentsDir, name), key);
      if (await exists(clone)) await quietly(git(hub, 'fetch', '--quiet', clone, `+refs/heads/${issueRefs(key)}:refs/heads/${issueRefs(key)}`));
    }
  }

  // The agent's own clone of the project, made from the hub if it hasn't one, with the
  // project's branches as origin/… and everyone's issue branches as munin/…, fresh from the hub.
  async function cloneFor(agent, key) {
    const hub = clonePath(key);
    const clone = ownClone(agent.folder, key);
    if (!(await exists(clone))) {
      await mkdir(join(agent.folder, '.repos'), { recursive: true });
      // Copied, not hardlinked: a hardlinked object is the hub's own file.
      await git(agent.folder, 'clone', '--no-checkout', '--no-hardlinks', '--quiet', '--', hub, clone);
      await git(clone, 'remote', 'set-url', 'origin', repos[key].source); // pushes go to the project
      await git(clone, 'config', 'extensions.worktreeConfig', 'true');
    }
    await git(clone, 'fetch', '--quiet', '--prune', hub, '+refs/remotes/origin/*:refs/remotes/origin/*', `+refs/heads/${issueRefs(key)}:refs/remotes/munin/${issueRefs(key)}`);
    return clone;
  }

  // Fetch the project and pass branches around: the hub from the project and every agent, then
  // the agent's clone from the hub.
  async function sync(agent, key) {
    await quietly(git(clonePath(key), 'fetch', '--quiet', '--prune', 'origin'));
    await collect(key);
    return cloneFor(agent, key);
  }

  // A worktree from before agents had clones of their own belongs to the hub, which a container
  // can't see. It moves to the agent's clone: what's uncommitted is committed first, so nothing
  // is lost, and the branch comes along. A detached review copy is just removed, if it's clean.
  async function moveOver(agent, key, folder, clone) {
    if (!(await exists(folder))) return null;
    const common = resolve(folder, await git(folder, 'rev-parse', '--git-common-dir').catch(() => '.'));
    if (common !== join(clonePath(key), '.git')) return null;
    const branch = await git(folder, 'branch', '--show-current').catch(() => '');
    let kept = false;
    if (branch) {
      if (await git(folder, 'status', '--porcelain')) {
        await git(folder, 'add', '--all');
        await git(folder, 'commit', '--quiet', '--no-verify', '-m', 'Work in progress, kept when munin moved this worktree');
        kept = true;
      }
      await git(clone, 'fetch', '--quiet', clonePath(key), `+refs/heads/${branch}:refs/heads/${branch}`);
    } else if (await git(folder, 'status', '--porcelain')) {
      return null; // a review copy with changes stays where it is
    }
    await git(clonePath(key), 'worktree', 'remove', '--force', folder);
    return { branch: branch || null, kept };
  }

  async function setRepo(key, { source, base } = {}) {
    if (!PROJECT.test(key)) throw new WorkspaceError('Projects are keys like MUN.');
    const where = String(source || '').trim();
    if (!where) throw new WorkspaceError('Say where the code is: a git URL, or a folder with a repository in it.');
    if (where.startsWith('-')) throw new WorkspaceError("That isn't a git URL or a folder.");
    if (!isRemote(where) && !(await quietly(git(resolve(expand(where)), 'rev-parse', '--git-dir')))) {
      throw new WorkspaceError(`There's no git repository at ${where}.`);
    }
    const repo = { source: isRemote(where) ? where : resolve(expand(where)), base: String(base || '').trim() || null };
    await serial(key, async () => {
      const path = clonePath(key);
      if (await exists(path) && repos[key]?.source === repo.source) return;
      if (await exists(path)) throw new WorkspaceError(`${key} already has a clone from ${repos[key]?.source || 'somewhere else'}; remove it first.`);
      await mkdir(dir, { recursive: true });
      await git(dir, 'clone', '--no-checkout', '--quiet', '--', repo.source, key);
      await git(path, 'config', 'extensions.worktreeConfig', 'true');
    });
    if (!repo.base) {
      const head = await git(clonePath(key), 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD').catch(() => 'origin/main');
      repo.base = head.replace(/^origin\//, '');
    }
    repos[key] = repo;
    return describe(key);
  }

  function removeRepo(key) {
    delete repos[key]; // the clone stays, with any worktrees agents still have in it
  }

  const describe = (key) => ({ project: key, source: repos[key].source, base: repos[key].base });
  const list = () => Object.keys(repos).sort().map(describe);

  // The issue's branch, if anyone has made one: "mun-46-…" or just "mun-46". The agent's own
  // comes first; `ref` is where it is, `branch` its name.
  async function branchOf(clone, issue) {
    const prefix = issue.id.toLowerCase();
    for (const space of ['refs/heads', 'refs/remotes/munin']) {
      const found = (await git(clone, 'for-each-ref', '--format=%(refname:short)', `${space}/${prefix}`, `${space}/${prefix}-*`)).split('\n').filter(Boolean);
      if (found[0]) return { ref: found[0], branch: found[0].replace(/^munin\//, ''), own: space === 'refs/heads' };
    }
    return null;
  }

  // Worktrees as git lists them: [{ path, branch }].
  async function worktrees(path) {
    const out = await git(path, 'worktree', 'list', '--porcelain');
    return out.split('\n\n').map((block) => ({
      path: /^worktree (.*)$/m.exec(block)?.[1],
      branch: /^branch refs\/heads\/(.*)$/m.exec(block)?.[1] || null,
    })).filter((w) => w.path);
  }

  // A worktree of its own for an issue the agent took: its branch from before if there is one,
  // or a new branch from the project's base. Commits in it are the agent's.
  async function openOwn(agent, issue) {
    checkIssue(issue);
    const key = issue.id.split('-')[0];
    if (!repos[key]) return null;
    return serial(key, async () => {
      const repo = await sync(agent, key);
      const folder = join(agent.folder, issue.id);
      const base = repos[key].base;
      const moved = await moveOver(agent, key, folder, repo);
      const found = await branchOf(repo, issue);
      let branch = found?.branch || null;
      let fresh = false;
      if (await exists(folder)) {
        branch = await git(folder, 'branch', '--show-current') || branch;
      } else if (found?.own) {
        const elsewhere = (await worktrees(repo)).some((w) => w.branch === branch);
        await git(repo, 'worktree', 'add', ...(elsewhere ? ['--force'] : []), folder, branch);
      } else if (found) {
        await git(repo, 'worktree', 'add', '-b', branch, folder, found.ref); // someone else's, to carry on
      } else {
        branch = branchFor(issue);
        const start = await quietly(git(repo, 'rev-parse', '--verify', '--quiet', `origin/${base}`)) ? `origin/${base}` : base;
        await git(repo, 'worktree', 'add', '-b', branch, folder, start);
        fresh = true;
      }
      await git(folder, 'config', '--worktree', 'user.name', agent.name);
      await git(folder, 'config', '--worktree', 'user.email', `${agent.name}@munin.local`);
      await tidy(agent, key, folder);
      return { folder, branch, base, fresh, issue, kept: Boolean(moved?.kept) };
    });
  }

  // Someone else's branch, detached, to review: the agent can look and run things, but its
  // commits don't land on their branch.
  async function openReview(agent, issue) {
    checkIssue(issue);
    const key = issue.id.split('-')[0];
    if (!repos[key]) throw new WorkspaceError(`munin has no repository for ${key}.`);
    return serial(key, async () => {
      const repo = await sync(agent, key);
      const folder = join(agent.folder, issue.id);
      await moveOver(agent, key, folder, repo);
      const found = await branchOf(repo, issue);
      if (!found) throw new WorkspaceError(`${issue.id} has no branch yet.`);
      if (await exists(folder)) await git(folder, 'checkout', '--quiet', '--detach', found.ref);
      else await git(repo, 'worktree', 'add', '--detach', folder, found.ref);
      await tidy(agent, key, folder);
      return { folder, branch: found.branch, base: repos[key].base, detached: true, issue };
    });
  }

  // Worktrees in the agent's folder that are done with: nothing uncommitted, and detached or on
  // a branch the base already has. The one it's going to work in stays.
  async function tidy(agent, key, keep) {
    const repo = ownClone(agent.folder, key);
    const base = repos[key].base;
    const target = await quietly(git(repo, 'rev-parse', '--verify', '--quiet', `origin/${base}`)) ? `origin/${base}` : base;
    for (const tree of await worktrees(repo)) {
      if (tree.path === keep || !tree.path.startsWith(`${agent.folder}/`)) continue;
      if (await git(tree.path, 'status', '--porcelain').catch(() => 'unknown')) continue;
      const merged = !tree.branch || await quietly(git(repo, 'merge-base', '--is-ancestor', tree.branch, target));
      if (merged) await quietly(git(repo, 'worktree', 'remove', tree.path));
    }
  }

  // Whether the agent has a worktree of its own for the issue, on the issue's branch.
  async function ownsWorktree(agent, issue) {
    checkIssue(issue);
    const folder = join(agent.folder, issue.id);
    if (!(await exists(folder))) return false;
    return (await git(folder, 'branch', '--show-current').catch(() => '')) !== '';
  }

  return { setRepo, removeRepo, list, openOwn, openReview, ownsWorktree, has: (key) => Boolean(repos[key]) };
}
