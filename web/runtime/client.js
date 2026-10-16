// The real agent runtime over HTTP: the same functions as mock.js, backed by /runtime/api
// (docs/runtime-api.md), and its event stream for live updates.

export function connect(base) {
  const root = `${base}/runtime/api`;
  const enc = encodeURIComponent;

  async function call(method, path, body) {
    let response;
    try {
      response = await fetch(root + path, {
        method,
        headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error("Can't reach the agent runtime. Is it running?");
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.detail || `${response.status} ${response.statusText}`);
    return data;
  }

  const listeners = new Set();
  let stream = null;
  const listen = () => {
    if (stream) return;
    stream = new EventSource(`${root}/stream`);
    stream.addEventListener('changed', () => listeners.forEach((fn) => fn()));
    // A reconnect may have missed changes, so say something changed once it's back.
    let opened = false;
    stream.addEventListener('open', () => {
      if (opened) listeners.forEach((fn) => fn());
      opened = true;
    });
  };

  const agent = (name) => `/agents/${enc(name)}`;
  return {
    kind: 'runtime',
    me: () => call('GET', '/me'),
    updateMe: (patch) => call('PATCH', '/me', patch),
    agents: () => call('GET', '/agents'),
    agent: (name) => call('GET', agent(name)),
    conversation: (name) => call('GET', `${agent(name)}/conversation`),
    waiting: () => call('GET', '/waiting'),
    send: (name, text) => call('POST', `${agent(name)}/messages`, { text }),
    answer: (name, id, answer) => call('POST', `${agent(name)}/items/${enc(id)}/answer`, answer),
    decide: (name, id, decision) => call('POST', `${agent(name)}/items/${enc(id)}/decide`, { decision }),
    undo: (name, id) => call('POST', `${agent(name)}/items/${enc(id)}/undo`, {}),
    stopRun: (name, id) => call('POST', `${agent(name)}/runs/${enc(id)}/stop`, {}),
    createAgent: (fields) => call('POST', '/agents', fields),
    updateAgent: (name, patch) => call('PATCH', agent(name), patch),
    deleteAgent: (name) => call('DELETE', agent(name)),
    pause: (name) => call('POST', `${agent(name)}/pause`, {}),
    resume: (name) => call('POST', `${agent(name)}/resume`, {}),
    addRoutine: (name, routine) => call('POST', `${agent(name)}/routines`, routine),
    updateRoutine: (name, id, fields) => call('PATCH', `${agent(name)}/routines/${enc(id)}`, fields),
    deleteRoutine: (name, id) => call('DELETE', `${agent(name)}/routines/${enc(id)}`),
    runRoutine: (name, id) => call('POST', `${agent(name)}/routines/${enc(id)}/run`, {}),
    forget: (name, id) => call('DELETE', `${agent(name)}/memory/${enc(id)}`),
    providers: () => call('GET', '/providers'),
    setKey: (provider, key) => call('PUT', `/providers/${enc(provider)}/key`, { key }),
    removeKey: (provider) => call('DELETE', `/providers/${enc(provider)}/key`),
    models: () => call('GET', '/models'),
    recommendedModels: () => call('GET', '/models/recommended'),
    searchModels: (q) => call('GET', `/models/search?q=${enc(q)}`),
    setFavourites: (models) => call('PUT', '/favourites', { models }),
    repos: () => call('GET', '/repos'),
    setRepo: (key, fields) => call('PUT', `/repos/${enc(key)}`, fields),
    removeRepo: (key) => call('DELETE', `/repos/${enc(key)}`),
    subscribe(fn) {
      listeners.add(fn);
      listen();
      return () => listeners.delete(fn);
    },
  };
}
