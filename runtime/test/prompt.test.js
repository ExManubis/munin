// What an agent is told it can do (prompt.js capabilities), from its real setup.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilities } from '../src/prompt.js';
import { ROUTINES_RULE } from '../src/roles.js';

const lines = (text) => text.split('\n');

test('an equipped agent hears what it can do, what asks first, and what it could have', () => {
  const agent = {
    name: 'hugin', role: 'assistant', abilities: { web: true, apps: true, code: true, tracker: true },
    askFirst: [
      { id: 'app:gmail:send', label: 'Gmail: sending mail', on: true },
      { id: 'app:gmail:organise', label: 'Gmail: labelling, archiving and marking read', on: false },
      { id: 'push', label: 'Pushing to git', on: true },
      { ...ROUTINES_RULE },
    ],
  };
  const text = capabilities(agent, 'Mikkel', {
    search: true,
    apps: {
      mine: [
        { name: 'Gmail', answering: true, detail: 'As mikkel@example.com', does: 'search and read your mail, draft replies, send mail' },
        { name: 'Google Calendar', answering: false, detail: 'Sign in with Google in Settings', does: 'see your events' },
      ],
      others: [{ name: 'Linear', detail: '12 tools' }],
    },
    tracker: { reachable: true, projects: ['MUN'] },
    repos: ['MUN'],
    routines: 2,
  });
  const said = lines(text);
  assert.match(said[0], /^What you can do\. When you're asked what you can do, or whether you can do something, answer from this/);
  assert.ok(said.includes('- The web: search it with web_search and read a page with read_page. Say where what you found came from.'));
  assert.ok(said.includes('- Gmail (as mikkel@example.com): search and read your mail, draft replies, send mail.'));
  assert.ok(!said.some((l) => l.startsWith('- Google Calendar')), "an app that doesn't work isn't offered");
  assert.ok(said.includes("- munin's tracker: take, review and file issues, in MUN."));
  assert.ok(said.includes('- Code: a folder of your own with a shell, files and git; munin keeps the code of MUN, and taking one of their issues gives you a worktree on its own branch.'));
  assert.match(text, /, and for the tracker "When an issue moves to In review"\. You have 2\./);
  assert.match(text, /These ask Mikkel first, and munin tells you the answer: sending mail \(Gmail\) and pushing to git\. Everything else you just do/);
  assert.ok(said.includes("- Use Google Calendar, which you have but which isn't working: Sign in with Google in Settings."));
  assert.ok(said.includes('- Use Linear (Mikkel can pick it under Apps on your profile).'));
  assert.ok(!said.some((l) => /turn on the (Web|Apps|Code|Tracker) ability/.test(l)), 'it has them all');
  assert.ok(said.includes('- Wake you when new mail arrives. A routine on a schedule, like "Every 30 minutes, 08–18", does instead.'));
});

test("a bare agent isn't offered what it doesn't have, and hears who can switch it on", () => {
  const agent = { name: 'pip', role: 'companion', abilities: {}, askFirst: [{ ...ROUTINES_RULE }] };
  const text = capabilities(agent, null, { routines: 0 });
  assert.doesNotMatch(text, /- The web|- Code:|tracker:/);
  assert.match(text, /You have none yet\./);
  assert.match(text, /Nothing you do asks the person you work for first\./);
  for (const ability of ['Web', 'Apps', 'Code', 'Tracker']) assert.match(text, new RegExp(`the person you work for can turn on the ${ability} ability on your profile`));
  assert.doesNotMatch(text, /Images ability/, "munin can't make pictures for anyone yet");
});
