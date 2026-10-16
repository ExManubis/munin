// A conversation's pi-durable entries as the frontend's items: messages, actions, runs with
// their steps, questions and approvals (docs/runtime-api.md). Runs are the tool calls from one
// input to the agent's answer; munin's own entry kinds carry questions, approvals and actions.

const iso = (ms) => new Date(ms).toISOString();

const textOf = (content) => (typeof content === 'string'
  ? content
  : (content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')).trim();

const first = (text, n = 80) => {
  const line = String(text || '').trim().split('\n')[0];
  return line.length > n ? `${line.slice(0, n - 1)}…` : line;
};

// One line for a tool call, like the steps of a run on the issue page.
export function describeCall(name, args = {}) {
  switch (name) {
    case 'read': return `Read ${args.path}`;
    case 'write': return `Wrote ${args.path}`;
    case 'edit': return `Edited ${args.path}`;
    case 'bash': return `Ran ${first(args.command, 100)}`;
    default: return `${name.replace(/_/g, ' ')}${Object.keys(args).length ? ` ${first(JSON.stringify(args), 80)}` : ''}`;
  }
}

// Tool calls that show as something else (a question card, an action line) aren't run steps.
const QUIET_TOOLS = new Set(['ask_human', 'remember']);

function resultDetail(message) {
  if (message.isError) return 'failed';
  const text = textOf(message.content);
  if (message.toolName === 'bash') {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.length ? first(lines[lines.length - 1], 48) : null;
  }
  return null;
}

// `entries` oldest first; `busy` while the conversation's run is going.
export function toItems(entries, { busy = false } = {}) {
  const items = [];
  const byQuestion = new Map();
  const byApproval = new Map();
  let run = null;
  let runs = 0;
  const closeRun = (at) => {
    if (run) run.endedAt = iso(at);
    run = null;
  };

  for (const entry of entries) {
    const message = entry.model?.[0];
    const at = message?.timestamp || entry.data?.at || Date.now();
    const id = `e${entry.id}`;
    switch (entry.kind) {
      case 'pi.user': {
        closeRun(at);
        items.push({ id, kind: 'message', from: 'human', at: iso(at), text: textOf(message.content) });
        break;
      }
      case 'pi.assistant': {
        const text = textOf(message.content);
        if (message.stopReason === 'error' || message.stopReason === 'aborted') {
          if (text) items.push({ id, kind: 'message', from: 'agent', at: iso(at), text });
          items.push({ id: `${id}-failed`, kind: 'action', at: iso(at), verb: message.stopReason === 'aborted' ? 'stopped' : 'failed', object: first(message.errorMessage || '', 120) || null });
          if (run) run.status = 'stopped';
          closeRun(at);
          break;
        }
        if (text) items.push({ id, kind: 'message', from: 'agent', at: iso(at), text });
        const calls = (message.content || []).filter((c) => c.type === 'toolCall' && !QUIET_TOOLS.has(c.name));
        if (calls.length) {
          if (!run) {
            run = { id: `${id}-run`, kind: 'run', number: ++runs, issue: null, at: iso(at), startedAt: iso(at), endedAt: null, status: 'running', steps: [] };
            items.push(run);
          }
          for (const call of calls) run.steps.push({ id: call.id, at: iso(at), text: describeCall(call.name, call.arguments), detail: null });
        }
        if (message.stopReason !== 'toolUse') {
          if (run) run.status = 'done';
          closeRun(at);
        }
        break;
      }
      case 'pi.tool-result': {
        const step = run?.steps.find((s) => s.id === message.toolCallId);
        if (step) step.detail = resultDetail(message);
        break;
      }
      case 'munin.question': {
        const item = { id, kind: 'question', at: iso(entry.data.at), text: entry.data.text, options: entry.data.options || [], issue: entry.data.issue || null, trackerQuestion: entry.data.trackerQuestion || null, status: 'open', answer: null, answeredAt: null };
        byQuestion.set(id, item);
        items.push(item);
        break;
      }
      case 'munin.answer': {
        const question = byQuestion.get(entry.data.question);
        if (question) Object.assign(question, { status: 'answered', answer: { option: entry.data.option || null, text: entry.data.text || null }, answeredAt: iso(entry.data.at) });
        if (entry.data.text) items.push({ id, kind: 'message', from: 'human', at: iso(entry.data.at), text: entry.data.text });
        closeRun(entry.data.at);
        break;
      }
      case 'munin.approval': {
        const item = { id, kind: 'approval', at: iso(entry.data.at), permission: entry.data.rule, label: entry.data.label, what: entry.data.what, third: entry.data.third, target: entry.data.target, status: 'open', answeredAt: null, undoUntil: null };
        byApproval.set(id, item);
        items.push(item);
        break;
      }
      case 'munin.decision': {
        const approval = byApproval.get(entry.data.approval);
        if (!approval) break;
        if (entry.data.decision === 'undo') {
          approval.status = 'once';
          approval.undoUntil = null;
        } else {
          approval.status = entry.data.decision === 'deny' ? 'denied' : entry.data.decision;
          approval.answeredAt = iso(entry.data.at);
          approval.undoUntil = entry.data.decision === 'always' ? iso(entry.data.at + 8000) : null;
        }
        break;
      }
      case 'munin.action': {
        items.push({ id, kind: 'action', at: iso(entry.data.at), verb: entry.data.verb, object: entry.data.object || null, issue: entry.data.issue || null });
        break;
      }
      default:
        break; // system, compaction and reset entries don't show
    }
  }
  if (run && !busy) run.status = 'stopped';
  if (run && busy) run.status = 'running';
  return items;
}

// What the agent is doing, for its face and the sidebar.
export function summarize(items, { busy, paused }) {
  const open = items.filter((i) => (i.kind === 'question' || i.kind === 'approval') && i.status === 'open');
  const run = [...items].reverse().find((i) => i.kind === 'run' && i.status === 'running') || null;
  const lastMessage = [...items].reverse().find((i) => i.kind === 'message' && i.from === 'agent');
  let state = 'idle';
  if (paused) state = 'paused';
  else if (busy && (run || !lastMessage)) state = 'working';
  else if (busy) state = 'working';
  else if (open.length) state = 'asks';
  let preview = lastMessage ? first(lastMessage.text, 140) : 'Say hello.';
  if (open.length) {
    const last = open[open.length - 1];
    preview = last.kind === 'approval' ? `Wants to ${last.what}: ${last.target}` : first(last.text, 140);
  } else if (run) {
    preview = run.steps[run.steps.length - 1]?.text || 'working';
  }
  const lastAt = items.length ? items[items.length - 1].at : null;
  return { state, waiting: open.length, preview, lastAt, run, typing: Boolean(busy && !run) };
}
