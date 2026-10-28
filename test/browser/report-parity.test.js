import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSameReport, maskNumbers } from './report-parity.js';

const report = (score, rank = 1, title = 'Binary heap') =>
  JSON.stringify({ id: 'q22', ranking: [{ title, rank, score }], ndcg: 0.6309297535714575 }) + '\n';

test('number masking leaves strings, including digits and escapes, untouched', () => {
  assert.equal(
    maskNumbers('{"q22":[1,-2.5e-3,"a\\"9"],"x":true}'),
    '{"q22":[#,#,"a\\"9"],"x":true}',
  );
});

test('report parity accepts last-place differences but nothing else', () => {
  // Real pair from Chromium 153 versus Node: the same BM25F score, one unit apart in the last place.
  assertSameReport(report(2.9456442920990384), report(2.945644292099039));
  assertSameReport(report(1e-17), report(0));
  assert.throws(() => assertSameReport(report(2.945644293), report(2.945644292099039)), /differs/);
  assert.throws(() => assertSameReport(report(1.5, 2), report(1.5, 1)), /integers/);
  assert.throws(() => assertSameReport(report(1.5, 1, 'Trie'), report(1.5)), /text outside/);
  assert.throws(() => assertSameReport(report(1.5).trimEnd(), report(1.5)), /text outside/);
});
