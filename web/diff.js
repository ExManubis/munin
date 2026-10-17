// What changed between two texts, word by word, for an agent's proposed change to its own brief:
// words taken out are struck through and words put in are underlined, in munin's greys. No
// imports, so the runtime's tests can check it.

// [{ op: 'same' | 'del' | 'add', text }], from a longest common subsequence of words, with the
// spaces and line breaks after each word kept with it.
export function wordDiff(before, after) {
  const a = String(before || '').match(/\S+\s*/g) || [];
  const b = String(after || '').match(/\S+\s*/g) || [];
  const n = a.length;
  const m = b.length;
  const longest = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      longest[i][j] = a[i].trim() === b[j].trim() ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
    }
  }
  const out = [];
  const push = (op, text) => (out.at(-1)?.op === op ? (out.at(-1).text += text) : out.push({ op, text }));
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i].trim() === b[j].trim()) {
      push('same', b[j]);
      i += 1;
      j += 1;
    } else if (longest[i + 1][j] >= longest[i][j + 1]) {
      push('del', a[i++]);
    } else {
      push('add', b[j++]);
    }
  }
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return out;
}

export function diffView(before, after) {
  const view = document.createElement('div');
  view.className = 'diff';
  for (const { op, text } of wordDiff(before, after)) {
    if (op === 'same') {
      view.append(text);
    } else {
      const part = document.createElement(op === 'del' ? 'del' : 'ins');
      part.textContent = text;
      view.append(part);
    }
  }
  return view;
}
