// An agent's soul over time: its brief and its examples, each version kept with who changed it,
// when and why, so you can see how it grew and go back. The agent may propose a change to its
// own soul (OpenClaw's SOUL.md is "yours to evolve"); every change goes through you, on an
// approval card with the change on it, since an agent rewriting itself unchecked drifts. A
// proposal can only touch the brief and the examples, never the agent's role, abilities or
// ask-first rules, and has to stay short.

export const LIMITS = { brief: 2000, examples: 1500 }; // characters
export const KEPT = 30; // versions

export class SoulError extends Error {}

// A proposed soul, cleaned and checked against the current one. Throws SoulError saying what's wrong.
export function checkSoul({ brief, examples }, current) {
  const next = {
    brief: brief === undefined ? current.brief : String(brief || '').trim(),
    examples: examples === undefined ? (current.examples || '') : String(examples || '').trim(),
  };
  if (!next.brief) throw new SoulError("A brief can't be empty: say who you are and how you work.");
  if (next.brief.length > LIMITS.brief) throw new SoulError(`Keep your brief under ${LIMITS.brief.toLocaleString('en')} characters; it's ${next.brief.length.toLocaleString('en')}. Say less, better.`);
  if (next.examples.length > LIMITS.examples) throw new SoulError(`Keep your examples under ${LIMITS.examples.toLocaleString('en')} characters; they're ${next.examples.length.toLocaleString('en')}.`);
  if (next.brief === current.brief && next.examples === (current.examples || '')) throw new SoulError("That's your brief and examples as they are: nothing would change.");
  return next;
}

// The history with the agent's soul as it is now on top, unless that's the version on top
// already. `by` is "you", the agent's name, "munin" (a role's newer words), or null (the version
// from before munin kept history).
export function withVersion(history, agent, by, at, why = null) {
  const top = history[0];
  const examples = agent.examples || '';
  if (top && top.brief === agent.brief && (top.examples || '') === examples) return history;
  return [{ at, by, why, brief: agent.brief, examples }, ...history].slice(0, KEPT);
}
