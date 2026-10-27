// Shared private example semantics. No filesystem, browser storage, network or provider calls.
const FILE_BYTES = 128 * 1024,
  CORPUS_BYTES = 1024 * 1024,
  FILE_COUNT = 128,
  SNAPSHOT_BYTES = 16 * 1024 * 1024,
  JUDGMENTS_BYTES = 256 * 1024;
export class LocalReviewError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
function refuse(code, message) {
  throw new LocalReviewError(code, message);
}

function decode(data, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    refuse(code, 'Input must contain valid UTF-8.');
  }
}
// JSON.stringify already escapes C0 controls inside strings. Escape the remaining terminal/
// bidi/separator characters without altering JSON's structural whitespace or string semantics.
export function serializeLocalReport(value) {
  return (
    JSON.stringify(value, null, 2).replace(/[\p{Cf}\p{Zl}\p{Zp}\u007f-\u009f]/gu, (character) =>
      character
        .split('')
        .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
        .join(''),
    ) + '\n'
  );
}

export function createLocalReviewer({ SearchIndex, evaluate, digest }) {
  function restore(data) {
    if (!(data instanceof Uint8Array) || data.byteLength > SNAPSHOT_BYTES)
      refuse('SNAPSHOT_LIMIT', 'Snapshot exceeds 16777216 bytes.');
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
          id.startsWith('/') ||
          id.split('/').some((part) => !part || part === '..' || part === '.') ||
          typeof stored?.title !== 'string' ||
          typeof stored.body !== 'string' ||
          stored.title.length > 1024 ||
          document.vector !== undefined
        ) {
          refuse('INVALID_SNAPSHOT', 'Snapshot document fields are malformed.');
        }
        const length = new TextEncoder().encode(stored.body).byteLength;
        if (length > FILE_BYTES || (bytes += length) > CORPUS_BYTES) {
          refuse('INVALID_SNAPSHOT', 'Snapshot document text exceeds the corpus limits.');
        }
      }
      return { index: SearchIndex.fromJSON(raw), data };
    } catch {
      refuse('INVALID_SNAPSHOT', 'Snapshot is malformed or incompatible with this example.');
    }
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
    if (!(data instanceof Uint8Array) || data.byteLength > JUDGMENTS_BYTES)
      refuse('JUDGMENTS_LIMIT', 'Judgments exceed 262144 bytes.');
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

  async function createEvaluationReport({ index, data: snapshotData }, judgmentsData) {
    const queries = loadJudgments(judgmentsData, index);
    const qrels = Object.fromEntries(
      queries.map((query) => [
        query.id,
        Object.fromEntries(
          query.relevance.map((judgment) => [judgment.documentId, judgment.grade]),
        ),
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
    const report = {
      schema: 'searchlite.local-evaluation/1',
      status: failedQueries.length ? 'fail' : 'pass',
      inputs: {
        snapshotSha256: await digest(snapshotData),
        judgmentsSha256: await digest(judgmentsData),
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
  function collection(index) {
    const records = index
      .toJSON()
      .documents.map(({ id, stored }) => [id, stored.title, stored.body]);
    records.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return JSON.stringify(records);
  }
  function assertComparable(baseline, candidate) {
    const value = collection(baseline.index);
    if (value !== collection(candidate.index))
      refuse(
        'INCOMPARABLE_COLLECTION',
        'Both snapshots must contain identical document IDs and stored title/body text.',
      );
    return value;
  }
  async function compare(baseline, candidate, judgmentsData) {
    const beforeCollection = assertComparable(baseline, candidate);
    const before = await createEvaluationReport(baseline, judgmentsData);
    const after = await createEvaluationReport(candidate, judgmentsData);
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
        collectionSha256: await digest(new TextEncoder().encode(beforeCollection)),
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
    return report;
  }
  return { restore, evaluate: createEvaluationReport, compare, assertComparable };
}
