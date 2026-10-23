import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analysis/analyzer';
import { normalizeText } from '../../src/analysis/normalize';
import { ENGLISH_STOPWORDS } from '../../src/analysis/stopwords';
import { tokenize } from '../../src/analysis/tokenizer';

describe('normalizeText', () => {
  it('lowercases and strips accents', () => {
    expect(normalizeText('Café CRÈME brûlée')).toBe('cafe creme brulee');
    expect(normalizeText('Ångström Øresund')).toBe('angstrom øresund');
  });

  it('applies compatibility decomposition', () => {
    expect(normalizeText('ﬁle')).toBe('file');
    expect(normalizeText('ＡＢＣ１２３')).toBe('abc123');
    expect(normalizeText('x²')).toBe('x2');
  });

  it('handles dotted capital I without leaving a combining mark behind', () => {
    expect(normalizeText('İstanbul')).toBe('istanbul');
  });
});

describe('tokenize', () => {
  it('splits on anything that is not a letter, digit or combining mark', () => {
    const text = 'Hash-tables (O(1) lookups), naïve_code!';
    expect(tokenize(text).map((token) => token.text)).toEqual([
      'Hash',
      'tables',
      'O',
      '1',
      'lookups',
      'naïve',
      'code',
    ]);
  });

  it('records positions and offsets into the original text', () => {
    const text = '  Ünïcode ﬁne-tuning ';
    const tokens = tokenize(text);
    expect(tokens).toEqual([
      { text: 'Ünïcode', position: 0, start: 2, end: 9 },
      { text: 'ﬁne', position: 1, start: 10, end: 13 },
      { text: 'tuning', position: 2, start: 14, end: 20 },
    ]);
    for (const token of tokens) {
      expect(text.slice(token.start, token.end)).toBe(token.text);
    }
  });

  it('returns nothing for text without words', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(' -- !! 🙂 ')).toEqual([]);
  });
});

describe('Analyzer', () => {
  it('normalizes, removes stopwords and stems by default', () => {
    const tokens = new Analyzer().analyze('The Indexing of Searches');
    expect(tokens).toEqual([
      { term: 'index', position: 1, start: 4, end: 12 },
      { term: 'search', position: 3, start: 16, end: 24 },
    ]);
  });

  it('keeps the positions of removed stopwords so phrases keep their shape', () => {
    const positions = new Analyzer().analyze('bank of america').map((token) => token.position);
    expect(positions).toEqual([0, 2]);
  });

  it('can disable stemming and stopword removal per field', () => {
    const analyzer = new Analyzer({ stemming: false, stopwords: false });
    expect(analyzer.analyze('The Indexing').map((token) => token.term)).toEqual([
      'the',
      'indexing',
    ]);
  });

  it('accepts a custom stopword list, normalized like the text', () => {
    const analyzer = new Analyzer({ stopwords: ['Lorem', 'IPSUM'] });
    expect(analyzer.analyze('lorem ipsum dolor').map((token) => token.term)).toEqual(['dolor']);
  });

  it('analyzes a single word without dropping stopwords', () => {
    expect(new Analyzer().analyzeWord('Running')).toBe('run');
    expect(new Analyzer().analyzeWord('The')).toBe('the');
    expect(new Analyzer({ stemming: false }).analyzeWord('Running')).toBe('running');
  });

  it('ships a stopword list that excludes words meaningful in technical text', () => {
    expect(ENGLISH_STOPWORDS.has('the')).toBe(true);
    expect(ENGLISH_STOPWORDS.has('out')).toBe(false);
  });
});
