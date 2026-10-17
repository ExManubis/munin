// What each role can reach, and what it asks first, when an agent is made. The frontend's
// web/runtime/roles.js has the words for these; everything here can be changed per agent.

export const ROLES = {
  coder: { name: 'Coder', abilities: { code: true, tracker: true } },
  reviewer: { name: 'Reviewer', abilities: { code: true, tracker: true } },
  assistant: { name: 'Assistant', abilities: { apps: true, web: true } },
  writer: { name: 'Writer', abilities: { web: true } },
  researcher: { name: 'Researcher', abilities: { web: true } },
  companion: { name: 'Companion', abilities: {} },
};

export const roleName = (role) => ROLES[role]?.name || role;

// Each role's brief as the frontend writes it (web/runtime/roles.js has the same words), and the
// older words a brief may still start with: from before agents had a voice, and from before the
// runtime told them who they work for, when an assistant's brief named you ("Mikkel's
// assistant"). On start, a brief that starts with older words gets the new ones; anything after
// them, and a brief you wrote yourself, stays.
const NAME = String.raw`([^\s,.:]+)`;
const UPGRADES = [
  [String.raw`You're ${NAME}, (?:.+?'s assistant|the assistant of the person you work for)\. Keep their calendar and inbox in order, and say things once, briefly\. Ask before you send mail or accept invites for them\.`,
    (n) => `You're ${n}, an assistant: organised, a step ahead, and calm when the day gets busy. You keep track of plans, people and loose ends, mention things once, and notice what's about to be forgotten. Ask before you send mail or accept invites on their behalf.`],
  [String.raw`You're ${NAME}\. You're curious and cheerful, and you like riddles, word games and odd facts\. Keep replies short\. When .+? seems busy, let them be\.`,
    (n) => `You're ${n}: curious, cheerful and a little odd. You like riddles, word games and strange facts, and you'd rather ask a good question than give a long answer. When things seem busy, keep it light and short.`],
  [String.raw`You're ${NAME}, a coder\. Take issues`,
    (n) => `You're ${n}, a coder: careful, practical, and quick to say when an idea won't hold up. Take issues`],
  [String.raw`You're ${NAME}, a reviewer\. Review`,
    (n) => `You're ${n}, a reviewer: thorough, fair and specific. Review`],
  [String.raw`You're ${NAME}, a writer\. Draft and edit in plain, short sentences, and keep one voice across everything you write\.`,
    (n) => `You're ${n}, a writer with an ear for plain, short sentences. Draft and edit, keep one voice across everything you write, and say when a sentence isn't pulling its weight.`],
  [String.raw`You're ${NAME}, a researcher\. Read up on what you're asked, say what you found in a few lines, and list your sources\.`,
    (n) => `You're ${n}, a researcher: curious and sceptical in equal measure. Read up on what you're asked, say what you found in a few lines, keep what's known apart from what's guessed, and list your sources.`],
].map(([from, to]) => [new RegExp(`^${from}`), to]);
export const upgradeBrief = (brief) => UPGRADES.reduce((out, [from, to]) => out.replace(from, (_, name) => to(name)), brief);

// Ask-first rules match a tool, and optionally its arguments. `what` and `third` are for the
// approval card: "hugin wants to push to git", "Stop asking before hugin pushes to git".
export function askFirstFor(abilities) {
  if (!abilities.code) return [];
  return [
    { id: 'push', label: 'Pushing to git', what: 'push to git', third: 'pushes to git', tool: 'bash', match: '\\bgit\\s+push\\b', on: true },
    { id: 'delete', label: 'Deleting files', what: 'delete files', third: 'deletes files', tool: 'bash', match: '\\brm\\s', on: true },
    { id: 'commands', label: 'Running any command', what: 'run a command', third: 'runs commands', tool: 'bash', on: false },
    { id: 'edits', label: 'Changing files', what: 'change files', third: 'changes files', tools: ['write', 'edit'], on: false },
  ];
}

// Every agent's rule for setting up its own routines (the routine tools in runtime.js): off,
// since agents do it when asked, and on for an agent you'd rather approve each one for.
export const ROUTINES_RULE = { id: 'routines', label: 'Setting up its own routines', what: 'change its routines', third: 'changes its routines', tools: ['add_routine', 'change_routine', 'remove_routine'], on: false };

export function ruleMatches(rule, name, args) {
  const tools = rule.tools || [rule.tool];
  if (!tools.includes(name)) return false;
  if (!rule.match) return true;
  return new RegExp(rule.match).test(String(args?.command || ''));
}
