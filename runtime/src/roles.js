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

// Briefs from before the runtime told agents who they work for named you in them ("Mikkel's
// assistant"), or said "your human" while munin had no name. Their template sentences now say
// "the person you work for"; anything else in a brief, and a brief you wrote yourself, stays.
const OLD_BRIEFS = [
  [/^You're ([^,\s]+), .+?'s assistant\. Keep their calendar and inbox in order/, "You're $1, the assistant of the person you work for. Keep their calendar and inbox in order"],
  [/Keep replies short\. When .+? seems busy, let them be\./, 'Keep replies short. When the person you work for seems busy, let them be.'],
];
export const upgradeBrief = (brief) => OLD_BRIEFS.reduce((out, [from, to]) => out.replace(from, to), brief);

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

export function ruleMatches(rule, name, args) {
  const tools = rule.tools || [rule.tool];
  if (!tools.includes(name)) return false;
  if (!rule.match) return true;
  return new RegExp(rule.match).test(String(args?.command || ''));
}
