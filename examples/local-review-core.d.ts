import type { SearchIndex, evaluate } from '../src/index';
export type ReviewBytes = Uint8Array<ArrayBuffer>;
export interface LocalMetrics {
  precisionAt5: number;
  recallAt10: number;
  mrr: number;
  map: number;
  ndcgAt10: number;
}
export interface LocalRanking {
  id: string;
  rank: number;
  score: number;
  grade: number;
}
export interface LocalQuerySide {
  passed: boolean;
  metrics: LocalMetrics;
  ranking: LocalRanking[];
  missingRelevantAt10: string[];
}
export interface LocalComparedQuery {
  id: string;
  text: string;
  minimumNdcgAt10: number;
  relevance: { documentId: string; grade: number }[];
  baseline: LocalQuerySide;
  candidate: LocalQuerySide;
  delta: LocalMetrics;
  passed: boolean;
}
export interface LocalComparison {
  schema: 'searchlite.local-comparison/1';
  status: 'pass' | 'fail';
  inputs: {
    baselineSnapshotSha256: string;
    candidateSnapshotSha256: string;
    judgmentsSha256: string;
    collectionSha256: string;
    documentCount: number;
    queryCount: number;
  };
  queries: LocalComparedQuery[];
  failedQueries: string[];
  failedMinimumQueries: string[];
  regressedQueries: string[];
}
type EngineIndex = Pick<SearchIndex, 'has' | 'size' | 'toJSON' | 'search'>;
export interface LoadedLocalIndex {
  index: EngineIndex;
  data: ReviewBytes;
}
export class LocalReviewError extends Error {
  code: string;
  exitCode: number;
  constructor(code: string, message: string, exitCode?: number);
}
export function serializeLocalReport(value: unknown): string;
export function createLocalReviewer(dependencies: {
  SearchIndex: { fromJSON(raw: unknown): EngineIndex };
  evaluate: typeof evaluate;
  digest(bytes: ReviewBytes): string | Promise<string>;
}): {
  restore(bytes: ReviewBytes): LoadedLocalIndex;
  assertComparable(baseline: LoadedLocalIndex, candidate: LoadedLocalIndex): string;
  evaluate(index: LoadedLocalIndex, judgments: ReviewBytes): Promise<{ status: 'pass' | 'fail' }>;
  compare(
    baseline: LoadedLocalIndex,
    candidate: LoadedLocalIndex,
    judgments: ReviewBytes,
  ): Promise<LocalComparison>;
};
