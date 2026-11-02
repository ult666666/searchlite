// Paired measurement of two trusted builds (for example main and a candidate) on the glossary
// scale workload and a Zipf workload: top-10 latency, index memory, postings memory, snapshot
// size and exact ranking parity. Writes JSON to stdout only when every check passes.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeWorkload, makeZipfWorkload, summarize } from '../examples/benchmark';

interface Sample {
  queryId: string;
  searchMs: number;
  resultCount: number;
  sha256: string;
}
interface Trial {
  processId: number;
  documentCount: number;
  moduleSha256: string;
  workloadSha256: string;
  buildMs: number;
  indexBytes: number;
  snapshotBytes: number;
  postingsBytes: number | null;
  samples: Sample[];
  rankings: { queryId: string; resultCount: number; sha256: string }[];
}
type Label = 'baseline' | 'candidate';

const USAGE =
  'Usage: npm run --silent bench:pruning -- --baseline=/absolute/index.js --candidate=/absolute/index.js [--smoke]; standalone --help';
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const refuse = (code: string): never => {
  throw Object.assign(new Error('Pruning benchmark refused'), { code });
};

function moduleInfo(file: string) {
  if (!isAbsolute(file) || !statSync(file).isFile()) refuse('INVALID_MODULE');
  const bytes = readFileSync(file);
  if (bytes.length < 1 || bytes.length > 2 * 1024 * 1024) refuse('INVALID_MODULE');
  return { bytes: bytes.length, sha256: hash(bytes) };
}

export function runPruningBenchmark(paths: Record<Label, string>, smoke: boolean) {
  const modules = { baseline: moduleInfo(paths.baseline), candidate: moduleInfo(paths.candidate) };
  // Long warmup: this harness measures steady-state latency (`npm run bench` measures a cold
  // process with the repository's original two warmup cycles).
  const profile = smoke
    ? { id: 'smoke', documentCounts: [120], trials: 1, warmupCycles: 1, measurementCycles: 1 }
    : {
        id: 'default',
        documentCounts: [1000, 10000],
        trials: 3,
        warmupCycles: 20,
        measurementCycles: 10,
      };
  const generators = { glossary: makeWorkload, zipf: makeZipfWorkload };
  const workloads = [];
  for (const [name, generate] of Object.entries(generators)) {
    for (const documentCount of profile.documentCounts) {
      const workload = {
        ...generate(documentCount, 1, 1),
        warmupCycles: profile.warmupCycles,
        measurementCycles: profile.measurementCycles,
      };
      const trials: (Trial & { module: Label; ordinal: number })[] = [];
      for (let ordinal = 0; ordinal < profile.trials; ordinal++) {
        // Alternate the order; only the first trial per module takes a heap snapshot.
        const order: Label[] = ordinal % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate'];
        for (const label of order) {
          const input = JSON.stringify({ ...workload, heapSnapshot: ordinal === 0 });
          if (Buffer.byteLength(input) > 8 * 1024 * 1024) refuse('WORKLOAD_LIMIT');
          const child = spawnSync(
            process.execPath,
            [
              '--expose-gc',
              '--max-old-space-size=2048',
              fileURLToPath(new URL('./bench-pruning-worker.js', import.meta.url)),
              paths[label],
            ],
            {
              input,
              encoding: 'utf8',
              timeout: 120_000,
              killSignal: 'SIGKILL',
              maxBuffer: 4 << 20,
            },
          );
          if (child.error || child.status !== 0) refuse('WORKER_FAILED');
          const trial = JSON.parse(child.stdout) as Trial;
          if (
            trial.documentCount !== documentCount ||
            trial.workloadSha256 !== hash(input) ||
            trial.moduleSha256 !== modules[label].sha256 ||
            trial.samples.length !== workload.queries.length * profile.measurementCycles ||
            trial.rankings.length !== workload.queries.length ||
            !(ordinal === 0 ? Number.isInteger(trial.postingsBytes) : trial.postingsBytes === null)
          )
            refuse('WORKER_FAILED');
          trials.push({ ...trial, module: label, ordinal });
        }
      }
      // Every trial of both builds must return byte-identical top-10 and complete rankings.
      const reference = trials[0];
      for (const trial of trials) {
        if (JSON.stringify(trial.rankings) !== JSON.stringify(reference?.rankings))
          refuse('RANKING_MISMATCH');
        trial.samples.forEach((sample, i) => {
          if (sample.sha256 !== reference?.samples[i % workload.queries.length]?.sha256)
            refuse('RANKING_MISMATCH');
        });
      }
      const of = (label: Label) => trials.filter((trial) => trial.module === label);
      const latency = (label: Label, queryId?: string) =>
        summarize(
          of(label).flatMap((trial) =>
            trial.samples
              .filter((s) => queryId === undefined || s.queryId === queryId)
              .map((s) => s.searchMs),
          ),
        );
      const memory = (label: Label) => {
        const first = of(label).find((trial) => trial.ordinal === 0);
        return {
          buildMedianMs: summarize(of(label).map((trial) => trial.buildMs)).p50Ms,
          indexBytesMedian: summarize(of(label).map((trial) => Math.max(0, trial.indexBytes)))
            .p50Ms,
          postingsBytes: first?.postingsBytes ?? null,
          snapshotBytes: first?.snapshotBytes ?? null,
        };
      };
      workloads.push({
        workload: name,
        documentCount,
        queries: workload.queries.map((query) => {
          const baseline = latency('baseline', query.id);
          const candidate = latency('candidate', query.id);
          return { ...query, baseline, candidate, meanSpeedup: baseline.meanMs / candidate.meanMs };
        }),
        allQueries: {
          baseline: latency('baseline'),
          candidate: latency('candidate'),
          meanSpeedup: latency('baseline').meanMs / latency('candidate').meanMs,
        },
        baseline: memory('baseline'),
        candidate: memory('candidate'),
        trials,
      });
    }
  }
  for (const label of ['baseline', 'candidate'] as const)
    if (JSON.stringify(moduleInfo(paths[label])) !== JSON.stringify(modules[label]))
      refuse('MODULE_CHANGED');
  const cpu = cpus();
  return {
    schema: 'searchlite.pruning-benchmark/1',
    recordedAtUtc: new Date().toISOString(),
    machine: {
      platform: process.platform,
      release: release(),
      architecture: process.arch,
      cpuModel: cpu[0]?.model ?? 'unavailable',
      logicalCpus: cpu.length,
      totalMemoryBytes: totalmem(),
      node: process.version,
      v8: process.versions.v8,
    },
    modules,
    profile,
    exactRankingParity: true,
    method: {
      searchTiming:
        'public search(text, { limit: 10 }) per call, after warmup; parsing, planning and results included',
      indexBytes:
        'heapUsed + arrayBuffers after two forced GCs, after minus before building; median of trials',
      postingsBytes:
        'V8 heap snapshot: summed self sizes of objects reachable from the GC roots only through FieldIndex.postings',
      snapshotBytes: 'UTF-8 bytes of JSON.stringify(index)',
    },
    workloads,
    limits: [
      'Synthetic workloads: repeated glossary entries and Zipf-distributed labels, not production text or traffic.',
      'One machine; scheduling, JIT and GC affect timings, and no CPU pinning or retries are used.',
      'Heap figures are V8 measurements of this process and depend on the Node.js version.',
    ],
  };
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') console.log(USAGE);
else {
  let baseline: string | undefined;
  let candidate: string | undefined;
  let smoke = false;
  let valid = true;
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
      console.log(JSON.stringify(runPruningBenchmark({ baseline, candidate }, smoke), null, 2));
    } catch {
      console.error(
        'Pruning benchmark failed; no report is available. Check the built modules and parity.',
      );
      process.exitCode = 1;
    }
  }
}
