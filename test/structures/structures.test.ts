import { describe, expect, it } from 'vitest';
import { at } from '../../src/internal/at';
import { osaDistance } from '../../src/structures/edit-distance';
import { TopK } from '../../src/structures/top-k';
import { Trie } from '../../src/structures/trie';

/** Small deterministic PRNG (mulberry32) so property-style tests are reproducible. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomWord(next: () => number, alphabet: string, maxLength: number): string {
  const length = 1 + Math.floor(next() * maxLength);
  let word = '';
  for (let i = 0; i < length; i++) {
    word += alphabet.charAt(Math.floor(next() * alphabet.length));
  }
  return word;
}

describe('osaDistance', () => {
  it('matches hand-computed distances', () => {
    expect(osaDistance('', '')).toBe(0);
    expect(osaDistance('abc', '')).toBe(3);
    expect(osaDistance('', 'abc')).toBe(3);
    expect(osaDistance('kitten', 'sitting')).toBe(3);
    expect(osaDistance('flaw', 'lawn')).toBe(2);
    expect(osaDistance('teh', 'the')).toBe(1); // one adjacent swap
    expect(osaDistance('ab', 'ba')).toBe(1);
    // OSA may not edit a substring twice, so "ca" → "abc" costs 3 (unrestricted
    // Damerau–Levenshtein would find 2).
    expect(osaDistance('ca', 'abc')).toBe(3);
  });

  it('is symmetric and compares code points rather than UTF-16 units', () => {
    expect(osaDistance('databse', 'database')).toBe(osaDistance('database', 'databse'));
    expect(osaDistance('a😀b', 'ab')).toBe(1);
  });
});

describe('TopK', () => {
  const higherFirst = (a: number, b: number): boolean => a > b;

  it('returns the k largest items in order', () => {
    const top = new TopK<number>(3, higherFirst);
    for (const value of [5, 1, 9, 3, 7, 9, 2]) {
      top.push(value);
    }
    expect(top.sorted()).toEqual([9, 9, 7]);
    expect(top.size).toBe(3);
  });

  it('agrees with a full sort on random input', () => {
    const next = random(42);
    for (let round = 0; round < 200; round++) {
      const values = Array.from({ length: Math.floor(next() * 60) }, () =>
        Math.floor(next() * 100),
      );
      const k = Math.floor(next() * 12);
      const top = new TopK<number>(k, higherFirst);
      values.forEach((value) => {
        top.push(value);
      });
      expect(top.sorted()).toEqual([...values].sort((a, b) => b - a).slice(0, k));
    }
  });

  it('keeps everything when the capacity is infinite and nothing when it is zero', () => {
    const all = new TopK<number>(Number.POSITIVE_INFINITY, higherFirst);
    const none = new TopK<number>(0, higherFirst);
    for (const value of [3, 1, 2]) {
      all.push(value);
      none.push(value);
    }
    expect(all.sorted()).toEqual([3, 2, 1]);
    expect(none.sorted()).toEqual([]);
  });
});

describe('Trie', () => {
  it('adds, finds and deletes terms, pruning dead branches', () => {
    const trie = new Trie();
    expect(trie.add('heap')).toBe(true);
    expect(trie.add('heap')).toBe(false);
    trie.add('heapsort');
    trie.add('hash');
    expect(trie.size).toBe(3);
    expect(trie.has('heap')).toBe(true);
    expect(trie.has('hea')).toBe(false);

    expect(trie.delete('heapsort')).toBe(true);
    expect(trie.delete('heapsort')).toBe(false);
    expect(trie.delete('hea')).toBe(false);
    expect(trie.delete('zebra')).toBe(false);
    expect(trie.withPrefix('heaps')).toEqual([]);
    expect([...trie.terms()].sort()).toEqual(['hash', 'heap']);

    expect(trie.delete('heap')).toBe(true);
    expect(trie.delete('hash')).toBe(true);
    expect(trie.size).toBe(0);
    expect([...trie.terms()]).toEqual([]);
  });

  it('lists prefix completions shortest first, then alphabetically, up to a limit', () => {
    const trie = new Trie();
    for (const term of ['data', 'databas', 'dataset', 'date', 'dat', 'delta']) {
      trie.add(term);
    }
    expect(trie.withPrefix('dat')).toEqual(['dat', 'data', 'date', 'databas', 'dataset']);
    expect(trie.withPrefix('dat', 3)).toEqual(['dat', 'data', 'date']);
    expect(trie.withPrefix('dat', 0)).toEqual([]);
    expect(trie.withPrefix('x')).toEqual([]);
  });

  it('finds fuzzy matches sorted by distance', () => {
    const trie = new Trie();
    for (const term of ['heap', 'help', 'hello', 'cheap', 'hash', 'leap']) {
      trie.add(term);
    }
    expect(trie.fuzzy('heap', 0)).toEqual([{ term: 'heap', distance: 0 }]);
    expect(trie.fuzzy('heap', 1)).toEqual([
      { term: 'heap', distance: 0 },
      { term: 'cheap', distance: 1 },
      { term: 'help', distance: 1 },
      { term: 'leap', distance: 1 },
    ]);
    expect(trie.fuzzy('ehap', 1)).toEqual([{ term: 'heap', distance: 1 }]);
  });

  it('handles the empty string as a term', () => {
    const trie = new Trie();
    trie.add('');
    trie.add('a');
    expect(trie.has('')).toBe(true);
    expect(trie.withPrefix('')).toEqual(['', 'a']);
    expect(trie.fuzzy('b', 1)).toEqual([
      { term: '', distance: 1 },
      { term: 'a', distance: 1 },
    ]);
  });

  it('returns exactly the terms a brute-force scan would find', () => {
    const next = random(7);
    const trie = new Trie();
    const dictionary = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const word = randomWord(next, 'abcde', 7);
      dictionary.add(word);
      trie.add(word);
    }
    for (let round = 0; round < 100; round++) {
      const query = randomWord(next, 'abcdef', 6);
      const maxDistance = Math.floor(next() * 3);
      const expected = [...dictionary]
        .map((term) => ({ term, distance: osaDistance(query, term) }))
        .filter((match) => match.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance || (a.term < b.term ? -1 : 1));
      expect(trie.fuzzy(query, maxDistance), `${query}~${maxDistance}`).toEqual(expected);
    }
  });
});

describe('at', () => {
  it('returns present elements and throws on out-of-range reads', () => {
    expect(at([1, 2, 3], 2)).toBe(3);
    expect(() => at([1], 5)).toThrow(RangeError);
  });
});
