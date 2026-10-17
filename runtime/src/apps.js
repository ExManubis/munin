// Apps: MCP servers you connect in Settings (a calendar, mail, Linear, GitHub…), whose tools
// agents use. Each is an HTTP MCP server with an optional token. The runtime keeps them in
// apps.json next to its database, readable by its own user only, and never hands a token back:
// the API says only its last four characters. An agent gets an app's tools when it has the Apps
// ability and the app is one of its own, named <app>__<tool> so they can't clash with the coding
// or tracker tools. An app that can't be reached is tried again every minute.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defineExtension, defineTool } from '@earendil-works/pi-durable';
import { mcpClient, textOf } from './mcp.js';

export class AppError extends Error {}

const RETRY_MS = 60 * 1000;
const slug = (name) => String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const toolName = (app, tool) => `${app.replace(/-/g, '_')}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
const hint = (token) => (token ? token.slice(-4) : null);

// Whether a tool changes something (sends, posts, accepts, deletes) rather than only reading:
// what the server says in its annotations, or else what its name says.
const READS = /^(list|get|read|search|find|fetch|query|describe|show|lookup|check|count|view)(_|$)/i;
export const changes = (spec) => (spec.annotations?.readOnlyHint !== undefined ? !spec.annotations.readOnlyHint : !READS.test(spec.name));

// A call in plain words for an approval card: "send email · to: ann@example.com · subject: Lunch".
export function describeAppCall(tool, args = {}) {
  const words = tool.replace(/_/g, ' ');
  const parts = Object.entries(args)
    .filter(([, value]) => value !== null && value !== undefined && typeof value !== 'object' || Array.isArray(value))
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  const line = [words, ...parts].join(' · ');
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

// `registry` gets each app's tools as an extension once it answers; `onChange()` hears that
// the apps, or which of them answer, changed, so conversations can be given the new tools.
// `builtins` are apps that come with munin (Gmail and Calendar, googleapps.js): { id, name,
// ready() → { ok, detail }, tools: [{ name, description, inputSchema, annotations, run(args,
// signal) }] }. They're always listed, can't be removed, and answer while ready() says so.
export async function openApps({ file, registry, onChange = () => {}, builtins = [] }) {
  let saved = [];
  if (file) {
    try {
      saved = JSON.parse(await readFile(file, 'utf8')).apps || [];
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Can't read the apps in ${file}: ${err.message}`);
    }
  }
  const save = async () => {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify({ apps: saved }, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };

  const live = new Map(); // id → { client, tools, extension, error, timer }
  let closed = false;
  const all = () => [...builtins, ...saved];
  // A built-in app's tools run here; it answers while it's ready.
  for (const app of builtins) {
    const extension = defineExtension({
      name: `app-${app.id}`,
      tools: app.tools.map((spec) => defineTool({
        name: toolName(app.id, spec.name),
        description: `${app.name}: ${spec.description}`,
        parameters: spec.inputSchema,
        async execute(args, api, context) {
          try {
            return { output: [{ type: 'text', text: await spec.run(args, context.abortSignal) }] };
          } catch (err) {
            if (context.abortSignal?.aborted) throw err;
            return { output: [{ type: 'text', text: err.message }], isError: true };
          }
        },
      })),
    });
    registry.install(extension);
    live.set(app.id, { tools: app.tools, extension, builtin: true });
  }
  const answers = (app) => {
    const state = live.get(app.id);
    return Boolean(state?.extension) && (!state.builtin || app.ready().ok);
  };

  function extensionOf(app, tools, client) {
    return defineExtension({
      name: `app-${app.id}`,
      tools: tools.map((spec) => defineTool({
        name: toolName(app.id, spec.name),
        description: `${app.name}: ${spec.description || spec.name}`,
        parameters: spec.inputSchema || { type: 'object', properties: {} },
        async execute(args, api, context) {
          let result;
          try {
            result = await client.call(spec.name, args, context.abortSignal);
          } catch (err) {
            if (context.abortSignal?.aborted) throw err;
            return { output: [{ type: 'text', text: err.message }], isError: true };
          }
          return { output: [{ type: 'text', text: textOf(result) || '(no text)' }], isError: Boolean(result?.isError) };
        },
      })),
    });
  }

  async function connect(app) {
    const state = live.get(app.id) || {};
    live.set(app.id, state);
    clearTimeout(state.timer);
    const client = mcpClient(app.url, { token: app.token, name: app.name });
    try {
      await client.initialize();
      const tools = await client.tools();
      if (closed || !saved.includes(app)) return;
      Object.assign(state, { client, tools, extension: extensionOf(app, tools, client), error: null, timer: null });
      registry.install(state.extension);
    } catch (err) {
      if (closed || !saved.includes(app)) return;
      Object.assign(state, { client: null, tools: null, extension: null, error: err.message });
      state.timer = setTimeout(() => connect(app), RETRY_MS);
      state.timer.unref?.();
    }
    onChange();
  }

  const describe = (app) => {
    const state = live.get(app.id) || {};
    if (state.builtin) {
      const ready = app.ready();
      return { id: app.id, name: app.name, builtin: true, url: null, token: null, connected: ready.ok, tools: app.tools.length, detail: ready.detail };
    }
    return {
      id: app.id,
      name: app.name,
      url: app.url,
      token: app.token ? { hint: hint(app.token) } : null,
      connected: Boolean(state.tools),
      tools: state.tools?.length ?? 0,
      detail: state.tools ? `${state.tools.length} ${state.tools.length === 1 ? 'tool' : 'tools'}` : state.error || 'Connecting…',
    };
  };

  // An agent's apps, by id or (for picks made before apps were real) by name.
  const picked = (agent) => all().filter((app) => (agent.apps || []).some((pick) => pick === app.id || pick.toLowerCase() === app.name.toLowerCase()));
  const appsOf = (agent) => (agent.abilities?.apps ? picked(agent) : []);

  for (const app of saved) connect(app); // in the background: agents get an app's tools once it answers

  return {
    list: () => all().map(describe),

    async add({ name, url, token } = {}) {
      const title = String(name || '').trim();
      if (!title) throw new AppError('An app needs a name, like Calendar.');
      const id = slug(title);
      if (!id) throw new AppError('Give the app a name with some letters in it.');
      if (all().some((app) => app.id === id)) throw new AppError(`There's already an app called ${title}.`);
      let where;
      try {
        where = new URL(String(url || '').trim());
      } catch {
        throw new AppError("That isn't a URL. An app is an MCP server's address, like https://mcp.example.com/mcp.");
      }
      if (!['http:', 'https:'].includes(where.protocol)) throw new AppError('An app is reached over http or https.');
      const app = { id, name: title, url: where.href, token: String(token || '').trim() || null };
      saved = [...saved, app];
      await save();
      await connect(app);
      return describe(app);
    },

    async remove(id) {
      const builtin = builtins.find((a) => a.id === id);
      if (builtin) throw new AppError(`${builtin.name} comes with munin. To turn it off, sign out of Google in Settings.`);
      const app = saved.find((a) => a.id === id);
      if (!app) throw new AppError(`There's no app ${id}.`);
      saved = saved.filter((a) => a !== app);
      clearTimeout(live.get(id)?.timer);
      live.delete(id);
      await save();
      onChange();
    },

    // The tools an agent gets: its own apps that answer.
    extensionsFor: (agent) => appsOf(agent).filter(answers).map((app) => live.get(app.id).extension),
    // What the prompt says: the names of the agent's apps that answer.
    namesFor: (agent) => appsOf(agent).filter(answers).map((app) => app.name),
    // A built-in app started or stopped answering (signing in or out of Google, say).
    changed: () => onChange(),

    // What the agent's prompt says about apps (prompt.js capabilities): its own, whether each
    // works right now and what it does, and the ones it could pick.
    capabilitiesFor(agent) {
      const mine = picked(agent);
      const doesOf = (app) => {
        if (app.does) return app.does();
        const tools = live.get(app.id)?.tools || [];
        return tools.length ? `its tools: ${tools.map((t) => t.name.replace(/_/g, ' ')).join(', ')}` : 'no tools yet';
      };
      return {
        mine: mine.map((app) => ({ name: app.name, answering: answers(app), detail: describe(app).detail, does: doesOf(app) })),
        others: all().filter((app) => !mine.includes(app) && describe(app).connected).map((app) => ({ name: app.name, detail: describe(app).detail })),
      };
    },

    // The ask-first rules an app gets on an agent that has it: one for anything that changes
    // something, or, for an app that sorts its tools by kind (Gmail), one per kind.
    rulesFor: (id) => {
      const app = all().find((a) => a.id === id);
      if (!app) return [];
      if (app.rules) return app.rules.map((rule) => ({ ...rule, id: `app:${app.id}:${rule.kind}`, app: app.id }));
      return [{ id: `app:${app.id}`, app: app.id, label: `${app.name}: sending, changing or deleting`, what: `do something in ${app.name}`, third: `does things in ${app.name}`, on: true }];
    },
    // The agent's apps by id, picks from before apps were real included.
    idsFor: (agent) => picked(agent).map((app) => app.id),
    // The tool behind a call's name, when it's one of `app`'s and changes something (of `kind`,
    // for a rule that covers one kind).
    changing(app, name, kind = null) {
      const spec = live.get(app)?.tools?.find((tool) => toolName(app, tool.name) === name);
      return spec && changes(spec) && (!kind || spec.ask === kind) ? spec : null;
    },

    close() {
      closed = true;
      for (const state of live.values()) clearTimeout(state.timer);
    },
  };
}
