import { normalizeText } from '../analysis/normalize';
import { tokenize } from '../analysis/tokenizer';
import { QuerySyntaxError } from '../errors';
import { at } from '../internal/at';
import type { FuzzyNode, LeafNode, PrefixNode, QueryNode } from '../query/ast';
import type { FieldIndex } from './field-index';

/** What one leaf looks for in one field: a single term, or a phrase of terms. */
export interface MatchTarget {
  /** Index of the field in the index's field list. */
  field: number;
  /** Analyzed terms in query order. A plain term has exactly one. */
  terms: string[];
  /** Position of each term relative to the first, so stopword gaps are preserved. */
  offsets: number[];
}

/**
 * A scored leaf. Its targets are combined BM25F-style: the frequencies found in each field are
 * weighted and length-normalized, summed, and saturated once.
 */
export interface MatchPlan {
  kind: 'match';
  /** The query clause as the user wrote it, e.g. `title:heap` or `"binary heap"`. */
  clause: string;
  targets: MatchTarget[];
  /** Multiplier on the clause's score: 1, or 1 / (1 + edits) for a fuzzy expansion. */
  weight: number;
}

/**
 * The expansions of one prefix or fuzzy word. They are alternatives for a single query word, so
 * a document scores with its best expansion instead of the sum of all of them; otherwise a
 * document mentioning "data", "database" and "dataset" would beat one that is about databases.
 */
export interface AlternativesPlan {
  kind: 'alternatives';
  clause: string;
  children: MatchPlan[];
}

/**
 * AND/OR over `children`, minus every document matching an `excluded` plan. A group with no
 * positive children matches nothing, so a query of only exclusions returns no results.
 */
export interface BooleanPlan {
  kind: 'and' | 'or';
  children: Plan[];
  excluded: Plan[];
}

export type Plan = MatchPlan | AlternativesPlan | BooleanPlan;

export interface CompileContext {
  /** The original query string, for error messages. */
  query: string;
  fields: readonly FieldIndex[];
  /** Fields searched by leaves that have no `field:` prefix. */
  defaultFields: readonly number[];
  /** Upper bound on the dictionary terms one prefix or fuzzy word expands to, per field. */
  maxExpansions: number;
}

/**
 * Turns a parsed query into an executable plan: analyzes every leaf with each field's analyzer
 * and expands prefix and fuzzy words against the term dictionaries.
 *
 * Returns `null` when nothing is left to search, for example when the query consists only of
 * stopwords. Clauses that analyze to nothing are dropped, so "the AND heap" searches for "heap".
 */
export function compileQuery(node: QueryNode, context: CompileContext): Plan | null {
  switch (node.type) {
    case 'term':
    case 'phrase':
      return compileMatch(node, context);
    case 'prefix':
      return compilePrefix(node, context);
    case 'fuzzy':
      return compileFuzzy(node, context);
    case 'not': {
      // A NOT outside any group only excludes, so it can never produce results.
      const excluded = compileQuery(node.child, context);
      return excluded ? { kind: 'and', children: [], excluded: [excluded] } : null;
    }
    case 'and':
    case 'or': {
      const children: Plan[] = [];
      const excluded: Plan[] = [];
      for (const child of node.children) {
        const plan = compileQuery(child.type === 'not' ? child.child : child, context);
        if (plan) {
          (child.type === 'not' ? excluded : children).push(plan);
        }
      }
      if (children.length === 0 && excluded.length === 0) {
        return null;
      }
      const [only] = children;
      if (only && children.length === 1 && excluded.length === 0) {
        return only;
      }
      return { kind: node.type, children, excluded };
    }
  }
}

function clauseText(node: LeafNode): string {
  const prefix = node.field === undefined ? '' : `${node.field}:`;
  switch (node.type) {
    case 'phrase':
      return `${prefix}"${node.text}"`;
    case 'prefix':
      return `${prefix}${node.text}*`;
    case 'fuzzy':
      return `${prefix}${node.text}~${node.maxEdits}`;
    case 'term':
      return `${prefix}${node.text}`;
  }
}

function fieldsFor(node: LeafNode, context: CompileContext): readonly number[] {
  if (node.field === undefined) {
    return context.defaultFields;
  }
  const index = context.fields.findIndex((field) => field.name === node.field);
  if (index === -1) {
    const known = context.fields.map((field) => field.name).join(', ');
    throw new QuerySyntaxError(
      `Unknown field "${node.field}"; searchable fields are: ${known}`,
      context.query,
      node.start,
    );
  }
  return [index];
}

/**
 * Terms and phrases. Each field analyzes the text with its own analyzer, so a word can become
 * the stem "run" in a stemmed field and stay "running" in an unstemmed one. A word that the
 * tokenizer splits ("real-time") becomes a phrase.
 */
function compileMatch(node: LeafNode, context: CompileContext): MatchPlan | null {
  const targets: MatchTarget[] = [];
  for (const field of fieldsFor(node, context)) {
    const tokens = at(context.fields, field).analyzer.analyze(node.text);
    const first = tokens[0];
    if (first) {
      targets.push({
        field,
        terms: tokens.map((token) => token.term),
        offsets: tokens.map((token) => token.position - first.position),
      });
    }
  }
  return targets.length === 0
    ? null
    : { kind: 'match', clause: clauseText(node), targets, weight: 1 };
}

/** The single word inside a prefix or fuzzy leaf; expanding several words is ambiguous. */
function singleWord(node: PrefixNode | FuzzyNode, context: CompileContext): string {
  const words = tokenize(node.text);
  const [word] = words;
  if (!word || words.length > 1) {
    const operator = node.type === 'prefix' ? '*' : '~';
    throw new QuerySyntaxError(
      `"${operator}" applies to a single word, but "${node.text}" is not one`,
      context.query,
      node.start,
    );
  }
  return word.text;
}

/** Collects expansions as term → (field → edit distance). */
type Expansions = Map<string, Map<number, number>>;

function addExpansion(expansions: Expansions, term: string, field: number, distance: number): void {
  let fields = expansions.get(term);
  if (!fields) {
    fields = new Map();
    expansions.set(term, fields);
  }
  fields.set(field, Math.min(distance, fields.get(field) ?? distance));
}

function alternatives(
  node: PrefixNode | FuzzyNode,
  expansions: Expansions,
  weightFor: (distance: number) => number,
): AlternativesPlan {
  const clause = clauseText(node);
  const children: MatchPlan[] = [];
  for (const [term, fields] of expansions) {
    const distance = Math.min(...fields.values());
    children.push({
      kind: 'match',
      clause,
      targets: [...fields.keys()].map((field) => ({ field, terms: [term], offsets: [0] })),
      weight: weightFor(distance),
    });
  }
  return { kind: 'alternatives', clause, children };
}

/**
 * `word*` matches every term that starts with the normalized word. It also matches the word's
 * own stem: the index stores "relat" for "relational", so without this "relational*" would
 * miss documents that contain exactly "relational".
 */
function compilePrefix(node: PrefixNode, context: CompileContext): AlternativesPlan {
  const word = singleWord(node, context);
  const prefix = normalizeText(word);
  const expansions: Expansions = new Map();
  for (const index of fieldsFor(node, context)) {
    const field = at(context.fields, index);
    for (const term of field.dictionary.withPrefix(prefix, context.maxExpansions)) {
      addExpansion(expansions, term, index, 0);
    }
    const stem = field.analyzer.analyzeWord(word);
    if (field.postings.has(stem)) {
      addExpansion(expansions, stem, index, 0);
    }
  }
  return alternatives(node, expansions, () => 1);
}

/**
 * `word~N` matches terms within N edits of the analyzed word. The word is stemmed first because
 * the dictionary holds stems; a closer match scores higher through a weight of 1 / (1 + edits).
 */
function compileFuzzy(node: FuzzyNode, context: CompileContext): AlternativesPlan {
  const word = singleWord(node, context);
  const expansions: Expansions = new Map();
  for (const index of fieldsFor(node, context)) {
    const field = at(context.fields, index);
    const matches = field.dictionary.fuzzy(field.analyzer.analyzeWord(word), node.maxEdits);
    for (const { term, distance } of matches.slice(0, context.maxExpansions)) {
      addExpansion(expansions, term, index, distance);
    }
  }
  return alternatives(node, expansions, (distance) => 1 / (1 + distance));
}
