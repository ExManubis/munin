// The roles a new agent can start from, and the models it can run on. Shared by the
// mock runtime and the new-agent screen; the real runtime will serve these.

export const ROLES = [
  {
    id: 'coder',
    name: 'Coder',
    line: 'Takes issues, writes code, sends it to review.',
    abilities: { code: true, tracker: true },
    model: 'sonnet-5.5',
    hint: 'Coding goes better on a strong model.',
    brief: (name) => `You're ${name}, a coder. Take issues from the top of the pile, do the work on a branch named after the issue, and send it to review with a short note on what you did. Ask when something is unclear instead of guessing.`,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    line: "Reviews other agents' work and merges it.",
    abilities: { code: true, tracker: true },
    model: 'sonnet-5.5',
    hint: 'Reviews need a careful reader.',
    brief: (name) => `You're ${name}, a reviewer. Review what other agents send to review: run the tests, read the diff, merge what's good and send back what isn't, saying exactly what's missing.`,
  },
  {
    id: 'assistant',
    name: 'Assistant',
    line: 'Keeps your calendar, mail and reminders in order.',
    abilities: { apps: true, web: true },
    model: 'haiku-5.5',
    hint: 'An assistant does many small things; a small model keeps it cheap.',
    brief: (name) => `You're ${name}, Mikkel's assistant. Keep his calendar and inbox in order, and say things once, briefly. Ask before you send mail or accept invites for him.`,
  },
  {
    id: 'writer',
    name: 'Writer',
    line: 'Drafts, edits and keeps one voice.',
    abilities: { web: true },
    model: 'sonnet-5.5',
    hint: 'Writing reads better from a bigger model.',
    brief: (name) => `You're ${name}, a writer. Draft and edit in plain, short sentences, and keep one voice across everything you write.`,
  },
  {
    id: 'researcher',
    name: 'Researcher',
    line: 'Reads up on a question and reports back with sources.',
    abilities: { web: true },
    model: 'sonnet-5.5',
    hint: 'Research reads a lot; a mid-sized model is a good balance.',
    brief: (name) => `You're ${name}, a researcher. Read up on what you're asked, say what you found in a few lines, and list your sources.`,
  },
  {
    id: 'companion',
    name: 'Companion',
    line: 'Someone to talk to. Riddles, ideas, bad puns.',
    abilities: {},
    model: 'haiku-5.5',
    hint: "A companion doesn't need a big model. About $0.02 a conversation.",
    brief: (name) => `You're ${name}. You're curious and cheerful, and you like riddles, word games and odd facts. Keep replies short. When Mikkel seems busy, let him be.`,
  },
];

export const roleOf = (id) => ROLES.find((r) => r.id === id) || ROLES[0];

// What an agent can reach, in the order the profile lists them.
export const ABILITIES = [
  ['apps', 'Apps', 'Calendar, mail and other apps you connect'],
  ['web', 'Web', 'Search and read pages'],
  ['code', 'Code', 'A folder, a shell and git'],
  ['tracker', 'Tracker', 'Take, review and file issues in munin'],
  ['images', 'Images', 'Make pictures'],
];

export const APPS = ['Calendar', 'Gmail', 'GitHub', 'Slack', 'Notion', 'Linear', 'Google Drive'];

// Providers and their models. `day` is a rough cost per day of steady use, for hints.
export const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    models: [
      { id: 'haiku-5.5', day: 0.1 },
      { id: 'sonnet-5.5', day: 0.6 },
      { id: 'opus-5.5', day: 2 },
      { id: 'gpt-6-sol', day: 1.2 },
    ],
  },
  {
    id: 'ollama',
    name: 'Ollama, on the server',
    models: [
      { id: 'llama', day: 0 },
      { id: 'qwen-coder', day: 0 },
    ],
  },
];

export const THINKING = ['off', 'low', 'medium', 'high'];

export function costHint(providerId, modelId) {
  const model = PROVIDERS.find((p) => p.id === providerId)?.models.find((m) => m.id === modelId);
  if (!model) return '';
  if (!model.day) return 'Runs on the server, so it costs nothing per token.';
  return `About $${model.day.toFixed(2)} a day at a steady pace.`;
}
