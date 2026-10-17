// Push notifications from the runtime: an agent's question, an approval it waits for, and what
// agents that don't code say (a morning brief, an answer), reaching your devices even with munin
// closed. The runtime has its own keys (VAPID) and devices in push.json next to its database,
// readable by its own user only; the tracker pushes its own things with keys of its own, and the
// frontend subscribes each device to both. A question about a tracker issue is the tracker's to
// push, so it isn't pushed twice.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import webpush from 'web-push';

export class PushError extends Error {}

const firstLine = (text, limit = 140) => {
  const line = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
};

// `file` is push.json (null in tests keeps it in memory); `send` is for tests.
export async function openPush({ file, subject = 'mailto:munin@localhost', send = (sub, body, options) => webpush.sendNotification(sub, body, options) }) {
  let saved = null;
  if (file) {
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Can't read the push keys in ${file}: ${err.message}`);
    }
  }
  const keys = saved?.keys || webpush.generateVAPIDKeys();
  let devices = saved?.devices || [];
  let chain = Promise.resolve();
  const save = () => {
    chain = chain.then(async () => {
      if (!file) return;
      await mkdir(dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ keys, devices }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, file);
    }).catch(() => {});
    return chain;
  };
  if (!saved) await save();

  async function sendAll(payload) {
    let sent = 0;
    const gone = [];
    await Promise.all(devices.map(async (device) => {
      try {
        await send(device, JSON.stringify(payload), { vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 24 * 60 * 60, timeout: 10 * 1000 });
        sent += 1;
      } catch (err) {
        if (err?.statusCode === 404 || err?.statusCode === 410) gone.push(device.endpoint);
        // any other failure: the push service is away; this one is missed, the next may land
      }
    }));
    if (gone.length) {
      devices = devices.filter((d) => !gone.includes(d.endpoint));
      await save();
    }
    return sent;
  }

  return {
    status: () => ({ key: keys.publicKey, devices: devices.length }),

    async subscribe(subscription) {
      const endpoint = String(subscription?.endpoint || '');
      if (!endpoint.startsWith('https://') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) throw new PushError("That isn't a push subscription from a browser.");
      devices = [...devices.filter((d) => d.endpoint !== endpoint), { endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } }];
      await save();
    },

    async forget(endpoint) {
      devices = devices.filter((d) => d.endpoint !== endpoint);
      await save();
    },

    // What happened, as a push: nothing when nobody's listening.
    notify(agent, kind, data) {
      if (!devices.length) return Promise.resolve(0);
      const url = `#/agents/${encodeURIComponent(agent.name)}`;
      if (kind === 'question' && !data.trackerQuestion) return sendAll({ title: `${agent.name} asks`, body: firstLine(data.text), url, tag: `question-${agent.name}` });
      if (kind === 'approval') return sendAll({ title: `${agent.name} wants to ${data.what}`, body: firstLine(data.target), url, tag: `approval-${agent.name}` });
      if (kind === 'meeting') return sendAll({ title: `${agent.name} calls you into "${data.title}"`, body: firstLine(data.text), url, tag: `meeting-${agent.name}` });
      if (kind === 'message' && !agent.abilities?.code) return sendAll({ title: agent.name, body: firstLine(data.text), url, tag: `message-${agent.name}` });
      return Promise.resolve(0);
    },

    flush: () => chain,
  };
}
