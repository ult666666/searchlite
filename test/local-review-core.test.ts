import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { SearchIndex, evaluate } from '../src/index';
import { createLocalReviewer, serializeLocalReport } from '../examples/local-review-core.js';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value) + '\n');
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reviewer = () => createLocalReviewer({ SearchIndex, evaluate, digest });
const documents = [
  { id: 'a.md', title: 'quartz', body: 'other' },
  { id: 'b.md', title: 'other', body: 'quartz' },
];
function snapshot(changed = false) {
  const index = new SearchIndex({
    fields: changed ? { title: {}, body: { boost: 3 } } : { title: { boost: 3 }, body: {} },
  });
  index.addAll(documents);
  return encode(index.toJSON());
}
const labels = (minimum = 0.5) =>
  encode({
    schema: 'searchlite.local-judgments/1',
    queries: [
      {
        id: 'title-task',
        text: 'quartz',
        relevance: [{ documentId: 'a.md', grade: 3 }],
        minimumNdcgAt10: minimum,
      },
      {
        id: 'body-task',
        text: 'quartz',
        relevance: [{ documentId: 'b.md', grade: 3 }],
        minimumNdcgAt10: minimum,
      },
    ],
  });

describe('shared local-review semantics on actual saved indexes', () => {
  it('retains the literal per-query regression gate and hashes exact owned bytes', async () => {
    const r = reviewer(),
      before = snapshot(),
      after = snapshot(true),
      judgments = labels();
    const copies = [before.slice(), after.slice(), judgments.slice()];
    const report = await r.compare(r.restore(before), r.restore(after), judgments);
    expect(report.status).toBe('fail');
    expect(report.regressedQueries).toEqual(['title-task']);
    expect(report.failedMinimumQueries).toEqual([]);
    expect(report.failedQueries).toEqual(['title-task']);
    expect(report.queries[0]?.baseline.ranking.map((x) => x.id)).toEqual(['a.md', 'b.md']);
    expect(report.queries[0]?.candidate.ranking.map((x) => x.id)).toEqual(['b.md', 'a.md']);
    expect(report.queries[0]?.delta.ndcgAt10).toBeCloseTo(-0.36907024642854247, 14);
    expect(report.inputs.baselineSnapshotSha256).toBe(digest(before));
    expect(report.inputs.candidateSnapshotSha256).toBe(digest(after));
    expect(report.inputs.judgmentsSha256).toBe(digest(judgments));
    expect([before, after, judgments]).toEqual(copies);
    expect(serializeLocalReport(report)).toBe(
      serializeLocalReport(await r.compare(r.restore(before), r.restore(after), judgments)),
    );
  });
  it('works with asynchronous WebCrypto-style hashing and preserves minimum failures', async () => {
    const r = createLocalReviewer({
      SearchIndex,
      evaluate,
      digest: (bytes) => Promise.resolve(digest(bytes)),
    });
    const raw = snapshot();
    const pass = await r.compare(r.restore(raw), r.restore(raw), labels());
    expect(pass.status).toBe('pass');
    expect(pass.queries.every((q) => q.delta.ndcgAt10 === 0)).toBe(true);
    const fail = await r.compare(r.restore(raw), r.restore(raw), labels(1));
    expect(fail.status).toBe('fail');
    expect(fail.failedMinimumQueries).toEqual(['body-task']);
  });
  it('refuses malformed, invalid UTF8 and excessive snapshot buffers before a report', () => {
    const r = reviewer();
    for (const raw of [encode({}), new Uint8Array([255]), new Uint8Array(16 * 1024 * 1024 + 1)])
      expect(() => r.restore(raw)).toThrow();
  });
  it('rejects a different collection and excessive or malformed labels', async () => {
    const r = reviewer(),
      raw = snapshot();
    const other = new SearchIndex({ fields: { title: {}, body: {} } });
    other.addAll([{ id: 'changed.md', title: 'quartz', body: 'different' }]);
    await expect(
      r.compare(r.restore(raw), r.restore(encode(other.toJSON())), labels()),
    ).rejects.toMatchObject({ code: 'INCOMPARABLE_COLLECTION' });
    for (const bad of [encode({}), new Uint8Array([255]), new Uint8Array(256 * 1024 + 1)])
      await expect(r.compare(r.restore(raw), r.restore(raw), bad)).rejects.toThrow();
  });
});
