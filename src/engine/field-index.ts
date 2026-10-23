import type { Analyzer } from '../analysis/analyzer';
import { Trie } from '../structures/trie';

/** Postings for one term in one field: document number → sorted positions of the term. */
export type Postings = Map<number, number[]>;

/**
 * The inverted index and statistics for one field.
 *
 * - `postings` maps each term to the documents containing it and the positions where it
 *   occurs. The number of positions is the term frequency; the positions themselves are what
 *   phrase matching needs.
 * - `dictionary` holds the same terms in a trie for prefix and fuzzy expansion.
 * - `totalLength` and `documentCount` give the average field length used by BM25's length
 *   normalization. They are updated on every add and remove, so scores never depend on stale
 *   statistics.
 */
export class FieldIndex {
  readonly name: string;
  /** BM25F weight w_f applied to this field's term frequencies. */
  readonly boost: number;
  /** BM25F length normalization b_f for this field. */
  readonly b: number;
  readonly analyzer: Analyzer;
  readonly postings = new Map<string, Postings>();
  readonly dictionary = new Trie();
  /** Sum of this field's length, in tokens, over all documents. */
  totalLength = 0;
  /** Number of documents in which this field has at least one token. */
  documentCount = 0;

  constructor(name: string, boost: number, b: number, analyzer: Analyzer) {
    this.name = name;
    this.boost = boost;
    this.b = b;
    this.analyzer = analyzer;
  }

  /**
   * Average length over the documents that have this field, as in Lucene. Documents without the
   * field never need normalizing for it, so counting them would only drag the average down.
   */
  get averageLength(): number {
    return this.documentCount === 0 ? 0 : this.totalLength / this.documentCount;
  }

  /** Records one document's terms (term → positions) and length. */
  addDocument(
    documentNumber: number,
    positionsByTerm: Map<string, number[]>,
    length: number,
  ): void {
    for (const [term, positions] of positionsByTerm) {
      let postings = this.postings.get(term);
      if (!postings) {
        postings = new Map();
        this.postings.set(term, postings);
        this.dictionary.add(term);
      }
      postings.set(documentNumber, positions);
    }
    this.totalLength += length;
    if (length > 0) {
      this.documentCount++;
    }
  }

  /** Reverses {@link addDocument}, dropping terms that no longer occur anywhere. */
  removeDocument(documentNumber: number, terms: Iterable<string>, length: number): void {
    for (const term of terms) {
      const postings = this.postings.get(term);
      postings?.delete(documentNumber);
      if (postings?.size === 0) {
        this.postings.delete(term);
        this.dictionary.delete(term);
      }
    }
    this.totalLength -= length;
    if (length > 0) {
      this.documentCount--;
    }
  }
}
