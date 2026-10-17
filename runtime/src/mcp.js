// Just enough of MCP over HTTP (streamable HTTP) for munin: initialize, list tools, call one.
// A server answers each request in JSON or as server-sent events, which this reads too. One that
// hands out a session (Mcp-Session-Id) gets it back on every request, and a new one is started
// when it says the session is gone. `name` is how errors refer to the server: "the tracker".

const PROTOCOL = '2025-06-18';

export class McpError extends Error {}

export function mcpClient(url, { token = null, name = 'the server', headers = {} } = {}) {
  let next = 0;
  let session = null;

  async function post(body, signal) {
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          ...headers,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(session ? { 'Mcp-Session-Id': session } : {}),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'MCP-Protocol-Version': PROTOCOL,
        },
        body: JSON.stringify(body),
        signal: signal || AbortSignal.timeout(30 * 1000), // a server that never answers isn't waited on forever
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new McpError(`Can't reach ${name} at ${url}.`);
    }
    return response;
  }

  async function rpc(method, params, signal, { retried = false } = {}) {
    const response = await post({ jsonrpc: '2.0', id: ++next, method, params }, signal);
    if (response.status === 404 && session && !retried) {
      session = null; // the server forgot it: start again
      if (method !== 'initialize') await initialize(signal);
      return rpc(method, params, signal, { retried: true });
    }
    if (response.status === 401 || response.status === 403) throw new McpError(`${capital(name)} doesn't accept this token. It may have been revoked.`);
    if (!response.ok) throw new McpError(`${capital(name)} answered ${response.status} ${response.statusText}.`);
    if (method === 'initialize') session = response.headers.get('mcp-session-id') || null;
    const body = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? fromEvents(await response.text())
      : await response.json();
    if (body?.error) throw new McpError(body.error.message || `${capital(name)} refused that.`);
    return body?.result;
  }

  async function initialize(signal) {
    const info = await rpc('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'munin-runtime', version: '0.1.0' } }, signal);
    if (session) await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, signal).catch(() => {});
    return info;
  }

  return {
    initialize,
    async tools(signal) {
      const tools = [];
      let cursor;
      do {
        const page = await rpc('tools/list', cursor ? { cursor } : {}, signal);
        tools.push(...(page?.tools || []));
        cursor = page?.nextCursor;
      } while (cursor);
      return tools;
    },
    call: (tool, args, signal) => rpc('tools/call', { name: tool, arguments: args }, signal),
  };
}

const capital = (text) => text[0].toUpperCase() + text.slice(1);

function fromEvents(text) {
  const messages = text.split(/\r?\n\r?\n/)
    .map((block) => block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
  return messages.find((m) => 'result' in m || 'error' in m) || null;
}

export const textOf = (result) => (result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
