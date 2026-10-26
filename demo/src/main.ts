import './style.css';
import { GLOSSARY } from '../../corpus/glossary';
import {
  QuerySyntaxError,
  SearchIndex,
  parseQuery,
  type Explanation,
  type QueryNode,
  type SearchResult,
} from '../../src/index';

const index = new SearchIndex({
  fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } },
});
index.addAll(GLOSSARY);

function element<T extends HTMLElement>(selector: string, type: new () => T): T {
  const found = document.querySelector(selector);
  if (!(found instanceof type)) {
    throw new Error(`Missing element ${selector}`);
  }
  return found;
}

const form = element('#search-form', HTMLFormElement);
const input = element('#query', HTMLInputElement);
const status = element('#status', HTMLParagraphElement);
const explainToggle = element('#explain', HTMLInputElement);
const resultList = element('#results', HTMLOListElement);

const RESULT_LIMIT = 20;

/**
 * Search-as-you-type: while the cursor is still on the last word (no trailing space), treat
 * that word as a prefix so "bina" already finds "binary". The query is parsed once and the
 * typed tree is rewritten, instead of patching the query string.
 */
function completeLastWord(node: QueryNode, inputLength: number): QueryNode {
  switch (node.type) {
    case 'and':
    case 'or': {
      const last = node.children.at(-1);
      if (!last) {
        return node;
      }
      return {
        ...node,
        children: [...node.children.slice(0, -1), completeLastWord(last, inputLength)],
      };
    }
    case 'term':
      return node.end === inputLength && /^[\p{L}\p{N}]+$/u.test(node.text)
        ? { ...node, type: 'prefix' }
        : node;
    default:
      return node;
  }
}

function renderExplanation(explanation: Explanation): HTMLElement {
  const table = document.createElement('table');
  table.className = 'explain';
  const caption = table.createCaption();
  caption.textContent = `Score ${explanation.score.toFixed(3)} = sum of the clause scores below. Each clause scores weight × idf × (k1 + 1) · tf̃ / (k1 + tf̃) with k1 = ${explanation.k1}, where tf̃ adds up boost × tf / length normalization over the fields.`;
  const head = table.createTHead().insertRow();
  for (const label of [
    'Clause',
    'idf',
    'Field',
    'tf',
    'Length (avg)',
    'Boost',
    'Weighted tf',
    'Clause score',
  ]) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = label;
    head.append(cell);
  }
  const body = table.createTBody();
  for (const clause of explanation.clauses) {
    clause.fields.forEach((field, i) => {
      const row = body.insertRow();
      const weight = clause.weight === 1 ? '' : ` × ${clause.weight.toFixed(2)}`;
      const cells = [
        i === 0 ? `${clause.clause} → ${clause.terms.join(' ')}` : '',
        i === 0 ? clause.idf.toFixed(3) : '',
        field.field,
        String(field.frequency),
        `${field.length} (${field.averageLength.toFixed(1)})`,
        String(field.boost),
        field.weightedFrequency.toFixed(3),
        i === 0 ? `${clause.score.toFixed(3)}${weight ? ` (fuzzy${weight})` : ''}` : '',
      ];
      for (const text of cells) {
        row.insertCell().textContent = text;
      }
    });
  }
  return table;
}

function renderResult(result: SearchResult, query: QueryNode): HTMLLIElement {
  const item = document.createElement('li');
  item.className = 'result';

  // highlight() HTML-escapes the document text and only adds <mark> tags, so it is safe here.
  const title = document.createElement('h2');
  title.innerHTML = index.highlight(result.id, 'title', query, {
    maxLength: Number.POSITIVE_INFINITY,
  });
  const snippet = document.createElement('p');
  snippet.className = 'snippet';
  snippet.innerHTML = index.highlight(result.id, 'body', query, { maxLength: 200 });

  const meta = document.createElement('p');
  meta.className = 'meta';
  const tags = document.createElement('span');
  tags.innerHTML = index.highlight(result.id, 'tags', query);
  const score = document.createElement('span');
  score.textContent = `score ${result.score.toFixed(3)}`;
  meta.append(tags, ' · ', score);

  item.append(title, snippet, meta);
  if (explainToggle.checked) {
    item.append(renderExplanation(index.explain(result.id, query)));
  }
  return item;
}

function runSearch(): void {
  const raw = input.value;
  resultList.replaceChildren();
  if (raw.trim() === '') {
    status.textContent = `${index.size} glossary entries indexed. Start typing to search.`;
    return;
  }
  let query: QueryNode | null;
  let results: SearchResult[];
  const started = performance.now();
  try {
    const parsed = parseQuery(raw);
    query = parsed && completeLastWord(parsed, raw.length);
    results = query ? index.search(query, { limit: RESULT_LIMIT }) : [];
  } catch (error) {
    if (error instanceof QuerySyntaxError) {
      status.textContent = `Query error: ${error.message}`;
      return;
    }
    throw error;
  }
  const elapsed = performance.now() - started;

  if (!query || results.length === 0) {
    status.textContent = `No results (${elapsed.toFixed(2)} ms).`;
    return;
  }
  const plural = results.length === 1 ? 'result' : 'results';
  const capped = results.length === RESULT_LIMIT ? ' (top 20)' : '';
  status.textContent = `${results.length} ${plural}${capped} in ${elapsed.toFixed(2)} ms`;
  const finalQuery = query;
  resultList.replaceChildren(...results.map((result) => renderResult(result, finalQuery)));
}

function syncUrl(): void {
  const url = new URL(window.location.href);
  if (input.value === '') {
    url.searchParams.delete('q');
  } else {
    url.searchParams.set('q', input.value);
  }
  window.history.replaceState(null, '', url);
}

input.addEventListener('input', () => {
  runSearch();
  syncUrl();
});
explainToggle.addEventListener('change', runSearch);
form.addEventListener('submit', (event) => {
  event.preventDefault();
});

for (const button of document.querySelectorAll<HTMLButtonElement>('button[data-query]')) {
  button.addEventListener('click', () => {
    input.value = button.dataset.query ?? '';
    runSearch();
    syncUrl();
    input.focus();
  });
}

document.addEventListener('keydown', (event) => {
  const target = event.target;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable);
  if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    input.focus();
    input.select();
  }
});

// A visible static input may already contain the visitor's newer text before modules load.
if (input.value === '') {
  input.value = new URLSearchParams(window.location.search).get('q') ?? '';
} else {
  syncUrl();
}
runSearch();
