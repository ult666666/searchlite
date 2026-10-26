// Internal worker: the parent supplies a fixed bounded workload and a trusted bundled ESM path.
import { readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
try {
  const input = readFileSync(0);
  if (input.length > 8 * 1024 * 1024 || process.argv.length !== 3) throw new Error('Input bound');
  const workload = JSON.parse(input.toString('utf8'));
  if (
    workload.protocol !== 'searchlite.filtering-workload/1' ||
    !Array.isArray(workload.documents) ||
    workload.documents.length < 1 ||
    workload.documents.length > 10000 ||
    workload.queries.length !== 8 ||
    !Number.isInteger(workload.warmupCycles) ||
    workload.warmupCycles < 0 ||
    workload.warmupCycles > 8 ||
    !Number.isInteger(workload.measurementCycles) ||
    workload.measurementCycles < 1 ||
    workload.measurementCycles > 8 ||
    workload.limit !== 10
  )
    throw new Error('Workload contract');
  const module = process.argv[2];
  if (!statSync(module).isFile() || statSync(module).size > 2 * 1024 * 1024)
    throw new Error('Module bound');
  const moduleSha256 = hash(readFileSync(module));
  const { SearchIndex } = await import(pathToFileURL(module).href);
  const started = performance.now();
  const index = new SearchIndex(workload.options);
  index.addAll(workload.documents);
  const buildMs = performance.now() - started;
  for (let cycle = 0; cycle < workload.warmupCycles; cycle++)
    for (const query of workload.queries) index.search(query.text, { limit: 10 });
  const samples = [];
  for (let cycle = 0; cycle < workload.measurementCycles; cycle++)
    for (const query of workload.queries) {
      const start = performance.now();
      const results = index.search(query.text, { limit: 10 });
      const searchMs = performance.now() - start;
      samples.push({
        queryId: query.id,
        searchMs,
        resultCount: results.length,
        sha256: hash(JSON.stringify(results)),
      });
    }
  // Full ranking verification is deliberately after timed calls, outside their samples.
  const rankings = workload.queries.map((query) => {
    const results = index.search(query.text, { limit: Infinity });
    return {
      queryId: query.id,
      resultCount: results.length,
      sha256: hash(JSON.stringify(results)),
    };
  });
  if (hash(readFileSync(module)) !== moduleSha256) throw new Error('Module changed');
  process.stdout.write(
    JSON.stringify({
      processId: process.pid,
      documentCount: index.size,
      moduleSha256,
      workloadSha256: hash(input),
      buildMs,
      samples,
      rankings,
    }) + '\n',
  );
} catch {
  console.error('Internal filtering worker could not complete the fixed workload.');
  process.exitCode = 1;
}
