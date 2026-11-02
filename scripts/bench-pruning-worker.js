// Internal worker for bench-pruning.ts: one trusted built module, one bounded workload on stdin.
// Run with --expose-gc. Reports index memory, postings memory from a V8 heap snapshot, snapshot
// size, raw search timings and ranking digests; the parent checks parity between builds.
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import v8 from 'node:v8';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const gc = globalThis.gc;

function heapBytes() {
  gc();
  gc();
  const usage = process.memoryUsage();
  return usage.heapUsed + usage.arrayBuffers;
}

/**
 * Bytes retained by every FieldIndex's `postings` (and, where present, the `arena` holding their
 * bytes): the summed self sizes of the heap objects, typed-array backing stores included, that
 * the GC roots reach only through those properties. Two reachability passes over the snapshot
 * graph, one with those edges cut.
 */
async function snapshotText() {
  let text = '';
  for await (const chunk of v8.getHeapSnapshot()) text += chunk;
  return text;
}

async function postingsBytes() {
  const { snapshot, nodes, edges, strings } = JSON.parse(await snapshotText());
  const { node_fields: nodeFields, edge_fields: edgeFields, edge_types: edgeTypes } = snapshot.meta;
  const nf = nodeFields.length;
  const ef = edgeFields.length;
  const [nameAt, selfAt, edgeCountAt] = ['name', 'self_size', 'edge_count'].map((f) =>
    nodeFields.indexOf(f),
  );
  const [typeAt, edgeNameAt, toAt] = ['type', 'name_or_index', 'to_node'].map((f) =>
    edgeFields.indexOf(f),
  );
  const weak = edgeTypes[0].indexOf('weak');
  const property = edgeTypes[0].indexOf('property');
  const count = nodes.length / nf;
  const firstEdge = new Float64Array(count + 1);
  for (let n = 0; n < count; n++)
    firstEdge[n + 1] = firstEdge[n] + nodes[n * nf + edgeCountAt] * ef;
  const cut = new Set();
  for (let n = 0; n < count; n++) {
    if (strings[nodes[n * nf + nameAt]] !== 'FieldIndex') continue;
    for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += ef) {
      const name = strings[edges[e + edgeNameAt]];
      if (edges[e + typeAt] === property && (name === 'postings' || name === 'arena')) cut.add(e);
    }
  }
  if (cut.size === 0) throw new Error('No FieldIndex postings found in the heap snapshot');
  const reach = (skip) => {
    const seen = new Uint8Array(count);
    const stack = [0];
    seen[0] = 1;
    while (stack.length > 0) {
      const n = stack.pop();
      for (let e = firstEdge[n]; e < firstEdge[n + 1]; e += ef) {
        if (edges[e + typeAt] === weak || (skip && cut.has(e))) continue;
        const to = edges[e + toAt] / nf;
        if (!seen[to]) {
          seen[to] = 1;
          stack.push(to);
        }
      }
    }
    return seen;
  };
  const all = reach(false);
  const without = reach(true);
  let bytes = 0;
  for (let n = 0; n < count; n++) if (all[n] && !without[n]) bytes += nodes[n * nf + selfAt];
  return { bytes, fieldIndexes: cut.size };
}

try {
  const input = readFileSync(0);
  if (input.length > 8 * 1024 * 1024 || process.argv.length !== 3 || typeof gc !== 'function')
    throw new Error('Input bound');
  const workload = JSON.parse(input.toString('utf8'));
  if (
    workload.protocol !== 'searchlite.benchmark-workload/1' ||
    !Array.isArray(workload.documents) ||
    workload.documents.length < 1 ||
    workload.documents.length > 10000 ||
    !Array.isArray(workload.queries) ||
    workload.queries.length < 1 ||
    workload.queries.length > 32 ||
    workload.limit !== 10
  )
    throw new Error('Workload contract');
  const module = process.argv[2];
  if (!statSync(module).isFile() || statSync(module).size > 2 * 1024 * 1024)
    throw new Error('Module bound');
  const moduleSha256 = hash(readFileSync(module));
  const { SearchIndex } = await import(pathToFileURL(module).href);
  const before = heapBytes();
  const started = performance.now();
  const index = new SearchIndex(workload.options);
  index.addAll(workload.documents);
  const buildMs = performance.now() - started;
  const indexBytes = heapBytes() - before;
  const snapshotBytes = Buffer.byteLength(JSON.stringify(index));
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
  // Complete rankings are compared after the timed calls, outside their samples.
  const rankings = workload.queries.map((query) => {
    const results = index.search(query.text, { limit: Infinity });
    return {
      queryId: query.id,
      resultCount: results.length,
      sha256: hash(JSON.stringify(results)),
    };
  });
  // The heap snapshot comes last: parsing it leaves garbage that would distort later timings.
  const postings = workload.heapSnapshot ? await postingsBytes() : undefined;
  if (hash(readFileSync(module)) !== moduleSha256) throw new Error('Module changed');
  process.stdout.write(
    JSON.stringify({
      processId: process.pid,
      documentCount: index.size,
      moduleSha256,
      workloadSha256: hash(input),
      buildMs,
      indexBytes,
      snapshotBytes,
      postingsBytes: postings?.bytes ?? null,
      samples,
      rankings,
    }) + '\n',
  );
} catch {
  console.error('Internal pruning worker could not complete the fixed workload.');
  process.exitCode = 1;
}
