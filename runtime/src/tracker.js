// The tracker, for agents that work in it. The runtime is one more MCP client: it lists the
// tracker's tools once and offers them to agents as the `tracker` extension, and each call
// goes out with the calling agent's own token, so the tracker sees forge as forge, the same
// as an agent in Claude Code. The tracker never hears of the runtime.
//
// Calls that matter to you also land in the conversation: a question about an issue becomes
// a question card tied to the tracker's copy (`trackerQuestion`), and taking, finishing or
// filing an issue becomes an action line.

import { configure, defineExtension, defineTool, section } from '@earendil-works/pi-durable';

const PROTOCOL = '2025-06-18';
const RETRY_MS = 30 * 1000;

export class TrackerError extends Error {}

// Just enough of MCP over HTTP for the tracker: it answers each request on its own, without a
// session, in JSON (or as one server-sent event, which this reads too).
export function mcpClient(url, token) {
  let next = 0;
  async function rpc(method, params, signal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method, params }),
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new TrackerError(`Can't reach the tracker at ${url}.`);
    }
    if (response.status === 401 || response.status === 403) throw new TrackerError("The tracker doesn't accept this agent's token. It may have been revoked.");
    if (!response.ok) throw new TrackerError(`The tracker answered ${response.status} ${response.statusText}.`);
    const body = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? fromEvents(await response.text())
      : await response.json();
    if (body?.error) throw new TrackerError(body.error.message || 'The tracker refused that.');
    return body?.result;
  }
  return {
    initialize: () => rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'munin-runtime', version: '0.1.0' } }),
    async tools() {
      const tools = [];
      let cursor;
      do {
        const page = await rpc('tools/list', cursor ? { cursor } : {});
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    },
    call: (name, args, signal) => rpc('tools/call', { name, arguments: args }, signal),
  };
}

function fromEvents(text) {
  const messages = text.split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  return messages.find((m) => 'result' in m || 'error' in m) || null;
}

const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

// "MUN-5 [in_progress] Retry rate-limited calls (assignee: forge)", as the tracker writes an
// issue on one line.
export function parseIssueLine(line) {
  const m = /^(\S+) \[(\w+)\] (.*)$/.exec(String(line || '').trim());
  if (!m) return null;
  let title = m[3];
  let assignee = null;
  title = title.replace(/ \(assignee: ([^)]*)\)/, (_, who) => {
    assignee = who;
    return '';
  }).replace(/ \((waiting on the human|blocked by [^)]*)\)/g, '');
  return { id: m[1], status: m[2], title: title.trim(), assignee };
}

const STATUS_WORDS = { todo: 'to Todo', in_progress: 'to In progress', in_review: 'to In review', done: 'to Done', cancelled: 'to Cancelled' };

// The action line for a change of status, or null when there's nothing to show.
export function actionFor(agentName, args, resultText) {
  const issue = parseIssueLine(resultText.replace(/^Updated /, ''));
  if (!issue || !args.status) return null;
  const ref = { id: issue.id, title: issue.title };
  switch (args.status) {
    case 'in_progress': return { verb: 'took', issue: ref, status: 'in_progress' };
    case 'in_review': return { verb: 'sent to review', issue: ref, status: 'in_review' };
    case 'done': return { verb: 'moved', object: STATUS_WORDS.done, issue: ref, status: 'done' };
    case 'cancelled': return { verb: 'cancelled', issue: ref, status: 'cancelled' };
    case 'todo': return { verb: issue.assignee && issue.assignee !== agentName ? 'sent back' : 'put back', issue: ref, status: 'todo' };
    default: return null;
  }
}

// `agents()` lists every agent, `agentFor(conversationId)` finds the calling one, and
// `write(agent, kind, data)` adds an entry to its conversation. `onTake(agent, issue, move)`
// hears that an agent took an issue, can `move(folder)` its tools there, and returns a line
// for the agent. `connect()` lists the
// tracker's tools with any connected agent's token and installs them in place of the empty
// extension, retrying every half minute until the tracker answers.
export function createTracker({ registry, agents, agentFor, write, user, onTake }) {
  let listed = null; // the tracker's tools, once it has answered
  let instructions = '';
  let timer = null;
  let closed = false;

  function asTool(spec) {
    return defineTool({
      name: spec.name,
      description: spec.description || spec.name,
      parameters: spec.inputSchema,
      async execute(args, api, context) {
        const agent = agentFor(api.conversationId);
        const fail = (text) => ({ output: [{ type: 'text', text }], isError: true });
        if (!agent?.tracker?.token) return fail(`You aren't connected to munin's tracker. Ask ${user} to turn on the Tracker ability in your profile.`);
        const client = mcpClient(agent.tracker.url, agent.tracker.token);
        let result;
        try {
          result = await client.call(spec.name, args, context.abortSignal);
        } catch (err) {
          if (context.abortSignal?.aborted) throw err;
          return fail(err.message);
        }
        const text = textOf(result);
        const move = (cwd) => api.commit((tx) => configure(tx, api.conversationId, { cwd }), context);
        const more = result?.isError ? null : await record(agent, client, spec.name, args, text, move).catch(() => null);
        return { output: [{ type: 'text', text: more ? `${text}\n\n${more}` : text }], isError: Boolean(result?.isError) };
      },
    });
  }

  // What shows in the conversation for a call that went through, and anything the agent
  // should hear besides the tracker's answer.
  async function record(agent, client, name, args, text, move) {
    if (name === 'add_comment' && args.ask_human) {
      const m = /on (\S+) \(comment (\d+)\)/.exec(text);
      if (!m) return;
      const found = textOf(await client.call('get_issue', { issue: m[1] })).split('\n')[0];
      const title = found.startsWith(`${m[1]}: `) ? found.slice(m[1].length + 2) : m[1];
      await write(agent, 'munin.question', {
        text: args.body,
        options: (args.options || []).map((o) => ({ label: o.label, detail: o.detail || '' })),
        issue: { id: m[1], title },
        trackerQuestion: Number(m[2]),
      });
    } else if (name === 'update_issue') {
      const action = actionFor(agent.name, args, text);
      if (action) await write(agent, 'munin.action', action);
      if (action?.status === 'in_progress' && onTake) return onTake(agent, action.issue, move);
    } else if (name === 'create_issue') {
      const m = /^Created (\S+): (.*)$/m.exec(text);
      if (m) await write(agent, 'munin.action', { verb: 'filed', object: m[2], issue: { id: m[1], title: m[2] } });
    }
  }

  const render = (input) => {
    const agent = agentFor(input.conversationId);
    if (!agent) return undefined;
    if (!agent.tracker?.token) return `You aren't connected to munin's tracker yet, so its tools won't work. If you need them, ask ${user} to turn on the Tracker ability in your profile.`;
    if (!listed) return `munin's tracker can't be reached right now, so its tools are missing. If you need them, tell ${user}.`;
    const projects = agent.tracker?.projects || [];
    return [
      instructions.trim(),
      projects.length ? `Your projects: ${projects.join(', ')}. Work on these unless ${user} says otherwise.` : null,
      `For a question about an issue, ask on the issue with add_comment(ask_human=true) rather than ask_human: ${user} sees it in this conversation and in the tracker's inbox, and the answer reaches you as a message.`,
    ].filter(Boolean).join('\n\n');
  };

  const build = () => defineExtension({ name: 'tracker', tools: (listed || []).map(asTool), sections: [section('tracker', render)] });
  let extension = build();
  registry.install(extension);

  async function connect() {
    if (listed || closed) return Boolean(listed);
    const linked = [...agents()].filter((a) => a.abilities.tracker && a.tracker?.token);
    for (const agent of linked) {
      try {
        const client = mcpClient(agent.tracker.url, agent.tracker.token);
        const info = await client.initialize();
        const tools = await client.tools();
        if (closed) return false;
        instructions = info?.instructions || '';
        listed = tools;
        extension = build();
        registry.install(extension); // conversations name it, so they get the tools at once
        clearTimeout(timer);
        timer = null;
        return true;
      } catch {
        // try the next agent's token, then again later
      }
    }
    if (linked.length && !timer && !closed) {
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, RETRY_MS);
      timer.unref?.();
    }
    return false;
  }

  // A tool call as the agent, outside a conversation: the routines read the event feed this way.
  async function call(agent, name, args) {
    const result = await mcpClient(agent.tracker.url, agent.tracker.token).call(name, args);
    if (result?.isError) throw new TrackerError(textOf(result));
    return textOf(result);
  }

  return {
    extension: () => extension,
    connect,
    call,
    reachable: () => Boolean(listed),
    close() {
      closed = true;
      clearTimeout(timer);
    },
  };
}
