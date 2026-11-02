import type { Analyzer } from '../analysis/analyzer';
import { Trie } from '../structures/trie';
import { PostingsArena, PostingsList } from './postings';

/**
 * The inverted index and statistics for one field.
 *
 * - `postings` maps each term to a compressed {@link PostingsList} of the documents containing
 *   it and the positions where it occurs. The number of positions is the term frequency; the
 *   positions themselves are what phrase matching needs.
 * - `arena` holds the compressed bytes of all of this field's postings lists.
 * - `dictionary` holds the same terms in a trie for prefix and fuzzy expansion.
 * - `lengths` holds every document's length in this field, indexed by document number, so
 *   document-at-a-time scoring reads it from an array instead of a map.
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
  readonly postings = new Map<string, PostingsList>();
  readonly arena = new PostingsArena();
  readonly dictionary = new Trie();
  /** This field's length in tokens for each document number; 0 for removed documents. */
  readonly lengths: number[] = [];
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
    // Document numbers are assigned in order, so this normally appends and the array stays dense.
    while (this.lengths.length < documentNumber) {
      this.lengths.push(0);
    }
    this.lengths[documentNumber] = length;
    for (const [term, positions] of positionsByTerm) {
      let postings = this.postings.get(term);
      if (!postings) {
        postings = new PostingsList(this.arena);
        this.postings.set(term, postings);
        this.dictionary.add(term);
      }
      postings.add(documentNumber, positions, this.lengths);
    }
    this.#compactIfWasteful();
    this.totalLength += length;
    if (length > 0) {
      this.documentCount++;
    }
  }

  #compactIfWasteful(): void {
    if (this.arena.wasteful) {
      this.arena.compact(this.postings.values());
    }
  }

  /** Reverses {@link addDocument}, dropping terms that no longer occur anywhere. */
  removeDocument(documentNumber: number, terms: Iterable<string>, length: number): void {
    for (const term of terms) {
      const postings = this.postings.get(term);
      postings?.remove(documentNumber, this.lengths);
      if (postings?.count === 0) {
        this.postings.delete(term);
        this.dictionary.delete(term);
      }
    }
    this.lengths[documentNumber] = 0;
    this.#compactIfWasteful();
    this.totalLength -= length;
    if (length > 0) {
      this.documentCount--;
    }
  }
}
