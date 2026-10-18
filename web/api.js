// Thin wrapper around munin's JSON API. Errors carry the server's `detail` message.

export class ApiError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

function detailOf(data) {
  const detail = data && data.detail;
  if (typeof detail === 'string') return detail;
  // FastAPI validation errors: [{loc, msg, ...}]
  if (Array.isArray(detail)) return detail.map((d) => d.msg).filter(Boolean).join(' ');
  return null;
}

async function request(method, path, body) {
  const options = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, options);
  } catch {
    throw new ApiError("Can't reach munin. Is the server running?");
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(detailOf(data) || `${res.status} ${res.statusText}`, res.status);
  return data;
}

const enc = encodeURIComponent;
const get = (path) => request('GET', path);

export const api = {
  me: () => get('/api/me'),

  projects: () => get('/api/projects'),
  createProject: (fields) => request('POST', '/api/projects', fields),
  updateProject: (key, fields) => request('PATCH', `/api/projects/${enc(key)}`, fields),

  // params: project, status ("all" for every status), assignee, q (an id or words), limit
  issues: (params) => get(`/api/issues?${new URLSearchParams(params)}`),
  issue: (id) => get(`/api/issues/${enc(id)}`),
  createIssue: (fields) => request('POST', '/api/issues', fields),
  updateIssue: (id, fields) => request('PATCH', `/api/issues/${enc(id)}`, fields),
  linkPullRequest: (id, url) => request('POST', `/api/issues/${enc(id)}/pull-requests`, { url }),
  unlinkPullRequest: (id, pullId) => request('DELETE', `/api/issues/${enc(id)}/pull-requests/${pullId}`),
  github: () => get('/api/github'),
  updateStatus: () => get('/api/update'),
  updateNow: () => request('POST', '/api/update'),
  setGithubToken: (token) => request('PUT', '/api/github', { token }),
  comment: (id, body) => request('POST', `/api/issues/${enc(id)}/comments`, { body }),

  inbox: () => get('/api/inbox'),
  snoozed: () => get('/api/inbox?snoozed=true'),
  snooze: (ref, until) => request('PUT', `/api/issues/${encodeURIComponent(ref)}/snooze`, { until }),
  activity: (params) => get(`/api/activity?${new URLSearchParams(params)}`),

  agents: () => get('/api/agents'),
  agentRecord: (name) => get(`/api/agents/${enc(name)}/record`),
  push: () => get('/api/push'),
  subscribePush: (subscription) => request('POST', '/api/push', { subscription }),
  forgetPush: (endpoint) => request('DELETE', '/api/push', { endpoint }),
  addAgent: (name, provider = null) => request('POST', '/api/agents', { name, provider }),
  revokeAgent: (name) => request('DELETE', `/api/agents/${enc(name)}`),
};
