import { describe, expect, it } from 'vitest';
import { Analyzer } from '../../src/analysis/analyzer';
import { buildSnippet, escapeHtml, markTokens } from '../../src/engine/highlight';
import { formatExplanation } from '../../src/format';
import { SearchIndex } from '../../src/search-index';

/** Removes the <mark> tags the highlighter adds; anything left that looks like a tag is a leak. */
function withoutMarks(html: string): string {
  return html.replaceAll('<mark>', '').replaceAll('</mark>', '');
}

describe('escapeHtml', () => {
  it('escapes the characters that matter in HTML', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
    expect(escapeHtml('plain text')).toBe('plain text');
  });
});

describe('markTokens', () => {
  const analyzer = new Analyzer();

  it('marks every occurrence of a term but only real occurrences of a phrase', () => {
    const tokens = analyzer.analyze('binary tree, then a binary heap and another heap');
    const terms = (targets: Parameters<typeof markTokens>[1]): string[] =>
      markTokens(tokens, targets).map((token) => `${token.term}@${token.position}`);
    expect(terms([{ terms: ['heap'], offsets: [0] }])).toEqual(['heap@5', 'heap@8']);
    expect(terms([{ terms: ['binari', 'heap'], offsets: [0, 1] }])).toEqual(['binari@4', 'heap@5']);
  });
});

describe('buildSnippet', () => {
  const analyzer = new Analyzer();
  const snippet = (text: string, words: string[], maxLength?: number): string => {
    const tokens = analyzer.analyze(text);
    const targets = words.map((word) => ({ terms: [analyzer.analyzeWord(word)], offsets: [0] }));
    return buildSnippet(text, tokens, markTokens(tokens, targets), maxLength ? { maxLength } : {});
  };

  it('returns short text whole and merges marks separated only by spaces', () => {
    expect(snippet('A binary heap stores items.', ['binary', 'heap'])).toBe(
      'A <mark>binary heap</mark> stores items.',
    );
  });

  it('centres a long text on the window with the most distinct matched terms', () => {
    const text =
      'Heaps appear early in this sentence. ' +
      'Lots of filler words follow here to push things apart from each other nicely. ' +
      'Later a priority queue is built on a binary heap, which is the interesting part. ' +
      'The end.';
    const html = snippet(text, ['priority', 'queue', 'heap'], 70);
    expect(html.startsWith('…')).toBe(true);
    expect(html.endsWith('…')).toBe(true);
    expect(html).toContain('<mark>priority queue</mark>');
    expect(html).toContain('<mark>heap</mark>');
    expect(withoutMarks(html).length).toBeLessThanOrEqual(70 + 2);
  });

  it('shows the start of the text when nothing matches', () => {
    const text = 'One two three four five six seven eight nine ten eleven twelve.';
    expect(snippet(text, ['missing'], 20)).toBe('One two three four…');
  });

  it('keeps a single overlong match whole', () => {
    const word = 'x'.repeat(50);
    expect(snippet(`intro ${word} outro`, [word], 10)).toBe(`…<mark>${word}</mark>…`);
  });

  it('can keep the whole text', () => {
    const text = 'word '.repeat(100).trim();
    expect(snippet(text, ['word'], Number.POSITIVE_INFINITY)).not.toContain('…');
  });
});

describe('SearchIndex.highlight', () => {
  const hostile =
    '<script>alert("x")</script> The heap & <img src=x onerror=alert(1)> heap "quoted" \'single\'';
  const index = new SearchIndex({
    fields: { title: {}, body: {}, tags: { stemming: false } },
    storeFields: ['title', 'body', 'tags', 'url'],
  });
  index.addAll([
    { id: 'evil', title: '<b>Heap</b>', body: hostile, tags: ['heap', 'xss'] },
    { id: 'plain', title: 'Binary heap', body: 'A binary tree and, separately, a binary heap.' },
  ]);

  it('escapes hostile document text so only <mark> tags remain', () => {
    const html = index.highlight('evil', 'body', 'script heap img onerror');
    expect(html).toContain('&lt;<mark>script</mark>&gt;');
    expect(html).toContain('&amp;');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(withoutMarks(html)).not.toMatch(/[<>]/);
  });

  it('is not affected by HTML in the query or the ellipsis option', () => {
    const html = index.highlight('evil', 'title', '"<b>heap</b>" <img>', { ellipsis: '<b>' });
    expect(withoutMarks(html)).not.toMatch(/[<>]/);
    const cut = index.highlight('evil', 'body', 'heap', { maxLength: 20, ellipsis: '<i>' });
    expect(cut).toContain('&lt;i&gt;');
    expect(withoutMarks(cut)).not.toMatch(/[<>]/);
  });

  it('marks only the tokens that formed the matched phrase', () => {
    expect(index.highlight('plain', 'body', '"binary heap"')).toBe(
      'A binary tree and, separately, a <mark>binary heap</mark>.',
    );
  });

  it('only marks clauses that contributed to the match', () => {
    // "tree" is in the document, but the AND clause it belongs to does not match.
    expect(index.highlight('plain', 'body', 'heap OR (tree AND missing)')).toBe(
      'A binary tree and, separately, a binary <mark>heap</mark>.',
    );
    expect(index.highlight('plain', 'body', 'unrelated')).toBe(
      'A binary tree and, separately, a binary heap.',
    );
  });

  it('highlights array fields joined with commas', () => {
    expect(index.highlight('evil', 'tags', 'xss')).toBe('heap, <mark>xss</mark>');
  });

  it('validates its arguments', () => {
    expect(() => index.highlight('missing', 'body', 'heap')).toThrow(/No document/);
    expect(() => index.highlight('plain', 'url', 'heap')).toThrow(/not a searchable field/);
    expect(() => index.highlight('plain', 'body', 'heap', { maxLength: 0 })).toThrow(/maxLength/);
    expect(() =>
      index.highlight('plain', 'body', 'heap', { ellipsis: 1 as unknown as string }),
    ).toThrow(/ellipsis/);
    const unstored = new SearchIndex({ fields: ['body'], storeFields: [] });
    unstored.add({ id: 'x', body: 'heap' });
    expect(() => unstored.highlight('x', 'body', 'heap')).toThrow(/not stored/);
  });
});

describe('formatExplanation', () => {
  it('renders clauses and fields as indented text', () => {
    const index = new SearchIndex({ fields: { title: { boost: 2 }, body: {} } });
    index.addAll([
      { id: 'a', title: 'Binary heap', body: 'Heap ordered tree.' },
      { id: 'b', title: 'Trie', body: 'Prefix tree.' },
    ]);
    const text = formatExplanation(index.explain('a', 'heap hepa~1'));
    expect(text.split('\n')).toEqual([
      expect.stringMatching(/^a: score [\d.]+ \(k1 = 1\.2\)$/),
      expect.stringMatching(/^ {2}heap \[heap\] [\d.]+ = idf [\d.]+ × saturation\(tf̃ [\d.]+\)$/),
      expect.stringMatching(/^ {4}title: tf 1, length 2 \(avg 1\.5\), boost 2, b 0\.75 → [\d.]+$/),
      expect.stringMatching(/^ {4}body: tf 1, length 3 \(avg 2\.5\), boost 1, b 0\.75 → [\d.]+$/),
      expect.stringMatching(/^ {2}hepa~1 \[heap\] [\d.]+ = 0\.5 × idf/),
      expect.stringMatching(/^ {4}title:/),
      expect.stringMatching(/^ {4}body:/),
    ]);
    expect(formatExplanation(index.explain('b', 'heap'))).toBe('b: does not match');
  });
});
