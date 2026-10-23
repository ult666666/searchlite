import { SearchliteError } from './errors';

/**
 * Relevance judgements ("qrels"): query id → document id → graded relevance. A grade of 0, a
 * negative grade, or no entry at all means "not relevant".
 */
export type Qrels = Readonly<Record<string, Readonly<Record<string, number>>>>;

/** A system's output: query id → ranked document ids, best first. */
export type Run = Readonly<Record<string, readonly string[]>>;

/** Metric values for one query, or their means over all queries. */
export interface MetricValues {
  /** Precision@k: the fraction of the top k results that are relevant. */
  precision: number;
  /** Recall@k: the fraction of all relevant documents found in the top k. */
  recall: number;
  /** Reciprocal rank of the first relevant result (its mean is MRR). Uses the full ranking. */
  reciprocalRank: number;
  /** Average precision (its mean is MAP). Uses the full ranking. */
  averagePrecision: number;
  /** nDCG@k with graded relevance. */
  ndcg: number;
}

export interface EvaluationReport {
  /** The cutoff used for precision, recall and nDCG. */
  k: number;
  /** Number of evaluated queries (every query in the qrels). */
  queryCount: number;
  /** Arithmetic mean of each metric over the queries. */
  mean: MetricValues;
  perQuery: Record<string, MetricValues>;
}

type Judgements = Readonly<Record<string, number>>;

function gradeOf(judgements: Judgements, id: string): number {
  const grade = judgements[id];
  return grade !== undefined && grade > 0 ? grade : 0;
}

/** A ranking with repeated ids removed; a document can only be retrieved once. */
function distinct(ranking: readonly string[]): string[] {
  return [...new Set(ranking)];
}

function relevantCount(judgements: Judgements): number {
  return Object.values(judgements).filter((grade) => grade > 0).length;
}

function checkCutoff(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new SearchliteError('INVALID_ARGUMENT', `k must be a positive integer, got ${k}`);
  }
}

/** Fraction of the top `k` positions holding a relevant document (empty slots count as misses). */
export function precisionAtK(
  ranking: readonly string[],
  judgements: Judgements,
  k: number,
): number {
  checkCutoff(k);
  const hits = distinct(ranking)
    .slice(0, k)
    .filter((id) => gradeOf(judgements, id) > 0).length;
  return hits / k;
}

/** Fraction of all relevant documents that appear in the top `k`. 0 if nothing is relevant. */
export function recallAtK(ranking: readonly string[], judgements: Judgements, k: number): number {
  checkCutoff(k);
  const total = relevantCount(judgements);
  if (total === 0) {
    return 0;
  }
  const hits = distinct(ranking)
    .slice(0, k)
    .filter((id) => gradeOf(judgements, id) > 0).length;
  return hits / total;
}

/** 1 / rank of the first relevant document, or 0 if none was retrieved. */
export function reciprocalRank(ranking: readonly string[], judgements: Judgements): number {
  const index = distinct(ranking).findIndex((id) => gradeOf(judgements, id) > 0);
  return index === -1 ? 0 : 1 / (index + 1);
}

/**
 * Average precision: the mean of precision@r over the ranks r at which relevant documents
 * appear, divided by the total number of relevant documents (so unretrieved ones count as 0).
 */
export function averagePrecision(ranking: readonly string[], judgements: Judgements): number {
  const total = relevantCount(judgements);
  if (total === 0) {
    return 0;
  }
  let found = 0;
  let sum = 0;
  distinct(ranking).forEach((id, index) => {
    if (gradeOf(judgements, id) > 0) {
      found++;
      sum += found / (index + 1);
    }
  });
  return sum / total;
}

/**
 * Normalized discounted cumulative gain at k (K. Järvelin and J. Kekäläinen, "Cumulated
 * gain-based evaluation of IR techniques", ACM TOIS 20(4), 2002).
 *
 *   DCG@k  = Σ_{i=1..k} grade_i / log2(i + 1)
 *   nDCG@k = DCG@k / IDCG@k
 *
 * The gain is the grade itself, and IDCG@k is the DCG of the best possible ordering of all
 * judged documents. This log2(i + 1) discount is the form used by trec_eval; the original paper
 * leaves ranks below the log base undiscounted. Returns 0 if nothing is relevant.
 */
export function ndcgAtK(ranking: readonly string[], judgements: Judgements, k: number): number {
  checkCutoff(k);
  const dcg = (grades: readonly number[]): number =>
    grades.slice(0, k).reduce((sum, grade, i) => sum + grade / Math.log2(i + 2), 0);
  const ideal = dcg(
    Object.values(judgements)
      .filter((grade) => grade > 0)
      .sort((a, b) => b - a),
  );
  if (ideal === 0) {
    return 0;
  }
  return dcg(distinct(ranking).map((id) => gradeOf(judgements, id))) / ideal;
}

/**
 * Scores a run against relevance judgements. Every query in `qrels` is evaluated; a query the
 * run has no ranking for scores 0 on every metric. Queries only present in the run are ignored.
 */
export function evaluate(run: Run, qrels: Qrels, options: { k?: number } = {}): EvaluationReport {
  const k = options.k ?? 10;
  checkCutoff(k);
  const queryIds = Object.keys(qrels).sort();
  if (queryIds.length === 0) {
    throw new SearchliteError('INVALID_ARGUMENT', 'qrels must contain at least one query');
  }
  const perQuery: Record<string, MetricValues> = {};
  const totals: MetricValues = {
    precision: 0,
    recall: 0,
    reciprocalRank: 0,
    averagePrecision: 0,
    ndcg: 0,
  };
  for (const queryId of queryIds) {
    const judgements = qrels[queryId] ?? {};
    const ranking = run[queryId] ?? [];
    const values: MetricValues = {
      precision: precisionAtK(ranking, judgements, k),
      recall: recallAtK(ranking, judgements, k),
      reciprocalRank: reciprocalRank(ranking, judgements),
      averagePrecision: averagePrecision(ranking, judgements),
      ndcg: ndcgAtK(ranking, judgements, k),
    };
    perQuery[queryId] = values;
    for (const metric of Object.keys(totals) as (keyof MetricValues)[]) {
      totals[metric] += values[metric];
    }
  }
  const mean = { ...totals };
  for (const metric of Object.keys(mean) as (keyof MetricValues)[]) {
    mean[metric] /= queryIds.length;
  }
  return { k, queryCount: queryIds.length, mean, perQuery };
}
