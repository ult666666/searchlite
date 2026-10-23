/**
 * Runs the glossary queries against several index configurations and prints an ablation table.
 *
 *   npm run eval
 *
 * The collection is tiny and the judgements were made by the author, so the numbers show how
 * the evaluation harness works; they are not evidence that one configuration is better in
 * general. The configurations were chosen up front and not tuned on these queries.
 */
import { GLOSSARY, type GlossaryEntry } from '../corpus/glossary';
import { QUERIES } from '../corpus/queries';
import {
  Analyzer,
  SearchIndex,
  evaluate,
  type IndexOptions,
  type Qrels,
  type Run,
  type SearchDocument,
} from '../src/index';

/** How many results each query retrieves; MRR and MAP are computed over this depth. */
const DEPTH = 100;

interface Configuration {
  name: string;
  options: IndexOptions;
  toDocument?: (entry: GlossaryEntry) => SearchDocument;
  hybrid?: boolean;
}

const DEFAULT_FIELDS = { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } };

const CONFIGURATIONS: Configuration[] = [
  {
    name: 'BM25F, default analysis, boosts title 3 / tags 2 / body 1',
    options: { fields: DEFAULT_FIELDS },
  },
  {
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
    name: 'no field boosts (all weights 1)',
    options: { fields: { title: {}, body: {}, tags: { stemming: false } } },
  },
  {
    name: 'single field (title + body + tags as one text)',
    options: { fields: ['text'] },
    toDocument: (entry) => ({
      id: entry.id,
      text: [entry.title, entry.body, ...entry.tags].join('\n'),
    }),
  },
  {
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

function runConfiguration(configuration: Configuration): Run {
  const index = new SearchIndex(configuration.options);
  index.addAll(GLOSSARY.map(configuration.toDocument ?? ((entry) => entry)));
  const run: Record<string, string[]> = {};
  for (const query of QUERIES) {
    const results = configuration.hybrid
      ? index.searchHybrid({ query: query.text, vector: trigramVector(query.text), k: DEPTH })
      : index.search(query.text, { limit: DEPTH });
    run[query.id] = results.map((result) => result.id);
  }
  return run;
}

const qrels: Qrels = Object.fromEntries(QUERIES.map((query) => [query.id, query.judgements]));
const judgementCount = QUERIES.reduce(
  (sum, query) => sum + Object.keys(query.judgements).length,
  0,
);
const format = (value: number): string => value.toFixed(3);

console.log(
  `Corpus: ${GLOSSARY.length} documents, ${QUERIES.length} queries, ${judgementCount} graded judgements (1-3) by the author.`,
);
console.log(`P@5, R@10 and nDCG@10 use those cutoffs; MRR and MAP use the top ${DEPTH} results.\n`);
console.log('| Configuration | P@5 | R@10 | MRR | MAP | nDCG@10 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const configuration of CONFIGURATIONS) {
  const run = runConfiguration(configuration);
  const at5 = evaluate(run, qrels, { k: 5 }).mean;
  const at10 = evaluate(run, qrels, { k: 10 }).mean;
  const cells = [at5.precision, at10.recall, at10.reciprocalRank, at10.averagePrecision, at10.ndcg];
  console.log(`| ${configuration.name} | ${cells.map(format).join(' | ')} |`);
}
