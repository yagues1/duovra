// Copyright (c) 2026 Leonxlnx, MIT. Véase public/licenses/Visual-effects-MIT.txt.

/**
 * Small fuzzy matcher for palettes and filters.
 *
 * Every space-separated token of the query must match the text as a subsequence.
 * Scores favour contiguous runs, word starts and early matches, so "nsess" ranks
 * "New session" above "Unread sessions". Returns the matched character indices
 * for highlighting.
 */

export interface FuzzyMatch {
  score: number;
  indices: number[];
}

const isBoundary = (t: string, i: number) => {
  if (i === 0) return true;
  const prev = t[i - 1];
  const cur = t[i];
  if (/[\s\-_/\\.:@>›·]/.test(prev)) return true;
  // camelCase boundary
  return prev.toLowerCase() === prev && cur.toUpperCase() === cur && cur.toLowerCase() !== cur;
};

function matchToken(token: string, text: string, lower: string): FuzzyMatch | null {
  if (!token) return { score: 0, indices: [] };

  // Contiguous substring: the strongest signal.
  let best: FuzzyMatch | null = null;
  let from = 0;
  for (let guard = 0; guard < 8; guard++) {
    const at = lower.indexOf(token, from);
    if (at < 0) break;
    const score = 60 + token.length * 6 + (at === 0 ? 24 : 0) + (isBoundary(text, at) ? 16 : 0) - at * 0.4;
    if (!best || score > best.score) best = { score, indices: Array.from({ length: token.length }, (_, k) => at + k) };
    from = at + 1;
  }
  if (best) return best;

  // Subsequence: try a few starting points and keep the best greedy walk.
  const starts: number[] = [];
  for (let i = 0; i < lower.length && starts.length < 10; i++) if (lower[i] === token[0]) starts.push(i);
  for (const start of starts) {
    const indices = [start];
    let ti = start + 1;
    let ok = true;
    for (let qi = 1; qi < token.length; qi++) {
      const ch = token[qi];
      // Prefer the next occurrence that sits on a word boundary, if one comes soon.
      let next = -1;
      let boundary = -1;
      for (let j = ti; j < lower.length; j++) {
        if (lower[j] !== ch) continue;
        if (next < 0) next = j;
        if (isBoundary(text, j)) {
          boundary = j;
          break;
        }
        if (j - ti > 12) break;
      }
      const pick = boundary >= 0 && next >= 0 && boundary - next < 10 && next !== ti ? boundary : next;
      if (pick < 0) {
        ok = false;
        break;
      }
      indices.push(pick);
      ti = pick + 1;
    }
    if (!ok) continue;
    // Reject scattered matches: most characters must start a word or continue a run.
    let good = 0;
    for (let k = 0; k < indices.length; k++) if (isBoundary(text, indices[k]) || (k > 0 && indices[k] === indices[k - 1] + 1)) good++;
    if (token.length >= 3 && good < Math.ceil(token.length * 0.6)) continue;
    let score = token.length * 2;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (isBoundary(text, i)) score += 7;
      if (k > 0) {
        const gap = i - indices[k - 1] - 1;
        if (gap === 0) score += 5;
        else score -= Math.min(gap, 10) * 0.5;
      }
    }
    score -= indices[0] * 0.3;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/** Matches `query` against `text`. Null when any token is missing. */
export function fuzzy(query: string, text: string): FuzzyMatch | null {
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, indices: [] };
  const lower = text.toLowerCase();
  let score = 0;
  const all = new Set<number>();
  for (const token of tokens) {
    const m = matchToken(token, text, lower);
    if (!m) return null;
    score += m.score;
    for (const i of m.indices) all.add(i);
  }
  // Shorter texts win ties: "Settings" beats "Settings for the whole workspace".
  score -= text.length * 0.05;
  return { score, indices: [...all].sort((a, b) => a - b) };
}
