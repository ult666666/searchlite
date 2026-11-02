// Writes test/fixtures/snapshot-v1.json: a version 1 snapshot and the exact search results that
// the build which wrote it returned. Run it against a build that still writes version 1 (0.2.0):
//   npx tsx scripts/snapshot-v1-fixture.ts --module=/absolute/path/to/0.2.0/dist/index.js
// The migration test reads the snapshot with the current build and expects the same results.
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { GLOSSARY } from '../corpus/glossary';

const QUERY_TEXTS = [
  'binary',
  'binary heap',
  'hash OR tree',
  '"binary search"',
  'title:hash*',
  'memori~1',
  'data AND structure',
  'tree -binary',
  '(lock OR tree) AND NOT heap',
  'tags:data-structures',
  'test OR time OR data',
  'queue priority heap',
  'lock* OR "race condition" -deadlock',
  'the OF and',
];

interface Result {
  id: string;
  score: number;
  terms: string[];
  match: Record<string, string[]>;
}
interface Index {
  addAll(documents: object[]): void;
  remove(id: string): boolean;
  replace(document: object): void;
  search(query: string, options?: { limit?: number }): Result[];
  toJSON(): { version: number };
}

const [flag, ...rest] = process.argv.slice(2);
const modulePath = flag?.startsWith('--module=') ? flag.slice('--module='.length) : '';
if (rest.length > 0 || !isAbsolute(modulePath)) {
  console.error('Usage: npx tsx scripts/snapshot-v1-fixture.ts --module=/absolute/dist/index.js');
  process.exitCode = 2;
} else {
  const { SearchIndex } = (await import(pathToFileURL(modulePath).href)) as {
    SearchIndex: new (options: object) => Index;
  };
  const index = new SearchIndex({
    fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } },
  });
  index.addAll(GLOSSARY.slice(0, 10));
  // A removal and a replacement leave gaps in the internal document numbers.
  index.remove(GLOSSARY[3]?.id ?? '');
  index.replace({
    id: GLOSSARY[5]?.id,
    title: 'Replaced entry about binary trees',
    body: 'A replacement document that mentions a binary tree, a hash and a priority queue.',
    tags: ['replaced', 'data-structures'],
  });
  index.addAll(GLOSSARY.slice(10, 12));
  const snapshot = index.toJSON();
  if (snapshot.version !== 1) throw new Error('This build does not write version 1 snapshots');
  const fixture = {
    description:
      'A version 1 snapshot written by searchlite 0.2.0 and the results that build returned for each query (limit Infinity).',
    command:
      'npx tsx scripts/snapshot-v1-fixture.ts --module=/absolute/path/to/0.2.0/dist/index.js',
    queries: QUERY_TEXTS.map((text) => ({
      text,
      results: index.search(text, { limit: Infinity }),
    })),
    snapshot,
  };
  process.stdout.write(JSON.stringify(fixture) + '\n');
}
