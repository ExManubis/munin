// Push notifications from the runtime: keys, devices, and what gets pushed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';

const DEVICE = { endpoint: 'https://push.example/send/abc', keys: { p256dh: 'BPkey', auth: 'authsecret' } };

test("an assistant's questions, answers and approvals reach your devices; a coder's chatter doesn't", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'munin-push-'));
  const sent = []; // [endpoint, payload, options]
  const send = async (device, body, options) => {
    if (device.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    sent.push([device.endpoint, JSON.parse(body), options]);
  };
  const settings = { db: join(dir, 'runtime.sqlite'), pushFile: join(dir, 'push.json'), agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false, push: { send } });
  t.after(() => runtime.close());

  const status = runtime.push();
  assert.equal(status.devices, 0);
  assert.match(status.key, /^[A-Za-z0-9_-]{87}$/, 'an uncompressed P-256 point, base64url');
  assert.equal((await stat(join(dir, 'push.json'))).mode & 0o777, 0o600);
  await assert.rejects(runtime.subscribePush({ endpoint: 'http://nope' }), /isn't a push subscription/);
  await runtime.subscribePush(DEVICE);
  await runtime.subscribePush({ ...DEVICE, endpoint: 'https://push.example/gone' });
  assert.equal(runtime.push().devices, 2);

  await runtime.createAgent({ name: 'hugin', role: 'assistant', provider: 'scripted', model: 'model' });
  await runtime.createAgent({ name: 'forge', role: 'coder', provider: 'scripted', model: 'model' });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  // An answer.
  faux.setResponses([fauxAssistantMessage([fauxText("Morning! Two meetings today.\nStandup at 9, dentist at 3.")])]);
  await runtime.send('hugin', 'Brief me.');
  await runtime.waitForIdle();
  await settle();
  assert.deepEqual(sent.map(([, p]) => p), [{ title: 'hugin', body: 'Morning! Two meetings today.', url: '#/agents/hugin', tag: 'message-hugin' }]);
  assert.match(sent[0][2].vapidDetails.subject, /^mailto:/);
  assert.equal(runtime.push().devices, 1, 'the device that is gone is forgotten');

  // A question, and an approval it waits for.
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('ask_human', { question: 'Lunch at 12 or 1?' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Asked.')]),
  ]);
  await runtime.send('hugin', 'Plan lunch.');
  await runtime.waitForIdle();
  await settle();
  assert.ok(sent.some(([, p]) => p.title === 'hugin asks' && p.body === 'Lunch at 12 or 1?'));
  await runtime.updateAgent('hugin', { askFirst: { routines: true } });
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('add_routine', { name: 'Brief', when: 'weekdays 7:30', does: 'Brief me.' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage([fauxText('Waiting for you.')]),
  ]);
  await runtime.send('hugin', 'Every morning, please.');
  await runtime.waitForIdle();
  await settle();
  assert.ok(sent.some(([, p]) => p.title === 'hugin wants to change its routines'));

  // A coder's answers stay in munin.
  const count = sent.length;
  faux.setResponses([fauxAssistantMessage([fauxText('Tests pass.')])]);
  await runtime.send('forge', 'Status?');
  await runtime.waitForIdle();
  await settle();
  assert.equal(sent.length, count);

  await runtime.forgetPush(DEVICE.endpoint);
  assert.equal(runtime.push().devices, 0);
});
