// Settings, behind your square in the topbar: the models munin's own agents run on, where
// each project's code lives, the outside agents that connect to the tracker over MCP (a token
// each), notifications, setup once more, and, on the mock runtime, a reset for its sample agents.

import { api } from '../api.js';
import { runtime } from '../runtime/index.js';
import { store, isWorking } from '../store.js';
import { h, agentAvatar, statusIcon, time, topbar, bindDraft, drafts, toast, copyButton, toggle } from '../ui.js';
import { notificationsSupported, notificationsOn, pushSupported, toggleNotifications } from '../notify.js';

let created = null; // { name, token } for the token just created; shown once
let tab = 'claude';
let keyFor = null; // the provider whose key is being pasted

export const view = {
  title: () => 'Settings',

  async load() {
    const [agents, providers, repos, about, apps, google, github] = await Promise.all([api.agents(), runtime.providers(), runtime.repos(), runtime.me(), runtime.apps(), runtime.google(), api.github()]);
    googleReturned();
    return { agents, providers, repos, apps, google, github, sandbox: about.sandbox, me: store.me };
  },

  leave() {
    created = null; // the token is only ever shown on the screen that created it
    if (keyFor) drafts.delete(`key:${keyFor}`); // nor is a key left half-pasted
    keyFor = null;
  },

  render({ agents, providers, repos, apps, google, github, sandbox, me }, ctx) {
    const live = agents.filter((a) => !a.revoked);
    return h('div', { class: 'page' },
      topbar([h('span', { class: 'title' }, 'Settings')]),
      h('div', { class: 'agents-page' },
        providerSection(providers, ctx),
        googleSection(google, ctx),
        appsSection(apps, ctx),
        codeSection(repos, sandbox, ctx),
        githubSection(github, ctx),
        h('section', { class: 'section', id: 'outside-agents' },
          h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Outside agents'), h('span', { class: 'mono muted' }, `${live.length} connected`)),
          h('p', { class: 'lead' },
            'Any MCP client can work in the tracker: Claude Code, Codex, a local model. Each connects with its own token, ',
            'so you can revoke one without touching the others, and shows up under the name you give it here.'),
          h('div', { class: 'mcp-url' },
            h('span', { class: 'label' }, 'MCP URL'),
            h('code', {}, me.mcp_url),
            copyButton(() => me.mcp_url))),
        table(agents, ctx),
        connect(agents, me, ctx),
        notifications(ctx),
        h('section', { class: 'section', id: 'setup' },
          h('div', { class: 'section-head' }, h('h2', {}, 'Setup')),
          h('div', { class: 'setting' },
            h('div', { class: 'setting-main' },
              h('div', {}, 'Go through setup again'),
              h('div', { class: 'hint' }, 'What agents call you, the model key and your favourite models, a new agent, and outside agents. Nothing you set up is lost.')),
            h('a', { class: 'btn small', href: '#/setup' }, 'Open setup'))),
        runtime.kind === 'mock' ? dummy(ctx) : null));
  },
};

function providerSection(providers, ctx) {
  return h('section', { class: 'section first', id: 'providers' },
    h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Models and providers')),
    h('p', { class: 'lead' }, "Where munin's own agents get their models. Each agent picks a provider and a model on its profile."),
    h('div', { class: 'provider-list' },
      providers.map((p) => [
        h('div', { class: 'agent-row provider-row' },
          h('span', { class: 'agent-name' }, h('span', {}, p.name)),
          h('span', { class: 'agent-seen' }, p.detail),
          h('span', { class: ['label', p.connected && 'on'] }, p.connected ? 'Connected' : 'Off'),
          // A provider that takes a key gets it pasted here; the others come from the runtime's environment.
          h('span', { class: 'agent-action' }, p.takesKey && keyFor !== p.id
            ? h('button', { type: 'button', class: 'link', onclick: () => openKey(p.id, ctx) }, p.key?.from === 'settings' ? 'Change key' : 'Paste key')
            : null)),
        keyFor === p.id ? keyForm(p, ctx) : null,
      ])));
}

function openKey(id, ctx) {
  keyFor = id;
  ctx.rerender();
  document.querySelector(`[data-keep="key:${id}"]`)?.focus();
}

function closeKey(ctx) {
  drafts.delete(`key:${keyFor}`);
  keyFor = null;
  ctx.rerender();
}

// The key goes to the runtime, which keeps it on its machine and only ever shows its last four
// characters. The browser forgets it once it's saved.
function keyForm(provider, ctx) {
  const input = bindDraft(h('input', {
    class: 'input',
    type: 'password',
    placeholder: 'sk-or-v1-…',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': `${provider.name} key`,
    onkeydown: (e) => e.key === 'Escape' && closeKey(ctx),
  }), `key:${provider.id}`);
  const button = h('button', { type: 'submit', class: 'btn small primary' }, 'Save');
  const save = async (e) => {
    e.preventDefault();
    if (!input.value.trim()) return input.focus();
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      await runtime.setKey(provider.id, input.value);
      closeKey(ctx);
      toast(`${provider.name} is connected. Pick one of its models on an agent's profile.`);
      ctx.reload();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Save';
      toast(err.message, { error: true });
    }
  };
  const remove = async () => {
    if (!confirm(`Remove the ${provider.name} key you pasted? Agents on its models fall back to the stand-in, unless the runtime has a key in its environment.`)) return;
    try {
      const after = await runtime.removeKey(provider.id);
      closeKey(ctx);
      toast(after?.connected ? `Removed. ${provider.name} uses the key in the runtime's environment again.` : `Removed. ${provider.name} is off.`);
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h('form', { class: 'key-form', onsubmit: save },
    h('div', { class: 'key-fields' },
      input,
      button,
      h('button', { type: 'button', class: 'link', onclick: () => closeKey(ctx) }, 'Cancel'),
      provider.key?.from === 'settings' ? h('button', { type: 'button', class: 'link', onclick: remove }, 'Remove key') : null),
    h('p', { class: 'hint' },
      provider.id === 'openrouter'
        ? ['Make one at ', h('a', { href: 'https://openrouter.ai/settings/keys', target: '_blank', rel: 'noopener noreferrer' }, 'openrouter.ai/settings/keys'), '. ']
        : null,
      "munin keeps it on the machine it runs on, uses it in place of any in the runtime's environment, and never shows it again. Agents don't get it."));
}

// Google: your own OAuth client, then signing in, for Gmail and Calendar. Google sends the
// browser back to the runtime, which comes back here with ?google=ok|failed&message=….
function googleReturned() {
  const query = new URLSearchParams(location.search);
  if (!query.has('google')) return;
  toast(query.get('message') || 'Back from Google.', { error: query.get('google') !== 'ok' });
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
}

function googleSection(google, ctx) {
  const step = (...parts) => h('li', {}, ...parts);
  const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const signIn = async () => {
    try {
      const { url } = await runtime.googleSignIn({ services: ['gmail', 'calendar'], back: location.href });
      location.href = url;
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  const signOut = async () => {
    if (!confirm(`Sign out ${google.account.email || 'of Google'}? Agents lose Gmail and Calendar until you sign in again.`)) return;
    await runtime.googleSignOut();
    ctx.reload();
  };
  const head = h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Google'),
    h('span', { class: 'mono muted' }, google.account ? (google.account.working ? 'Signed in' : 'Sign in again') : google.client.configured ? 'Not signed in' : 'Not set up'));
  const lead = h('p', { class: 'lead' }, "Gmail and Google Calendar for munin's agents: pick them under Apps on an agent's profile. Reading and drafting need no asking; sending mail and changing your calendar ask you first.");
  if (google.account) {
    return h('section', { class: 'section', id: 'google' }, head, lead,
      h('div', { class: 'provider-list' }, h('div', { class: 'agent-row provider-row' },
        h('span', { class: 'agent-name' }, h('span', {}, google.account.email || 'Your Google account')),
        h('span', { class: 'agent-seen' }, google.account.working ? google.account.services.map((s) => (s === 'gmail' ? 'Gmail' : 'Calendar')).join(' and ') : google.account.problem),
        h('span', { class: ['label', google.account.working && 'on'] }, google.account.working ? 'Connected' : 'Stopped'),
        h('span', { class: 'agent-action' }, google.account.working
          ? h('button', { type: 'button', class: 'link', onclick: signOut }, 'Sign out')
          : h('button', { type: 'button', class: 'link', onclick: signIn }, 'Sign in again')))),
      // A sign-in from before munin asked for gmail.modify: Gmail works, but can't organise.
      google.account.working && google.account.services.includes('gmail') && !google.account.organise
        ? h('p', { class: 'hint' }, 'To let agents label, archive and clean up your mail, Google needs one more permission (gmail.modify). Add it under Data Access in your Google Cloud project, then ',
          h('button', { type: 'button', class: 'link', onclick: signIn }, 'sign in again'), '.')
        : null);
  }
  if (google.client.configured) {
    return h('section', { class: 'section', id: 'google' }, head, lead,
      h('p', { class: 'hint' }, `Your OAuth client: ${google.client.id}. Google's page asks you to allow Gmail and Calendar, then sends you back here.`),
      h('div', { class: 'key-fields' }, h('button', { type: 'button', class: 'btn small primary', onclick: signIn }, 'Sign in with Google')));
  }
  const json = bindDraft(h('textarea', { class: 'input', rows: 4, placeholder: '{"web":{"client_id":"….apps.googleusercontent.com","client_secret":"…"}}', 'aria-label': 'OAuth client JSON', spellcheck: false }), 'google:client');
  const save = async (e) => {
    e.preventDefault();
    if (!json.value.trim()) return json.focus();
    try {
      await runtime.setGoogleClient(json.value);
      drafts.delete('google:client');
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h('section', { class: 'section', id: 'google' }, head, lead,
    h('p', { class: 'hint' }, 'munin signs in with an OAuth client of your own, from Google Cloud. Once, about five minutes:'),
    h('ol', { class: 'steps' },
      step('Make a project: ', link('https://console.cloud.google.com/projectcreate', 'console.cloud.google.com/projectcreate'), '.'),
      step('Turn on the ', link('https://console.cloud.google.com/apis/library/gmail.googleapis.com', 'Gmail API'), ' and the ', link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'), '.'),
      step('Set up the consent screen under ', link('https://console.cloud.google.com/auth/overview', 'Google Auth Platform'), ': Internal if your Google Workspace allows it; otherwise External, and add yourself under Audience → Test users. (An External app in Testing has to sign in again every 7 days.)'),
      step('Under ', link('https://console.cloud.google.com/auth/clients', 'Clients'), ', create a client of type Web application, with this as an authorized redirect URI: ',
        h('code', {}, google.redirect), ' ', copyButton(() => google.redirect)),
      step('Download its JSON and paste it here.')),
    h('form', { class: 'key-form', onsubmit: save },
      json,
      h('div', { class: 'key-fields' }, h('button', { type: 'submit', class: 'btn small primary' }, 'Save client')),
      h('p', { class: 'hint' }, "munin keeps the client and your sign-in on the machine it runs on and never shows them again. Agents don't get them.")));
}

// GitHub: a token for reading pull requests linked to issues, for private repositories and more
// than GitHub's 60 requests an hour without one. The tracker keeps it and shows its last four.
function githubSection(github, ctx) {
  const input = bindDraft(h('input', { class: 'input', type: 'password', placeholder: 'ghp_… or github_pat_…', autocomplete: 'off', spellcheck: false, 'aria-label': 'GitHub token' }), 'github:token');
  const save = async (e) => {
    e.preventDefault();
    try {
      await api.setGithubToken(input.value.trim() || null);
      drafts.delete('github:token');
      toast(input.value.trim() ? 'Saved. munin reads pull requests with it.' : 'Token removed.');
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h('section', { class: 'section', id: 'github' },
    h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'GitHub'), h('span', { class: 'mono muted' }, github.token ? `token …${github.token.hint}` : 'no token')),
    h('p', { class: 'lead' }, "Pull requests linked to issues show their title and whether they've merged. Public repositories need no token; private ones, and more than 60 checks an hour, do."),
    h('form', { class: 'key-form', onsubmit: save },
      h('div', { class: 'key-fields' }, input, h('button', { type: 'submit', class: 'btn small primary' }, github.token ? 'Replace' : 'Save'),
        github.token ? h('button', { type: 'button', class: 'link', onclick: async () => { await api.setGithubToken(null); ctx.reload(); } }, 'Remove') : null),
      h('p', { class: 'hint' }, 'A fine-grained token with read access to pull requests is enough. munin keeps it on the machine it runs on and never shows it again.')));
}

// Apps: MCP servers munin's agents use, like a calendar or mail. The runtime keeps each one's
// token on its machine and only ever shows its last four characters.
function appsSection(apps, ctx) {
  const field = (name, attrs) => bindDraft(h('input', { class: 'input', autocomplete: 'off', spellcheck: false, ...attrs }), `app:${name}`);
  const name = field('name', { placeholder: 'Linear', 'aria-label': 'App name' });
  const url = field('url', { placeholder: 'https://mcp.example.com/mcp', 'aria-label': 'MCP server URL' });
  const token = field('token', { type: 'password', placeholder: 'Token, if it needs one', 'aria-label': 'Token' });
  const button = h('button', { type: 'submit', class: 'btn small primary' }, 'Add');
  const add = async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    if (!url.value.trim()) return url.focus();
    button.disabled = true;
    button.textContent = 'Connecting…';
    try {
      const app = await runtime.addApp({ name: name.value, url: url.value, token: token.value });
      for (const key of ['name', 'url', 'token']) drafts.delete(`app:${key}`);
      toast(app.connected ? `${app.name} is connected, with ${app.detail}. Pick it on an agent's profile.` : `${app.name} is added, but doesn't answer yet: ${app.detail}`, { error: !app.connected });
      ctx.reload();
    } catch (err) {
      button.disabled = false;
      button.textContent = 'Add';
      toast(err.message, { error: true });
    }
  };
  const remove = async (app) => {
    if (!confirm(`Remove ${app.name}? Agents that use it lose its tools.`)) return;
    try {
      await runtime.removeApp(app.id);
      ctx.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  return h('section', { class: 'section', id: 'apps' },
    h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Apps'), h('span', { class: 'mono muted' }, `${apps.filter((a) => a.connected).length} connected`)),
    h('p', { class: 'lead' }, "MCP servers munin's agents can use: a calendar, mail, Linear. An agent gets an app's tools once you pick the app on its profile."),
    apps.length ? h('div', { class: 'provider-list' }, apps.map((app) => h('div', { class: 'agent-row provider-row' },
      h('span', { class: 'agent-name' }, h('span', {}, app.name)),
      h('span', { class: 'agent-seen' }, app.builtin ? `Comes with munin · ${app.detail}` : `${app.url} · ${app.detail}${app.token ? ` · token …${app.token.hint}` : ''}`),
      h('span', { class: ['label', app.connected && 'on'] }, app.connected ? 'Connected' : 'Off'),
      h('span', { class: 'agent-action' }, app.builtin
        ? h('a', { class: 'link', href: '#google', onclick: (e) => { e.preventDefault(); document.getElementById('google')?.scrollIntoView({ behavior: 'smooth' }); } }, 'Google')
        : h('button', { type: 'button', class: 'link', onclick: () => remove(app) }, 'Remove'))))) : null,
    h('form', { class: 'key-form', onsubmit: add },
      h('div', { class: 'key-fields' }, name, url, token, button),
      h('p', { class: 'hint' }, "An app is an MCP server reached over HTTP. munin keeps its token on the machine it runs on and never shows it again; agents use the app's tools through munin, without the token.")));
}

// Where each tracker project's code is. The runtime keeps a clone, and each coder gets a
// worktree per issue, on a branch named after the issue.
function codeSection(repos, sandbox, ctx) {
  if (!store.projects.length) return null;
  return h('section', { class: 'section', id: 'code' },
    h('div', { class: 'section-head' }, h('h2', { class: 'h1' }, 'Code')),
    h('p', { class: 'lead' },
      "Where each project's code lives. munin keeps a clone of it, and a coder that takes an issue gets a worktree of its own, ",
      'on a branch named after the issue, so agents working side by side never share a checkout.'),
    runtime.kind === 'runtime' ? h('p', { class: 'hint sandbox-note' }, sandbox
      ? `Coders run in a container each, from ${sandbox.image}: they see their own folder and nothing else of this machine, behind a firewall that keeps them off munin and the tailnet.`
      : "Coders run on this machine, as the runtime's own user. Their shells don't get the runtime's keys, but they can read its files. "
        + 'Start the runtime with MUNIN_AGENT_SANDBOX=docker to give each a container of its own.') : null,
    h('div', { class: 'repo-list' }, store.projects.map((project) => repoRow(project, repos.find((r) => r.project === project.key), ctx))));
}

function repoRow(project, repo, ctx) {
  const key = `repo:${project.key}`;
  const source = bindDraft(h('input', {
    class: 'input',
    placeholder: 'git@github.com:you/repo.git, or a folder with a clone',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': `Where ${project.key}'s code is`,
  }), `${key}:source`, repo?.source || '');
  const base = bindDraft(h('input', { class: 'input', placeholder: 'main', autocomplete: 'off', spellcheck: false, 'aria-label': `${project.key}'s base branch` }), `${key}:base`, repo?.base || '');
  const button = h('button', { type: 'submit', class: 'btn small' }, repo ? 'Save' : 'Set up');
  const save = async (e) => {
    e.preventDefault();
    button.disabled = true;
    button.textContent = repo ? 'Saving…' : 'Cloning…';
    try {
      const saved = await runtime.setRepo(project.key, { source: source.value.trim(), base: base.value.trim() || undefined });
      drafts.delete(`${key}:source`);
      drafts.delete(`${key}:base`);
      toast(`${project.key}'s code is set up. New branches start from ${saved.base}.`);
    } catch (err) {
      toast(err.message, { error: true });
    }
    ctx.reload();
  };
  const remove = async () => {
    if (!confirm(`Forget where ${project.key}'s code is? Worktrees agents already have stay.`)) return;
    await runtime.removeRepo(project.key);
    ctx.reload();
  };
  return h('form', { class: 'repo-row', onsubmit: save },
    h('span', { class: 'repo-project' }, h('span', { class: 'mono' }, project.key), h('span', { class: 'hint' }, repo ? `branches from ${repo.base}` : project.name)),
    source,
    base,
    h('span', { class: 'repo-actions' }, button, repo ? h('button', { type: 'button', class: 'link', onclick: remove }, 'Remove') : null));
}

function dummy(ctx) {
  return h('section', { class: 'section', id: 'dummy' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Dummy data')),
    h('div', { class: 'setting' },
      h('div', { class: 'setting-main' },
        h('div', {}, 'Start the sample agents over'),
        h('div', { class: 'hint' }, "munin's agents are a stand-in until the agent runtime exists. Their conversations live in this browser; this puts them back the way they started.")),
      h('button', {
        type: 'button',
        class: 'btn small',
        onclick: () => {
          if (!confirm('Start the sample agents over? Your messages to them are lost.')) return;
          runtime.reset();
          toast('The sample agents are back where they started.');
          ctx.reload();
        },
      }, 'Reset')));
}

function table(agents, ctx) {
  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connected'), h('span', { class: 'mono muted' }, agents.length)),
    agents.length
      ? h('div', { class: 'agent-table', role: 'table', 'aria-label': 'Agents' },
        h('div', { class: 'agent-row head', role: 'row' },
          h('span', { class: 'label', role: 'columnheader' }, 'Agent'),
          h('span', { class: 'label', role: 'columnheader' }, 'Doing'),
          h('span', { class: 'label', role: 'columnheader' }, 'Token'),
          h('span', { role: 'columnheader' })),
        agents.map((a) => h('div', { class: ['agent-row', a.revoked && 'revoked'], role: 'row' },
          h('span', { class: 'agent-name', role: 'cell' }, agentAvatar(a.name), h('span', {}, a.name),
            store.runtimeAgents.some((r) => r.name === a.name) ? h('span', { class: 'role-tag own-tag', title: "One of munin's own agents" }, 'Own') : null),
          h('span', { class: 'agent-seen', role: 'cell' }, doing(a)),
          h('span', { class: 'mono muted', role: 'cell' }, `mun_…${a.token_hint}`),
          h('span', { class: 'agent-action', role: 'cell' },
            a.revoked
              ? h('button', { type: 'button', class: 'link', onclick: () => issueToken(a.name, ctx) }, 'New token')
              : h('button', { type: 'button', class: 'link', onclick: () => revoke(a.name, ctx) }, 'Revoke')))))
      : h('p', { class: 'muted' }, 'No agents yet. Add one below, then paste the command into its terminal.'));
}

// Working on what, idle since when, or never connected.
function doing(agent) {
  const seen = agent.last_seen_at ? time(agent.last_seen_at, { long: true, prefix: 'seen ', cls: 'muted' }) : null;
  if (agent.revoked) return h('span', { class: 'agent-state' }, h('span', { class: 'label' }, 'Revoked'));
  if (!agent.last_seen_at) return h('span', { class: 'agent-state muted' }, 'Never connected');
  if (!isWorking(agent)) return h('span', { class: 'agent-state' }, h('span', { class: 'state' }, 'Idle'), ' · ', seen);
  return h('span', { class: 'agent-state' },
    h('span', { class: 'state working' }, 'Working'), ' · ', seen,
    agent.working_on.map((issue) => h('a', { class: 'working-on', href: `#/issues/${issue.id}` },
      statusIcon(issue.status), h('span', { class: 'mono' }, issue.id), h('span', { class: 'working-title' }, issue.title))));
}

function notifications(ctx) {
  if (!notificationsSupported) return null;
  const on = notificationsOn();
  const denied = Notification.permission === 'denied';
  return h('section', { class: 'section', id: 'notifications' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Notifications')),
    h('div', { class: 'setting' },
      h('div', { class: 'setting-main' },
        h('div', {}, 'Notify me when an agent asks something'),
        h('div', { class: 'hint' }, denied
          ? 'Your browser blocks notifications from munin. Allow them in the site settings first.'
          : pushSupported
            ? ['On this device, even with munin closed: when an agent asks something or waits for your OK, when work is ready for review, and what your assistants say (a morning brief, an answer). ',
              /iPhone|iPad/.test(navigator.userAgent) && !navigator.standalone ? 'On an iPhone, add munin to your home screen first (Share → Add to Home Screen) and turn this on from there.' : null]
            : 'A notification for each new question, and when an agent moves work to In review, while munin is open in a tab. This browser can\'t get notifications with munin closed.')),
      toggle(on, 'Notify me when an agent asks something', async () => {
        await toggleNotifications();
        ctx.rerender();
      })));
}

async function revoke(name, ctx) {
  if (!confirm(`Revoke ${name}'s token? It stops working right away.`)) return;
  try {
    await api.revokeAgent(name);
    if (created && created.name === name) created = null;
    toast(`Revoked ${name}`);
  } catch (err) {
    toast(err.message, { error: true });
  }
  ctx.reload();
}

async function issueToken(name, ctx) {
  try {
    const agent = await api.addAgent(name);
    created = { name: agent.name, token: agent.token };
    drafts.delete('agent:name');
  } catch (err) {
    toast(err.message, { error: true });
  }
  await ctx.reload();
  document.querySelector('.token')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function connect(agents, me, ctx) {
  const name = bindDraft(h('input', {
    class: 'input',
    placeholder: 'claude-code',
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Agent name',
  }), 'agent:name');
  const add = async (e) => {
    e.preventDefault();
    const value = name.value.trim();
    if (!value) return name.focus();
    const existing = agents.find((a) => a.name === value && !a.revoked);
    if (existing && !confirm(`${value} already has a token. Replace it? The old one stops working.`)) return;
    await issueToken(value, ctx);
  };

  const token = created ? created.token : 'mun_…';
  const command = `claude mcp add --transport http munin ${me.mcp_url} --header "Authorization: Bearer ${token}"`;
  const json = JSON.stringify({ mcpServers: { munin: { type: 'http', url: me.mcp_url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2);
  const snippet = tab === 'claude' ? command : json;
  const setTab = (t) => () => {
    tab = t;
    ctx.rerender();
  };

  return h('section', { class: 'section' },
    h('div', { class: 'section-head' }, h('h2', {}, 'Connect an outside agent')),
    h('p', { class: 'muted section-lead' }, 'Name it after the client, like claude-code or codex. You get a token for it, shown once.'),
    h('form', { class: 'add-agent', onsubmit: add },
      name,
      h('button', { type: 'submit', class: 'btn primary' }, 'Create token')),
    created
      ? h('div', { class: 'token', role: 'status' },
        h('div', { class: 'token-head' },
          h('span', { class: 'label' }, `Token for ${created.name}`),
          copyButton(() => created.token)),
        h('code', { class: 'token-value' }, created.token),
        h('p', { class: 'hint' }, 'Shown once: munin only keeps a hash. If you lose it, create a new token for the same name.'))
      : null,
    h('div', { class: 'tabs', role: 'tablist' },
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'claude'), onclick: setTab('claude') }, 'Claude Code'),
      h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === 'json'), onclick: setTab('json') }, 'Any MCP client')),
    h('div', { class: 'snippet' },
      h('pre', {}, h('code', {}, snippet)),
      copyButton(() => snippet)),
    h('p', { class: 'hint' }, created
      ? (tab === 'claude' ? `Run this where ${created.name} works.` : 'Add this to the client\'s MCP config.')
      : 'The token fills into the command once you create it.'));
}
