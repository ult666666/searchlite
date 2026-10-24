// Loads the built package through its `exports` map, the way a consumer would, in both module
// formats, and runs a search with each. Run after `npm run build`.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as esm from 'searchlite';

const cjs = createRequire(import.meta.url)('searchlite');

for (const [format, library] of [
  ['ESM', esm],
  ['CJS', cjs],
]) {
  const index = new library.SearchIndex({ fields: ['body'] });
  index.add({ id: 'heap', body: 'Binary heaps implement priority queues.' });
  assert.equal(index.search('heap')[0]?.id, 'heap', `${format} build returned the wrong result`);
}
console.log('dist OK: the ESM and CJS builds load through package.json "exports" and search');
