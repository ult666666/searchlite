import assert from 'node:assert/strict';
import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../src/hybrid';
import { SearchIndex } from '../src/search-index';

describe('finite-vector cosine across supported magnitudes', () => {
  it.each([1e308, 1e-200, Number.MIN_VALUE])('preserves direction at magnitude %s', (scale) => {
    expect(cosineSimilarity([scale, scale], [scale, scale])).toBeCloseTo(1, 14);
    expect(cosineSimilarity([scale, scale], [-scale, -scale])).toBeCloseTo(-1, 14);
    expect(cosineSimilarity([scale, 0], [0, scale])).toBe(0);
    expect(cosineSimilarity([0, 0], [scale, scale])).toBe(0);
  });

  it('retains tiny representable correlations and cancellation residuals', () => {
    for (const [a, b, expected] of [
      [[1e308, 1], [0, 1e308], 1e-308],
      [[1e-100, 1e-220], [0, 1e-100], 1e-120],
      [[1, 1e-300, -1], [1, 1, 1], 1e-300 / Math.sqrt(6)],
    ] as const) {
      const actual = cosineSimilarity(a, b);
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(
        Math.max(Number.MIN_VALUE * 8, Math.abs(expected) * 8 * Number.EPSILON),
      );
      expect(actual).toBeGreaterThan(0);
    }
    expect(cosineSimilarity([1e-160, 1e-160], [0, 1e-160])).toBeCloseTo(1 / Math.sqrt(2), 14);
  });

  it('keeps ordinary results, true zero/empty conventions and readonly inputs', () => {
    const left = Object.freeze([3, 4]),
      right = Object.freeze([4, 3]);
    expect(cosineSimilarity(left, right)).toBe(0.96);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([-0, 0], [0, -0])).toBe(0);
    expect(left).toEqual([3, 4]);
    expect(right).toEqual([4, 3]);
    const many = Array<number>(4096).fill(Number.MAX_VALUE);
    const value = cosineSimilarity(many, many);
    expect(Number.isFinite(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(-1);
    expect(value).toBeLessThanOrEqual(1);
    expect(value).toBeCloseTo(1, 14);
  });

  it('refuses missing/nonfinite components with a structured argument error', () => {
    const sparse = Array<number>(2);
    sparse[0] = 1;
    for (const bad of [sparse, [NaN, 1], [Infinity, 1], [-Infinity, 1]]) {
      assert.throws(() => cosineSimilarity(bad, [1, 0]), { code: 'INVALID_ARGUMENT' });
      assert.throws(() => cosineSimilarity([1, 0], bad), { code: 'INVALID_ARGUMENT' });
    }
    assert.throws(() => cosineSimilarity([1], [1, 2]), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => cosineSimilarity(null as never, [1]), { code: 'INVALID_ARGUMENT' });
  });
});

describe('actual hybrid ranking and atomic finite-vector boundaries', () => {
  it.each([1e308, 1e-200, Number.MIN_VALUE])(
    'ranks aligned before orthogonal/opposed and restores at %s',
    (scale) => {
      const index = new SearchIndex({ fields: ['body'], vectorField: 'embedding' });
      index.addAll([
        { id: 'orthogonal', body: 'orthogonal', embedding: [0, scale] },
        { id: 'aligned', body: 'aligned', embedding: [scale, 0] },
        { id: 'opposed', body: 'opposed', embedding: [-scale, 0] },
      ]);
      for (const target of [index, SearchIndex.fromJSON(index.toJSON())]) {
        expect(target.searchHybrid({ vector: [scale, 0], k: 1, depth: 1 })[0]?.id).toBe('aligned');
        const ranked = target.searchHybrid({ vector: [scale, 0], depth: 3 });
        expect(ranked.map((r) => r.id)).toEqual(['aligned', 'orthogonal', 'opposed']);
        expect(ranked.map((r) => r.semantic?.similarity)).toEqual([1, 0, -1]);
        const fused = target.searchHybrid({
          query: 'orthogonal',
          vector: [scale, 0],
          depth: 1,
          rrfK: 0,
        });
        expect(fused.map((r) => r.id)).toEqual(['aligned', 'orthogonal']);
        expect(fused.find((r) => r.id === 'orthogonal')?.lexical?.score).toBe(
          target.search('orthogonal')[0]?.score,
        );
        target.remove('aligned');
        target.replace({ id: 'orthogonal', body: 'updated', embedding: [0, -scale] });
        expect(target.searchHybrid({ vector: [0, -scale], k: 1 })[0]?.id).toBe('orthogonal');
      }
    },
  );

  it('refuses sparse add/batch/replace/query/snapshot without changing the index', () => {
    const index = new SearchIndex({ fields: ['body'], vectorField: 'embedding' });
    index.add({ id: 'existing', body: 'existing', embedding: [1, 0] });
    const before = index.toJSON(),
      sparse = Array<number>(2);
    sparse[0] = 1;
    assert.throws(
      () => {
        index.add({ id: 'bad', embedding: sparse });
      },
      { code: 'INVALID_DOCUMENT' },
    );
    assert.throws(
      () => {
        index.addAll([
          { id: 'valid', embedding: [0, 1] },
          { id: 'bad', embedding: sparse },
        ]);
      },
      { code: 'INVALID_DOCUMENT' },
    );
    assert.throws(
      () => {
        index.replace({ id: 'existing', embedding: sparse });
      },
      {
        code: 'INVALID_DOCUMENT',
      },
    );
    assert.throws(() => index.searchHybrid({ vector: sparse }), { code: 'INVALID_ARGUMENT' });
    const first = before.documents[0];
    if (!first) throw new Error('Expected snapshot document');
    assert.throws(
      () => SearchIndex.fromJSON({ ...before, documents: [{ ...first, vector: sparse }] }),
      { code: 'INVALID_SNAPSHOT' },
    );
    expect(index.toJSON()).toEqual(before);
    expect(index.searchHybrid({ vector: [0, 0] })[0]?.semantic?.similarity).toBe(0);
  });
});
