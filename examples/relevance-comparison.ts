/** Fixed-collection consumer: no new metric, ranking, ingestion or public package API. */
import { GLOSSARY } from '../corpus/glossary';
import { QUERIES } from '../corpus/queries';
import { CONFIGURATIONS, DEPTH, retrieveConfiguration } from '../corpus/retrieval';
import { evaluate, SearchliteError, type MetricValues, type Qrels, type Run } from '../src/index';

export interface ComparisonMetrics {
  precisionAt5: number;
  recallAt10: number;
  mrr: number;
  map: number;
  ndcgAt10: number;
}

export interface ComparedQuerySide {
  ranking: { id: string; title: string; rank: number; grade: number; score: number }[];
  metrics: ComparisonMetrics;
  missingRelevantAt10: string[];
}

function metrics(at5: MetricValues, at10: MetricValues): ComparisonMetrics {
  return {
    precisionAt5: at5.precision,
    recallAt10: at10.recall,
    mrr: at10.reciprocalRank,
    map: at10.averagePrecision,
    ndcgAt10: at10.ndcg,
  };
}

function delta(baseline: ComparisonMetrics, candidate: ComparisonMetrics): ComparisonMetrics {
  return {
    precisionAt5: candidate.precisionAt5 - baseline.precisionAt5,
    recallAt10: candidate.recallAt10 - baseline.recallAt10,
    mrr: candidate.mrr - baseline.mrr,
    map: candidate.map - baseline.map,
    ndcgAt10: candidate.ndcgAt10 - baseline.ndcgAt10,
  };
}

function configuration(id: string) {
  const found = CONFIGURATIONS.find((item) => item.id === id);
  if (!found) {
    throw new SearchliteError('INVALID_ARGUMENT', 'Unknown retrieval configuration');
  }
  return {
    id: found.id,
    name: found.name,
    options: found.options,
    scoreKind: found.hybrid ? 'RRF' : 'BM25F',
  };
}

/** All queries/inputs/rankings are retained so a download can be reproduced and inspected. */
export function createComparison(baselineId = 'bm25f', candidateId = 'no-stemming') {
  const baseline = configuration(baselineId);
  const candidate = configuration(candidateId);
  const baselineRanking = retrieveConfiguration(baseline.id);
  const candidateRanking = retrieveConfiguration(candidate.id);
  const ids = (run: typeof baselineRanking): Run =>
    Object.fromEntries(Object.entries(run).map(([id, results]) => [id, results.map((r) => r.id)]));
  const baselineRun = ids(baselineRanking);
  const candidateRun = ids(candidateRanking);
  const qrels: Qrels = Object.fromEntries(QUERIES.map((q) => [q.id, q.judgements]));
  const baseline5 = evaluate(baselineRun, qrels, { k: 5 });
  const baseline10 = evaluate(baselineRun, qrels, { k: 10 });
  const candidate5 = evaluate(candidateRun, qrels, { k: 5 });
  const candidate10 = evaluate(candidateRun, qrels, { k: 10 });
  const baselineMean = metrics(baseline5.mean, baseline10.mean);
  const candidateMean = metrics(candidate5.mean, candidate10.mean);
  const titles = new Map(GLOSSARY.map((entry) => [entry.id, entry.title]));
  const side = (
    run: typeof baselineRanking,
    id: string,
    judgements: Record<string, number>,
    values: ComparisonMetrics,
  ): ComparedQuerySide => {
    const ranked = run[id] ?? [];
    const documentIds = ranked.map((result) => result.id);
    return {
      ranking: ranked.map(({ id: documentId, score }, i) => ({
        id: documentId,
        title: titles.get(documentId) ?? documentId,
        rank: i + 1,
        grade: judgements[documentId] ?? 0,
        score,
      })),
      metrics: values,
      missingRelevantAt10: Object.keys(judgements)
        .filter(
          (documentId) =>
            (judgements[documentId] ?? 0) > 0 && !documentIds.slice(0, 10).includes(documentId),
        )
        .sort(),
    };
  };
  const queries = QUERIES.map((query) => {
    // All four reports evaluate these same fixed qrels, so every query has metric values.
    const before5 = baseline5.perQuery[query.id];
    const before10 = baseline10.perQuery[query.id];
    const after5 = candidate5.perQuery[query.id];
    const after10 = candidate10.perQuery[query.id];
    if (!before5 || !before10 || !after5 || !after10) {
      throw new Error('Missing fixed-collection evaluation values');
    }
    const before = metrics(before5, before10);
    const after = metrics(after5, after10);
    return {
      ...query,
      baseline: side(baselineRanking, query.id, query.judgements, before),
      candidate: side(candidateRanking, query.id, query.judgements, after),
      delta: delta(before, after),
    };
  });
  return structuredClone({
    schema: 'searchlite.relevance-comparison/1' as const,
    depth: DEPTH,
    collection: { documents: GLOSSARY, queries: QUERIES },
    baseline: { ...baseline, metrics: baselineMean },
    candidate: { ...candidate, metrics: candidateMean },
    meanDelta: delta(baselineMean, candidateMean),
    queries,
    limits: [
      'Tiny demonstration: 60 documents, 22 queries and 51 graded judgments by one author; not a benchmark or evidence of general performance.',
      'Configurations were fixed before evaluation; differences can come from a single query. Unlisted documents have grade 0 in this collection.',
      'Toy hybrid vectors capture spelling overlap, not meaning; no embedding model or provider is called.',
      'P@5 divides by 5; R@10 and nDCG@10 use top 10; MRR and MAP use the full retrieved ranking (up to 100).',
      'This report records reproducible synthetic inputs and computed outputs, not authenticated provenance or statistical significance.',
    ],
  });
}

export type ComparisonReport = ReturnType<typeof createComparison>;

export function serializeComparison(report: ComparisonReport): string {
  return JSON.stringify(report, null, 2) + '\n';
}
