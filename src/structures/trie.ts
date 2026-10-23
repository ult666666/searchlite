import { at } from '../internal/at';
import { firstOsaRow, nextOsaRow } from './edit-distance';

class TrieNode {
  readonly children = new Map<string, TrieNode>();
  isTerm = false;
}

/** A dictionary term within the allowed edit distance of a fuzzy query. */
export interface FuzzyMatch {
  term: string;
  distance: number;
}

/**
 * A prefix tree over the index's term dictionary. Words that share a prefix share a path from
 * the root, which makes the two expensive query types cheap:
 *
 * - prefix queries walk down to the prefix node and enumerate only the subtree below it;
 * - fuzzy queries run the edit-distance dynamic program along the trie, sharing the work for
 *   common prefixes and abandoning a branch as soon as no word below it can be close enough.
 *
 * Edges are Unicode code points, so characters outside the Basic Multilingual Plane are never
 * split in half.
 */
export class Trie {
  readonly #root = new TrieNode();
  #size = 0;

  /** Number of terms stored. */
  get size(): number {
    return this.#size;
  }

  /** Adds a term. Returns `false` if it was already present. */
  add(term: string): boolean {
    let node = this.#root;
    for (const char of term) {
      let child = node.children.get(char);
      if (!child) {
        child = new TrieNode();
        node.children.set(char, child);
      }
      node = child;
    }
    if (node.isTerm) {
      return false;
    }
    node.isTerm = true;
    this.#size++;
    return true;
  }

  /** Whether the exact term is stored. */
  has(term: string): boolean {
    return this.#find(term)?.isTerm ?? false;
  }

  /** Removes a term and prunes branches that no longer lead to any term. */
  delete(term: string): boolean {
    const path: [parent: TrieNode, char: string][] = [];
    let node = this.#root;
    for (const char of term) {
      const child = node.children.get(char);
      if (!child) {
        return false;
      }
      path.push([node, char]);
      node = child;
    }
    if (!node.isTerm) {
      return false;
    }
    node.isTerm = false;
    this.#size--;
    // Walk back up, removing nodes that are now dead ends.
    for (let i = path.length - 1; i >= 0 && !node.isTerm && node.children.size === 0; i--) {
      const [parent, char] = at(path, i);
      parent.children.delete(char);
      node = parent;
    }
    return true;
  }

  /**
   * Terms that start with `prefix`, shortest first and alphabetical within a length, stopping
   * after `limit` terms. The walk is breadth-first, so when the limit is hit the terms returned
   * are the closest completions of what the user typed.
   */
  withPrefix(prefix: string, limit = Number.POSITIVE_INFINITY): string[] {
    const start = this.#find(prefix);
    if (!start || limit <= 0) {
      return [];
    }
    const results: string[] = [];
    let level: [TrieNode, string][] = [[start, prefix]];
    while (level.length > 0) {
      const next: [TrieNode, string][] = [];
      for (const [node, word] of level) {
        if (node.isTerm) {
          results.push(word);
          if (results.length >= limit) {
            return results;
          }
        }
        for (const char of [...node.children.keys()].sort()) {
          const child = node.children.get(char);
          if (child) {
            next.push([child, word + char]);
          }
        }
      }
      level = next;
    }
    return results;
  }

  /**
   * Terms within `maxDistance` optimal-string-alignment edits of `query`, sorted by distance and
   * then alphabetically.
   *
   * A depth-first walk carries one row of the edit-distance table per trie level. If every
   * value in the current row exceeds `maxDistance`, no word in the subtree can come back under
   * it (rows never decrease along a path), so the whole subtree is skipped. That pruning is what
   * makes this faster than measuring the distance to every term in the dictionary.
   */
  fuzzy(query: string, maxDistance: number): FuzzyMatch[] {
    const queryChars = Array.from(query);
    const matches: FuzzyMatch[] = [];
    const visit = (
      node: TrieNode,
      word: string,
      char: string,
      previousChar: string | undefined,
      previous: readonly number[],
      twoBack: readonly number[] | undefined,
    ): void => {
      const row = nextOsaRow(queryChars, char, previousChar, previous, twoBack);
      const distance = at(row, queryChars.length);
      if (node.isTerm && distance <= maxDistance) {
        matches.push({ term: word, distance });
      }
      if (Math.min(...row) <= maxDistance) {
        for (const [nextChar, child] of node.children) {
          visit(child, word + nextChar, nextChar, char, row, previous);
        }
      }
    };

    const firstRow = firstOsaRow(queryChars);
    if (this.#root.isTerm && queryChars.length <= maxDistance) {
      matches.push({ term: '', distance: queryChars.length });
    }
    for (const [char, child] of this.#root.children) {
      visit(child, char, char, undefined, firstRow, undefined);
    }
    return matches.sort(
      (a, b) => a.distance - b.distance || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0),
    );
  }

  /** Every stored term, in no particular order. */
  *terms(): IterableIterator<string> {
    const stack: [TrieNode, string][] = [[this.#root, '']];
    for (let entry = stack.pop(); entry; entry = stack.pop()) {
      const [node, word] = entry;
      if (node.isTerm) {
        yield word;
      }
      for (const [char, child] of node.children) {
        stack.push([child, word + char]);
      }
    }
  }

  #find(word: string): TrieNode | undefined {
    let node: TrieNode | undefined = this.#root;
    for (const char of word) {
      node = node.children.get(char);
      if (!node) {
        return undefined;
      }
    }
    return node;
  }
}
