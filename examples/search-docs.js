// Run after `npm run build`. This consumer deliberately uses the package's public exports.
import * as fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { createHash } from 'node:crypto';
import { SearchIndex, evaluate, formatExplanation } from 'searchlite';

const FILE_BYTES = 128 * 1024;
const CORPUS_BYTES = 1024 * 1024;
const FILE_COUNT = 128;
const ENTRIES = 4096;
const DEPTH = 16;
const SNAPSHOT_BYTES = 16 * 1024 * 1024;
const JUDGMENTS_BYTES = 256 * 1024;
const EXCLUDED = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'coverage',
  'out',
  'output',
  'target',
  'generated',
  '__pycache__',
]);
const USAGE =
  'node examples/search-docs.js index DIRECTORY SNAPSHOT\n' +
  'node examples/search-docs.js search SNAPSHOT QUERY\n' +
  'node examples/search-docs.js evaluate SNAPSHOT JUDGMENTS\n' +
  'node examples/search-docs.js compare BASELINE CANDIDATE JUDGMENTS\nBuild the package first with npm run build.';

class DocsError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
function refuse(code, message) {
  throw new DocsError(code, message);
}

// Preserve our own layout, escaping every untrusted line independently.
function safe(text) {
  return String(text).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16).padStart(4, '0')}}`,
  );
}
function snippet(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return safe(Array.from(flat).slice(0, 180).join('')) + (Array.from(flat).length > 180 ? '…' : '');
}
function unlinkedPath(file) {
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink())
      refuse('UNSAFE_PATH', 'Linked paths are not supported.');
    if (path.dirname(current) === current) break;
  }
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
}
function readBounded(file, limit, limitCode) {
  let descriptor;
  try {
    unlinkedPath(file);
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.nlink !== 1)
      refuse('UNSAFE_FILE', 'Choose one regular unlinked file.');
    if (initial.size > limit) refuse(limitCode, `File exceeds ${limit} bytes.`);
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (identity(initial) !== identity(opened))
      refuse('FILE_CHANGED', 'Input changed while opening.');
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(descriptor, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    unlinkedPath(file);
    if (
      used !== opened.size ||
      identity(opened) !== identity(fs.fstatSync(descriptor)) ||
      identity(opened) !== identity(fs.lstatSync(file))
    ) {
      refuse('FILE_CHANGED', 'Input changed while reading.');
    }
    return buffer.subarray(0, used);
  } catch (error) {
    if (error instanceof DocsError) throw error;
    refuse('FILE_UNREADABLE', `Unable to read ${path.basename(file)}.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function decode(data, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    refuse(code, 'Input must contain valid UTF-8.');
  }
}
function excluded(name) {
  return name.startsWith('.') || EXCLUDED.has(name.toLowerCase());
}

function collect(root) {
  try {
    unlinkedPath(root);
    if (!fs.lstatSync(root).isDirectory())
      refuse('DIRECTORY_UNREADABLE', 'Choose a readable document directory.');
  } catch (error) {
    if (error instanceof DocsError) throw error;
    refuse('DIRECTORY_UNREADABLE', 'Choose a readable document directory.');
  }
  if (root.split(path.sep).some((part) => part && excluded(part))) {
    refuse(
      'EXCLUDED_ROOT',
      'The selected root is inside an excluded hidden/dependency/generated directory.',
    );
  }
  const documents = [];
  let visited = 0;
  let eligible = 0;
  let bytes = 0;
  function walk(directory, depth) {
    if (depth > DEPTH) refuse('DEPTH_LIMIT', 'Directory nesting exceeds 16 levels.');
    let handle;
    const entries = [];
    try {
      unlinkedPath(directory);
      handle = fs.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (++visited > ENTRIES) refuse('ENTRY_LIMIT', 'Directory traversal exceeds 4096 entries.');
        entries.push(entry.name);
      }
    } catch (error) {
      if (error instanceof DocsError) throw error;
      refuse('DIRECTORY_UNREADABLE', 'An included directory could not be read.');
    } finally {
      handle?.closeSync();
    }
    entries.sort();
    for (const name of entries) {
      if (excluded(name)) continue;
      const file = path.join(directory, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        refuse('FILE_UNREADABLE', `Unable to inspect ${name}.`);
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(file, depth + 1);
        continue;
      }
      const extension = path.extname(name).toLowerCase();
      if (extension !== '.md' && extension !== '.txt') continue;
      if (++eligible > FILE_COUNT) refuse('DOCUMENT_LIMIT', 'Corpus exceeds 128 eligible files.');
      if (stat.size > FILE_BYTES) refuse('FILE_LIMIT', 'An eligible file exceeds 131072 bytes.');
      if (bytes + stat.size > CORPUS_BYTES)
        refuse('CORPUS_LIMIT', 'Eligible corpus exceeds 1048576 bytes.');
      const data = readBounded(file, FILE_BYTES, 'FILE_LIMIT');
      bytes += data.length;
      if (bytes > CORPUS_BYTES) refuse('CORPUS_LIMIT', 'Eligible corpus exceeds 1048576 bytes.');
      if (data.includes(0)) refuse('INVALID_TEXT', `NUL bytes are not supported in ${name}.`);
      const body = decode(data, 'INVALID_UTF8');
      if (!body.trim()) continue;
      documents.push({
        id: path.relative(root, file).split(path.sep).join('/'),
        title: path.basename(name, path.extname(name)),
        body,
      });
    }
  }
  walk(root, 0);
  if (!documents.length) refuse('NO_DOCUMENTS', 'No nonempty UTF-8 .md/.txt documents were found.');
  return { documents, bytes };
}
function publish(file, data) {
  try {
    unlinkedPath(path.dirname(file));
    // wx refuses existing files, symlinks and competing writers without replacing them.
    fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof DocsError) throw error;
    if (error.code === 'EEXIST')
      refuse('SNAPSHOT_EXISTS', 'Snapshot already exists; choose a new filename.');
    refuse('OUTPUT_UNWRITABLE', 'Snapshot parent must be an existing writable unlinked directory.');
  }
}
function indexDocuments(directory, output) {
  const root = path.resolve(directory);
  const { documents, bytes } = collect(root);
  const index = new SearchIndex({ fields: { title: { boost: 3 }, body: {} } });
  index.addAll(documents);
  const data = JSON.stringify(index.toJSON()) + '\n';
  if (Buffer.byteLength(data) > SNAPSHOT_BYTES)
    refuse('SNAPSHOT_LIMIT', 'Serialized index exceeds 16777216 bytes.');
  publish(path.resolve(output), data);
  console.log(`Indexed ${documents.length} documents (${bytes} UTF-8 bytes).`);
  console.log(`Snapshot: ${safe(path.resolve(output))}`);
}
function restore(file) {
  const data = readBounded(path.resolve(file), SNAPSHOT_BYTES, 'SNAPSHOT_LIMIT');
  try {
    const raw = JSON.parse(decode(data, 'INVALID_SNAPSHOT'));
    if (
      !raw ||
      raw.format !== 'searchlite' ||
      !Array.isArray(raw.documents) ||
      raw.documents.length < 1 ||
      raw.documents.length > FILE_COUNT ||
      !Array.isArray(raw.options?.fields) ||
      raw.options.fields.length !== 2 ||
      raw.options.fields[0]?.name !== 'title' ||
      raw.options.fields[1]?.name !== 'body' ||
      raw.options.vectorField !== undefined ||
      raw.options.idField !== 'id' ||
      JSON.stringify(raw.options.storeFields) !== '["title","body"]'
    ) {
      refuse('INVALID_SNAPSHOT', 'Snapshot is not a bounded title/body document index.');
    }
    let bytes = 0;
    for (const document of raw.documents) {
      const { id, stored } = document;
      if (
        typeof id !== 'string' ||
        id.length > 4096 ||
        path.posix.isAbsolute(id) ||
        id.split('/').some((part) => !part || part === '..' || part === '.') ||
        typeof stored?.title !== 'string' ||
        typeof stored.body !== 'string' ||
        stored.title.length > 1024 ||
        document.vector !== undefined
      ) {
        refuse('INVALID_SNAPSHOT', 'Snapshot document fields are malformed.');
      }
      const length = Buffer.byteLength(stored.body);
      if (length > FILE_BYTES || (bytes += length) > CORPUS_BYTES) {
        refuse('INVALID_SNAPSHOT', 'Snapshot document text exceeds the corpus limits.');
      }
    }
    return { index: SearchIndex.fromJSON(raw), data };
  } catch {
    refuse('INVALID_SNAPSHOT', 'Snapshot is malformed or incompatible with this example.');
  }
}
function searchSnapshot(file, query) {
  if (!query.trim() || query.length > 1000)
    refuse('INVALID_QUERY', 'Use a nonempty query of at most 1000 characters.');
  const { index } = restore(file);
  let results;
  try {
    results = index.search(query, { limit: 5 });
  } catch {
    refuse('INVALID_QUERY', 'Query syntax is invalid. See the searchlite query grammar.');
  }
  console.log(`Loaded ${index.size} documents. Query: ${safe(query)}`);
  if (!results.length) {
    console.log('No results.');
    return;
  }
  results.forEach((result, position) => {
    console.log(`${position + 1}. ${safe(result.id)} score=${result.score.toFixed(3)}`);
    console.log(`   snippet: ${snippet(result.fields.body)}`);
    const explanation = index.explain(result.id, query);
    explanation.id = safe(explanation.id);
    for (const clause of explanation.clauses) {
      clause.clause = safe(clause.clause);
      clause.terms = clause.terms.map(safe);
      for (const field of clause.fields) field.field = safe(field.field);
    }
    console.log(formatExplanation(explanation));
  });
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function loadJudgments(data, index) {
  let manifest;
  try {
    manifest = JSON.parse(decode(data, 'INVALID_JUDGMENTS'));
  } catch {
    refuse('INVALID_JUDGMENTS', 'Judgments must be valid UTF-8 JSON.');
  }
  const bad = () =>
    refuse(
      'INVALID_JUDGMENTS',
      'Use the bounded local-judgments/1 schema, unique known IDs, grades 0–3 and explicit thresholds.',
    );
  if (
    !exactKeys(manifest, ['schema', 'queries']) ||
    manifest.schema !== 'searchlite.local-judgments/1' ||
    !Array.isArray(manifest.queries) ||
    manifest.queries.length < 1 ||
    manifest.queries.length > 32
  )
    bad();
  const ids = new Set();
  for (const query of manifest.queries) {
    if (
      !exactKeys(query, ['id', 'text', 'relevance', 'minimumNdcgAt10']) ||
      typeof query.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(query.id) ||
      ids.has(query.id) ||
      typeof query.text !== 'string' ||
      !query.text.trim() ||
      query.text.length > 1000 ||
      query.text.includes('\0') ||
      typeof query.minimumNdcgAt10 !== 'number' ||
      !Number.isFinite(query.minimumNdcgAt10) ||
      query.minimumNdcgAt10 < 0 ||
      query.minimumNdcgAt10 > 1 ||
      !Array.isArray(query.relevance) ||
      query.relevance.length < 1 ||
      query.relevance.length > 128
    )
      bad();
    ids.add(query.id);
    const documents = new Set();
    let positive = false;
    for (const judgment of query.relevance) {
      if (
        !exactKeys(judgment, ['documentId', 'grade']) ||
        typeof judgment.documentId !== 'string' ||
        !index.has(judgment.documentId) ||
        documents.has(judgment.documentId) ||
        !Number.isInteger(judgment.grade) ||
        judgment.grade < 0 ||
        judgment.grade > 3
      )
        bad();
      documents.add(judgment.documentId);
      if (judgment.grade > 0) positive = true;
    }
    if (!positive) bad();
  }
  return manifest.queries;
}

// JSON.stringify already escapes C0 controls inside strings. Escape the remaining terminal/
// bidi/separator characters without altering JSON's structural whitespace or string semantics.
function safeJson(value) {
  return (
    JSON.stringify(value, null, 2).replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu, (character) =>
      character
        .split('')
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(''),
    ) + '\n'
  );
}

function createEvaluationReport({ index, data: snapshotData }, judgmentsData) {
  const queries = loadJudgments(judgmentsData, index);
  const qrels = Object.fromEntries(
    queries.map((query) => [
      query.id,
      Object.fromEntries(query.relevance.map((judgment) => [judgment.documentId, judgment.grade])),
    ]),
  );
  const rankings = new Map();
  for (const query of queries) {
    try {
      rankings.set(query.id, index.search(query.text, { limit: 100 }));
    } catch {
      refuse('INVALID_QUERY', 'A labelled query has invalid syntax. See the searchlite grammar.');
    }
  }
  const run = Object.fromEntries(
    [...rankings].map(([id, results]) => [id, results.map((result) => result.id)]),
  );
  const at5 = evaluate(run, qrels, { k: 5 });
  const at10 = evaluate(run, qrels, { k: 10 });
  const results = queries.map((query) => {
    const values = at10.perQuery[query.id];
    const ranking = rankings.get(query.id).map((result, i) => ({
      id: result.id,
      rank: i + 1,
      score: result.score,
      grade: Object.hasOwn(qrels[query.id], result.id) ? qrels[query.id][result.id] : 0,
    }));
    return {
      id: query.id,
      text: query.text,
      relevance: query.relevance,
      minimumNdcgAt10: query.minimumNdcgAt10,
      passed: values.ndcg >= query.minimumNdcgAt10,
      metrics: {
        precisionAt5: at5.perQuery[query.id].precision,
        recallAt10: values.recall,
        mrr: values.reciprocalRank,
        map: values.averagePrecision,
        ndcgAt10: values.ndcg,
      },
      ranking,
      missingRelevantAt10: query.relevance
        .filter(
          (judgment) =>
            judgment.grade > 0 &&
            !ranking.slice(0, 10).some((result) => result.id === judgment.documentId),
        )
        .map((judgment) => judgment.documentId)
        .sort(),
    };
  });
  const failedQueries = results.filter((query) => !query.passed).map((query) => query.id);
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const report = {
    schema: 'searchlite.local-evaluation/1',
    status: failedQueries.length ? 'fail' : 'pass',
    inputs: {
      snapshotSha256: digest(snapshotData),
      judgmentsSha256: digest(judgmentsData),
      documentCount: index.size,
      queryCount: queries.length,
    },
    configuration: index.toJSON().options,
    cutoffs: {
      precision: 5,
      recall: 10,
      ndcg: 10,
      rankingDepth: 100,
      mrrAndMap: 'full retrieved ranking',
    },
    criteria: 'Every query must have unrounded nDCG@10 >= its declared minimumNdcgAt10.',
    queries: results,
    failedQueries,
    limits: [
      'Caller-supplied labels and criteria describe this saved collection, not statistical significance or general relevance quality.',
      'Hashes identify the exact used input bytes, not source authenticity or current source freshness. Original document folders are not read.',
      'Reports contain query text and relative document IDs; keep private reports local unless intentionally shared. No provider/network call, source body export or file write.',
    ],
  };
  return report;
}
function evaluateSnapshot(file, judgmentsFile) {
  const loaded = restore(file);
  const judgmentsData = readBounded(
    path.resolve(judgmentsFile),
    JUDGMENTS_BYTES,
    'JUDGMENTS_LIMIT',
  );
  const report = createEvaluationReport(loaded, judgmentsData);
  process.stdout.write(safeJson(report));
  process.exitCode = report.status === 'pass' ? 0 : 3;
}
function collection(index) {
  const records = index.toJSON().documents.map(({ id, stored }) => [id, stored.title, stored.body]);
  records.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return JSON.stringify(records);
}
function compareSnapshots(baselineFile, candidateFile, judgmentsFile) {
  const baseline = restore(baselineFile);
  const candidate = restore(candidateFile);
  const beforeCollection = collection(baseline.index);
  if (beforeCollection !== collection(candidate.index))
    refuse(
      'INCOMPARABLE_COLLECTION',
      'Both snapshots must contain identical document IDs and stored title/body text.',
    );
  const judgmentsData = readBounded(
    path.resolve(judgmentsFile),
    JUDGMENTS_BYTES,
    'JUDGMENTS_LIMIT',
  );
  const before = createEvaluationReport(baseline, judgmentsData);
  const after = createEvaluationReport(candidate, judgmentsData);
  const side = ({ passed, metrics, ranking, missingRelevantAt10 }) => ({
    passed,
    metrics,
    ranking,
    missingRelevantAt10,
  });
  const queries = before.queries.map((query, i) => {
    const candidateQuery = after.queries[i];
    return {
      id: query.id,
      text: query.text,
      relevance: query.relevance,
      minimumNdcgAt10: query.minimumNdcgAt10,
      baseline: side(query),
      candidate: side(candidateQuery),
      delta: Object.fromEntries(
        Object.keys(query.metrics).map((key) => [
          key,
          candidateQuery.metrics[key] - query.metrics[key],
        ]),
      ),
      passed: candidateQuery.passed && candidateQuery.metrics.ndcgAt10 >= query.metrics.ndcgAt10,
    };
  });
  const regressedQueries = queries
    .filter((query) => query.delta.ndcgAt10 < 0)
    .map((query) => query.id);
  const failedQueries = queries.filter((query) => !query.passed).map((query) => query.id);
  const report = {
    schema: 'searchlite.local-comparison/1',
    status: failedQueries.length ? 'fail' : 'pass',
    inputs: {
      baselineSnapshotSha256: before.inputs.snapshotSha256,
      candidateSnapshotSha256: after.inputs.snapshotSha256,
      judgmentsSha256: before.inputs.judgmentsSha256,
      collectionSha256: createHash('sha256').update(beforeCollection).digest('hex'),
      documentCount: before.inputs.documentCount,
      queryCount: before.inputs.queryCount,
    },
    baseline: {
      configuration: before.configuration,
      status: before.status,
      failedQueries: before.failedQueries,
    },
    candidate: {
      configuration: after.configuration,
      status: after.status,
      failedQueries: after.failedQueries,
    },
    cutoffs: before.cutoffs,
    criteria:
      'Every candidate query must meet its unrounded minimumNdcgAt10 and have unrounded nDCG@10 >= baseline. No tolerance or average override.',
    queries,
    regressedQueries,
    failedMinimumQueries: after.failedQueries,
    failedQueries,
    limits: [
      ...before.limits,
      'Comparability checks identical supplied document IDs and stored title/body text; it does not authenticate postings, configurations, labels or source history.',
      'Metric deltas are candidate minus baseline. Raw ranking scores belong to each query/configuration and are not compared across configurations.',
      'Any nDCG@10 drop fails this deterministic gate; other metric deltas are visible but do not gate. This is not a significance test or a corpus-edit comparison.',
    ],
  };
  process.stdout.write(safeJson(report));
  process.exitCode = failedQueries.length ? 3 : 0;
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(USAGE);
  else {
    const [command, first, second, third] = args;
    if (
      args.length !== (command === 'compare' ? 4 : 3) ||
      !first ||
      !second ||
      (command === 'compare' && !third) ||
      !['index', 'search', 'evaluate', 'compare'].includes(command)
    ) {
      throw new DocsError('USAGE', USAGE, 2);
    }
    if (command === 'index') indexDocuments(first, second);
    else if (command === 'search') searchSnapshot(first, second);
    else if (command === 'evaluate') evaluateSnapshot(first, second);
    else compareSnapshots(first, second, third);
  }
} catch (error) {
  const known = error instanceof DocsError;
  const code = known ? error.code : 'OPERATION_FAILED';
  const message = known ? error.message : 'The operation could not be completed.';
  console.error(`${code}: ${code === 'USAGE' ? USAGE : safe(message)}`);
  process.exitCode = known ? error.exitCode : 1;
}
