// A passing expression: an agent's face shows how the work is going for a minute, and its status
// wins whenever you're needed (runtime.js set_expression, web/figbot.js faceOf).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { buildModels } from '../src/models.js';
import { openRuntime } from '../src/runtime.js';
import { faceOf } from '../../web/figbot.js';

const reply = (...content) => fauxAssistantMessage(content, { stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop' });

test("a face shows a passing expression while it lasts, unless you're needed or the agent is paused", () => {
  const now = Date.parse('2027-01-04T10:00:00Z');
  const forge = { state: 'working', expression: { pose: 'excited', until: '2027-01-04T10:01:00Z' } };
  assert.equal(faceOf(forge, undefined, now), 'excited');
  assert.equal(faceOf({ ...forge, state: 'idle' }, undefined, now), 'excited');
  assert.equal(faceOf({ ...forge, state: 'asks' }, undefined, now), 'asks', 'asking you wins');
  assert.equal(faceOf({ ...forge, state: 'paused' }, undefined, now), 'paused');
  assert.equal(faceOf(forge, undefined, Date.parse('2027-01-04T10:01:00Z')), 'working', 'a minute later, status again');
  assert.equal(faceOf({ state: 'idle', expression: null }, undefined, now), 'idle');
  assert.equal(faceOf(forge, 'asks', now), 'asks', 'a state from elsewhere, like the tracker, wins too');
});

test('an agent sets a passing expression, which lasts a minute and shows no step', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-01-04T10:00:00Z') });
  const dir = await mkdtemp(join(tmpdir(), 'munin-face-'));
  const settings = { db: ':memory:', agentsDir: join(dir, 'agents'), ollamaUrl: null, user: 'Mikkel' };
  const faux = fauxProvider({ provider: 'scripted', models: [{ id: 'model' }] });
  const runtime = await openRuntime(settings, { models: await buildModels(settings, { extra: [faux.provider], env: {} }), timers: false });
  await runtime.createAgent({ name: 'pip', role: 'companion', provider: 'scripted', model: 'model' });

  let told = '';
  let prompt = '';
  faux.setResponses([
    (context) => {
      prompt = JSON.stringify(context.messages.filter((m) => m.role === 'system'));
      return reply(fauxToolCall('set_expression', { expression: 'excited' }));
    },
    (context) => {
      told = JSON.stringify(context.messages.findLast((m) => m.role === 'toolResult'));
      return reply(fauxText('Yes! A piano.'));
    },
  ]);
  await runtime.send('pip', 'A piano?');
  await runtime.waitForIdle();
  assert.match(prompt, /Your face: munin draws you as a Figbot in your colour, and Mikkel sees it beside everything you say\. When something real happens in the work, .*set_expression: excited when something finally works, .*Not for small talk\./);
  assert.match(told, /Your face shows excited for a minute\./);
  let pip = (await runtime.agents()).find((a) => a.name === 'pip');
  assert.deepEqual(pip.expression, { pose: 'excited', until: '2027-01-04T10:01:00.000Z' });
  assert.deepEqual((await runtime.agent('pip')).expression, pip.expression, 'in full too');
  const { items } = await runtime.conversation('pip');
  assert.deepEqual(items.map((i) => i.kind), ['message', 'message'], 'no step, no line: it shows on the face');

  t.mock.timers.tick(61 * 1000);
  pip = (await runtime.agents()).find((a) => a.name === 'pip');
  assert.equal(pip.expression, null);
  await runtime.close();
});
