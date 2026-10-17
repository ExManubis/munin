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

const STATUS = { todo: 'Todo', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled', all: 'all' };

// One line for a tool call, like the steps of a run on the issue page.
export function describeCall(name, args = {}) {
  switch (name) {
    case 'read': return `Read ${args.path}`;
    case 'write': return `Wrote ${args.path}`;
    case 'edit': return `Edited ${args.path}`;
    case 'bash': return `Ran ${first(args.command, 100)}`;
    // The tracker's tools
    case 'list_projects': return 'Read the projects';
    case 'update_project': return `${args.description !== undefined ? 'Rewrote the brief of' : 'Renamed'} ${String(args.project || '').toUpperCase()}`;
    case 'create_project': return `Created the ${args.key ? String(args.key).toUpperCase() : 'new'} project`;
    case 'list_issues': return `Listed ${args.project || 'all'} issues${args.status ? `, ${STATUS[args.status] || args.status}` : ''}${args.query ? ` matching "${first(args.query, 30)}"` : ''}`;
    case 'get_issue': return `Read ${args.issue}`;
    case 'create_issue': return `Filed ${first(args.title, 60)}`;
    case 'update_issue': return args.status ? `Moved ${args.issue} to ${STATUS[args.status] || args.status}` : `Edited ${args.issue}`;
    case 'add_comment': return `Commented on ${args.issue}`;
    case 'events': return 'Read what changed in the tracker';
    case 'wait_for_work': return `Waited for work in ${args.project}`;
    case 'open_worktree': return args.issue ? `Opened ${args.issue}` : 'Went back to its own folder';
    case 'read_skill': return `Read the skill ${args.name}`;
    default: {
      const app = /^([a-z0-9_]+?)__(.+)$/.exec(name); // an app's tool: calendar__list_events
      const what = app ? `${app[1].replace(/_/g, ' ')}: ${app[2].replace(/_/g, ' ')}` : name.replace(/_/g, ' ');
      return `${what}${Object.keys(args).length ? ` ${first(JSON.stringify(args), 80)}` : ''}`;
    }
  }
}

// Tool calls that show as something else (a question card, an action line) aren't run steps.
const quiet = (call) => ['ask_human', 'remember', 'change_note', 'forget_note', 'save_skill'].includes(call.name) || (call.name === 'add_comment' && call.arguments?.ask_human);

function resultDetail(message) {
  if (message.isError) return 'failed';
  const text = textOf(message.content);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (message.toolName === 'bash') return lines.length ? first(lines[lines.length - 1], 48) : null;
  if (message.toolName === 'wait_for_work') return lines.length ? first(lines[0].split(/(?<=\.) |:$/)[0].replace(/\.$/, ''), 48) : null;
  if (message.toolName === 'list_issues') return text.startsWith('No issues') ? 'none' : `${lines.length} ${lines.length === 1 ? 'issue' : 'issues'}`;
  return null;
}

// `entries` oldest first; `busy` while the conversation's run is going.
export function toItems(entries, { busy = false } = {}) {
  const items = [];
  const byQuestion = new Map();
  const byApproval = new Map();
  let run = null;
  let runs = 0;
  let working = null; // the issue the agent took and hasn't let go of yet
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
        const calls = (message.content || []).filter((c) => c.type === 'toolCall' && !quiet(c));
        if (calls.length) {
          if (!run) {
            run = { id: `${id}-run`, kind: 'run', number: ++runs, issue: working, at: iso(at), startedAt: iso(at), endedAt: null, status: 'running', steps: [] };
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
        const item = { id, kind: 'approval', at: iso(entry.data.at), permission: entry.data.rule, label: entry.data.label, what: entry.data.what, third: entry.data.third, target: entry.data.target, skill: entry.data.skill || null, status: 'open', answeredAt: null, undoUntil: null };
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
      case 'munin.routine': {
        closeRun(entry.data.at);
        items.push({ id, kind: 'action', at: iso(entry.data.at), verb: 'ran routine', object: entry.data.name, issue: entry.data.issue || null });
        break;
      }
      case 'munin.action': {
        const { issue, status } = entry.data;
        items.push({ id, kind: 'action', at: iso(entry.data.at), verb: entry.data.verb, object: entry.data.object || null, issue: issue || null });
        if (status === 'in_progress') {
          working = issue;
          if (run && !run.issue) run.issue = issue;
        } else if (status && working?.id === issue?.id) {
          working = null;
        }
        break;
      }
      case 'munin.decided':
        closeRun(entry.data.at); // what munin told the agent about a decision: the card shows it
        break;
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
