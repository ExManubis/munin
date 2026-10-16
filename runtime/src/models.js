// The models agents can run on: OpenRouter when OPENROUTER_API_KEY is set, an Ollama server
// when MUNIN_OLLAMA_URL is, and always the stand-in, which answers without a model so munin
// works before any provider is set up.

import { createModels, createProvider, fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { openrouterProvider } from '@earendil-works/pi-ai/providers/openrouter';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';

export const STANDIN = { provider: 'standin', model: 'stand-in' };

// A short list to pick from; the rest of OpenRouter's catalog is still usable by id.
const PICKS = {
  openrouter: [
    'anthropic/claude-haiku-5.5', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5',
    '~google/gemini-flash-latest', '~deepseek/deepseek-flash-latest', '~moonshotai/kimi-latest',
  ],
};

// Rough dollars a day at a steady pace: two million tokens in, a hundred thousand out.
const perDay = (cost) => (cost ? Math.round((cost.input * 2 + cost.output * 0.1) * 100) / 100 : 0);

function standinReply(context) {
  const last = [...context.messages].reverse().find((m) => m.role === 'user');
  const said = typeof last?.content === 'string' ? last.content : (last?.content || []).map((c) => c.text || '').join(' ');
  return fauxAssistantMessage([fauxText(
    "I'm on munin's stand-in model, so I can't think yet. Pick a real model on my profile: OpenRouter's show up "
    + 'once the runtime has OPENROUTER_API_KEY in its environment, and Ollama once it has MUNIN_OLLAMA_URL.'
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

// `extra` adds providers, like a scripted faux one in tests.
export async function buildModels(settings, { extra = [], env = process.env } = {}) {
  const models = createModels();
  models.setProvider(standinProvider());
  const openrouter = Boolean(env.OPENROUTER_API_KEY);
  if (openrouter) models.setProvider(openrouterProvider());
  const ollama = settings.ollamaUrl ? await ollamaProvider(settings.ollamaUrl) : null;
  if (ollama) models.setProvider(ollama);
  for (const provider of extra) models.setProvider(provider);

  const catalog = () => {
    const out = [];
    if (openrouter) {
      out.push({
        id: 'openrouter', name: 'OpenRouter',
        models: PICKS.openrouter.map((id) => models.getModel('openrouter', id)).filter(Boolean)
          .map((m) => ({ id: m.id, name: m.name.replace(/^[^:]+: /, ''), day: perDay(m.cost) })),
      });
    }
    if (ollama) out.push({ id: 'ollama', name: 'Ollama, on the server', models: models.getModels('ollama').map((m) => ({ id: m.id, name: m.id, day: 0 })) });
    for (const provider of extra) out.push({ id: provider.id, name: provider.name || provider.id, models: models.getModels(provider.id).map((m) => ({ id: m.id, name: m.name || m.id, day: 0 })) });
    out.push({ id: STANDIN.provider, name: 'Stand-in, no model', models: [{ id: STANDIN.model, name: 'Stand-in', day: 0 }] });
    return out;
  };

  const providers = () => [
    { id: 'openrouter', name: 'OpenRouter', connected: openrouter, detail: openrouter ? `${models.getModels('openrouter').length} models` : 'Set OPENROUTER_API_KEY in the runtime’s environment' },
    { id: 'ollama', name: 'Ollama, on the server', connected: Boolean(ollama), detail: ollama ? `${settings.ollamaUrl} · ${models.getModels('ollama').length} models` : settings.ollamaUrl ? `Can't reach ${settings.ollamaUrl}` : 'Set MUNIN_OLLAMA_URL' },
    { id: STANDIN.provider, name: 'Stand-in', connected: true, detail: 'Answers without a model, for trying munin out' },
  ];

  // The model to use, falling back to the stand-in when it isn't available.
  const resolve = (provider, model) => (models.getModel(provider, model) ? { provider, model } : { ...STANDIN });

  return { models, catalog, providers, resolve };
}
