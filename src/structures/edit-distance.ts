import { at } from '../internal/at';

/**
 * One step of the dynamic program for optimal string alignment (OSA) distance.
 *
 * Row `i` of the table holds the distances between the first `i` characters of a word and every
 * prefix of `query`. Given the rows for the word without its last character (`previous`) and
 * without its last two (`twoBack`), this computes the row after appending `char`.
 *
 * The trie's fuzzy search calls this once per trie edge, so all words that share a prefix share
 * the work for that prefix.
 */
export function nextOsaRow(
  query: readonly string[],
  char: string,
  previousChar: string | undefined,
  previous: readonly number[],
  twoBack: readonly number[] | undefined,
): number[] {
  const row = [at(previous, 0) + 1];
  query.forEach((queryChar, j) => {
    const deletion = at(previous, j + 1) + 1;
    const insertion = at(row, j) + 1;
    const substitution = at(previous, j) + (queryChar === char ? 0 : 1);
    let best = Math.min(deletion, insertion, substitution);
    // An adjacent swap: the last two characters of the word are the query's characters j-1 and j
    // in the opposite order.
    if (twoBack !== undefined && j > 0 && char === query[j - 1] && previousChar === queryChar) {
      best = Math.min(best, at(twoBack, j - 1) + 1);
    }
    row.push(best);
  });
  return row;
}

/** The first row of the table: turning the empty word into each prefix of the query. */
export function firstOsaRow(query: readonly string[]): number[] {
  return Array.from({ length: query.length + 1 }, (_, j) => j);
}

/**
 * Optimal string alignment distance: the minimum number of insertions, deletions,
 * substitutions and swaps of two adjacent characters needed to turn `a` into `b`, where no
 * substring is edited more than once. This is the "restricted" Damerau–Levenshtein distance.
 * Counting a swap as one edit matches how people mistype: "teh" → "the" costs 1, whereas plain
 * Levenshtein distance would charge 2.
 *
 * Characters are compared by Unicode code point. Runs in O(|a|·|b|) time.
 */
export function osaDistance(a: string, b: string): number {
  const query = Array.from(b);
  let twoBack: number[] | undefined;
  let previous = firstOsaRow(query);
  let previousChar: string | undefined;
  for (const char of a) {
    const row = nextOsaRow(query, char, previousChar, previous, twoBack);
    twoBack = previous;
    previous = row;
    previousChar = char;
  }
  return at(previous, query.length);
}
