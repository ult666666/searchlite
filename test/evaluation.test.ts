import { describe, expect, it } from 'vitest';
import {
  averagePrecision,
  evaluate,
  ndcgAtK,
  precisionAtK,
  recallAtK,
  reciprocalRank,
} from '../src/evaluation';

// Five results; d2 (grade 3) and d4 (grade 1) are relevant, d7 (grade 2) was never retrieved.
const RANKING = ['d1', 'd2', 'd3', 'd4', 'd5'];
const JUDGEMENTS = { d2: 3, d4: 1, d7: 2, d9: 0 };

describe('ranking metrics (hand-computed)', () => {
  it('precision@k counts relevant results in the top k', () => {
    expect(precisionAtK(RANKING, JUDGEMENTS, 1)).toBe(0);
    expect(precisionAtK(RANKING, JUDGEMENTS, 3)).toBeCloseTo(1 / 3, 15);
    expect(precisionAtK(RANKING, JUDGEMENTS, 5)).toBeCloseTo(2 / 5, 15);
    expect(precisionAtK(RANKING, JUDGEMENTS, 10)).toBeCloseTo(2 / 10, 15);
  });

  it('recall@k divides by every relevant document, retrieved or not', () => {
    expect(recallAtK(RANKING, JUDGEMENTS, 3)).toBeCloseTo(1 / 3, 15);
    expect(recallAtK(RANKING, JUDGEMENTS, 5)).toBeCloseTo(2 / 3, 15);
  });

  it('reciprocal rank uses the first relevant result', () => {
    expect(reciprocalRank(RANKING, JUDGEMENTS)).toBe(1 / 2);
    expect(reciprocalRank(['d1'], JUDGEMENTS)).toBe(0);
  });

  it('average precision averages precision at each relevant rank over all relevant documents', () => {
    // Relevant at ranks 2 and 4: (1/2 + 2/4) / 3.
    expect(averagePrecision(RANKING, JUDGEMENTS)).toBeCloseTo((1 / 2 + 2 / 4) / 3, 15);
  });

  it('nDCG@k uses graded gains and a log2(rank + 1) discount', () => {
    const ideal = 3 / Math.log2(2) + 2 / Math.log2(3) + 1 / Math.log2(4);
    expect(ndcgAtK(RANKING, JUDGEMENTS, 5)).toBeCloseTo(
      (3 / Math.log2(3) + 1 / Math.log2(5)) / ideal,
      15,
    );
    expect(ndcgAtK(RANKING, JUDGEMENTS, 5)).toBeCloseTo(0.48793, 5);
    expect(ndcgAtK(RANKING, JUDGEMENTS, 1)).toBe(0);
    expect(ndcgAtK(['d2', 'd7', 'd4'], JUDGEMENTS, 3)).toBeCloseTo(1, 15);
  });

  it('ignores repeated ids and handles queries without relevant documents', () => {
    expect(precisionAtK(['d2', 'd2', 'd4'], JUDGEMENTS, 2)).toBe(1);
    const none = { d1: 0 };
    expect(recallAtK(RANKING, none, 5)).toBe(0);
    expect(averagePrecision(RANKING, none)).toBe(0);
    expect(ndcgAtK(RANKING, none, 5)).toBe(0);
  });

  it('rejects an invalid cutoff', () => {
    expect(() => precisionAtK(RANKING, JUDGEMENTS, 0)).toThrow(/positive integer/);
    expect(() => ndcgAtK(RANKING, JUDGEMENTS, 2.5)).toThrow(/positive integer/);
  });
});

describe('evaluate', () => {
  it('averages every metric over the queries in the qrels', () => {
    const report = evaluate(
      { q1: RANKING, q2: ['x'], extra: ['ignored'] },
      { q1: JUDGEMENTS, q2: { x: 1 }, q3: { y: 2 } },
      { k: 5 },
    );
    expect(report.k).toBe(5);
    expect(report.queryCount).toBe(3);
    expect(report.perQuery.q2).toEqual({
      precision: 1 / 5,
      recall: 1,
      reciprocalRank: 1,
      averagePrecision: 1,
      ndcg: 1,
    });
    // q3 has no ranking in the run, so it scores 0 everywhere.
    expect(report.perQuery.q3).toEqual({
      precision: 0,
      recall: 0,
      reciprocalRank: 0,
      averagePrecision: 0,
      ndcg: 0,
    });
    expect(report.mean.precision).toBeCloseTo((2 / 5 + 1 / 5 + 0) / 3, 15);
    expect(report.mean.reciprocalRank).toBeCloseTo((1 / 2 + 1 + 0) / 3, 15);
    expect(report.mean.averagePrecision).toBeCloseTo((1 / 3 + 1 + 0) / 3, 15);
  });

  it('defaults to k = 10 and validates its input', () => {
    expect(evaluate({ q: ['a'] }, { q: { a: 1 } }).k).toBe(10);
    expect(() => evaluate({}, {})).toThrow(/at least one query/);
    expect(() => evaluate({}, { q: {} }, { k: 0 })).toThrow(/positive integer/);
  });
});
