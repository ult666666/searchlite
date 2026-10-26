import { SearchliteError } from './errors';
import { at } from './internal/at';

interface CompensatedSum {
  sum: number;
  correction: number;
}

function accumulate(total: CompensatedSum, value: number): void {
  const next = total.sum + value;
  total.correction +=
    Math.abs(total.sum) >= Math.abs(value) ? total.sum - next + value : value - next + total.sum;
  total.sum = next;
}

/**
 * Cosine from −1 to 1, with zero for an all-zero vector (including two empty arrays).
 * Finite array components are required. Unsafe raw arithmetic uses independently scaled,
 * compensated sums; this is floating-point approximation, not correctly-rounded arithmetic.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    throw new SearchliteError('INVALID_ARGUMENT', 'Vectors must be arrays of finite numbers');
  }
  if (a.length !== b.length) {
    throw new SearchliteError(
      'INVALID_ARGUMENT',
      `Vectors must have the same length to be compared (${a.length} vs ${b.length})`,
    );
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let scaleA = 0;
  let scaleB = 0;
  for (let i = 0; i < a.length; i++) {
    const x: unknown = a[i],
      y: unknown = b[i];
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y)
    ) {
      throw new SearchliteError('INVALID_ARGUMENT', 'Vectors must contain only finite numbers');
    }
    scaleA = Math.max(scaleA, Math.abs(x));
    scaleB = Math.max(scaleB, Math.abs(y));
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (scaleA === 0 || scaleB === 0) return 0;
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  const minimumNormal = 2 ** -1022;
  const clamp = (value: number) => Math.max(-1, Math.min(1, value));
  // Preserve ordinary arithmetic when raw sums carry normal finite information.
  if (
    Number.isFinite(dot) &&
    Number.isFinite(normA) &&
    Number.isFinite(normB) &&
    Number.isFinite(denominator) &&
    denominator > 0 &&
    normA >= minimumNormal &&
    normB >= minimumNormal &&
    Math.abs(dot) >= minimumNormal
  ) {
    return clamp(dot / denominator);
  }
  // At least one component of each scaled vector has magnitude one, so these
  // norms cannot underflow. Components/products are bounded, avoiding overflow.
  const scaledDot = { sum: 0, correction: 0 },
    squaredA = { sum: 0, correction: 0 },
    squaredB = { sum: 0, correction: 0 };
  for (let i = 0; i < a.length; i++) {
    const x = at<number>(a, i) / scaleA,
      y = at<number>(b, i) / scaleB;
    accumulate(scaledDot, x * y);
    accumulate(squaredA, x * x);
    accumulate(squaredB, y * y);
  }
  return clamp(
    (scaledDot.sum + scaledDot.correction) /
      (Math.sqrt(squaredA.sum + squaredA.correction) *
        Math.sqrt(squaredB.sum + squaredB.correction)),
  );
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
