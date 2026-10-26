/** Existing fixed glossary evaluation configurations, shared by native and browser consumers. */
import { GLOSSARY, type GlossaryEntry } from './glossary';
import { QUERIES } from './queries';
import {
  Analyzer,
  SearchIndex,
  SearchliteError,
  type IndexOptions,
  type Run,
  type SearchDocument,
} from '../src/index';

/** Full retrieved depth used by MRR and MAP; does not truncate them at metric k. */
export const DEPTH = 100;

export interface Configuration {
  id: string;
  name: string;
  options: IndexOptions;
  toDocument?: (entry: GlossaryEntry) => SearchDocument;
  hybrid?: boolean;
}

const DEFAULT_FIELDS = { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } };

export const CONFIGURATIONS: Configuration[] = [
  {
    id: 'bm25f',
    name: 'BM25F, default analysis, boosts title 3 / tags 2 / body 1',
    options: { fields: DEFAULT_FIELDS },
  },
  {
    id: 'no-stemming',
    name: 'no stemming',
    options: {
      fields: {
        title: { boost: 3, stemming: false },
        body: { stemming: false },
        tags: { boost: 2, stemming: false },
      },
    },
  },
  {
    id: 'no-stopwords',
    name: 'no stopword removal',
    options: {
      fields: {
        title: { boost: 3, stopwords: false },
        body: { stopwords: false },
        tags: { boost: 2, stemming: false, stopwords: false },
      },
    },
  },
  {
    id: 'no-boosts',
    name: 'no field boosts (all weights 1)',
    options: { fields: { title: {}, body: {}, tags: { stemming: false } } },
  },
  {
    id: 'single-field',
    name: 'single field (title + body + tags as one text)',
    options: { fields: ['text'] },
    toDocument: (entry) => ({
      id: entry.id,
      text: [entry.title, entry.body, ...entry.tags].join('\n'),
    }),
  },
  {
    id: 'toy-hybrid',
    name: 'hybrid: default BM25F + toy trigram vectors, RRF',
    options: { fields: DEFAULT_FIELDS, vectorField: 'vector' },
    toDocument: (entry) => ({
      ...entry,
      vector: trigramVector([entry.title, entry.body, ...entry.tags].join('\n')),
    }),
    hybrid: true,
  },
];

const wordAnalyzer = new Analyzer({ stemming: false });

/**
 * A deliberately crude stand-in for an embedding model, so the hybrid path can run without
 * downloading one: the character trigrams of each non-stopword, hashed into 256 buckets
 * (feature hashing with FNV-1a). It captures spelling overlap, not meaning.
 */
function trigramVector(text: string, dimensions = 256): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  for (const { term } of wordAnalyzer.analyze(text)) {
    const chars = Array.from(`#${term}#`);
    for (let i = 0; i + 3 <= chars.length; i++) {
      const bucket = fnv1a(chars.slice(i, i + 3).join('')) % dimensions;
      vector[bucket] = (vector[bucket] ?? 0) + 1;
    }
  }
  return vector;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function retrieveConfiguration(id: string): Record<string, { id: string; score: number }[]> {
  const configuration = CONFIGURATIONS.find((entry) => entry.id === id);
  if (!configuration) {
    throw new SearchliteError('INVALID_ARGUMENT', 'Unknown retrieval configuration');
  }
  const index = new SearchIndex(configuration.options);
  index.addAll(GLOSSARY.map(configuration.toDocument ?? ((entry) => entry)));
  const run: Record<string, { id: string; score: number }[]> = {};
  for (const query of QUERIES) {
    const results = configuration.hybrid
      ? index.searchHybrid({ query: query.text, vector: trigramVector(query.text), k: DEPTH })
      : index.search(query.text, { limit: DEPTH });
    run[query.id] = results.map(({ id: documentId, score }) => ({ id: documentId, score }));
  }
  return run;
}

export function runConfiguration(id: string): Run {
  return Object.fromEntries(
    Object.entries(retrieveConfiguration(id)).map(([queryId, results]) => [
      queryId,
      results.map((result) => result.id),
    ]),
  );
}
