import { at } from '../internal/at';
import { TopK } from '../structures/top-k';
import { inverseDocumentFrequency, lengthNormalization, saturate } from './bm25';
import {
  documentFrequencyOf,
  executePlan,
  isPhrase,
  occurrencesOf,
  postingsOf,
  type ExecutionContext,
  type Occurrences,
} from './execute';
import type { FieldIndex } from './field-index';
import type { MatchPlan, Plan } from './plan';
import { BLOCK_SIZE, NO_MORE_DOCUMENTS, PostingsCursor } from './postings';

/**
 * Document-at-a-time top-k evaluation with MaxScore and block-max upper bounds.
 *
 * Every clause becomes a {@link Scorer}: a cursor over its matching documents in ascending order
 * that can also report an upper bound on its score for a range of documents. A top-level OR runs
 * the MaxScore algorithm (Turtle and Flood, 1995) in windows, as Lucene's MaxScoreBulkScorer does:
 * per window, the clauses whose summed upper bounds cannot beat the current k-th best score are
 * "non-essential", candidates come only from the essential clauses, and the non-essential clauses
 * are consulted, highest bound first, only while the candidate can still beat that score. The
 * bounds come from each block's impacts (block-max, Ding and Suel, 2011), so a window in which no
 * clause can compete is skipped without decoding it.
 *
 * Results equal exhaustive evaluation exactly: the same documents, in the same order, with the
 * same scores bit for bit. Each candidate that is scored is scored by the same arithmetic, in the
 * same order, as the term-at-a-time executor. Pruning only drops a document when an upper bound
 * proves it cannot enter the top k, and bounds carry a relative margin of
 * {@link BOUND_MARGIN} so that floating-point rounding can never turn a competitive document into
 * a pruned one. Documents are visited in ascending order and a later document never beats an
 * earlier one with the same score, so ties are broken by insertion order, as before.
 */

/** Relative safety margin applied to every upper bound before it is compared with a score. */
export const BOUND_MARGIN = 1e-9;
/** Absolute margin, so that bounds in the subnormal range never prune. */
const BOUND_FLOOR = 1e-300;

/** Whether a document whose score is at most `bound` might still beat `threshold`. */
function mayCompete(bound: number, threshold: number): boolean {
  return bound * (1 + BOUND_MARGIN) + BOUND_FLOOR > threshold;
}

/** A clause or Boolean group, iterated in document order. */
interface Scorer {
  /** Current document: -1 before the first `advance`, NO_MORE_DOCUMENTS when exhausted. */
  document: number;
  /** Moves to the first matching document at or after `target` and returns it. */
  advance(target: number): number;
  /** The exact score of the current document, as the term-at-a-time executor computes it. */
  score(): number;
  /**
   * Computes `bound`, an upper bound on the score of any document from `target` up to the
   * returned document number. Targets must not decrease from one call to the next.
   */
  shallow(target: number): number;
  bound: number;
  /** Upper bound on the score of every document. */
  readonly maxScore: number;
  /** Estimated number of matches, used to pick the leading clause of a conjunction. */
  readonly cost: number;
}

/** Counters that tests and diagnostics can pass in to see how much work pruning saved. */
export interface PruningStatistics {
  /** Documents whose exact score was computed. */
  scored: number;
  /** Windows skipped because no document in them could enter the top k. */
  skippedWindows: number;
}

type Entry = [document: number, score: number];

const better = ([documentA, scoreA]: Entry, [documentB, scoreB]: Entry): boolean =>
  scoreA > scoreB || (scoreA === scoreB && documentA < documentB);

/**
 * The best `limit` documents for `plan`, best first, as [document number, score] pairs. `accept`
 * (a filter) is asked only about documents that would otherwise enter the results; rejected
 * documents never raise the score a later document must beat.
 */
export function topDocuments(
  plan: Plan,
  context: ExecutionContext,
  limit: number,
  accept?: (document: number) => boolean,
  statistics?: PruningStatistics,
): Entry[] {
  const top = new TopK<Entry>(limit, better);
  const offer = (document: number, score: number, excluded: readonly Scorer[]): void => {
    const entry: Entry = [document, score];
    if (top.accepts(entry) && !isExcluded(excluded, document) && (accept?.(document) ?? true)) {
      top.push(entry);
    }
  };
  const group = plan.kind === 'and' || plan.kind === 'or' ? plan : undefined;
  const built = group
    ? group.children.map((child) => build(child, context, true))
    : [build(plan, context, true)];
  const children = built.filter((child) => child !== EMPTY);
  if (children.length === 0 || (group?.kind === 'and' && children.length < built.length)) {
    return [];
  }
  // Absurd parameters (a huge k1 or boost) can make bounds infinite or NaN; score exhaustively.
  if (!children.every((child) => Number.isFinite(child.maxScore))) {
    for (const [document, hit] of executePlan(plan, context)) {
      offer(document, hit.score, []);
    }
    return top.sorted();
  }
  const excluded = (group?.excluded ?? [])
    .map((child) => build(child, context, false))
    .filter((scorer) => scorer.document !== NO_MORE_DOCUMENTS);
  if (group?.kind === 'or' && children.length > 1) {
    collectDisjunction(
      children,
      top,
      (document, score) => {
        offer(document, score, excluded);
      },
      statistics,
    );
  } else {
    collectSingle(
      conjunction(children),
      top,
      (document, score) => {
        offer(document, score, excluded);
      },
      statistics,
    );
  }
  return top.sorted();
}

function isExcluded(excluded: readonly Scorer[], document: number): boolean {
  for (const scorer of excluded) {
    if (scorer.advance(document) === document) {
      return true;
    }
  }
  return false;
}

function threshold(top: TopK<Entry>): number {
  return top.threshold?.[1] ?? Number.NEGATIVE_INFINITY;
}

/** Top k over one scorer, skipping every window whose bound cannot beat the k-th best score. */
function collectSingle(
  scorer: Scorer,
  top: TopK<Entry>,
  offer: (document: number, score: number) => void,
  statistics: PruningStatistics | undefined,
): void {
  let windowMin = 0;
  while (windowMin !== NO_MORE_DOCUMENTS) {
    const windowMax = scorer.shallow(windowMin);
    if (!mayCompete(scorer.bound, threshold(top))) {
      // Skipping only moves the shallow pointers: no block in this window is decoded.
      if (statistics) statistics.skippedWindows++;
    } else {
      for (
        let document = scorer.advance(windowMin);
        document <= windowMax && document !== NO_MORE_DOCUMENTS;
        document = scorer.advance(document + 1)
      ) {
        if (statistics) statistics.scored++;
        offer(document, scorer.score());
      }
    }
    windowMin = windowMax + 1;
  }
}

/**
 * MaxScore over the children of a top-level OR, one window at a time. A window ends at the first
 * block boundary of any child, so every child's block-max bound holds for the whole window.
 */
function collectDisjunction(
  children: readonly Scorer[],
  top: TopK<Entry>,
  offer: (document: number, score: number) => void,
  statistics: PruningStatistics | undefined,
): void {
  const count = children.length;
  const bounds = new Float64Array(count);
  const scores = new Float64Array(count);
  const matched = new Uint8Array(count);
  const order = children.map((_, i) => i);
  // prefix[j] = sum of the j smallest bounds in this window.
  const prefix = new Float64Array(count + 1);
  let windowMin = 0;
  while (windowMin !== NO_MORE_DOCUMENTS) {
    let windowMax = NO_MORE_DOCUMENTS;
    children.forEach((child, i) => {
      windowMax = Math.min(windowMax, child.shallow(windowMin));
      bounds[i] = child.bound;
    });
    order.sort((a, b) => (bounds[a] ?? 0) - (bounds[b] ?? 0) || a - b);
    for (let j = 0; j < count; j++) {
      prefix[j + 1] = (prefix[j] ?? 0) + (bounds[at(order, j)] ?? 0);
    }
    let theta = threshold(top);
    let essential = firstEssential(prefix, count, theta);
    if (essential === count) {
      if (statistics) statistics.skippedWindows++;
    }
    while (essential < count) {
      // The next candidate is the smallest current document of an essential child.
      let document = NO_MORE_DOCUMENTS;
      for (let j = essential; j < count; j++) {
        const child = at(children, at(order, j));
        document = Math.min(document, child.advance(windowMin));
      }
      if (document > windowMax || document === NO_MORE_DOCUMENTS) {
        break;
      }
      let bound = prefix[essential] ?? 0;
      for (let j = essential; j < count; j++) {
        const i = at(order, j);
        if (at(children, i).document === document) bound += bounds[i] ?? 0;
      }
      if (mayCompete(bound, theta)) {
        const score = scoreCandidate(children, order, essential, document, theta, {
          bounds,
          scores,
          matched,
          prefix,
        });
        if (score !== undefined) {
          if (statistics) statistics.scored++;
          offer(document, score);
        }
      }
      windowMin = document + 1;
      const updated = threshold(top);
      if (updated !== theta) {
        theta = updated;
        essential = firstEssential(prefix, count, theta);
      }
    }
    windowMin = windowMax + 1;
  }
}

/** Index in `order` of the first essential child: the earlier ones together cannot compete. */
function firstEssential(prefix: Float64Array, count: number, theta: number): number {
  let essential = 0;
  while (essential < count && !mayCompete(prefix[essential + 1] ?? 0, theta)) {
    essential++;
  }
  return essential;
}

/**
 * Scores the essential children positioned on `document`, then the non-essential ones from the
 * highest bound down, giving up as soon as the partial score plus the remaining bounds cannot
 * beat `theta`. The returned score adds the children in query order, exactly as term-at-a-time
 * execution does; undefined means the document was pruned.
 */
function scoreCandidate(
  children: readonly Scorer[],
  order: readonly number[],
  essential: number,
  document: number,
  theta: number,
  work: { bounds: Float64Array; scores: Float64Array; matched: Uint8Array; prefix: Float64Array },
): number | undefined {
  const { scores, matched, prefix } = work;
  let partial = 0;
  for (let j = essential; j < order.length; j++) {
    const i = at(order, j);
    const child = at(children, i);
    matched[i] = child.document === document ? 1 : 0;
    if (matched[i]) {
      scores[i] = child.score();
      partial += scores[i] ?? 0;
    }
  }
  for (let j = essential - 1; j >= 0; j--) {
    if (!mayCompete(partial + (prefix[j + 1] ?? 0), theta)) {
      return undefined;
    }
    const i = at(order, j);
    const child = at(children, i);
    matched[i] = child.advance(document) === document ? 1 : 0;
    if (matched[i]) {
      scores[i] = child.score();
      partial += scores[i] ?? 0;
    }
  }
  let total = 0;
  let any = false;
  for (let i = 0; i < children.length; i++) {
    if (matched[i]) {
      total = any ? total + (scores[i] ?? 0) : (scores[i] ?? 0);
      any = true;
    }
  }
  return total;
}

/** Builds the scorer for a plan. `scoring` is false for exclusions, which only need membership. */
function build(plan: Plan, context: ExecutionContext, scoring: boolean): Scorer {
  switch (plan.kind) {
    case 'match':
      return clause(plan, context, scoring);
    case 'alternatives': {
      const children = plan.children
        .map((child) => clause(child, context, scoring))
        .filter((child) => child !== EMPTY);
      return children.length <= 1 ? (children[0] ?? EMPTY) : new MaxScorer(children);
    }
    case 'and':
    case 'or': {
      const built = plan.children.map((child) => build(child, context, scoring));
      const children = built.filter((child) => child !== EMPTY);
      if (children.length === 0 || (plan.kind === 'and' && children.length < built.length)) {
        return EMPTY;
      }
      const base =
        children.length === 1
          ? at(children, 0)
          : plan.kind === 'and'
            ? conjunction(children)
            : new SumScorer(children);
      const excluded = plan.excluded
        .map((child) => build(child, context, false))
        .filter((child) => child !== EMPTY);
      return excluded.length === 0 ? base : new ExclusionScorer(base, excluded);
    }
  }
}

function conjunction(children: readonly Scorer[]): Scorer {
  return children.length === 1 ? at(children, 0) : new ConjunctionScorer(children);
}

/** BM25F weight of a block: the best boost · tf / B over its (frequency, length) impacts. */
function blockWeight(cursor: PostingsCursor, block: number, field: FieldIndex): number {
  const list = cursor.list;
  const [start, end] = list.impactRange(block);
  const impacts = list.meta;
  const averageLength = field.averageLength;
  let best = 0;
  for (let i = start; i < end; i += 2) {
    const normalization = lengthNormalization(field.b, impacts[i + 1] ?? 0, averageLength);
    best = Math.max(best, (field.boost * (impacts[i] ?? 0)) / normalization);
  }
  return best;
}

function clause(plan: MatchPlan, context: ExecutionContext, scoring: boolean): Scorer {
  if (isPhrase(plan)) {
    const occurrences = occurrencesOf(plan, context);
    if (occurrences.size === 0) {
      return EMPTY;
    }
    return new PhraseScorer(plan, occurrences, context, scoring);
  }
  const cursors: PostingsCursor[] = [];
  const fields: FieldIndex[] = [];
  for (const target of plan.targets) {
    const list = postingsOf(target, context);
    if (list) {
      cursors.push(new PostingsCursor(list));
      fields.push(at(context.fields, target.field));
    }
  }
  if (cursors.length === 0) {
    return EMPTY;
  }
  const weightIdf = scoring
    ? plan.weight *
      inverseDocumentFrequency(context.documentCount, documentFrequencyOf(plan, context))
    : 0;
  return new TermScorer(cursors, fields, weightIdf, context.k1, scoring);
}

/**
 * A term clause: the union of its targets' postings lists, scored with BM25F. The score adds
 * the weighted frequencies of the targets in query order and saturates once, exactly like
 * `scoreDocument`.
 */
class TermScorer implements Scorer {
  document = -1;
  bound = 0;
  readonly maxScore: number;
  readonly cost: number;
  readonly #cursors: PostingsCursor[];
  readonly #fields: FieldIndex[];
  readonly #averageLengths: number[];
  /** plan.weight · idf, multiplied first as in `scoreDocument`. */
  readonly #weightIdf: number;
  readonly #k1: number;
  readonly #blocks: number[];
  readonly #weights: number[];

  constructor(
    cursors: PostingsCursor[],
    fields: FieldIndex[],
    weightIdf: number,
    k1: number,
    scoring: boolean,
  ) {
    this.#cursors = cursors;
    this.#fields = fields;
    this.#averageLengths = fields.map((field) => field.averageLength);
    this.#weightIdf = weightIdf;
    this.#k1 = k1;
    this.#blocks = cursors.map(() => -1);
    this.#weights = cursors.map(() => 0);
    this.cost = cursors.reduce((sum, cursor) => sum + cursor.list.count, 0);
    let pseudoFrequency = 0;
    if (scoring) {
      cursors.forEach((cursor, c) => {
        let best = 0;
        for (let block = 0; block < cursor.list.blockCount; block++) {
          best = Math.max(best, blockWeight(cursor, block, at(fields, c)));
        }
        pseudoFrequency += best;
      });
    }
    this.maxScore = scoring ? weightIdf * saturate(pseudoFrequency, k1) : 0;
  }

  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    let document = NO_MORE_DOCUMENTS;
    for (const cursor of this.#cursors) {
      const current = cursor.document < target ? cursor.advance(target) : cursor.document;
      if (current < document) document = current;
    }
    this.document = document;
    return document;
  }

  score(): number {
    const document = this.document;
    let pseudoFrequency = 0;
    const cursors = this.#cursors;
    for (let c = 0; c < cursors.length; c++) {
      const cursor = at(cursors, c);
      if (cursor.document === document) {
        const field = at(this.#fields, c);
        const normalization = lengthNormalization(
          field.b,
          field.lengths[document] ?? 0,
          this.#averageLengths[c] ?? 0,
        );
        pseudoFrequency += (field.boost * cursor.frequency) / normalization;
      }
    }
    return this.#weightIdf * saturate(pseudoFrequency, this.#k1);
  }

  shallow(target: number): number {
    let end = NO_MORE_DOCUMENTS;
    let pseudoFrequency = 0;
    const cursors = this.#cursors;
    for (let c = 0; c < cursors.length; c++) {
      const cursor = at(cursors, c);
      const block = cursor.shallow(target);
      if (block < 0) continue;
      if (block !== this.#blocks[c]) {
        this.#blocks[c] = block;
        this.#weights[c] = blockWeight(cursor, block, at(this.#fields, c));
      }
      pseudoFrequency += this.#weights[c] ?? 0;
      end = Math.min(end, cursor.list.blockLast(block));
    }
    this.bound = pseudoFrequency === 0 ? 0 : this.#weightIdf * saturate(pseudoFrequency, this.#k1);
    return end;
  }
}

/**
 * A clause with a phrase target, whose matches were computed up front: a phrase's document
 * frequency needs positional matching in every document anyway. Scores are computed only for
 * documents that get scored, with the same arithmetic as `scoreDocument` but without allocating.
 * Each run of 128 matches keeps the largest weighted frequency of each target as its bound.
 */
class PhraseScorer implements Scorer {
  document = -1;
  bound = 0;
  readonly maxScore: number;
  readonly cost: number;
  readonly #occurrences: Occurrences;
  readonly #documents: Float64Array;
  readonly #fields: FieldIndex[];
  readonly #averageLengths: number[];
  readonly #weightIdf: number;
  readonly #k1: number;
  readonly #chunkBounds: number[] = [];
  #index = -1;
  #chunk = 0;

  constructor(
    plan: MatchPlan,
    occurrences: Occurrences,
    context: ExecutionContext,
    scoring: boolean,
  ) {
    this.#occurrences = occurrences;
    this.#documents = Float64Array.from(occurrences.keys()).sort();
    this.#fields = plan.targets.map((target) => at(context.fields, target.field));
    this.#averageLengths = this.#fields.map((field) => field.averageLength);
    this.#weightIdf =
      plan.weight * inverseDocumentFrequency(context.documentCount, occurrences.size);
    this.#k1 = context.k1;
    this.cost = occurrences.size;
    const documents = this.#documents;
    const best = this.#fields.map(() => 0);
    for (let start = 0; scoring && start < documents.length; start += BLOCK_SIZE) {
      best.fill(0);
      for (let i = start; i < Math.min(start + BLOCK_SIZE, documents.length); i++) {
        const frequencies = occurrences.get(documents[i] ?? 0) ?? [];
        for (let t = 0; t < best.length; t++) {
          best[t] = Math.max(best[t] ?? 0, this.#weighted(t, documents[i] ?? 0, frequencies));
        }
      }
      const pseudoFrequency = best.reduce((sum, value) => sum + value, 0);
      this.#chunkBounds.push(this.#weightIdf * saturate(pseudoFrequency, this.#k1));
    }
    this.maxScore = Math.max(0, ...this.#chunkBounds);
  }

  /** boost · frequency / B for one target, as `scoreDocument` computes it; 0 if absent. */
  #weighted(target: number, document: number, frequencies: readonly number[]): number {
    const frequency = frequencies[target] ?? 0;
    if (frequency === 0) {
      return 0;
    }
    const field = at(this.#fields, target);
    const length = field.lengths[document] ?? 0;
    const normalization = lengthNormalization(field.b, length, this.#averageLengths[target] ?? 0);
    return (field.boost * frequency) / normalization;
  }

  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    const documents = this.#documents;
    let index = this.#index + 1;
    while (index < documents.length && (documents[index] ?? 0) < target) {
      index++;
    }
    this.#index = index;
    this.document = documents[index] ?? NO_MORE_DOCUMENTS;
    return this.document;
  }

  score(): number {
    const document = this.document;
    const frequencies = this.#occurrences.get(document) ?? [];
    let pseudoFrequency = 0;
    for (let t = 0; t < this.#fields.length; t++) {
      if ((frequencies[t] ?? 0) > 0) {
        pseudoFrequency += this.#weighted(t, document, frequencies);
      }
    }
    return this.#weightIdf * saturate(pseudoFrequency, this.#k1);
  }

  shallow(target: number): number {
    const documents = this.#documents;
    const chunks = this.#chunkBounds.length;
    const lastOf = (chunk: number) =>
      documents[Math.min((chunk + 1) * BLOCK_SIZE, documents.length) - 1] ?? 0;
    let chunk = this.#chunk;
    while (chunk < chunks && lastOf(chunk) < target) {
      chunk++;
    }
    this.#chunk = chunk;
    if (chunk >= chunks) {
      this.bound = 0;
      return NO_MORE_DOCUMENTS;
    }
    this.bound = this.#chunkBounds[chunk] ?? 0;
    return lastOf(chunk);
  }
}

/** Shared iteration for scorers over several children: the current document is their minimum. */
abstract class UnionScorer implements Scorer {
  document = -1;
  bound = 0;
  abstract readonly maxScore: number;
  readonly cost: number;
  protected readonly children: readonly Scorer[];

  constructor(children: readonly Scorer[]) {
    this.children = children;
    this.cost = children.reduce((sum, child) => sum + child.cost, 0);
  }

  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    let document = NO_MORE_DOCUMENTS;
    for (const child of this.children) {
      const current = child.document < target ? child.advance(target) : child.document;
      if (current < document) document = current;
    }
    this.document = document;
    return document;
  }

  abstract score(): number;
  abstract shallow(target: number): number;
}

/** The expansions of a prefix or fuzzy word: a document scores with its best expansion. */
class MaxScorer extends UnionScorer {
  readonly maxScore: number;

  constructor(children: readonly Scorer[]) {
    super(children);
    this.maxScore = Math.max(...children.map((child) => child.maxScore));
  }

  score(): number {
    let best: number | undefined;
    for (const child of this.children) {
      if (child.document === this.document) {
        const score = child.score();
        if (best === undefined || score > best) best = score;
      }
    }
    return best ?? 0;
  }

  shallow(target: number): number {
    let end = NO_MORE_DOCUMENTS;
    let bound = 0;
    for (const child of this.children) {
      end = Math.min(end, child.shallow(target));
      bound = Math.max(bound, child.bound);
    }
    this.bound = bound;
    return end;
  }
}

/** A nested OR: the scores of the children that match are added in query order. */
class SumScorer extends UnionScorer {
  readonly maxScore: number;

  constructor(children: readonly Scorer[]) {
    super(children);
    this.maxScore = children.reduce((sum, child) => sum + child.maxScore, 0);
  }

  score(): number {
    let total = 0;
    let any = false;
    for (const child of this.children) {
      if (child.document === this.document) {
        total = any ? total + child.score() : child.score();
        any = true;
      }
    }
    return total;
  }

  shallow(target: number): number {
    let end = NO_MORE_DOCUMENTS;
    let bound = 0;
    for (const child of this.children) {
      end = Math.min(end, child.shallow(target));
      bound += child.bound;
    }
    this.bound = bound;
    return end;
  }
}

/** AND: leapfrog intersection led by the cheapest child; scores add in query order. */
class ConjunctionScorer implements Scorer {
  document = -1;
  bound = 0;
  readonly maxScore: number;
  readonly cost: number;
  readonly #children: readonly Scorer[];
  readonly #byCost: readonly Scorer[];

  constructor(children: readonly Scorer[]) {
    this.#children = children;
    this.#byCost = [...children].sort((a, b) => a.cost - b.cost);
    this.cost = Math.min(...children.map((child) => child.cost));
    this.maxScore = children.reduce((sum, child) => sum + child.maxScore, 0);
  }

  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    let document = target;
    for (;;) {
      let agreed = true;
      for (const child of this.#byCost) {
        const current = child.document < document ? child.advance(document) : child.document;
        if (current !== document) {
          document = current;
          agreed = false;
          break;
        }
      }
      if (agreed || document === NO_MORE_DOCUMENTS) {
        this.document = document;
        return document;
      }
    }
  }

  score(): number {
    let total = 0;
    this.#children.forEach((child, i) => {
      total = i === 0 ? child.score() : total + child.score();
    });
    return total;
  }

  shallow(target: number): number {
    let end = NO_MORE_DOCUMENTS;
    let bound = 0;
    for (const child of this.#children) {
      end = Math.min(end, child.shallow(target));
      bound += child.bound;
    }
    this.bound = bound;
    return end;
  }
}

/** A group with exclusions: its base's documents minus those matched by any excluded plan. */
class ExclusionScorer implements Scorer {
  document = -1;
  bound = 0;
  readonly maxScore: number;
  readonly cost: number;
  readonly #base: Scorer;
  readonly #excluded: readonly Scorer[];

  constructor(base: Scorer, excluded: readonly Scorer[]) {
    this.#base = base;
    this.#excluded = excluded;
    this.maxScore = base.maxScore;
    this.cost = base.cost;
  }

  advance(target: number): number {
    if (target <= this.document) {
      return this.document;
    }
    let document = this.#base.advance(target);
    while (document !== NO_MORE_DOCUMENTS && isExcluded(this.#excluded, document)) {
      document = this.#base.advance(document + 1);
    }
    this.document = document;
    return document;
  }

  score(): number {
    return this.#base.score();
  }

  shallow(target: number): number {
    const end = this.#base.shallow(target);
    this.bound = this.#base.bound;
    return end;
  }
}

/** Matches nothing. */
const EMPTY: Scorer = {
  document: NO_MORE_DOCUMENTS,
  bound: 0,
  maxScore: 0,
  cost: 0,
  advance: () => NO_MORE_DOCUMENTS,
  score: () => 0,
  shallow: () => NO_MORE_DOCUMENTS,
};
