import { at } from '../internal/at';
import { inverseDocumentFrequency, lengthNormalization, saturate } from './bm25';
import type { FieldIndex } from './field-index';
import type { MatchPlan, MatchTarget, Plan } from './plan';
import { NO_MORE_DOCUMENTS, PostingsCursor, unionSize, type PostingsList } from './postings';

/** How one field contributed to a clause's score. */
export interface FieldExplanation {
  field: string;
  /** Index terms looked up in this field (one for a term, several for a phrase). */
  terms: string[];
  /** Occurrences of the term or phrase in this field of the document. */
  frequency: number;
  /** The field's length in tokens. */
  length: number;
  /** Average length of this field across documents that have it. */
  averageLength: number;
  /** BM25F field weight. */
  boost: number;
  /** BM25F length normalization for the field. */
  b: number;
  /** boost · frequency / B, this field's share of the clause's pseudo-frequency. */
  weightedFrequency: number;
}

/** Score breakdown for one matching clause (a term, a phrase, or one prefix/fuzzy expansion). */
export interface ClauseExplanation {
  /** The clause as written in the query, e.g. `heap`, `title:"binary heap"` or `hash*`. */
  clause: string;
  /** Distinct index terms that matched. */
  terms: string[];
  /** Number of documents in which the clause matches at least one searched field. */
  documentFrequency: number;
  /** Number of documents in the index. */
  documentCount: number;
  idf: number;
  /** BM25F pseudo-frequency tf̃: the sum of the fields' weighted frequencies. */
  frequency: number;
  /** 1, or 1 / (1 + edits) for a fuzzy expansion. */
  weight: number;
  /** weight · idf · (k1 + 1) · tf̃ / (k1 + tf̃). */
  score: number;
  fields: FieldExplanation[];
}

/** One scored clause, with the plan it came from so callers can see which targets matched. */
export interface TraceEntry {
  plan: MatchPlan;
  /** Occurrences per target, aligned with `plan.targets`. */
  frequencies: readonly number[];
  explanation: ClauseExplanation;
}

/** A matching document's score so far, and (when tracing) how it was obtained. */
export interface Hit {
  score: number;
  trace: TraceEntry[] | undefined;
}

export type Hits = Map<number, Hit>;

/** Per document, how often each target of a clause occurs (aligned with `plan.targets`). */
export type Occurrences = Map<number, number[]>;

export interface ExecutionContext {
  fields: readonly FieldIndex[];
  /** Every document's field lengths in tokens, aligned with `fields`. */
  documents: ReadonlyMap<number, { readonly lengths: readonly number[] }>;
  documentCount: number;
  k1: number;
  /** Score only this document. Statistics such as document frequency still use every document. */
  only?: number | undefined;
  /** Restrict matches without narrowing global occurrence tables or document frequencies. */
  candidates?: ReadonlyMap<number, unknown> | undefined;
  /** False for exclusion membership: normalization and score traces are unnecessary. */
  score?: boolean | undefined;
  /** Record a score breakdown for every hit. */
  trace: boolean;
  /**
   * Occurrence tables per clause. Computing them is the expensive part of a query, so they are
   * cached and reused when the same plan is executed again to explain individual results.
   */
  cache: Map<MatchPlan, Occurrences>;
  /**
   * Document frequency per clause, for clauses whose occurrence table was never built: the
   * document-at-a-time search computes it once, and explaining a result reuses it.
   */
  documentFrequencies?: Map<MatchPlan, number> | undefined;
}

/**
 * Executes a plan term-at-a-time: every clause produces a map of matching documents to
 * partial scores, and AND/OR combine those maps (intersection or union, adding scores).
 * Exclusions are applied last by deleting their documents from the group's result.
 */
export function executePlan(plan: Plan, context: ExecutionContext): Hits {
  switch (plan.kind) {
    case 'match':
      return executeMatch(plan, context);
    case 'alternatives': {
      const best: Hits = new Map();
      for (const child of plan.children) {
        for (const [document, hit] of executeMatch(child, context)) {
          const current = best.get(document);
          if (!current || hit.score > current.score) {
            best.set(document, hit);
          }
        }
      }
      return best;
    }
    case 'and': {
      let result: Hits | undefined;
      // Each child narrows the candidate set, so later children only combine with survivors.
      for (const child of plan.children) {
        if (result?.size === 0) break;
        const hits = executePlan(
          child,
          result === undefined ? context : { ...context, candidates: result },
        );
        if (result === undefined) {
          result = hits;
          continue;
        }
        const narrowed: Hits = new Map();
        for (const [document, hit] of result) {
          const other = hits.get(document);
          if (other) {
            narrowed.set(document, combine(hit, other));
          }
        }
        result = narrowed;
      }
      return exclude(result ?? new Map<number, Hit>(), plan.excluded, context);
    }
    case 'or': {
      const result: Hits = new Map();
      for (const child of plan.children) {
        for (const [document, hit] of executePlan(child, context)) {
          const current = result.get(document);
          result.set(document, current ? combine(current, hit) : hit);
        }
      }
      return exclude(result, plan.excluded, context);
    }
  }
}

function combine(a: Hit, b: Hit): Hit {
  return {
    score: a.score + b.score,
    trace: a.trace && b.trace ? [...a.trace, ...b.trace] : undefined,
  };
}

function exclude(hits: Hits, excluded: readonly Plan[], context: ExecutionContext): Hits {
  for (const plan of excluded) {
    if (hits.size === 0) break;
    for (const document of executePlan(plan, {
      ...context,
      candidates: hits,
      score: false,
    }).keys()) {
      hits.delete(document);
    }
  }
  return hits;
}

function executeMatch(plan: MatchPlan, context: ExecutionContext): Hits {
  if (context.only !== undefined) {
    return executeMatchOne(plan, context.only, context);
  }
  const occurrences = occurrencesOf(plan, context);
  const hits: Hits = new Map();
  if (occurrences.size === 0) {
    return hits;
  }
  const idf = inverseDocumentFrequency(context.documentCount, occurrences.size);
  // Keep full occurrences for global IDF and later explanations; only scoring is scoped.
  const candidates = context.candidates;
  if (!candidates) {
    // Preserve the direct entry iteration for unrestricted clauses.
    for (const [document, frequencies] of occurrences) {
      hits.set(
        document,
        scoreDocument(plan, document, frequencies, idf, occurrences.size, context),
      );
    }
    return hits;
  }
  const documents = candidates.size < occurrences.size ? candidates.keys() : occurrences.keys();
  for (const document of documents) {
    const frequencies = occurrences.get(document);
    if (frequencies && candidates.has(document)) {
      hits.set(
        document,
        scoreDocument(plan, document, frequencies, idf, occurrences.size, context),
      );
    }
  }
  return hits;
}

/**
 * Scores one document for one clause. Unless an occurrence table is already cached, a term
 * clause looks the document up in each target's postings and takes its document frequency from
 * `documentFrequency`, so explaining a few results never decodes whole postings lists.
 */
function executeMatchOne(plan: MatchPlan, document: number, context: ExecutionContext): Hits {
  const hits: Hits = new Map();
  if (context.candidates && !context.candidates.has(document)) return hits;
  const cached = context.cache.get(plan) ?? (isPhrase(plan) ? occurrencesOf(plan, context) : null);
  const frequencies = cached ? cached.get(document) : frequenciesAt(plan, document, context);
  if (frequencies) {
    const documentFrequency = cached ? cached.size : documentFrequencyOf(plan, context);
    const idf = inverseDocumentFrequency(context.documentCount, documentFrequency);
    hits.set(document, scoreDocument(plan, document, frequencies, idf, documentFrequency, context));
  }
  return hits;
}

/** Whether some target of the clause is a phrase, which needs positional matching. */
export function isPhrase(plan: MatchPlan): boolean {
  return plan.targets.some((target) => target.terms.length > 1);
}

/** The postings list of a single-term target, if the term occurs in the field. */
export function postingsOf(
  target: MatchTarget,
  context: ExecutionContext,
): PostingsList | undefined {
  return target.terms.length === 1
    ? at(context.fields, target.field).postings.get(at(target.terms, 0))
    : undefined;
}

/** Frequencies of a term clause's targets in one document, or undefined if none occurs. */
function frequenciesAt(
  plan: MatchPlan,
  document: number,
  context: ExecutionContext,
): number[] | undefined {
  const frequencies = plan.targets.map(
    (target) => postingsOf(target, context)?.frequency(document) ?? 0,
  );
  return frequencies.some((frequency) => frequency > 0) ? frequencies : undefined;
}

/**
 * Number of documents in which a clause matches at least one of its fields. For a term clause
 * this is the size of the union of its postings lists, which is counted without building an
 * occurrence table and remembered in `context.documentFrequencies`.
 */
export function documentFrequencyOf(plan: MatchPlan, context: ExecutionContext): number {
  const cached = context.cache.get(plan);
  if (cached) {
    return cached.size;
  }
  if (isPhrase(plan)) {
    return occurrencesOf(plan, context).size;
  }
  const known = context.documentFrequencies?.get(plan);
  if (known !== undefined) {
    return known;
  }
  const lists = plan.targets
    .map((target) => postingsOf(target, context))
    .filter((list) => list !== undefined);
  const size = unionSize(lists);
  context.documentFrequencies?.set(plan, size);
  return size;
}

/** BM25F for one clause and one document. */
function scoreDocument(
  plan: MatchPlan,
  document: number,
  frequencies: readonly number[],
  idf: number,
  documentFrequency: number,
  context: ExecutionContext,
): Hit {
  if (context.score === false) return { score: 0, trace: undefined };
  const lengths = context.documents.get(document)?.lengths ?? [];
  let pseudoFrequency = 0;
  const fields: FieldExplanation[] = [];
  plan.targets.forEach((target, t) => {
    const frequency = at(frequencies, t);
    if (frequency === 0) {
      return;
    }
    const field = at(context.fields, target.field);
    const length = lengths[target.field] ?? 0;
    const normalization = lengthNormalization(field.b, length, field.averageLength);
    const weightedFrequency = (field.boost * frequency) / normalization;
    pseudoFrequency += weightedFrequency;
    if (context.trace) {
      fields.push({
        field: field.name,
        terms: target.terms,
        frequency,
        length,
        averageLength: field.averageLength,
        boost: field.boost,
        b: field.b,
        weightedFrequency,
      });
    }
  });
  const score = plan.weight * idf * saturate(pseudoFrequency, context.k1);
  if (!context.trace) {
    return { score, trace: undefined };
  }
  const explanation: ClauseExplanation = {
    clause: plan.clause,
    terms: [...new Set(fields.flatMap((field) => field.terms))],
    documentFrequency,
    documentCount: context.documentCount,
    idf,
    frequency: pseudoFrequency,
    weight: plan.weight,
    score,
    fields,
  };
  return { score, trace: [{ plan, frequencies, explanation }] };
}

export function occurrencesOf(plan: MatchPlan, context: ExecutionContext): Occurrences {
  const cached = context.cache.get(plan);
  if (cached) {
    return cached;
  }
  const occurrences: Occurrences = new Map();
  plan.targets.forEach((target, t) => {
    for (const [document, frequency] of countTarget(at(context.fields, target.field), target)) {
      let row = occurrences.get(document);
      if (!row) {
        row = plan.targets.map(() => 0);
        occurrences.set(document, row);
      }
      row[t] = frequency;
    }
  });
  context.cache.set(plan, occurrences);
  return occurrences;
}

/** Documents in which a term or phrase occurs in one field, with the number of occurrences. */
function countTarget(field: FieldIndex, target: MatchTarget): Map<number, number> {
  const counts = new Map<number, number>();
  const lists = target.terms
    .map((term) => field.postings.get(term))
    .filter((postings) => postings !== undefined);
  if (lists.length < target.terms.length) {
    return counts; // some term never occurs in this field
  }
  const cursors = lists.map((list) => new PostingsCursor(list));
  if (cursors.length === 1) {
    const cursor = at(cursors, 0);
    for (let document = cursor.advance(0); document !== NO_MORE_DOCUMENTS;) {
      counts.set(document, cursor.frequency);
      document = cursor.advance(document + 1);
    }
    return counts;
  }
  // Drive the intersection from the rarest term: only its documents can contain the phrase.
  const rarest = cursors.reduce((best, cursor) =>
    cursor.list.count < best.list.count ? cursor : best,
  );
  const positions = cursors.map((): number[] => []);
  for (let document = rarest.advance(0); document !== NO_MORE_DOCUMENTS;) {
    let all = true;
    for (const cursor of cursors) {
      if (cursor.advance(document) !== document) {
        all = false;
        break;
      }
    }
    if (all) {
      for (let i = 0; i < cursors.length; i++) at(cursors, i).positions(at(positions, i));
      const count = countPhraseMatches(positions, target.offsets);
      if (count > 0) {
        counts.set(document, count);
      }
    }
    document = rarest.advance(document + 1);
  }
  return counts;
}

/**
 * Counts the start positions p at which term i occurs at p + offsets[i] for every i
 * (positional intersection). Every list is sorted and candidate starts only increase, so each
 * cursor moves forward only and the whole check is O(total number of positions).
 */
export function countPhraseMatches(
  positions: readonly (readonly number[])[],
  offsets: readonly number[],
): number {
  const [first, ...rest] = positions;
  if (!first) {
    return 0;
  }
  const cursors = rest.map(() => 0);
  let count = 0;
  for (const start of first) {
    let matched = true;
    for (const [i, list] of rest.entries()) {
      const wanted = start + at(offsets, i + 1);
      let cursor = at(cursors, i);
      while (cursor < list.length && at(list, cursor) < wanted) {
        cursor++;
      }
      cursors[i] = cursor;
      if (cursor === list.length) {
        // This term has no position left at or after `wanted`, and later starts need even
        // larger positions, so no further match is possible.
        return count;
      }
      if (at(list, cursor) !== wanted) {
        matched = false;
        break;
      }
    }
    if (matched) {
      count++;
    }
  }
  return count;
}
