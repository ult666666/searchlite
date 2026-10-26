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
