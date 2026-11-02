import { GLOSSARY } from '../corpus/glossary';
import { QUERIES } from '../corpus/queries';

/** Deterministic synthetic workload; source text/vocabulary repeat deliberately. */
export function makeWorkload(
  documentCount: number,
  warmupCycles: number,
  measurementCycles: number,
) {
  if (
    !Number.isInteger(documentCount) ||
    documentCount < 1 ||
    documentCount > 10_000 ||
    !Number.isInteger(warmupCycles) ||
    warmupCycles < 0 ||
    warmupCycles > 8 ||
    !Number.isInteger(measurementCycles) ||
    measurementCycles < 1 ||
    measurementCycles > 8
  ) {
    throw new RangeError('Invalid bounded benchmark workload');
  }
  const documents = Array.from({ length: documentCount }, (_, i) => {
    const source = GLOSSARY[i % GLOSSARY.length];
    if (!source) throw new Error('Missing glossary fixture');
    return { ...source, id: `${String(i).padStart(5, '0')}-${source.id}`, tags: [...source.tags] };
  });
  return {
    protocol: 'searchlite.benchmark-workload/1',
    documents,
    queries: [
      ...QUERIES.map(({ id, text }) => ({ id, text })),
      { id: 'syntax-phrase', text: '"binary heap"' },
      { id: 'syntax-prefix', text: 'title:hash*' },
      { id: 'syntax-boolean', text: '(index OR tree) AND disk' },
      { id: 'syntax-fuzzy', text: 'volatlity~1' },
    ],
    options: { fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } } },
    warmupCycles,
    measurementCycles,
    limit: 10,
  };
}

/** Nearest-rank percentile: sorted[ceil(p * N) - 1], not interpolation. */
export function summarize(values: readonly number[]) {
  if (!values.length || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new RangeError('Samples must be nonempty, finite and nonnegative');
  }
  const sorted = [...values].sort((a, b) => a - b);
  const at = (index: number): number => {
    const value = sorted[index];
    if (value === undefined) throw new RangeError('Missing sample');
    return value;
  };
  return {
    count: sorted.length,
    minMs: at(0),
    meanMs: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50Ms: at(Math.ceil(0.5 * sorted.length) - 1),
    p95Ms: at(Math.ceil(0.95 * sorted.length) - 1),
    maxMs: at(sorted.length - 1),
  };
}

/**
 * A synthetic collection with Zipf-distributed vocabulary (word rank r has weight 1 / r), so a few
 * terms are in most documents and most terms are rare, as in natural text. Words are labels such
 * as `w0007` rather than language; queries are disjunctions that mix common and rare ranks.
 */
export function makeZipfWorkload(
  documentCount: number,
  warmupCycles: number,
  measurementCycles: number,
) {
  if (
    !Number.isInteger(documentCount) ||
    documentCount < 1 ||
    documentCount > 10_000 ||
    !Number.isInteger(warmupCycles) ||
    warmupCycles < 0 ||
    warmupCycles > 8 ||
    !Number.isInteger(measurementCycles) ||
    measurementCycles < 1 ||
    measurementCycles > 8
  ) {
    throw new RangeError('Invalid bounded benchmark workload');
  }
  const vocabulary = 5000;
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= vocabulary; rank++) cumulative.push((total += 1 / rank));
  let seed = 0x5eed;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const label = (rank: number) => `w${String(rank).padStart(4, '0')}`;
  const draw = () => {
    const target = random() * total;
    let low = 0;
    let high = vocabulary - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((cumulative[middle] ?? total) < target) low = middle + 1;
      else high = middle;
    }
    return label(low + 1);
  };
  const words = (count: number) => Array.from({ length: count }, draw).join(' ');
  const or = (...ranks: number[]) => ranks.map(label).join(' OR ');
  return {
    protocol: 'searchlite.benchmark-workload/1',
    documents: Array.from({ length: documentCount }, (_, i) => ({
      id: `zipf-${String(i).padStart(5, '0')}`,
      title: words(2 + Math.floor(random() * 5)),
      body: words(20 + Math.floor(random() * 61)),
    })),
    queries: [
      { id: 'common-rare', text: or(1, 50) },
      { id: 'mixed-three', text: or(3, 200, 2000) },
      { id: 'two-mid', text: or(10, 100) },
      { id: 'three-common', text: or(2, 5, 8) },
      { id: 'three-rare', text: or(500, 1500, 4000) },
      { id: 'six-common', text: or(1, 2, 3, 4, 5, 6) },
      { id: 'implicit-or', text: [20, 300, 900].map(label).join(' ') },
      { id: 'field-scoped', text: `title:${label(7)} OR ${label(30)}` },
    ],
    options: { fields: { title: { boost: 3 }, body: {} } },
    warmupCycles,
    measurementCycles,
    limit: 10,
  };
}
