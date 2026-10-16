// Model keys pasted in Settings. The runtime keeps them in keys.json next to its database,
// readable by its own user only, and never hands them back: the API says only where a key came
// from and its last four characters. Agents don't get them either: their shells get none of the
// runtime's keys, and coders' containers don't see the runtime's folder. pi-ai reads them as
// stored credentials, which win over the same key in the environment.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class KeyError extends Error {}

// A CredentialStore for pi-ai's createModels, in memory when there's no file (in tests).
export async function openKeys(file) {
  let saved = {};
  if (file) {
    try {
      saved = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Can't read the model keys in ${file}: ${err.message}`);
    }
  }
  const save = async () => {
    if (!file) return;
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  };
  // One write at a time, so two saves can't lose one another's key.
  let chain = Promise.resolve();
  const serial = (fn) => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    async read(providerId) {
      return saved[providerId];
    },
    async list() {
      return Object.entries(saved).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    },
    modify(providerId, fn) {
      return serial(async () => {
        const next = await fn(saved[providerId]);
        if (next !== undefined) {
          saved = { ...saved, [providerId]: next };
          await save();
        }
        return saved[providerId];
      });
    },
    delete(providerId) {
      return serial(async () => {
        if (!(providerId in saved)) return;
        const { [providerId]: _gone, ...rest } = saved;
        saved = rest;
        await save();
      });
    },
  };
}

// What was pasted, without what tends to come with it: spaces, quotes, or the whole
// OPENROUTER_API_KEY=… line.
export function cleanKey(text) {
  const key = String(text ?? '').trim().replace(/^(export\s+)?[A-Z_]+=/, '').replace(/^["']|["']$/g, '').trim();
  if (!key) throw new KeyError('Paste the key first.');
  if (/\s/.test(key)) throw new KeyError("That doesn't look like a key: it has spaces in it.");
  return key;
}

// Whether OpenRouter takes the key. Only a clear no stops it: when OpenRouter can't be
// reached from here, the key is kept, and agents say what's wrong when they use it.
export async function checkOpenRouterKey(key, get = fetch) {
  let response;
  try {
    response = await get('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
  } catch {
    return;
  }
  if (response.status === 401 || response.status === 403) {
    throw new KeyError("OpenRouter doesn't take that key. Copy it again from openrouter.ai/settings/keys.");
  }
}
