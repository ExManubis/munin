// Routines: work an agent does on its own, on a schedule or when something happens in the
// tracker. A routine that's due becomes an input in the agent's conversation, queued behind
// whatever it's doing, and shows there as "ran routine". Mail and calendar triggers are kept
// for when munin can connect those apps.

import { parseSchedule, describeSchedule, nextRun, ScheduleError } from './schedule.js';
import { parseWatch, describeWatch, readFeed, matches, WatchError } from './watch.js';

export const TRIGGERS = ['schedule', 'tracker', 'mail', 'calendar'];
// A run missed while the runtime was down still happens if it's this recent.
const CATCH_UP_MS = 15 * 60 * 1000;
export const POLL_MS = 30 * 1000;

export class RoutineError extends Error {}

// A routine from what you typed, with "when" in munin's words so you see what it understood.
export function prepareRoutine({ name, trigger = 'schedule', when = '', does = '' }, agent, now) {
  const clean = { name: String(name || '').trim(), trigger, when: String(when || '').trim(), does: String(does || '').trim() };
  if (!clean.name) throw new RoutineError('A routine needs a name.');
  if (clean.name.length > 80) throw new RoutineError('Keep the name under 80 characters.');
  if (!TRIGGERS.includes(trigger)) throw new RoutineError(`A routine starts on ${TRIGGERS.join(', ')}.`);
  if (!clean.does) throw new RoutineError(`Say what ${agent.name} should do.`);
  try {
    if (trigger === 'schedule') {
      const schedule = parseSchedule(clean.when);
      return { ...clean, when: describeSchedule(schedule), schedule, next: nextRun(schedule, new Date(now))?.getTime() ?? null };
    }
    if (trigger === 'tracker') {
      const watch = parseWatch(clean.when, agent.name);
      return { ...clean, when: describeWatch(watch), watch, next: null };
    }
  } catch (err) {
    if (err instanceof ScheduleError || err instanceof WatchError) throw new RoutineError(err.message);
    throw err;
  }
  if (!clean.when) throw new RoutineError(`Say when, like "When mail from Paul arrives".`);
  return { ...clean, next: null };
}

// Why a routine isn't running, if it isn't.
export function routineNote(routine, agent) {
  if (routine.trigger === 'mail') return "Waits for the mail app, which munin can't connect yet.";
  if (routine.trigger === 'calendar') return "Waits for the calendar app, which munin can't connect yet.";
  if (routine.trigger === 'tracker' && !(agent.abilities.tracker && agent.tracker?.token)) return `Starts once ${agent.name} is in the tracker.`;
  if (!routine.schedule && !routine.watch) return 'Edit it to set it up again.';
  return null;
}

// `agents()` lists agents; `run(agent, routine, reason)` starts a routine; `feed(agent, args)`
// calls the tracker's `events` tool as the agent, and `issue(agent, ref)` its `get_issue`;
// `save()` keeps what changed. `tick()` does whatever is due at `now()`.
export function createScheduler({ agents, run, feed, issue, save, now }) {
  const polled = new Map(); // agent name → when its feed was last read

  async function schedules(agent, t) {
    let dirty = false;
    for (const routine of agent.routines) {
      if (!routine.schedule) continue;
      if (routine.next == null) {
        routine.next = nextRun(routine.schedule, new Date(t))?.getTime() ?? null;
        dirty = true;
        continue;
      }
      if (routine.next > t) continue;
      const due = routine.next;
      routine.next = nextRun(routine.schedule, new Date(t))?.getTime() ?? null;
      dirty = true;
      if (t - due <= CATCH_UP_MS) await run(agent, routine, { why: `it's ${routine.when}` });
    }
    return dirty;
  }

  // Read what happened in the tracker since last time, and start the routines it matches.
  async function events(agent, t) {
    const watching = agent.routines.filter((r) => r.watch);
    if (!watching.length || !agent.abilities.tracker || !agent.tracker?.token) return false;
    if (t - (polled.get(agent.name) || 0) < POLL_MS) return false;
    polled.set(agent.name, t);
    if (agent.eventsAfter == null) {
      // The first look starts from now; what happened before isn't news.
      agent.eventsAfter = readFeed(await feed(agent, { limit: 1 })).next ?? 0;
      return true;
    }
    const hits = new Map(); // routine → events
    const owners = new Map(); // issue → assignee, looked up once a poll
    const ownerOf = async (ref) => {
      if (!owners.has(ref)) owners.set(ref, /Assignee: (\S+)/.exec(await issue(agent, ref))?.[1] ?? null);
      return owners.get(ref);
    };
    let after = agent.eventsAfter;
    for (let page = 0; page < 10; page++) {
      const found = readFeed(await feed(agent, { after, limit: 100 }));
      for (const event of found.events) {
        for (const routine of watching) {
          if (!matches(routine.watch, event, agent.name)) continue;
          if (routine.watch.assignee && await ownerOf(event.ref) !== routine.watch.assignee) continue;
          hits.set(routine, [...(hits.get(routine) || []), event]);
        }
      }
      after = found.next ?? after;
      if (!found.more) break;
    }
    const moved = after !== agent.eventsAfter;
    agent.eventsAfter = after;
    for (const [routine, found] of hits) {
      const refs = [...new Set(found.map((e) => e.ref))];
      await run(agent, routine, {
        why: `in the tracker:\n${found.slice(-10).map((e) => e.line).join('\n')}`,
        issue: refs.length === 1 ? { id: refs[0], title: null } : null,
      });
    }
    return moved || hits.size > 0;
  }

  let ticking = null;
  async function tick() {
    if (ticking) return ticking;
    ticking = (async () => {
      const t = now();
      let dirty = false;
      for (const agent of [...agents()]) {
        dirty = (await schedules(agent, t)) || dirty;
        try {
          dirty = (await events(agent, t)) || dirty;
        } catch {
          // the tracker is away or refused; try again next poll
        }
      }
      if (dirty) await save();
    })();
    try {
      await ticking;
    } finally {
      ticking = null;
    }
  }

  // How long until something might be due, for the timer.
  function wait() {
    const t = now();
    let soonest = POLL_MS;
    for (const agent of agents()) for (const r of agent.routines) if (r.next != null) soonest = Math.min(soonest, r.next - t);
    return Math.max(1000, soonest);
  }

  return { tick, wait };
}
