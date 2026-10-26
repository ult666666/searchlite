import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { cpus, arch, platform, release, totalmem } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFilteringWorkload } from '../examples/filtering-workload.js';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (code) => {
  throw Object.assign(new Error('Filtering benchmark refused'), { code });
};
const hexadecimal = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
function moduleInfo(file) {
  if (typeof file !== 'string' || !isAbsolute(file)) fail('INVALID_MODULE');
  const stat = statSync(file);
  if (!stat.isFile() || stat.size < 1 || stat.size > 2 * 1024 * 1024) fail('INVALID_MODULE');
  const bytes = readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024) fail('INVALID_MODULE');
  return { bytes: bytes.length, sha256: hash(bytes) };
}
function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length || !sorted.every(nonnegative)) fail('INVALID_SAMPLES');
  return {
    count: sorted.length,
    minMs: sorted[0],
    meanMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    maxMs: sorted.at(-1),
  };
}
export function runFilteringBenchmark({
  baseline,
  candidate,
  smoke = false,
  workerTimeoutMs = 30000,
}) {
  if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1 || workerTimeoutMs > 30000)
    fail('INVALID_DEADLINE');
  const paths = { baseline, candidate };
  const modules = { baseline: moduleInfo(baseline), candidate: moduleInfo(candidate) };
  const profile = smoke
    ? {
        id: 'smoke',
        documentCounts: [120],
        trials: 1,
        warmupCycles: 1,
        measurementCycles: 1,
        limit: 10,
      }
    : {
        id: 'default',
        documentCounts: [1000, 10000],
        trials: 3,
        warmupCycles: 2,
        measurementCycles: 4,
        limit: 10,
      };
  const sizes = [];
  for (const documentCount of profile.documentCounts) {
    const workload = makeFilteringWorkload(
      documentCount,
      profile.warmupCycles,
      profile.measurementCycles,
    );
    const input = JSON.stringify(workload),
      workloadSha256 = hash(input);
    if (Buffer.byteLength(input) > 8 * 1024 * 1024) fail('WORKLOAD_LIMIT');
    const trials = [];
    for (let ordinal = 0; ordinal < profile.trials; ordinal++) {
      // Alternate execution order; all workers remain serial and all trials are retained.
      for (const label of ordinal % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('./bench-filtering-worker.js', import.meta.url)), paths[label]],
          {
            input,
            encoding: 'utf8',
            timeout: workerTimeoutMs,
            killSignal: 'SIGKILL',
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        if (child.error?.code === 'ETIMEDOUT') fail('WORKER_DEADLINE');
        if (child.error?.code === 'ENOBUFS') fail('WORKER_OUTPUT_LIMIT');
        if (child.error || child.status !== 0) fail('WORKER_FAILED');
        let trial;
        try {
          trial = JSON.parse(child.stdout);
        } catch {
          fail('WORKER_FAILED');
        }
        if (
          !trial ||
          trial.documentCount !== documentCount ||
          trial.workloadSha256 !== workloadSha256 ||
          trial.moduleSha256 !== modules[label].sha256 ||
          !Number.isInteger(trial.processId) ||
          trial.processId < 1 ||
          trial.processId === process.pid ||
          !nonnegative(trial.buildMs) ||
          !Array.isArray(trial.samples) ||
          trial.samples.length !== 8 * profile.measurementCycles ||
          !Array.isArray(trial.rankings) ||
          trial.rankings.length !== 8 ||
          trial.samples.some(
            (s, i) =>
              s.queryId !== workload.queries[i % 8].id ||
              !nonnegative(s.searchMs) ||
              !Number.isInteger(s.resultCount) ||
              s.resultCount < 0 ||
              s.resultCount > 10 ||
              !hexadecimal(s.sha256),
          ) ||
          trial.rankings.some(
            (r, i) =>
              r.queryId !== workload.queries[i].id ||
              !Number.isInteger(r.resultCount) ||
              r.resultCount < 0 ||
              r.resultCount > documentCount ||
              !hexadecimal(r.sha256),
          )
        )
          fail('WORKER_FAILED');
        trials.push({
          module: label,
          ordinal,
          processId: trial.processId,
          documentCount,
          moduleSha256: trial.moduleSha256,
          workloadSha256,
          buildMs: trial.buildMs,
          samples: trial.samples,
          rankings: trial.rankings,
        });
      }
    }
    const reference = trials[0];
    for (const trial of trials) {
      if (JSON.stringify(trial.rankings) !== JSON.stringify(reference.rankings))
        fail('RANKING_MISMATCH');
      for (const [i, sample] of trial.samples.entries()) {
        const expected = reference.samples[i % 8];
        if (sample.sha256 !== expected.sha256 || sample.resultCount !== expected.resultCount)
          fail('RANKING_MISMATCH');
      }
    }
    const queries = workload.queries.map((query) => ({
      ...query,
      baseline: summarize(
        trials
          .filter((t) => t.module === 'baseline')
          .flatMap((t) => t.samples.filter((s) => s.queryId === query.id).map((s) => s.searchMs)),
      ),
      candidate: summarize(
        trials
          .filter((t) => t.module === 'candidate')
          .flatMap((t) => t.samples.filter((s) => s.queryId === query.id).map((s) => s.searchMs)),
      ),
    }));
    sizes.push({ documentCount, workloadSha256, trials, queries });
  }
  for (const label of ['baseline', 'candidate'])
    if (JSON.stringify(moduleInfo(paths[label])) !== JSON.stringify(modules[label]))
      fail('MODULE_CHANGED');
  return {
    schema: 'searchlite.filtering-benchmark/1',
    observedAt: new Date().toISOString(),
    machine: {
      node: process.version,
      v8: process.versions.v8,
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model ?? 'unknown',
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    modules,
    profile,
    exactRankingParity: true,
    sizes,
    limits: [
      'Fixed synthetic skew; not production traffic, model quality or a general speed guarantee.',
      'Search samples include public parse/plan/execute/result construction; result hashing, full rankings, build, startup and warmup are outside search timing.',
      'Whole ranking digests cover IDs, exact scores, fields and matches; shared API consistency is not independent formula certification.',
      'No CPU pinning, forced GC, retries, best-run selection or latency gate. Scheduling/JIT/GC affect timings.',
      'Only explicitly selected trusted bundled ESM code may be used; modules execute with ordinary Node permissions.',
      'Module hashes are observed reproducibility checks, not source authenticity or protection against a hostile operating-system owner.',
    ],
  };
}
const USAGE =
  'Usage: node scripts/bench-filtering.js --baseline=/absolute/trusted/index.js --candidate=/absolute/trusted/index.js [--smoke]; standalone --help';
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(USAGE);
  else {
    let baseline,
      candidate,
      smoke = false,
      valid = true;
    for (const arg of args) {
      if (arg === '--smoke' && !smoke) smoke = true;
      else if (arg.startsWith('--baseline=') && baseline === undefined) baseline = arg.slice(11);
      else if (arg.startsWith('--candidate=') && candidate === undefined) candidate = arg.slice(12);
      else valid = false;
    }
    if (!valid || !baseline || !candidate || !isAbsolute(baseline) || !isAbsolute(candidate)) {
      console.error(USAGE);
      process.exitCode = 2;
    } else {
      try {
        console.log(JSON.stringify(runFilteringBenchmark({ baseline, candidate, smoke }), null, 2));
      } catch {
        console.error(
          'Filtering benchmark failed; no comparison report is available. Check trusted built modules and worker/parity bounds.',
        );
        process.exitCode = 1;
      }
    }
  }
}
