import { Analyzer, type Token } from './analysis/analyzer';
import {
  executePlan,
  type ClauseExplanation,
  type ExecutionContext,
  type Hit,
  type TraceEntry,
} from './engine/execute';
import { FieldIndex } from './engine/field-index';
import { compileQuery, type Plan } from './engine/plan';
import { SearchliteError } from './errors';
import { at } from './internal/at';
import {
  resolveIndexOptions,
  type FieldOptions,
  type IndexOptions,
  type ResolvedIndexOptions,
} from './options';
import type { QueryNode } from './query/ast';
import { parseQuery, type DefaultOperator } from './query/parser';
import { TopK } from './structures/top-k';

/** A document to index: any object with an id property and string (or string array) fields. */
export type SearchDocument = Readonly<Record<string, unknown>>;

export interface SearchOptions {
  /** Maximum number of results. Default 10; `Infinity` returns every match. */
  limit?: number;
  /** Fields searched by terms without a `field:` prefix. Default: every searchable field. */
  fields?: readonly string[];
  /** Overrides the index's default operator for this query. */
  defaultOperator?: DefaultOperator;
  /** Maximum dictionary terms one prefix or fuzzy word expands to, per field. Default 64. */
  maxExpansions?: number;
}

export interface SearchResult {
  id: string;
  /** BM25F score; higher is better. Only comparable between results of the same query. */
  score: number;
  /** The document's stored fields. */
  fields: Record<string, unknown>;
  /** Distinct index terms (after analysis) that contributed to the score, sorted. */
  terms: string[];
  /** For each field that matched, the index terms that matched in it. */
  match: Record<string, string[]>;
}

export interface Explanation {
  id: string;
  /** Whether the document matches the query at all. */
  matched: boolean;
  /** Equal to the score the document gets from `search` for the same query and options. */
  score: number;
  /** The index's k1, needed to recompute each clause's saturation by hand. */
  k1: number;
  /** One entry per clause that contributed to the score, in query order. */
  clauses: ClauseExplanation[];
}

export interface FieldStats {
  /** Documents in which the field has at least one token. */
  documents: number;
  /** Average field length in tokens over those documents. */
  averageLength: number;
  /** Distinct terms in the field's dictionary. */
  terms: number;
}

export interface IndexStats {
  documentCount: number;
  fields: Record<string, FieldStats>;
}

/** Bumped whenever the snapshot layout changes, so old snapshots fail loudly. */
export const SNAPSHOT_VERSION = 1;

/** Serialized form produced by {@link SearchIndex.toJSON}. Plain JSON data. */
export interface IndexSnapshot {
  format: 'searchlite';
  version: number;
  options: ResolvedIndexOptions;
  /** Documents in internal order. Postings refer to them by position in this array. */
  documents: SnapshotDocument[];
  /** Per field: [term, [[document slot, positions], ...]] pairs. */
  postings: Record<string, [string, [number, number[]][]][]>;
}

export interface SnapshotDocument {
  id: string;
  lengths: number[];
  stored: Record<string, unknown>;
  vector?: number[];
}

/** Gap inserted between the elements of an array field, so phrases never span two elements. */
const ARRAY_POSITION_GAP = 100;

interface DocumentRecord {
  id: string;
  /** Length in tokens of each field, aligned with the field list. */
  lengths: number[];
  /** Distinct terms of each field, kept so the document can be removed without re-analysis. */
  terms: string[][];
  stored: Record<string, unknown>;
  vector: number[] | undefined;
}

interface PreparedDocument {
  id: string;
  fields: { positionsByTerm: Map<string, number[]>; length: number }[];
  stored: Record<string, unknown>;
  vector: number[] | undefined;
}

interface QuerySettings {
  limit: number;
  defaultFields: number[];
  defaultOperator: DefaultOperator;
  maxExpansions: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Runtime guard for JavaScript callers; deliberately does not narrow the static type. */
function requireObject(value: unknown, message: string): void {
  if (!isRecord(value)) {
    throw argumentError(message);
  }
}

function documentError(message: string): SearchliteError {
  return new SearchliteError('INVALID_DOCUMENT', message);
}

function argumentError(message: string): SearchliteError {
  return new SearchliteError('INVALID_ARGUMENT', message);
}

function snapshotError(message: string): SearchliteError {
  return new SearchliteError('INVALID_SNAPSHOT', message);
}

/** Field values may be a string, a number, or an array of those; absent fields are empty. */
function fieldTexts(value: unknown, field: string, id: string): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  const isText = (item: unknown): item is string | number =>
    typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item));
  if (isText(value)) {
    return [String(value)];
  }
  if (Array.isArray(value) && value.every(isText)) {
    return value.map(String);
  }
  throw documentError(
    `Field "${field}" of document "${id}" must be a string, a number or an array of strings`,
  );
}

function analyzeTexts(analyzer: Analyzer, texts: readonly string[]): Token[] {
  const tokens: Token[] = [];
  let base = 0;
  for (const text of texts) {
    const analyzed = analyzer.analyze(text);
    for (const token of analyzed) {
      tokens.push({ ...token, position: base + token.position });
    }
    base += (analyzed.at(-1)?.position ?? 0) + 1 + ARRAY_POSITION_GAP;
  }
  return tokens;
}

function validVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function positiveLimit(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (value !== Number.POSITIVE_INFINITY && (!Number.isInteger(value) || value < 1)) {
    throw argumentError(`${name} must be a positive integer or Infinity, got ${String(value)}`);
  }
  return value;
}

/**
 * An in-memory full-text index with BM25F ranking.
 *
 * Documents are analyzed per field, stored in a positional inverted index, and scored with
 * BM25F (Robertson & Zaragoza, 2009). Queries use a small language with AND/OR/NOT, phrases,
 * field scoping, prefix and fuzzy terms; see {@link parseQuery}.
 *
 * @example
 * ```ts
 * const index = new SearchIndex({ fields: { title: { boost: 2 }, body: {} } });
 * index.add({ id: 'heap', title: 'Binary heap', body: 'A tree-shaped priority queue.' });
 * index.search('priority queue')[0]?.id; // "heap"
 * ```
 */
export class SearchIndex {
  readonly #options: ResolvedIndexOptions;
  readonly #fields: FieldIndex[];
  readonly #fieldNames: string[];
  readonly #documents = new Map<number, DocumentRecord>();
  /** External id → internal document number. Numbers are dense and never reused. */
  readonly #numbers = new Map<string, number>();
  #nextNumber = 0;
  #dimensions: number | undefined;
  #vectorCount = 0;

  constructor(options: IndexOptions) {
    this.#options = resolveIndexOptions(options);
    this.#fields = this.#options.fields.map(
      (field) =>
        new FieldIndex(
          field.name,
          field.boost,
          field.b,
          new Analyzer({ stemming: field.stemming, stopwords: field.stopwords }),
        ),
    );
    this.#fieldNames = this.#fields.map((field) => field.name);
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.#documents.size;
  }

  /** Whether a document with this id is indexed. */
  has(id: string | number): boolean {
    return this.#numbers.has(String(id));
  }

  /** A copy of a document's stored fields, or undefined if there is no such document. */
  get(id: string | number): Record<string, unknown> | undefined {
    const number = this.#numbers.get(String(id));
    return number === undefined ? undefined : { ...this.#record(number).stored };
  }

  /**
   * Indexes a document.
   * @throws {SearchliteError} `DUPLICATE_ID` if the id is taken (use {@link replace}), or
   * `INVALID_DOCUMENT` if the document is malformed. The index is unchanged after an error.
   */
  add(document: SearchDocument): void {
    this.addAll([document]);
  }

  /**
   * Indexes several documents atomically: every document is validated and analyzed before any
   * is added, so one bad document leaves the index untouched.
   */
  addAll(documents: Iterable<SearchDocument>): void {
    const prepared: PreparedDocument[] = [];
    const batchIds = new Set<string>();
    let dimensions = this.#dimensions;
    for (const document of documents) {
      const entry = this.#prepare(document, dimensions);
      if (this.#numbers.has(entry.id) || batchIds.has(entry.id)) {
        throw new SearchliteError(
          'DUPLICATE_ID',
          `A document with id "${entry.id}" is already indexed; use replace() to update it`,
        );
      }
      batchIds.add(entry.id);
      dimensions ??= entry.vector?.length;
      prepared.push(entry);
    }
    for (const entry of prepared) {
      this.#commit(entry, this.#nextNumber++);
    }
  }

  /** Removes a document. Returns false if there was no document with this id. */
  remove(id: string | number): boolean {
    const key = String(id);
    const number = this.#numbers.get(key);
    if (number === undefined) {
      return false;
    }
    const record = this.#record(number);
    this.#fields.forEach((field, i) => {
      field.removeDocument(number, at(record.terms, i), at(record.lengths, i));
    });
    this.#documents.delete(number);
    this.#numbers.delete(key);
    if (record.vector && --this.#vectorCount === 0) {
      this.#dimensions = undefined;
    }
    return true;
  }

  /**
   * Replaces an existing document with a new version that has the same id.
   * @throws {SearchliteError} `NOT_FOUND` if there is no document with that id.
   */
  replace(document: SearchDocument): void {
    const entry = this.#prepare(document, this.#dimensions);
    const number = this.#numbers.get(entry.id);
    if (number === undefined) {
      throw new SearchliteError(
        'NOT_FOUND',
        `No document with id "${entry.id}" to replace; use add() for new documents`,
      );
    }
    this.remove(entry.id);
    // Reusing the document number keeps the document's place in tie-breaking order.
    this.#commit(entry, number);
  }

  /**
   * Runs a query and returns the best matches, highest score first. Ties are broken by
   * insertion order.
   *
   * Matching documents are scored with BM25F and the top `limit` are selected with a binary
   * heap. For each returned document the matched terms are worked out by re-scoring it with
   * tracing on, which reuses the per-clause data already computed for the query.
   *
   * @param query - A query string (see {@link parseQuery}) or an already-parsed query tree.
   * @throws {QuerySyntaxError} if the query string is malformed or names an unknown field.
   */
  search(query: string | QueryNode, options: SearchOptions = {}): SearchResult[] {
    const settings = this.#settings(options, 10);
    const plan = this.#compile(query, settings);
    if (!plan) {
      return [];
    }
    const context = this.#context();
    const top = new TopK<[number, number]>(
      settings.limit,
      ([documentA, scoreA], [documentB, scoreB]) =>
        scoreA > scoreB || (scoreA === scoreB && documentA < documentB),
    );
    for (const [document, hit] of executePlan(plan, context)) {
      top.push([document, hit.score]);
    }
    return top.sorted().map(([document, score]) => {
      const record = this.#record(document);
      const match = this.#matchedTerms(this.#traced(plan, context, document)?.trace);
      return {
        id: record.id,
        score,
        fields: { ...record.stored },
        terms: [...new Set(Object.values(match).flat())].sort(),
        match,
      };
    });
  }

  /**
   * Breaks a document's score for a query down by clause and field. The total equals the score
   * `search` gives the document, because both run the same scoring code.
   * @throws {SearchliteError} `NOT_FOUND` if there is no document with this id.
   */
  explain(
    id: string | number,
    query: string | QueryNode,
    options: SearchOptions = {},
  ): Explanation {
    const number = this.#numberOf(id);
    const plan = this.#compile(query, this.#settings(options, 10));
    const hit = plan ? this.#traced(plan, this.#context(), number) : undefined;
    return {
      id: String(id),
      matched: hit !== undefined,
      score: hit?.score ?? 0,
      k1: this.#options.k1,
      clauses: hit?.trace?.map((entry) => entry.explanation) ?? [],
    };
  }

  /** Document count and per-field statistics. */
  stats(): IndexStats {
    const fields: Record<string, FieldStats> = {};
    for (const field of this.#fields) {
      fields[field.name] = {
        documents: field.documentCount,
        averageLength: field.averageLength,
        terms: field.postings.size,
      };
    }
    return { documentCount: this.size, fields };
  }

  /**
   * Serializes the index to plain JSON data. Restore it with {@link SearchIndex.fromJSON};
   * stored field values must themselves be JSON-serializable.
   */
  toJSON(): IndexSnapshot {
    const ordered = [...this.#documents].sort(([a], [b]) => a - b);
    const slots = new Map(ordered.map(([number], slot) => [number, slot]));
    const documents = ordered.map(([, record]): SnapshotDocument => {
      const snapshot: SnapshotDocument = {
        id: record.id,
        lengths: [...record.lengths],
        stored: { ...record.stored },
      };
      if (record.vector) {
        snapshot.vector = [...record.vector];
      }
      return snapshot;
    });
    const postings: IndexSnapshot['postings'] = {};
    for (const field of this.#fields) {
      postings[field.name] = [...field.postings].map(([term, entries]) => [
        term,
        [...entries].map(([number, positions]): [number, number[]] => [
          slots.get(number) ?? -1,
          [...positions],
        ]),
      ]);
    }
    return {
      format: 'searchlite',
      version: SNAPSHOT_VERSION,
      options: JSON.parse(JSON.stringify(this.#options)) as ResolvedIndexOptions,
      documents,
      postings,
    };
  }

  /**
   * Rebuilds an index from {@link toJSON} output (after `JSON.parse` if it was stored as text).
   * @throws {SearchliteError} `INVALID_SNAPSHOT` if the data is not a compatible snapshot.
   */
  static fromJSON(snapshot: unknown): SearchIndex {
    if (!isRecord(snapshot) || snapshot.format !== 'searchlite') {
      throw snapshotError('Not a searchlite index snapshot');
    }
    if (snapshot.version !== SNAPSHOT_VERSION) {
      throw snapshotError(
        `Unsupported snapshot version ${String(snapshot.version)}; this version of searchlite reads version ${SNAPSHOT_VERSION}`,
      );
    }
    const { options, documents, postings } = snapshot;
    if (!isRecord(options) || !Array.isArray(options.fields)) {
      throw snapshotError('Snapshot options are missing or malformed');
    }
    const fields: Record<string, FieldOptions> = {};
    for (const field of options.fields as unknown[]) {
      if (!isRecord(field) || typeof field.name !== 'string') {
        throw snapshotError('Snapshot field options are malformed');
      }
      const { name, ...settings } = field;
      fields[name] = settings;
    }
    let index: SearchIndex;
    try {
      index = new SearchIndex({ ...(options as unknown as IndexOptions), fields });
    } catch (error) {
      throw snapshotError(`Snapshot options are invalid: ${(error as Error).message}`);
    }
    if (!Array.isArray(documents) || !isRecord(postings)) {
      throw snapshotError('Snapshot documents or postings are missing');
    }
    index.#restore(documents, postings);
    return index;
  }

  #restore(documents: unknown[], postings: Record<string, unknown>): void {
    const fieldCount = this.#fields.length;
    // positionsByTerm for each document slot and field, filled from the postings lists.
    const perDocument = documents.map(() => this.#fields.map(() => new Map<string, number[]>()));
    this.#fields.forEach((field, f) => {
      const list = postings[field.name];
      if (!Array.isArray(list)) {
        throw snapshotError(`Snapshot has no postings for field "${field.name}"`);
      }
      for (const entry of list as unknown[]) {
        if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
          throw snapshotError(`Malformed postings entry in field "${field.name}"`);
        }
        const term = entry[0];
        for (const posting of entry[1] as unknown[]) {
          const [slot, positions] = Array.isArray(posting) ? (posting as unknown[]) : [];
          const target = typeof slot === 'number' ? perDocument[slot]?.[f] : undefined;
          if (
            !target ||
            !Array.isArray(positions) ||
            !positions.every((p) => Number.isInteger(p) && (p as number) >= 0)
          ) {
            throw snapshotError(`Malformed posting for term "${term}" in field "${field.name}"`);
          }
          target.set(term, positions as number[]);
        }
      }
    });

    const prepared = documents.map((document, slot): PreparedDocument => {
      if (
        !isRecord(document) ||
        typeof document.id !== 'string' ||
        !isRecord(document.stored) ||
        !Array.isArray(document.lengths) ||
        document.lengths.length !== fieldCount ||
        !document.lengths.every((length) => Number.isInteger(length) && (length as number) >= 0) ||
        (document.vector !== undefined && !validVector(document.vector))
      ) {
        throw snapshotError(`Malformed document at position ${slot}`);
      }
      const lengths = document.lengths as number[];
      return {
        id: document.id,
        fields: at(perDocument, slot).map((positionsByTerm, f) => ({
          positionsByTerm,
          length: at(lengths, f),
        })),
        stored: { ...document.stored },
        vector: document.vector,
      };
    });
    const ids = new Set(prepared.map((document) => document.id));
    const dimensions = new Set(prepared.flatMap((document) => document.vector?.length ?? []));
    if (ids.size !== prepared.length || dimensions.size > 1) {
      throw snapshotError('Snapshot has duplicate ids or vectors of different lengths');
    }
    for (const document of prepared) {
      this.#commit(document, this.#nextNumber++);
    }
  }

  /** Validates and analyzes a document without touching the index. */
  #prepare(document: unknown, dimensions: number | undefined): PreparedDocument {
    if (!isRecord(document)) {
      throw documentError('Documents must be plain objects');
    }
    const { idField, storeFields, vectorField } = this.#options;
    const rawId = document[idField];
    if (
      !(typeof rawId === 'string' && rawId !== '') &&
      !(typeof rawId === 'number' && Number.isFinite(rawId))
    ) {
      throw documentError(
        `Every document needs a non-empty string or number "${idField}" property`,
      );
    }
    const id = String(rawId);
    const fields = this.#fields.map((field) => {
      const tokens = analyzeTexts(field.analyzer, fieldTexts(document[field.name], field.name, id));
      const positionsByTerm = new Map<string, number[]>();
      for (const token of tokens) {
        const positions = positionsByTerm.get(token.term);
        if (positions) {
          positions.push(token.position);
        } else {
          positionsByTerm.set(token.term, [token.position]);
        }
      }
      return { positionsByTerm, length: tokens.length };
    });

    const stored: Record<string, unknown> = {};
    for (const name of storeFields) {
      const value = document[name];
      if (value !== undefined) {
        stored[name] = Array.isArray(value) ? [...(value as unknown[])] : value;
      }
    }

    let vector: number[] | undefined;
    const rawVector = vectorField === undefined ? undefined : document[vectorField];
    if (vectorField !== undefined && rawVector !== undefined && rawVector !== null) {
      if (!validVector(rawVector)) {
        throw documentError(
          `"${vectorField}" of document "${id}" must be a non-empty array of finite numbers`,
        );
      }
      if (dimensions !== undefined && rawVector.length !== dimensions) {
        throw documentError(
          `"${vectorField}" of document "${id}" has ${rawVector.length} dimensions, but this index uses ${dimensions}`,
        );
      }
      vector = [...rawVector];
    }
    return { id, fields, stored, vector };
  }

  #commit(document: PreparedDocument, number: number): void {
    const record: DocumentRecord = {
      id: document.id,
      lengths: [],
      terms: [],
      stored: document.stored,
      vector: document.vector,
    };
    document.fields.forEach(({ positionsByTerm, length }, i) => {
      at(this.#fields, i).addDocument(number, positionsByTerm, length);
      record.lengths.push(length);
      record.terms.push([...positionsByTerm.keys()]);
    });
    this.#documents.set(number, record);
    this.#numbers.set(document.id, number);
    if (document.vector) {
      this.#dimensions ??= document.vector.length;
      this.#vectorCount++;
    }
  }

  #settings(options: SearchOptions, defaultLimit: number): QuerySettings {
    requireObject(options, 'Search options must be an object');
    const defaultFields = (options.fields ?? this.#fieldNames).map((name) => {
      const index = this.#fieldNames.indexOf(name);
      if (index === -1) {
        throw argumentError(`"${name}" is not a searchable field`);
      }
      return index;
    });
    const defaultOperator: unknown = options.defaultOperator ?? this.#options.defaultOperator;
    if (defaultOperator !== 'AND' && defaultOperator !== 'OR') {
      throw argumentError(`defaultOperator must be "AND" or "OR", got ${String(defaultOperator)}`);
    }
    return {
      limit: positiveLimit('limit', options.limit, defaultLimit),
      defaultFields,
      defaultOperator,
      maxExpansions: positiveLimit('maxExpansions', options.maxExpansions, 64),
    };
  }

  #compile(query: string | QueryNode, settings: QuerySettings): Plan | null {
    if (typeof query !== 'string' && !(isRecord(query) && typeof query.type === 'string')) {
      throw argumentError('The query must be a string or a parsed query node');
    }
    const node =
      typeof query === 'string'
        ? parseQuery(query, { defaultOperator: settings.defaultOperator, fields: this.#fieldNames })
        : query;
    if (node === null) {
      return null;
    }
    return compileQuery(node, {
      query: typeof query === 'string' ? query : '',
      fields: this.#fields,
      defaultFields: settings.defaultFields,
      maxExpansions: settings.maxExpansions,
    });
  }

  #context(): ExecutionContext {
    return {
      fields: this.#fields,
      documents: this.#documents,
      documentCount: this.#documents.size,
      k1: this.#options.k1,
      trace: false,
      cache: new Map(),
    };
  }

  /**
   * Re-scores one document with tracing on; undefined if it does not match. The score is
   * computed by the same code, in the same order, as during the search, so it is identical.
   */
  #traced(plan: Plan, context: ExecutionContext, document: number): Hit | undefined {
    return executePlan(plan, { ...context, only: document, trace: true }).get(document);
  }

  #matchedTerms(trace: readonly TraceEntry[] | undefined): Record<string, string[]> {
    const byField = new Map<string, Set<string>>();
    for (const entry of trace ?? []) {
      entry.plan.targets.forEach((target, t) => {
        if (at(entry.frequencies, t) === 0) {
          return;
        }
        const name = at(this.#fieldNames, target.field);
        const terms = byField.get(name) ?? new Set<string>();
        target.terms.forEach((term) => terms.add(term));
        byField.set(name, terms);
      });
    }
    const match: Record<string, string[]> = {};
    for (const name of this.#fieldNames) {
      const terms = byField.get(name);
      if (terms) {
        match[name] = [...terms].sort();
      }
    }
    return match;
  }

  #numberOf(id: string | number): number {
    const number = this.#numbers.get(String(id));
    if (number === undefined) {
      throw new SearchliteError('NOT_FOUND', `No document with id "${String(id)}"`);
    }
    return number;
  }

  #record(number: number): DocumentRecord {
    const record = this.#documents.get(number);
    if (!record) {
      throw new SearchliteError('NOT_FOUND', `No document with internal number ${number}`);
    }
    return record;
  }
}
