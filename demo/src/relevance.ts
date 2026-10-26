import './style.css';
import './relevance.css';
import { CONFIGURATIONS } from '../../corpus/retrieval';
import {
  createComparison,
  serializeComparison,
  type ComparisonMetrics,
  type ComparedQuerySide,
} from '../../examples/relevance-comparison';

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) throw new Error(`Missing workbench element ${selector}`);
  return found;
}

const baseline = element('#baseline', HTMLSelectElement);
const candidate = element('#candidate', HTMLSelectElement);
const querySelect = element('#evaluation-query', HTMLSelectElement);
const notice = element('#selection-notice', HTMLParagraphElement);
const download = element('#download', HTMLAnchorElement);
const number = (value: number): string => value.toFixed(3);
const change = (value: number): string => (value > 0 ? '+' : '') + number(value);
const status = (value: number): string =>
  value > 0 ? 'improved' : value < 0 ? 'regressed' : 'unchanged';
const metricLabels: [keyof ComparisonMetrics, string][] = [
  ['precisionAt5', 'P@5'],
  ['recallAt10', 'R@10'],
  ['mrr', 'MRR (depth ≤100)'],
  ['map', 'MAP (depth ≤100)'],
  ['ndcgAt10', 'nDCG@10'],
];

for (const config of CONFIGURATIONS) {
  for (const select of [baseline, candidate]) {
    const option = document.createElement('option');
    option.value = config.id;
    option.textContent = config.name;
    select.append(option);
  }
}

const params = new URLSearchParams(location.search);
const known = (id: string): boolean => CONFIGURATIONS.some((c) => c.id === id);
const requestedBaseline = params.get('baseline') ?? 'bm25f';
const requestedCandidate = params.get('candidate') ?? 'no-stemming';
baseline.value = known(requestedBaseline) ? requestedBaseline : 'bm25f';
candidate.value = known(requestedCandidate) ? requestedCandidate : 'no-stemming';
let report = createComparison(baseline.value, candidate.value);
const requestedQuery = params.get('query') ?? 'q01';
if (
  !known(requestedBaseline) ||
  !known(requestedCandidate) ||
  !report.queries.some((q) => q.id === requestedQuery)
) {
  notice.textContent = 'Unknown comparison selections; defaults used for unsupported values.';
}
for (const query of report.queries) {
  const option = document.createElement('option');
  option.value = query.id;
  option.textContent = `${query.id} — ${query.text}`;
  querySelect.append(option);
}
querySelect.value = report.queries.some((q) => q.id === requestedQuery) ? requestedQuery : 'q01';
let downloadUrl: string | undefined;

function tableHead(table: HTMLTableElement, caption: string, columns: string[]): void {
  table.replaceChildren();
  table.createCaption().textContent = caption;
  const row = table.createTHead().insertRow();
  for (const text of columns) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = text;
    row.append(th);
  }
}

function metricTable(
  selector: string,
  caption: string,
  before: ComparisonMetrics,
  after: ComparisonMetrics,
  delta: ComparisonMetrics,
): void {
  const table = element(selector, HTMLTableElement);
  tableHead(table, caption, ['Metric', 'Baseline', 'Candidate', 'Δ']);
  const body = table.createTBody();
  for (const [key, label] of metricLabels) {
    const row = body.insertRow();
    const name = document.createElement('th');
    name.scope = 'row';
    name.textContent = label;
    row.append(name);
    for (const text of [number(before[key]), number(after[key]), change(delta[key])])
      row.insertCell().textContent = text;
  }
}

function syncUrl(): void {
  const url = new URL(location.href);
  url.searchParams.set('baseline', baseline.value);
  url.searchParams.set('candidate', candidate.value);
  url.searchParams.set('query', querySelect.value);
  history.replaceState(null, '', url);
}

function rankings(side: 'baseline' | 'candidate', values: ComparedQuerySide): void {
  element(`#${side}-title`, HTMLHeadingElement).textContent =
    `${side === 'baseline' ? 'Baseline' : 'Candidate'} — ${report[side].name}`;
  element(`#${side}-score-kind`, HTMLParagraphElement).textContent =
    `Top 10 · ${report[side].scoreKind} scores (within this query/configuration only)`;
  const list = element(`#${side}-ranking`, HTMLOListElement);
  list.replaceChildren();
  for (const result of values.ranking.slice(0, 10)) {
    const item = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = result.title;
    const detail = document.createElement('span');
    detail.className = 'rank-detail';
    detail.textContent = `${result.id} · grade ${result.grade} · ${report[side].scoreKind} score ${result.score.toFixed(6)}`;
    item.append(title, detail);
    list.append(item);
  }
  const missing = values.missingRelevantAt10.map(
    (id) => report.collection.documents.find((d) => d.id === id)?.title ?? id,
  );
  element(`#${side}-missing`, HTMLParagraphElement).textContent =
    `Relevant but missing from top 10: ${missing.length ? missing.join('; ') : 'none'}.`;
}

function inspectQuery(): void {
  const selected = report.queries.find((query) => query.id === querySelect.value);
  if (!selected) throw new Error('Missing fixed evaluation query');
  element('#query-title', HTMLHeadingElement).textContent = `${selected.id} — ${selected.text}`;
  element('#query-state', HTMLParagraphElement).textContent =
    `nDCG@10 ${status(selected.delta.ndcgAt10)} (${change(selected.delta.ndcgAt10)}); ${Object.keys(selected.judgements).length} relevant ${Object.keys(selected.judgements).length === 1 ? 'judgment' : 'judgments'}.`;
  metricTable(
    '#query-metrics',
    'Selected query — full precision in JSON',
    selected.baseline.metrics,
    selected.candidate.metrics,
    selected.delta,
  );
  rankings('baseline', selected.baseline);
  rankings('candidate', selected.candidate);
  syncUrl();
}

function renderComparison(): void {
  metricTable(
    '#summary',
    'Mean over all 22 queries — full precision in JSON',
    report.baseline.metrics,
    report.candidate.metrics,
    report.meanDelta,
  );
  const overview = element('#query-overview', HTMLTableElement);
  tableHead(overview, 'Per-query nDCG@10 — candidate minus baseline', [
    'Query',
    'Baseline',
    'Candidate',
    'Δ',
    'Inspect',
  ]);
  const body = overview.createTBody();
  for (const query of report.queries) {
    const row = body.insertRow();
    row.insertCell().textContent = `${query.id} — ${query.text}`;
    row.insertCell().textContent = number(query.baseline.metrics.ndcgAt10);
    row.insertCell().textContent = number(query.candidate.metrics.ndcgAt10);
    const delta = row.insertCell();
    delta.textContent = `${change(query.delta.ndcgAt10)} ${status(query.delta.ndcgAt10)}`;
    delta.className = `delta-${status(query.delta.ndcgAt10)}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Inspect ${query.id}`;
    button.addEventListener('click', () => {
      querySelect.value = query.id;
      inspectQuery();
      querySelect.focus();
    });
    row.insertCell().append(button);
  }
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = URL.createObjectURL(
    new Blob([serializeComparison(report)], { type: 'application/json' }),
  );
  download.href = downloadUrl;
  download.download = `searchlite-${baseline.value}-vs-${candidate.value}.json`;
  inspectQuery();
}

function compare(): void {
  report = createComparison(baseline.value, candidate.value);
  notice.textContent = '';
  renderComparison();
}
baseline.addEventListener('change', compare);
candidate.addEventListener('change', compare);
querySelect.addEventListener('change', inspectQuery);
element('#swap', HTMLButtonElement).addEventListener('click', () => {
  const previous = baseline.value;
  baseline.value = candidate.value;
  candidate.value = previous;
  compare();
});
window.addEventListener('pagehide', (event) => {
  // A persisted page may return from the back/forward cache with this same live DOM.
  if (!event.persisted && downloadUrl) URL.revokeObjectURL(downloadUrl);
});
renderComparison();
