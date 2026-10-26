// Internal single-process worker. The parent supplies only its bounded generated workload.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { SearchIndex } from 'searchlite';

try {
  const data = readFileSync(0);
  if (data.length > 8 * 1024 * 1024) throw new Error('Workload limit');
  const workload = JSON.parse(data.toString('utf8'));
  if (
    workload.protocol !== 'searchlite.benchmark-workload/1' ||
    workload.documents.length > 10_000 ||
    workload.queries.length !== 26 ||
    workload.measurementCycles < 1 ||
    workload.measurementCycles > 8 ||
    workload.warmupCycles < 0 ||
    workload.warmupCycles > 8 ||
    workload.limit !== 10
  )
    throw new Error('Workload contract');
  const beforeIndex = process.memoryUsage();
  const started = performance.now();
  const index = new SearchIndex(workload.options);
  index.addAll(workload.documents);
  const buildMs = performance.now() - started;
  const afterIndex = process.memoryUsage();
  let checksum = 0;
  for (let cycle = 0; cycle < workload.warmupCycles; cycle++) {
    for (const query of workload.queries)
      checksum += index.search(query.text, { limit: 10 }).length;
  }
  const samples = [];
  for (let cycle = 0; cycle < workload.measurementCycles; cycle++) {
    for (const query of workload.queries) {
      const start = performance.now();
      const results = index.search(query.text, { limit: 10 });
      const searchMs = performance.now() - start;
      checksum += results.length;
      samples.push({ queryId: query.id, searchMs, resultCount: results.length });
    }
  }
  const require = createRequire(import.meta.url);
  process.stdout.write(
    JSON.stringify({
      processId: process.pid,
      packageVersion: require('searchlite/package.json').version,
      documentCount: index.size,
      workloadSha256: createHash('sha256').update(data).digest('hex'),
      buildMs,
      beforeIndex,
      afterIndex,
      samples,
      checksum,
    }) + '\n',
  );
} catch {
  console.error('Internal benchmark worker could not complete the fixed workload.');
  process.exitCode = 1;
}
