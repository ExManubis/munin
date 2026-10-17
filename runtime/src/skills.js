// Skills: what an agent knows how to do here, learned from its work. A skill is a SKILL.md, the
// agentskills.io format Claude Code reads too: a name and a description up top, then when to use
// it, the steps, the pitfalls and how to check (Hermes' When to Use, Procedure, Pitfalls and
// Verification, in munin's words). The prompt lists each skill by name and
// description, and the agent reads one when it fits (read_skill), the way Anthropic's Agent
// Skills load. Agents write their own after finishing something, getting out of a dead end or
// being corrected (Hermes Agent, Devin), and you approve each one. A skill is a lesson, not a
// log, so one that tells a story (issue ids, dates) is turned back.

export class SkillError extends Error {}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIMITS = { name: 64, description: 1024, body: 8000 };
export const STALE_MS = 30 * 24 * 60 * 60 * 1000; // unused this long, a skill shows as stale

// The SKILL.md for a skill.
export const skillText = ({ name, description, body }) => `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;

// A skill from its SKILL.md: { name, description, body }.
export function parseSkill(text) {
  const m = /^\s*---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(String(text || ''));
  if (!m) throw new SkillError('A skill starts with its name and description between --- lines, like a SKILL.md.');
  const fields = Object.fromEntries([...m[1].matchAll(/^(\w+):\s*(.*)$/gm)].map(([, key, value]) => [key, value.trim().replace(/^(["'])(.*)\1$/, '$2')]));
  return { name: fields.name || '', description: fields.description || '', body: m[2].trim() };
}

// A skill as the agent or you wrote it, cleaned and checked. Throws SkillError saying what to fix.
export function checkSkill({ name, description, body }) {
  const skill = { name: String(name || '').trim().toLowerCase(), description: String(description || '').trim().replace(/\s+/g, ' '), body: String(body || '').trim() };
  if (!NAME.test(skill.name) || skill.name.length > LIMITS.name) throw new SkillError('A skill\'s name is lowercase words joined by dashes, like run-gateway-tests, under 64 characters.');
  if (!skill.description) throw new SkillError('Say in the description what the skill does and when to use it: that\'s how you find it again.');
  if (skill.description.length > LIMITS.description) throw new SkillError(`Keep the description under ${LIMITS.description} characters.`);
  if (skill.body.length < 40) throw new SkillError('Say how to do it: when to use it, the steps, the pitfalls and how to check.');
  if (skill.body.length > LIMITS.body) throw new SkillError(`Keep a skill under ${LIMITS.body.toLocaleString('en')} characters; split it if it does two things.`);
  const log = [
    [/\b[A-Z][A-Z0-9]{1,9}-\d+\b/, 'an issue id'],
    [/\b\d{4}-\d{2}-\d{2}\b/, 'a date'],
    [/(?:^|\s)#\d+\b/, 'a pull request number'],
    [/\b(?:yesterday|last (?:week|time)|this morning|earlier today)\b/i, 'when something happened'],
  ].find(([pattern]) => pattern.test(`${skill.description}\n${skill.body}`));
  if (log) throw new SkillError(`Lessons, not logs: a skill says how to do something next time, not what happened, so it has no ${log[1]} in it. Say it as a step that holds next time.`);
  return skill;
}

// Whether `agent` has `skill`: its own, or one shared with it or with everyone.
export const hasSkill = (agent, skill) => skill.owner === agent.name || skill.sharedWith.includes('*') || skill.sharedWith.includes(agent.name);

// The agent's skills for its prompt: each by name and description, and whose it is when it isn't
// its own. Uses aren't in it, since a section that changes every turn is sent again every turn.
export function skillsSection(agent, skills, askFirst) {
  const mine = skills.filter((s) => hasSkill(agent, s)).toSorted((a, b) => a.name.localeCompare(b.name));
  return [
    mine.length
      ? "Your skills: how things are done here, from experience. When one fits what you're about to do, read it with read_skill first and follow it."
      : 'You have no skills yet.',
    ...mine.map((s) => `- ${s.name}${s.owner === agent.name ? '' : ` (${s.owner}'s)`}: ${s.description}`),
    `When you've worked out how to do something you'll do again, got out of a dead end, or been corrected, save it with save_skill: a name, a description that says when to use it, and a body with When to use, Steps, Pitfalls and How to check. Lessons, not logs: no issue ids, dates or stories. Saving one with a name you have changes it.${askFirst ? ' Each one you save asks first.' : ''}`,
  ].join('\n');
}
