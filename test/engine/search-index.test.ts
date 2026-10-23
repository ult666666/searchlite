import { describe, expect, it } from 'vitest';
import { SearchliteError } from '../../src/errors';
import { SearchIndex, SNAPSHOT_VERSION, type SearchDocument } from '../../src/search-index';

const HEAP: SearchDocument = {
  id: 'heap',
  title: 'Binary heap',
  body: 'A binary heap is a complete binary tree.',
  tags: ['trees'],
};
const TRIE: SearchDocument = {
  id: 'trie',
  title: 'Trie',
  body: 'A prefix tree that stores strings by character.',
  tags: ['trees'],
};
const HASH: SearchDocument = {
  id: 'hash',
  title: 'Hash table',
  body: 'Buckets addressed by a hash function.',
  tags: ['hashing'],
};
const BLOOM: SearchDocument = {
  id: 'bloom',
  title: 'Bloom filter',
  body: 'A probabilistic set built from several hash functions.',
};
const DOCS = [HEAP, TRIE, HASH, BLOOM];

function build(docs: readonly SearchDocument[] = DOCS): SearchIndex {
  const index = new SearchIndex({
    fields: { title: { boost: 2 }, body: {}, tags: { stemming: false } },
    storeFields: ['title', 'body', 'tags'],
  });
  index.addAll(docs);
  return index;
}

function errorCode(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    if (error instanceof SearchliteError) {
      return error.code;
    }
    throw error;
  }
  throw new Error('expected an error');
}

const QUERIES = ['binary', 'tree', 'hash*', '"hash function"', 'trees', 'prefix OR bloom', 'tre~1'];

describe('adding documents', () => {
  it('indexes documents and keeps their stored fields', () => {
    const index = build();
    expect(index.size).toBe(4);
    expect(index.has('heap')).toBe(true);
    expect(index.get('trie')).toEqual({
      title: 'Trie',
      body: 'A prefix tree that stores strings by character.',
      tags: ['trees'],
    });
    expect(index.get('missing')).toBeUndefined();
  });

  it('accepts numeric ids and treats them as strings', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.add({ id: 7, body: 'seven' });
    expect(index.has(7)).toBe(true);
    expect(index.has('7')).toBe(true);
    expect(index.search('seven')[0]?.id).toBe('7');
  });

  it('copies stored arrays so later caller mutations do not leak in', () => {
    const tags = ['a'];
    const index = new SearchIndex({ fields: ['tags'] });
    index.add({ id: 'x', tags });
    tags.push('b');
    expect(index.get('x')).toEqual({ tags: ['a'] });
  });

  it('rejects duplicate ids, including within one batch', () => {
    const index = build();
    expect(
      errorCode(() => {
        index.add({ id: 'heap', title: 'Again' });
      }),
    ).toBe('DUPLICATE_ID');
    expect(
      errorCode(() => {
        index.addAll([
          { id: 'new', body: 'one' },
          { id: 'new', body: 'two' },
        ]);
      }),
    ).toBe('DUPLICATE_ID');
    expect(index.has('new')).toBe(false);
  });

  it('rejects malformed documents with a clear message', () => {
    const index = build();
    const bad: [unknown, RegExp][] = [
      [null, /plain objects/],
      [['heap'], /plain objects/],
      [{ title: 'no id' }, /non-empty string or number "id"/],
      [{ id: '' }, /non-empty string or number "id"/],
      [{ id: Number.NaN }, /non-empty string or number "id"/],
      [{ id: 'x', title: { nested: true } }, /Field "title" of document "x" must be a string/],
      [{ id: 'x', tags: ['ok', false] }, /Field "tags" of document "x"/],
    ];
    for (const [document, message] of bad) {
      expect(() => {
        index.add(document as SearchDocument);
      }).toThrow(message);
    }
  });

  it('adds a batch atomically: one bad document leaves the index unchanged', () => {
    const index = build();
    const before = index.stats();
    expect(() => {
      index.addAll([
        { id: 'ok', body: 'fine' },
        { id: 'bad', body: 42n },
      ]);
    }).toThrow(/must be a string/);
    expect(index.has('ok')).toBe(false);
    expect(index.stats()).toEqual(before);
  });

  it('treats missing and null fields as empty', () => {
    const index = build();
    index.add({ id: 'sparse', title: null, body: 'only a body' });
    expect(index.search('body')[0]?.id).toBe('sparse');
  });
});

describe('statistics', () => {
  it('tracks document counts, average lengths and vocabulary size per field', () => {
    const stats = build().stats();
    expect(stats.documentCount).toBe(4);
    // Title lengths 2, 1, 2, 2; tags exist in 3 documents with one token each.
    expect(stats.fields.title).toEqual({ documents: 4, averageLength: 7 / 4, terms: 7 });
    expect(stats.fields.tags).toEqual({ documents: 3, averageLength: 1, terms: 2 });
  });

  it('stay identical to a fresh build after removals and replacements', () => {
    const index = build();
    index.remove('trie');
    index.replace({ id: 'hash', title: 'Hash map', body: 'Keys map to buckets via hashing.' });
    index.add({ id: 'skip', title: 'Skip list', body: 'Layers of linked lists.' });

    const fresh = build([
      HEAP,
      { id: 'hash', title: 'Hash map', body: 'Keys map to buckets via hashing.' },
      BLOOM,
      { id: 'skip', title: 'Skip list', body: 'Layers of linked lists.' },
    ]);
    expect(index.stats()).toEqual(fresh.stats());
    for (const query of [...QUERIES, 'map', 'list*']) {
      const scores = (target: SearchIndex): Record<string, number> =>
        Object.fromEntries(
          target.search(query, { limit: Number.POSITIVE_INFINITY }).map((r) => [r.id, r.score]),
        );
      expect(scores(index), query).toEqual(scores(fresh));
    }
  });
});

describe('removing and replacing', () => {
  it('removes documents and their terms from the dictionary', () => {
    const index = build();
    expect(index.remove('trie')).toBe(true);
    expect(index.remove('trie')).toBe(false);
    expect(index.has('trie')).toBe(false);
    expect(index.search('prefix')).toEqual([]);
    expect(index.search('charact*')).toEqual([]);
    expect(index.search('trees').map((r) => r.id)).toEqual(['heap']);
  });

  it('can empty the index completely', () => {
    const index = build();
    for (const doc of DOCS) {
      index.remove(doc.id as string);
    }
    expect(index.size).toBe(0);
    expect(index.stats().fields.body).toEqual({ documents: 0, averageLength: 0, terms: 0 });
    expect(index.search('binary')).toEqual([]);
  });

  it('replaces a document in place, keeping its tie-breaking position', () => {
    const index = new SearchIndex({ fields: ['body'] });
    index.addAll([
      { id: 'a', body: 'same words' },
      { id: 'b', body: 'same words' },
    ]);
    index.replace({ id: 'a', body: 'same words' });
    expect(index.search('words').map((r) => r.id)).toEqual(['a', 'b']);
    index.replace({ id: 'a', body: 'different now' });
    expect(index.search('words').map((r) => r.id)).toEqual(['b']);
    expect(index.search('different').map((r) => r.id)).toEqual(['a']);
  });

  it('refuses to replace a document that does not exist', () => {
    const index = build();
    expect(
      errorCode(() => {
        index.replace({ id: 'ghost', body: 'boo' });
      }),
    ).toBe('NOT_FOUND');
    expect(index.has('ghost')).toBe(false);
  });
});

describe('options validation', () => {
  it('rejects bad index options', () => {
    const cases: [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ fields: [] }, /at least one searchable field/],
      [{ fields: {} }, /at least one searchable field/],
      [{ fields: 'title' }, /at least one searchable field/],
      [{ fields: ['bad name'] }, /Field name "bad name"/],
      [{ fields: ['title', 'title'] }, /unique/],
      [{ fields: { title: 3 } }, /must be an object/],
      [
        { fields: { title: { boost: 0 } } },
        /fields.title.boost must be a finite number greater than 0/,
      ],
      [{ fields: { title: { b: 2 } } }, /fields.title.b must be a finite number between 0 and 1/],
      [{ fields: { title: { stemming: 'yes' } } }, /stemming must be a boolean/],
      [{ fields: { title: { stopwords: 'the' } } }, /stopwords must be an array of strings/],
      [{ fields: ['title'], k1: -1 }, /k1 must be a finite number at least 0/],
      [{ fields: ['title'], b: Number.NaN }, /b must be a finite number between 0 and 1/],
      [{ fields: ['title'], defaultOperator: 'XOR' }, /defaultOperator/],
      [{ fields: ['title'], storeFields: 'title' }, /storeFields must be an array of strings/],
      [{ fields: ['title'], idField: '' }, /idField must be a non-empty string/],
      [{ fields: ['title'], vectorField: 5 }, /vectorField must be a non-empty string/],
    ];
    for (const [options, message] of cases) {
      expect(() => new SearchIndex(options as never), JSON.stringify(options)).toThrow(message);
    }
  });

  it('supports a custom id field and custom stopwords', () => {
    const index = new SearchIndex({
      fields: { body: { stopwords: ['lorem'] } },
      idField: 'slug',
    });
    index.add({ slug: 'one', body: 'lorem the ipsum' });
    expect(index.search('lorem')).toEqual([]);
    expect(index.search('the')[0]?.id).toBe('one');
  });
});

describe('serialization', () => {
  it('round-trips through JSON with identical results, explanations and statistics', () => {
    const index = build();
    index.remove('trie');
    index.add({ id: 'late', title: 'Late arrival', body: 'Added after a removal.' });
    const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(index)));

    expect(restored.size).toBe(index.size);
    expect(restored.stats()).toEqual(index.stats());
    for (const query of QUERIES) {
      expect(restored.search(query), query).toEqual(index.search(query));
    }
    expect(restored.explain('heap', 'binary tree')).toEqual(index.explain('heap', 'binary tree'));
    expect(restored.highlight('heap', 'body', 'binary')).toBe(
      index.highlight('heap', 'body', 'binary'),
    );
  });

  it('keeps working after a restore', () => {
    const restored = SearchIndex.fromJSON(JSON.parse(JSON.stringify(build())));
    restored.add({ id: 'new', body: 'brand new document' });
    expect(restored.remove('heap')).toBe(true);
    expect(restored.search('brand')[0]?.id).toBe('new');
    expect(
      errorCode(() => {
        restored.add({ id: 'hash' });
      }),
    ).toBe('DUPLICATE_ID');
  });

  it('writes a versioned snapshot', () => {
    const snapshot = build().toJSON();
    expect(snapshot.format).toBe('searchlite');
    expect(snapshot.version).toBe(SNAPSHOT_VERSION);
    expect(snapshot.options.fields.map((field) => field.name)).toEqual(['title', 'body', 'tags']);
    expect(snapshot.documents.map((document) => document.id)).toEqual([
      'heap',
      'trie',
      'hash',
      'bloom',
    ]);
  });

  it('rejects snapshots it cannot read', () => {
    const good = JSON.parse(JSON.stringify(build())) as Record<string, unknown>;
    const emptyPostings = { title: [], body: [], tags: [] };
    const withDocuments = (documents: unknown, postings: unknown = good.postings): unknown => ({
      ...good,
      documents,
      postings,
    });
    const cases: [unknown, RegExp][] = [
      [null, /Not a searchlite index snapshot/],
      [{ format: 'other' }, /Not a searchlite index snapshot/],
      [{ ...good, version: 99 }, /Unsupported snapshot version 99/],
      [{ ...good, options: null }, /options are missing or malformed/],
      [{ ...good, options: { fields: [{ boost: 1 }] } }, /field options are malformed/],
      [{ ...good, options: { fields: [{ name: 'x', boost: -1 }] } }, /options are invalid/],
      [{ ...good, postings: null }, /documents or postings are missing/],
      [{ ...good, postings: {} }, /no postings for field "title"/],
      [{ ...good, postings: { title: [['t', 'x']] } }, /Malformed postings entry/],
      [
        { ...good, postings: { ...(good.postings as object), title: [['t', [[99, [0]]]]] } },
        /Malformed posting for term "t"/,
      ],
      [withDocuments([{ id: 1 }], emptyPostings), /Malformed document at position 0/],
      [
        withDocuments([...(good.documents as unknown[]), ...(good.documents as unknown[])]),
        /duplicate ids/,
      ],
    ];
    for (const [snapshot, message] of cases) {
      expect(() => SearchIndex.fromJSON(snapshot), message.source).toThrow(message);
    }
  });
});
