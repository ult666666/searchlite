import { SearchliteError } from './errors';
import { at } from './internal/at';

/**
 * Cosine of the angle between two vectors: dot(a, b) / (|a| · |b|), from −1 to 1. It ignores
 * vector length, which is why it is the usual way to compare embeddings. Returns 0 when either
 * vector is all zeros, since the angle is then undefined.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new SearchliteError(
      'INVALID_ARGUMENT',
      `Vectors must have the same length to be compared (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  a.forEach((x, i) => {
    const y = at(b, i);
    dot += x * y;
    normA += x * x;
    normB += y * y;
  });
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface FusedResult {
  id: string;
  /** Sum over rankings of 1 / (k + rank). */
  score: number;
}

export interface FusionOptions {
  /**
   * Smoothing constant. Larger values flatten the difference between top ranks and lower ones.
   * Default 60, the value used by Cormack et al.
   */
  k?: number;
}

/**
 * Reciprocal Rank Fusion (G. V. Cormack, C. L. A. Clarke and S. Büttcher, "Reciprocal Rank
 * Fusion outperforms Condorcet and individual Rank Learning Methods", SIGIR 2009).
 *
 * Each ranking contributes 1 / (k + rank) for every document it contains, with ranks starting
 * at 1, and the contributions are summed. RRF only looks at ranks, so it can merge lists whose
 * scores are on incompatible scales, such as BM25 scores and cosine similarities.
 *
 * A document listed twice in the same ranking counts once, at its best rank. Ties are broken
 * by id so the output is deterministic.
 */
export function reciprocalRankFusion(
  rankings: readonly (readonly string[])[],
  options: FusionOptions = {},
): FusedResult[] {
  const k = options.k ?? 60;
  if (!Number.isFinite(k) || k < 0) {
    throw new SearchliteError('INVALID_ARGUMENT', `RRF k must be a finite number ≥ 0, got ${k}`);
  }
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    const seen = new Set<string>();
    ranking.forEach((id, index) => {
      if (seen.has(id)) {
        return;
      }
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
