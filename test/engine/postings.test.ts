import { describe, expect, it } from 'vitest';
import {
  BLOCK_SIZE,
  NO_MORE_DOCUMENTS,
  PostingsArena,
  PostingsCursor,
  PostingsList,
  unionSize,
} from '../../src/engine/postings';
import { Analyzer } from '../../src/analysis/analyzer';
import { FieldIndex } from '../../src/engine/field-index';
import { decodePostingsPayload, encodePostingsPayload } from '../../src/engine/postings-codec';

function random(seed: number) {
  let state = seed >>> 0;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
}

function positionsFor(next: () => number): number[] {
  const positions: number[] = [];
  let position = Math.floor(next() * 3);
  for (let i = 0, count = 1 + Math.floor(next() ** 3 * 6); i < count; i++) {
    positions.push(position);
    position += 1 + Math.floor(next() * (next() < 0.1 ? 300 : 4));
  }
  return positions;
}

/** Brute-force Pareto frontier: pairs no other pair beats on frequency and length at once. */
function frontier(pairs: [number, number][]): string[] {
  const kept = pairs.filter(
    ([f, l]) => !pairs.some(([g, m]) => g >= f && m <= l && (g > f || m < l)),
  );
  return [...new Set(kept.map(([f, l]) => `${f}/${l}`))].sort();
}

function check(list: PostingsList, model: Map<number, number[]>, lengths: number[]): void {
  const expected = [...model].sort(([a], [b]) => a - b);
  expect(list.count).toBe(expected.length);
  expect(list.decodeAll().map((posting) => [posting.document, posting.positions])).toEqual(
    expected,
  );
  let previous = -1;
  for (let block = 0; block < list.blockCount; block++) {
    const postings = list.decodeBlock(block);
    expect(postings.length).toBe(list.blockSize(block));
    expect(postings.length).toBeGreaterThan(0);
    expect(postings.length).toBeLessThanOrEqual(2 * BLOCK_SIZE);
    expect(postings[0]?.document).toBe(list.blockFirst(block));
    expect(postings.at(-1)?.document).toBe(list.blockLast(block));
    expect(list.blockFirst(block)).toBeGreaterThan(previous);
    previous = list.blockLast(block);
    const [start, end] = list.impactRange(block);
    const pairs: [number, number][] = [];
    for (let i = start; i < end; i += 2) pairs.push([list.meta[i] ?? -1, list.meta[i + 1] ?? -1]);
    expect(pairs.map(([f, l]) => `${f}/${l}`).sort()).toEqual(
      frontier(postings.map((p) => [p.positions.length, lengths[p.document] ?? 0])),
    );
  }
  expect(list.size).toBe(list.blockCount === 0 ? 0 : list.blockEnd(list.blockCount - 1));
}

describe('compressed postings lists', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'match a map model under appends, removals and re-insertions (seed %i)',
    (seed) => {
      const next = random(seed * 7919);
      const list = new PostingsList(new PostingsArena());
      const model = new Map<number, number[]>();
      const lengths: number[] = [];
      const removed: number[] = [];
      let document = 0;
      for (let step = 0; step < 900; step++) {
        const action = next();
        if (action < 0.6 || model.size === 0) {
          // Large gaps leave room for re-insertions; dense runs fill whole blocks.
          document += next() < 0.5 ? 1 : 1 + Math.floor(next() * 40);
          const positions = positionsFor(next);
          lengths[document] = (positions.at(-1) ?? 0) + Math.floor(next() * 50);
          list.add(document, positions, lengths);
          model.set(document, positions);
        } else if (action < 0.8) {
          const keys = [...model.keys()];
          const victim = keys[Math.floor(next() * keys.length)] ?? 0;
          expect(list.remove(victim, lengths)).toBe(true);
          expect(list.remove(victim, lengths)).toBe(false);
          model.delete(victim);
          removed.push(victim);
        } else {
          // What `replace` does: put a document back under an old number, out of order.
          const candidate = removed.pop() ?? Math.floor(next() * document);
          if (model.has(candidate)) continue;
          const positions = positionsFor(next);
          lengths[candidate] = (positions.at(-1) ?? 0) + Math.floor(next() * 50);
          list.add(candidate, positions, lengths);
          model.set(candidate, positions);
        }
        if (step % 50 === 0) check(list, model, lengths);
      }
      check(list, model, lengths);
      for (let probe = -2; probe <= document + 2; probe++) {
        expect(list.frequency(probe)).toBe(model.get(probe)?.length ?? 0);
        expect(list.positions(probe)).toEqual(model.get(probe));
      }
      // Cursors: advance to increasing random targets and compare with the model.
      const sorted = [...model.keys()].sort((a, b) => a - b);
      for (let trial = 0; trial < 20; trial++) {
        const cursor = new PostingsCursor(list);
        const buffer: number[] = [];
        let target = 0;
        while (target <= document + 1) {
          const actual = cursor.advance(target);
          const expected = sorted.find((d) => d >= target) ?? NO_MORE_DOCUMENTS;
          expect(actual).toBe(expected);
          if (actual === NO_MORE_DOCUMENTS) break;
          expect(cursor.frequency).toBe(model.get(actual)?.length);
          expect(cursor.positions(buffer)).toEqual(model.get(actual));
          target = actual + 1 + Math.floor(next() ** 4 * 200);
        }
      }
    },
  );

  it('splits a block that re-insertions grow past twice the block size', () => {
    const list = new PostingsList(new PostingsArena());
    const lengths: number[] = [];
    for (let d = 0; d < 10 * BLOCK_SIZE; d += 10) {
      lengths[d] = 5;
      list.add(d, [0], lengths);
    }
    const model = new Map(list.decodeAll().map((p) => [p.document, p.positions]));
    for (let d = 1; d < 10 * BLOCK_SIZE; d++) {
      if (d % 10 === 0) continue;
      lengths[d] = 1 + (d % 7);
      list.add(d, [d % 3, 4], lengths);
      model.set(d, [d % 3, 4]);
    }
    check(list, model, lengths);
    expect(list.blockCount).toBeGreaterThan(9);
  });

  it('decodes frequencies and positions that need several bytes, and re-adds in place', () => {
    const list = new PostingsList(new PostingsArena());
    const lengths: number[] = [];
    const many = Array.from({ length: 300 }, (_, i) => i * 1000);
    for (const d of [5, 6, 70000]) {
      lengths[d] = 300_000;
      list.add(d, d === 6 ? many : [d], lengths);
    }
    const cursor = new PostingsCursor(list);
    expect(cursor.advance(6)).toBe(6);
    expect(cursor.frequency).toBe(300);
    expect(cursor.positions([])).toEqual(many);
    expect(cursor.advance(7)).toBe(70000);
    // Adding a document the list already holds replaces its positions.
    list.add(6, [1, 2], lengths);
    expect(list.count).toBe(3);
    expect(list.positions(6)).toEqual([1, 2]);
  });

  it('compacts the shared byte arena without changing any list', () => {
    const field = new FieldIndex(
      'body',
      1,
      0.75,
      new Analyzer({ stemming: false, stopwords: false }),
    );
    const compact = field.arena.compact.bind(field.arena);
    let compactions = 0;
    field.arena.compact = (lists) => {
      compactions++;
      compact(lists);
    };
    const next = random(4242);
    const model = new Map<string, Map<number, number[]>>();
    const terms = new Map<number, string[]>();
    for (let d = 0; d < 4000; d++) {
      const positions = new Map<string, number[]>();
      for (let p = 0; p < 12; p++) {
        const term = `t${Math.floor(300 * next() ** 2)}`;
        positions.set(term, [...(positions.get(term) ?? []), p]);
      }
      field.addDocument(d, positions, 12);
      terms.set(d, [...positions.keys()]);
      for (const [term, list] of positions) {
        model.set(term, (model.get(term) ?? new Map<number, number[]>()).set(d, list));
      }
    }
    for (let d = 0; d < 4000; d += 3) {
      field.removeDocument(d, terms.get(d) ?? [], 12);
      for (const term of terms.get(d) ?? []) model.get(term)?.delete(d);
    }
    expect(compactions).toBeGreaterThan(0);
    for (const [term, documents] of model) {
      const expected = [...documents].sort(([a], [b]) => a - b);
      expect(
        field.postings
          .get(term)
          ?.decodeAll()
          .map((p) => [p.document, p.positions]) ?? [],
        term,
      ).toEqual(expected);
    }
  });

  it('reclaims the arena regions of terms that no longer occur anywhere', () => {
    const field = new FieldIndex(
      'body',
      1,
      0.75,
      new Analyzer({ stemming: false, stopwords: false }),
    );
    // Every byte the arena handed out is either in a live list's region or counted as garbage.
    const accounted = (): void => {
      let live = 0;
      for (const list of field.postings.values()) {
        if (list.own === undefined) live += list.capacity;
      }
      expect(field.arena.used - field.arena.garbage).toBe(live);
    };
    // Ten live documents at a time, each with one word of its own, as when edited notes are
    // removed and indexed again: 20,000 words come and go.
    for (let d = 0; d < 20_000; d++) {
      field.addDocument(
        d,
        new Map([
          [`w${d.toString(36)}`, [0]],
          ['shared', [1]],
        ]),
        2,
      );
      if (d >= 10) field.removeDocument(d - 10, [`w${(d - 10).toString(36)}`, 'shared'], 2);
      if (d % 997 === 0) accounted();
    }
    accounted();
    expect(field.postings.size).toBe(11);
    // Without reclaiming them, the deleted lists' regions would fill about 480 KB.
    expect(field.arena.used).toBeLessThan(200 * 1024);
  });

  it('counts the documents of a union without double counting', () => {
    const next = random(99);
    for (let trial = 0; trial < 30; trial++) {
      const sets = Array.from({ length: 1 + Math.floor(next() * 4) }, () => {
        const list = new PostingsList(new PostingsArena());
        const lengths: number[] = [];
        const documents = new Set<number>();
        const density = next();
        for (let d = 0; d < 1500; d++) {
          if (next() < density * 0.3) {
            lengths[d] = 3;
            list.add(d, [1], lengths);
            documents.add(d);
          }
        }
        return { list, documents };
      });
      const union = new Set(sets.flatMap(({ documents }) => [...documents]));
      expect(unionSize(sets.map(({ list }) => list))).toBe(union.size);
    }
    expect(unionSize([])).toBe(0);
  });

  it('serializes to slot-numbered snapshot payloads and back', () => {
    const list = new PostingsList(new PostingsArena());
    const lengths: number[] = [];
    const documents = [3, 4, 9, 400, 401];
    for (const d of documents) {
      lengths[d] = 9;
      list.add(d, [d % 5, 7 + d], lengths);
    }
    const slots = new Map(documents.map((d, slot) => [d, slot]));
    const payload = encodePostingsPayload(list, slots);
    expect(decodePostingsPayload(payload, documents.length)).toEqual(
      documents.map((d, slot) => [slot, [d % 5, 7 + d]]),
    );
    // One document, frequency 1, position 0: bytes 01 01 00.
    const single = new PostingsList(new PostingsArena());
    single.add(0, [0], [1]);
    expect(encodePostingsPayload(single, new Map([[0, 0]]))).toBe('AQEA');
  });
});
