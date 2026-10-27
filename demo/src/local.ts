import './style.css';
import './relevance.css';
import './local.css';
import LocalWorker from './local-worker?worker&inline';
import type {
  LocalComparedQuery,
  LocalComparison,
  LocalMetrics,
} from '../../examples/local-review-core.js';
import type { LocalReply, LocalRequest } from './local-types';

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const node = document.querySelector(selector);
  if (!(node instanceof type)) throw new Error(`Missing local workbench element ${selector}`);
  return node;
}
const slots = ['baseline', 'candidate', 'judgments'] as const;
type Slot = (typeof slots)[number];
const files: Record<Slot, File | undefined> = {
  baseline: undefined,
  candidate: undefined,
  judgments: undefined,
};
const controls = Object.fromEntries(
  slots.map((slot) => [slot, element(`#${slot}-file`, HTMLInputElement)]),
) as Record<Slot, HTMLInputElement>;
const status = element('#local-status', HTMLParagraphElement),
  results = element('#results', HTMLElement);
const compare = element('#compare-local', HTMLButtonElement),
  example = element('#load-example', HTMLButtonElement),
  choice = element('#example-control', HTMLSelectElement);
const samples = element('#sample-downloads', HTMLParagraphElement);
let generation = 0,
  worker: Worker | undefined,
  deadline: ReturnType<typeof setTimeout> | undefined,
  busy = false;
let reportUrl: string | undefined;
const sampleUrls: string[] = [];
function literal(value: string): string {
  return value.replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (c) => `\\u{${c.codePointAt(0)?.toString(16).padStart(4, '0')}}`,
  );
}
function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = literal(text);
  return result;
}
function update(): void {
  compare.disabled = busy || !slots.every((slot) => files[slot]);
  for (const slot of slots)
    element(`#${slot}-selection`, HTMLSpanElement).textContent = files[slot]
      ? literal(files[slot].name.slice(0, 256))
      : 'None selected.';
}
function stop(): void {
  if (deadline !== undefined) clearTimeout(deadline);
  deadline = undefined;
  worker?.terminate();
  worker = undefined;
  busy = false;
}
function invalidate(): void {
  generation++;
  stop();
  if (reportUrl) URL.revokeObjectURL(reportUrl);
  reportUrl = undefined;
  results.replaceChildren();
  results.hidden = true;
  update();
}
function discardSamples(): void {
  sampleUrls.forEach((url) => {
    URL.revokeObjectURL(url);
  });
  sampleUrls.length = 0;
  samples.replaceChildren();
}
function fail(code: string, message: string): void {
  invalidate();
  status.textContent = `${code}: ${message}`;
}
function link(
  text: string,
  content: BlobPart,
  filename: string,
  list: string[],
): HTMLAnchorElement {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  list.push(url);
  const anchor = node('a', text);
  anchor.href = url;
  anchor.download = filename;
  return anchor;
}
const metricNames: [keyof LocalMetrics, string][] = [
  ['precisionAt5', 'P@5'],
  ['recallAt10', 'R@10'],
  ['mrr', 'MRR (depth ≤100)'],
  ['map', 'MAP (depth ≤100)'],
  ['ndcgAt10', 'nDCG@10'],
];
function queryView(query: LocalComparedQuery, target: HTMLElement): void {
  target.replaceChildren();
  target.append(node('h3', `${query.id} — ${query.text}`));
  target.append(
    node(
      'p',
      `${query.passed ? 'Pass' : 'Fail'} · minimum nDCG@10 ${query.minimumNdcgAt10}. Displayed metrics are rounded; the gate uses full precision.`,
    ),
  );
  const scroll = node('div');
  scroll.className = 'table-scroll';
  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', 'Local query metrics');
  const table = node('table');
  table.id = 'local-metrics';
  table.createCaption().textContent = 'Candidate minus baseline';
  const header = table.createTHead().insertRow();
  for (const name of ['Metric', 'Baseline', 'Candidate', 'Δ']) {
    const th = node('th', name);
    th.scope = 'col';
    header.append(th);
  }
  const body = table.createTBody();
  for (const [key, name] of metricNames) {
    const row = body.insertRow(),
      th = node('th', name);
    th.scope = 'row';
    row.append(th);
    for (const value of [
      query.baseline.metrics[key],
      query.candidate.metrics[key],
      query.delta[key],
    ])
      row.insertCell().textContent = value.toFixed(6);
  }
  scroll.append(table);
  target.append(scroll);
  const columns = node('div');
  columns.className = 'local-rankings';
  for (const side of ['baseline', 'candidate'] as const) {
    const column = node('div');
    column.append(node('h4', side === 'baseline' ? 'Baseline ranking' : 'Candidate ranking'));
    const list = node('ol');
    list.id = side + '-ranking';
    for (const result of query[side].ranking)
      list.append(node('li', `${result.id} · grade ${result.grade} · score ${result.score}`));
    column.append(list);
    column.append(
      node(
        'p',
        'Relevant IDs missing at 10: ' + (query[side].missingRelevantAt10.join(', ') || 'none'),
      ),
    );
    columns.append(column);
  }
  target.append(columns);
}
function render(text: string): void {
  const report = JSON.parse(text) as LocalComparison;
  const verdict = node('h2', report.status === 'pass' ? 'Comparison passed' : 'Comparison failed');
  verdict.id = 'verdict';
  results.append(verdict);
  results.append(
    node(
      'p',
      `${report.inputs.documentCount} documents · ${report.inputs.queryCount} queries. Failed minimums: ${report.failedMinimumQueries.join(', ') || 'none'}. Regressions: ${report.regressedQueries.join(', ') || 'none'}.`,
    ),
  );
  const description = node(
    'p',
    'SHA-256 identifies the exact used input bytes; it does not authenticate them.',
  );
  description.className = 'hint';
  results.append(description);
  const hashes = node('dl');
  for (const [key, value] of Object.entries(report.inputs))
    if (key.endsWith('Sha256')) {
      hashes.append(node('dt', key), node('dd', String(value)));
    }
  hashes.className = 'input-hashes';
  results.append(hashes);
  const label = node('label', 'Inspect local query'),
    select = node('select');
  select.setAttribute('aria-label', 'Inspect local query');
  label.append(select);
  for (const query of report.queries) {
    const option = node('option', query.id);
    option.value = query.id;
    select.append(option);
  }
  results.append(label);
  const detail = node('div');
  detail.id = 'query-detail';
  results.append(detail);
  select.onchange = () => {
    const query = report.queries.find((q) => q.id === select.value);
    if (query) queryView(query, detail);
  };
  if (report.queries[0]) queryView(report.queries[0], detail);
  const urls: string[] = [];
  const download = link(
    'Download local comparison JSON',
    text,
    'searchlite-local-comparison.json',
    urls,
  );
  reportUrl = urls[0];
  results.append(download);
  results.hidden = false;
}
function receive(token: number, active: Worker, reply: LocalReply): void {
  if (token !== generation || active !== worker) return;
  stop();
  if (reply.kind === 'error') {
    fail(reply.code, reply.message);
    return;
  }
  try {
    if (reply.inputs) {
      for (const slot of slots) {
        const file = new File([reply.inputs[slot]], `synthetic-${slot}.json`, {
          type: 'application/json',
        });
        files[slot] = file;
        const transfer = new DataTransfer();
        transfer.items.add(file);
        controls[slot].files = transfer.files;
        samples.append(
          link(
            'Download synthetic ' + slot,
            reply.inputs[slot],
            `synthetic-${slot}.json`,
            sampleUrls,
          ),
          document.createTextNode(' '),
        );
      }
    }
    render(reply.text);
    status.textContent = 'Complete. Review individual queries before sharing the report.';
    update();
  } catch {
    fail('OPERATION_FAILED', 'The local comparison could not be displayed.');
  }
}
function startWorker(token: number, request: LocalRequest): void {
  if (token !== generation) return;
  try {
    const active = new LocalWorker();
    worker = active;
    active.onmessage = (event: MessageEvent<LocalReply>) => {
      receive(token, active, event.data);
    };
    active.onerror = () => {
      if (token === generation)
        fail('WORKER_FAILED', 'The local worker could not complete the comparison.');
    };
    active.onmessageerror = () => {
      if (token === generation)
        fail('WORKER_FAILED', 'The local worker response could not be read.');
    };
    active.postMessage(request);
  } catch {
    fail('WORKER_FAILED', 'The local worker could not start.');
  }
}
function begin(): number {
  invalidate();
  const token = generation;
  busy = true;
  update();
  status.textContent = 'Reading and comparing locally…';
  deadline = setTimeout(() => {
    if (token === generation)
      fail('DEADLINE', 'Comparison exceeded 15 seconds. Try smaller inputs.');
  }, 15000);
  return token;
}
async function runFiles(): Promise<void> {
  const selected = slots.map((slot) => files[slot]);
  if (!selected.every((file) => file !== undefined)) return;
  const token = begin();
  try {
    for (let i = 0; i < selected.length; i++)
      if ((selected[i]?.size ?? 0) > (i === 2 ? 256 * 1024 : 16 * 1024 * 1024))
        throw new Error('FILE_LIMIT');
    const bytes = await Promise.all(
      selected.map(async (file) => {
        const buffer = await file.arrayBuffer();
        if (buffer.byteLength !== file.size) throw new Error('FILE_CHANGED');
        return new Uint8Array(buffer);
      }),
    );
    if (token !== generation) return;
    const [baseline, candidate, judgments] = bytes;
    if (!baseline || !candidate || !judgments) throw new Error('FILE_UNREADABLE');
    startWorker(token, { kind: 'compare', inputs: { baseline, candidate, judgments } });
  } catch (error) {
    if (token === generation)
      fail(
        error instanceof Error ? error.message : 'FILE_UNREADABLE',
        'Choose bounded, unchanged readable JSON files.',
      );
  }
}
for (const slot of slots)
  controls[slot].onchange = () => {
    invalidate();
    discardSamples();
    const file = controls[slot].files?.[0];
    if (file) files[slot] = file;
    else files[slot] = undefined;
    status.textContent = 'Inputs changed. Compare again to produce a new report.';
    update();
  };
compare.onclick = () => {
  void runFiles();
};
example.onclick = () => {
  discardSamples();
  for (const slot of slots) {
    files[slot] = undefined;
    controls[slot].value = '';
  }
  const token = begin();
  startWorker(token, { kind: 'example', changed: choice.value !== 'unchanged' });
};
element('#clear-local', HTMLButtonElement).onclick = () => {
  invalidate();
  discardSamples();
  for (const slot of slots) {
    files[slot] = undefined;
    controls[slot].value = '';
  }
  update();
  status.textContent = 'Cleared local inputs and results.';
};
window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    if (busy) {
      generation++;
      stop();
      update();
      status.textContent = 'Pending comparison cancelled during navigation.';
    }
  } else {
    invalidate();
    discardSamples();
    for (const slot of slots) files[slot] = undefined;
  }
});
example.disabled = false;
update();
