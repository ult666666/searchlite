/**
 * Evaluation queries for the glossary, with graded relevance judgements made by reading the
 * entries (not by looking at search results):
 *
 * - 3: the entry that directly answers the query
 * - 2: an entry that covers the topic substantially
 * - 1: an entry that is only partly relevant
 *
 * Entries not listed are judged not relevant. This is a tiny, single-annotator collection meant
 * to exercise the evaluation harness, not a benchmark.
 */
export interface EvaluationQuery {
  id: string;
  text: string;
  /** Glossary entry id → relevance grade. */
  judgements: Record<string, number>;
}

export const QUERIES: EvaluationQuery[] = [
  { id: 'q01', text: 'how do hash tables handle collisions', judgements: { 'hash-table': 3 } },
  {
    id: 'q02',
    text: 'ranking documents for a keyword query',
    judgements: {
      bm25: 3,
      'tf-idf': 2,
      'inverted-index': 2,
      'precision-and-recall': 1,
      embeddings: 1,
    },
  },
  {
    id: 'q03',
    text: 'risk-adjusted return',
    judgements: { 'sharpe-ratio': 3, volatility: 1, diversification: 1, 'value-at-risk': 1 },
  },
  {
    id: 'q04',
    text: 'value today of future cash flows',
    judgements: {
      'net-present-value': 3,
      'discounted-cash-flow': 3,
      'internal-rate-of-return': 2,
      'compound-interest': 1,
    },
  },
  {
    id: 'q05',
    text: 'two threads updating shared data',
    judgements: { 'race-condition': 3, deadlock: 2, 'acid-transactions': 1 },
  },
  {
    id: 'q06',
    text: 'run tests automatically on every pull request',
    judgements: { 'continuous-integration': 3, 'unit-testing': 2, 'version-control': 1 },
  },
  { id: 'q07', text: 'fuzzy matching for typos', judgements: { 'edit-distance': 3, trie: 2 } },
  {
    id: 'q08',
    text: 'model does well on training data but fails on new examples',
    judgements: { overfitting: 3, 'cross-validation': 2 },
  },
  {
    id: 'q09',
    text: 'spread incoming requests across servers',
    judgements: { 'load-balancing': 3, 'rate-limiting': 1, sharding: 1 },
  },
  {
    id: 'q10',
    text: 'compare embedding vectors',
    judgements: { 'cosine-similarity': 3, embeddings: 3 },
  },
  {
    id: 'q11',
    text: 'profit from price differences between markets',
    judgements: { arbitrage: 3 },
  },
  {
    id: 'q12',
    text: 'stock valuation multiples',
    judgements: {
      'price-to-earnings': 3,
      'market-capitalization': 2,
      'discounted-cash-flow': 1,
    },
  },
  {
    id: 'q13',
    text: 'sorted tree structure for fast lookups on disk',
    judgements: { 'b-tree': 3, 'database-index': 2, 'binary-search': 1 },
  },
  { id: 'q14', text: 'priority queue', judgements: { 'binary-heap': 3 } },
  {
    id: 'q15',
    text: 'minimize a loss function',
    judgements: { 'gradient-descent': 3, 'linear-regression': 1, 'logistic-regression': 1 },
  },
  {
    id: 'q16',
    text: 'analytics over historical data',
    judgements: { 'data-warehouse': 3, 'etl-pipeline': 2 },
  },
  {
    id: 'q17',
    text: 'randomized experiment comparing two versions',
    judgements: { 'ab-testing': 3, 'statistical-significance': 2 },
  },
  {
    id: 'q18',
    text: 'safely retry a failed request',
    judgements: { idempotency: 3, 'message-queue': 1 },
  },
  {
    id: 'q19',
    text: 'bond prices and interest rates',
    judgements: { 'bond-yield': 3, inflation: 1 },
  },
  { id: 'q20', text: 'automatic memory management', judgements: { 'garbage-collection': 3 } },
  {
    id: 'q21',
    text: 'predict the probability of a yes or no outcome',
    judgements: { 'logistic-regression': 3 },
  },
  { id: 'q22', text: 'token bucket algorithm', judgements: { 'rate-limiting': 3 } },
];
