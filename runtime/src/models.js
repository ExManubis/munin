// The models agents can run on: OpenRouter once it has a key (pasted in Settings, or
// OPENROUTER_API_KEY), an Ollama server when MUNIN_OLLAMA_URL is set, and always the stand-in,
// which answers without a model so munin works before any provider is set up.

import { createModels, createProvider, defaultProviderAuthContext, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { withWebSearch } from './web.js';
import { KeyError, checkOpenRouterKey, cleanKey, openKeys } from './keys.js';

export const STANDIN = { provider: 'standin', model: 'stand-in' };

// OpenRouter's models agents pick from are your favourites; these until you choose your own.
// The rest of its catalog is a search away (search below), and usable by id.
export const FAVOURITES = ['anthropic/claude-haiku-5.5', 'anthropic/claude-opus-5.5'];

// What setup recommends: a few cheap models and a few frontier ones.
const RECOMMENDED = {
  cheap: ['anthropic/claude-haiku-5.5', 'deepseek/deepseek-v4-flash', 'z-ai/glm-5.3-flash'],
  frontier: ['anthropic/claude-opus-5.5', 'meta/muse-wonder', 'google/gemini-4-argon'],
};

// Rough dollars a day at a steady pace: two million tokens in, a hundred thousand out.
const perDay = (cost) => (cost ? Math.round((cost.input * 2 + cost.output * 0.1) * 100) / 100 : 0);

// A model as the frontend shows it. OpenRouter names its models "Maker: Name"; prices are
// dollars per million tokens.
function described(m) {
  const [maker, name] = /^([^:]+): (.+)$/.exec(m.name)?.slice(1) || [m.id.split('/')[0].replace(/^~/, ''), m.name];
  return { id: m.id, name, maker, input: m.cost?.input ?? 0, output: m.cost?.output ?? 0, day: perDay(m.cost) };
}

function standinReply(context) {
  const last = [...context.messages].reverse().find((m) => m.role === 'user');
  const said = typeof last?.content === 'string' ? last.content : (last?.content || []).map((c) => c.text || '').join(' ');
  return fauxAssistantMessage([fauxText(
    "I'm on munin's stand-in model, so I can't think yet. Pick a real model on my profile: OpenRouter's show up "
    + "once you paste a key for it in Settings, and Ollama's once the runtime has MUNIN_OLLAMA_URL."
    + (said ? `\n\nYou said: ${said.slice(0, 280)}` : ''),
  )]);
}

function standinProvider() {
  const faux = fauxProvider({ provider: STANDIN.provider, models: [{ id: STANDIN.model, name: 'Stand-in' }] });
  // Each answer queues the next, so it never runs dry.
  const reply = (context) => {
    faux.appendResponses([reply]);
    return standinReply(context);
  };
  faux.setResponses([reply]);
  return faux.provider;
}

async function ollamaProvider(url) {
  const base = `${url.replace(/\/+$/, '').replace(/\/v1$/, '')}/v1`;
  let ids = [];
  try {
    const response = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
    ids = (await response.json()).data.map((m) => m.id);
  } catch {
    return null; // not running; agents on it fail with a clear error until it is
  }
  const models = ids.map((id) => ({
    id, name: id, api: 'openai-completions', provider: 'ollama', baseUrl: base, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16000,
  }));
  return createProvider({
    id: 'ollama',
    name: 'Ollama, on the server',
    baseUrl: base,
    auth: { apiKey: { name: 'Ollama', resolve: async () => ({ auth: {} }) } },
    models,
    api: openAICompletionsApi(),
  });
}

// The models, with every request to OpenRouter passed through withWebSearch (web.js): an agent's
// web_search tool becomes OpenRouter's own search, right before the request goes out.
export function searching(models) {
  const withSearch = (options) => ({
    ...options,
    onPayload: async (payload, model) => {
      const theirs = await options?.onPayload?.(payload, model);
      return withWebSearch(theirs ?? payload) ?? theirs;
    },
  });
  return new Proxy(models, {
    get(target, key) {
      if (key === 'stream' || key === 'streamSimple') {
        return (model, context, options) => target[key](model, context, model?.provider === 'openrouter' ? withSearch(options) : options);
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

// `extra` adds providers, like a scripted faux one in tests; `check` stands in for asking
// OpenRouter about a pasted key.
export async function buildModels(settings, { extra = [], env = process.env, check = checkOpenRouterKey } = {}) {
  const keys = await openKeys(settings.keysFile);
  // Keys from `env`, so whether a provider is there and the key it then uses agree.
  const authContext = { ...defaultProviderAuthContext(), env: async (name) => env[name]?.trim() || undefined };
  const models = createModels({ credentials: keys, authContext });
  models.setProvider(standinProvider());
  // OpenRouter is there while it has a key: a pasted one, or failing that the environment's.
  let pasted = (await keys.read('openrouter'))?.key || null;
  let openrouter = false;
  const sync = () => {
    openrouter = Boolean(pasted || env.OPENROUTER_API_KEY?.trim());
    if (openrouter) models.setProvider(openrouterProvider());
    else models.deleteProvider('openrouter');
  };
  sync();
  const ollama = settings.ollamaUrl ? await ollamaProvider(settings.ollamaUrl) : null;
  if (ollama) models.setProvider(ollama);
  for (const provider of extra) models.setProvider(provider);
  // OpenRouter's whole catalog, key or not, for recommending and searching.
  const everything = createModels({});
  everything.setProvider(openrouterProvider());
  const known = (id) => everything.getModel('openrouter', id);

  const free = (m) => ({ id: m.id, name: m.name || m.id, maker: '', input: 0, output: 0, day: 0 });
  // OpenRouter's models are your favourites, then any other an agent is on (`inUse`), so an
  // agent's picker always has its own model in it.
  const catalog = ({ favourites = FAVOURITES, inUse = [] } = {}) => {
    const out = [];
    if (openrouter) {
      const ids = [...new Set([...favourites, ...inUse])];
      out.push({
        id: 'openrouter', name: 'OpenRouter',
        models: ids.map((id) => models.getModel('openrouter', id)).filter(Boolean)
          .map((m) => ({ ...described(m), favourite: favourites.includes(m.id) })),
      });
    }
    if (ollama) out.push({ id: 'ollama', name: 'Ollama, on the server', models: models.getModels('ollama').map((m) => ({ ...free(m), name: m.id })) });
    for (const provider of extra) out.push({ id: provider.id, name: provider.name || provider.id, models: models.getModels(provider.id).map(free) });
    out.push({ id: STANDIN.provider, name: 'Stand-in, no model', models: [{ ...free({ id: STANDIN.model, name: 'Stand-in' }) }] });
    return out;
  };

  const recommended = () => Object.fromEntries(Object.entries(RECOMMENDED).map(([tier, ids]) => [tier, ids.map(known).filter(Boolean).map(described)]));

  // OpenRouter's models whose id or name has every word of `q`, leaving out batch-only ones.
  const search = (q, limit = 20) => {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return { total: 0, models: [] };
    const found = everything.getModels('openrouter')
      .filter((m) => !m.id.endsWith(':batch') && words.every((w) => `${m.id} ${m.name}`.toLowerCase().includes(w)));
    return { total: found.length, models: found.slice(0, limit).map(described) };
  };

  const keyOf = () => (pasted ? { from: 'settings', hint: pasted.slice(-4) } : env.OPENROUTER_API_KEY?.trim() ? { from: 'environment' } : null);
  const openrouterDetail = () => {
    if (!openrouter) return 'Paste a key from openrouter.ai to use its models';
    const from = pasted ? `key …${pasted.slice(-4)}` : 'key from OPENROUTER_API_KEY';
    return `${models.getModels('openrouter').length} models · ${from}`;
  };
  const providers = () => [
    { id: 'openrouter', name: 'OpenRouter', connected: openrouter, detail: openrouterDetail(), takesKey: true, key: keyOf() },
    { id: 'ollama', name: 'Ollama, on the server', connected: Boolean(ollama), detail: ollama ? `${settings.ollamaUrl} · ${models.getModels('ollama').length} models` : settings.ollamaUrl ? `Can't reach ${settings.ollamaUrl}` : 'Set MUNIN_OLLAMA_URL' },
    { id: STANDIN.provider, name: 'Stand-in', connected: true, detail: 'Answers without a model, for trying munin out' },
  ];

  // The model to use, falling back to the stand-in when it isn't available.
  const resolve = (provider, model) => (models.getModel(provider, model) ? { provider, model } : { ...STANDIN });

  const keyed = (provider) => {
    if (provider !== 'openrouter') throw new KeyError(`${provider} doesn't take a key here.`);
  };
  // A key pasted in Settings; agents on OpenRouter's models use it from their next turn.
  async function setKey(provider, text) {
    keyed(provider);
    const key = cleanKey(text);
    await check(key);
    await keys.modify(provider, async () => ({ type: 'api_key', key }));
    pasted = key;
    sync();
  }
  // Back to the environment's key, if it has one.
  async function removeKey(provider) {
    keyed(provider);
    await keys.delete(provider);
    pasted = null;
    sync();
  }

  return { models: searching(models), catalog, recommended, search, known, providers, resolve, setKey, removeKey };
}
