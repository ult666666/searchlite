import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, release, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { GLOSSARY } from '../corpus/glossary';
import { makeWorkload, summarize } from '../examples/benchmark';

interface Trial {
  processId: number;
  packageVersion: string;
  documentCount: number;
  workloadSha256: string;
  buildMs: number;
  beforeIndex: NodeJS.MemoryUsage;
  afterIndex: NodeJS.MemoryUsage;
  samples: { queryId: string; searchMs: number; resultCount: number }[];
  checksum: number;
}
const args = process.argv.slice(2);
const USAGE = 'Usage: npm run --silent bench -- [--smoke] (build package first); standalone --help';
if (args.length === 1 && args[0] === '--help') console.log(USAGE);
else if (args.length > 1 || (args.length === 1 && args[0] !== '--smoke')) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    const smoke = args[0] === '--smoke';
    const profile = smoke
      ? { id: 'smoke', documentCounts: [60, 120], trials: 1, warmupCycles: 1, measurementCycles: 1 }
      : {
          id: 'default',
          documentCounts: [1000, 10000],
          trials: 3,
          warmupCycles: 2,
          measurementCycles: 4,
        };
    const sizes = [];
    for (const count of profile.documentCounts) {
      const workload = makeWorkload(count, profile.warmupCycles, profile.measurementCycles);
      const input = JSON.stringify(workload);
      if (Buffer.byteLength(input) > 8 * 1024 * 1024) throw new Error('Workload bound');
      const hash = createHash('sha256').update(input).digest('hex');
      const trials: Trial[] = [];
      for (let i = 0; i < profile.trials; i++) {
        const child = spawnSync(
          process.execPath,
          [fileURLToPath(new URL('./bench-worker.js', import.meta.url))],
          {
            input,
            encoding: 'utf8',
            timeout: 30_000,
            killSignal: 'SIGKILL',
            maxBuffer: 2 * 1024 * 1024,
          },
        );
        if (child.error || child.status !== 0) throw new Error('Worker failed');
        const trial = JSON.parse(child.stdout) as Trial;
        if (
          trial.documentCount !== count ||
          trial.workloadSha256 !== hash ||
          trial.processId === process.pid ||
          !Number.isInteger(trial.processId) ||
          trial.processId < 1 ||
          !Number.isFinite(trial.buildMs) ||
          trial.buildMs < 0 ||
          trial.samples.length !== 26 * profile.measurementCycles ||
          trial.samples.some(
            (sample, j) =>
              sample.queryId !== workload.queries[j % 26]?.id ||
              !Number.isFinite(sample.searchMs) ||
              sample.searchMs < 0 ||
              !Number.isInteger(sample.resultCount) ||
              sample.resultCount < 0 ||
              sample.resultCount > 10,
          )
        )
          throw new Error('Worker report mismatch');
        trials.push(trial);
      }
      sizes.push({
        documentCount: count,
        trials,
        buildMedianMs: summarize(trials.map((t) => t.buildMs)).p50Ms,
        latency: summarize(trials.flatMap((t) => t.samples.map((s) => s.searchMs))),
      });
    }
    const cpu = cpus();
    const report = {
      schema: 'searchlite.microbenchmark/1',
      recordedAtUtc: new Date().toISOString(),
      profile,
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
      fixtureSha256: createHash('sha256').update(JSON.stringify(GLOSSARY)).digest('hex'),
      method: {
        documentGeneration:
          'round-robin copies of 60 glossary entries, unique ordinal-prefixed IDs, repeated vocabulary',
        queries: makeWorkload(1, 1, 1).queries,
        resultLimit: 10,
        searchTiming:
          'public search(text) including parsing/analysis/planning/execution/results; setup/startup/generation/warmup excluded',
        percentiles: 'nearest rank ceil(p*N)-1 over pooled measured searches at each size',
        memory:
          'whole worker process before/after index construction, bytes; not isolated index size or peak',
      },
      sizes,
      limits: [
        'Synthetic repeated vocabulary and a uniform query mix are not representative production traffic or a service SLA.',
        'Finite warmup, JIT/GC, OS scheduling and other desktop activity affect these measurements; no CPU pinning or forced GC.',
        'Pooled query timings are not independent population samples or a confidence interval; compare raw queries/trials on the same setup.',
        'Memory snapshots include runtime, input and index and may reflect GC; no isolated allocation or peak-memory claim.',
      ],
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } catch {
    console.error(
      'Benchmark failed. Build the package first; fixed worker work is bounded to 30 seconds per trial.',
    );
    process.exitCode = 1;
  }
}
