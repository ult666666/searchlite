/**
 * Typed syntax tree produced by `parseQuery`. Leaves remember where they came from in the query
 * string (`start`/`end`, 0-based UTF-16 offsets) so errors and user interfaces can point at them.
 */
export type QueryNode = TermNode | PhraseNode | PrefixNode | FuzzyNode | AndNode | OrNode | NotNode;

/** Fields shared by every leaf. */
export interface LeafBase {
  /** The raw text of the word or phrase, without quotes or operators. */
  text: string;
  /** Field the leaf is restricted to (`title:heap`), or undefined to search every field. */
  field?: string;
  /** Offset of the word or phrase in the query string (after any `field:` prefix). */
  start: number;
  /** Offset just past the leaf's last character. */
  end: number;
}

/** A bare word such as `heap`. Words that analysis splits in two (`real-time`) act as phrases. */
export interface TermNode extends LeafBase {
  type: 'term';
}

/** A quoted phrase such as `"binary heap"`: the words must appear next to each other. */
export interface PhraseNode extends LeafBase {
  type: 'phrase';
}

/** A word ending in `*`, matching every term that starts with it. `text` excludes the `*`. */
export interface PrefixNode extends LeafBase {
  type: 'prefix';
}

/** A word ending in `~N`, matching terms within N edits. `text` excludes the `~N`. */
export interface FuzzyNode extends LeafBase {
  type: 'fuzzy';
  /** Maximum optimal-string-alignment distance: 0, 1 or 2. */
  maxEdits: number;
}

/** All children must match. */
export interface AndNode {
  type: 'and';
  children: QueryNode[];
}

/** At least one child must match. */
export interface OrNode {
  type: 'or';
  children: QueryNode[];
}

/**
 * Excludes documents matching `child` from the enclosing AND/OR group. NOT never matches
 * anything on its own: `-draft` alone returns no results, like Lucene.
 */
export interface NotNode {
  type: 'not';
  child: QueryNode;
}

/** Leaf node types. */
export type LeafNode = TermNode | PhraseNode | PrefixNode | FuzzyNode;
