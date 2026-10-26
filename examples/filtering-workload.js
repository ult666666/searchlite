/** Fixed fictional skew for candidate-filtering measurements; no external corpus or model. */
export function makeFilteringWorkload(documentCount, warmupCycles, measurementCycles) {
  if (
    !Number.isInteger(documentCount) ||
    documentCount < 1 ||
    documentCount > 10000 ||
    !Number.isInteger(warmupCycles) ||
    warmupCycles < 0 ||
    warmupCycles > 8 ||
    !Number.isInteger(measurementCycles) ||
    measurementCycles < 1 ||
    measurementCycles > 8
  )
    throw new RangeError('Invalid bounded filtering workload');
  return {
    protocol: 'searchlite.filtering-workload/1',
    documents: Array.from({ length: documentCount }, (_, i) => ({
      id: 'doc-' + String(i).padStart(5, '0'),
      title: i % 2 === 0 ? 'storage record' : 'vector record',
      body: [
        'common',
        i % 97 === 0 ? 'needle' : '',
        i % 4 !== 3 ? 'shared phrase' : '',
        i % 5 === 0 ? 'excluded' : '',
      ]
        .filter(Boolean)
        .join(' '),
      tags: i % 3 === 0 ? ['secondary'] : ['general'],
    })),
    queries: [
      { id: 'rare-first', text: 'needle AND common' },
      { id: 'common-first', text: 'common AND needle' },
      { id: 'nested-or', text: 'needle AND (common OR secondary)' },
      { id: 'exclusion', text: 'needle AND common NOT excluded' },
      { id: 'prefix', text: 'needle AND title:stor*' },
      { id: 'phrase', text: 'needle AND "shared phrase"' },
      { id: 'broad-negative', text: 'common NOT needle' },
      { id: 'broad-or', text: 'common OR secondary' },
    ],
    options: { fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } } },
    limit: 10,
    warmupCycles,
    measurementCycles,
  };
}
