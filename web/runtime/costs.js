// What issues cost, from the runtime: model responses while its agents worked on them. The
// tracker knows nothing of cost, so screens join the two here, as they do for questions.

import { runtime } from './index.js';

// Puts `cost` ({ cost, tokens, agents }, or null) on each issue. Without a runtime, nothing.
export async function withCosts(issues) {
  if (runtime.kind === 'none' || !issues.length) return issues;
  const ids = issues.length <= 50 ? issues.map((issue) => issue.id) : null;
  const costs = await runtime.issueCosts(ids).catch(() => ({}));
  for (const issue of issues) issue.cost = costs[issue.id] || null;
  return issues;
}

export function dollars(amount) {
  if (amount > 0 && amount < 0.01) return '<$0.01';
  return `$${amount.toFixed(2)}`;
}
