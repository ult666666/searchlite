import { describe, expect, it } from 'vitest';
import { QuerySyntaxError, SearchliteError } from '../../src/errors';
import type { QueryNode } from '../../src/query/ast';
import { lexQuery } from '../../src/query/lexer';
import { MAX_QUERY_DEPTH, MAX_QUERY_LENGTH, parseQuery } from '../../src/query/parser';

/** Compact, position-free rendering of a tree so expectations stay readable. */
function show(node: QueryNode | null): string {
  if (node === null) {
    return '∅';
  }
  switch (node.type) {
    case 'and':
    case 'or':
      return `(${node.children.map(show).join(` ${node.type.toUpperCase()} `)})`;
    case 'not':
      return `NOT ${show(node.child)}`;
    case 'phrase':
      return `${node.field ? `${node.field}:` : ''}"${node.text}"`;
    case 'prefix':
      return `${node.field ? `${node.field}:` : ''}${node.text}*`;
    case 'fuzzy':
      return `${node.field ? `${node.field}:` : ''}${node.text}~${node.maxEdits}`;
    case 'term':
      return `${node.field ? `${node.field}:` : ''}${node.text}`;
  }
}

function parsed(query: string, defaultOperator: 'AND' | 'OR' = 'OR'): string {
  return show(parseQuery(query, { defaultOperator }));
}

function syntaxError(query: string, fields?: readonly string[]): QuerySyntaxError {
  try {
    parseQuery(query, fields ? { fields } : {});
  } catch (error) {
    if (error instanceof QuerySyntaxError) {
      return error;
    }
    throw error;
  }
  throw new Error(`expected "${query}" to fail`);
}

describe('lexQuery', () => {
  it('produces typed tokens with offsets', () => {
    expect(lexQuery('title:"binary heap" -draft OR (x*)')).toEqual([
      { kind: 'field', text: 'title', start: 0, end: 6 },
      { kind: 'phrase', text: 'binary heap', start: 6, end: 19 },
      { kind: 'minus', text: '-', start: 20, end: 21 },
      { kind: 'word', text: 'draft', start: 21, end: 26 },
      { kind: 'or', text: 'OR', start: 27, end: 29 },
      { kind: 'lparen', text: '(', start: 30, end: 31 },
      { kind: 'word', text: 'x*', start: 31, end: 33 },
      { kind: 'rparen', text: ')', start: 33, end: 34 },
      { kind: 'eof', text: '', start: 34, end: 34 },
    ]);
  });

  it('treats lower-case operators, inner hyphens and dangling colons as text', () => {
    expect(lexQuery('and real-time note: -').map((token) => token.kind)).toEqual([
      'word',
      'word',
      'word',
      'word',
      'eof',
    ]);
  });
});

describe('parseQuery', () => {
  it('returns null for an empty query', () => {
    expect(parseQuery('')).toBeNull();
    expect(parseQuery('   ')).toBeNull();
  });

  it('parses leaves with their spans', () => {
    expect(parseQuery('  heap')).toEqual({ type: 'term', text: 'heap', start: 2, end: 6 });
    expect(parseQuery('"binary heap"')).toEqual({
      type: 'phrase',
      text: 'binary heap',
      start: 0,
      end: 13,
    });
    expect(parseQuery('title:hash*')).toEqual({
      type: 'prefix',
      text: 'hash',
      field: 'title',
      start: 6,
      end: 11,
    });
    expect(parseQuery('volatilty~2')).toEqual({
      type: 'fuzzy',
      text: 'volatilty',
      maxEdits: 2,
      start: 0,
      end: 11,
    });
  });

  it('defaults a bare ~ to one edit', () => {
    expect(parsed('teh~')).toBe('teh~1');
    expect(parsed('teh~0')).toBe('teh~0');
  });

  it('gives AND higher precedence than OR', () => {
    expect(parsed('a OR b AND c')).toBe('(a OR (b AND c))');
    expect(parsed('a AND b OR c AND d')).toBe('((a AND b) OR (c AND d))');
    expect(parsed('(a OR b) AND c')).toBe('((a OR b) AND c)');
  });

  it('reads juxtaposition with the default operator at that operator’s precedence', () => {
    expect(parsed('a b c')).toBe('(a OR b OR c)');
    expect(parsed('a b AND c')).toBe('(a OR (b AND c))');
    expect(parsed('a b c', 'AND')).toBe('(a AND b AND c)');
    expect(parsed('a b OR c', 'AND')).toBe('((a AND b) OR c)');
  });

  it('parses NOT and leading minus as exclusions that bind tightest', () => {
    expect(parsed('heap -binary')).toBe('(heap OR NOT binary)');
    expect(parsed('heap AND NOT binary')).toBe('(heap AND NOT binary)');
    expect(parsed('NOT a b')).toBe('(NOT a OR b)');
    expect(parsed('-(a OR b) c')).toBe('(NOT (a OR b) OR c)');
    expect(parsed('--a')).toBe('NOT NOT a');
  });

  it('applies a field scope to a single leaf or to a whole group', () => {
    expect(parsed('title:heap body')).toBe('(title:heap OR body)');
    expect(parsed('title:(heap OR "priority queue" -binary)')).toBe(
      '(title:heap OR title:"priority queue" OR NOT title:binary)',
    );
    expect(parsed('tags:data*')).toBe('tags:data*');
  });

  it('keeps operator words and modifiers out of plain terms', () => {
    expect(parsed('and or not')).toBe('(and OR or OR not)');
    expect(parsed('real-time')).toBe('real-time');
  });

  it('reports errors with 1-based columns', () => {
    const cases: [string, string, number][] = [
      ['(binary heap', 'Missing ")" to close the "(" at column 1', 13],
      ['binary heap)', 'Unexpected ")" without a matching "("', 12],
      ['binary AND', 'Expected a search term after AND but found end of query', 11],
      ['AND binary', 'Expected a search term before AND', 1],
      ['heap OR OR x', 'Expected a search term after OR but found "OR"', 9],
      ['NOT', 'Expected a search term after NOT but found end of query', 4],
      ['a -)', 'Expected a search term after "-" but found ")"', 4],
      ['(OR a)', 'Expected a search term before OR', 2],
      ['"binary heap', 'Unterminated phrase: add a closing quote', 1],
      ['"binary heap"~2', 'Phrase proximity ("..."~N) is not supported', 14],
      ['()', 'Empty parentheses', 1],
      ['da*ta', '"*" is only supported at the end of a word, as in data*', 3],
      ['*', 'Expected a word before "*"', 1],
      ['~2', 'Expected a word before "~"', 1],
      ['heap~x', 'Expected an edit distance after "~" but found "x"', 5],
      ['heap~3', 'Fuzzy edit distance must be 0, 1 or 2, not 3', 5],
      ['title:(body:heap)', 'Field scopes cannot be nested ("body:" inside "title:")', 8],
      ['title:body:heap', 'Expected a word, phrase or group after "title:" but found "body:"', 7],
      ['title:-heap', 'Expected a word, phrase or group after "title:" but found "-"', 7],
    ];
    for (const [query, message, column] of cases) {
      const error = syntaxError(query);
      expect(error.message, query).toBe(`${message} (column ${column})`);
      expect(error.column, query).toBe(column);
      expect(error.query).toBe(query);
      expect(error.code).toBe('QUERY_SYNTAX');
    }
  });

  it('validates field names when the caller supplies them', () => {
    const error = syntaxError('heap price:cheap', ['title', 'body']);
    expect(error.message).toBe(
      'Unknown field "price"; searchable fields are: title, body (column 6)',
    );
    expect(parseQuery('title:heap', { fields: ['title'] })).not.toBeNull();
  });

  it('limits nesting depth and query length', () => {
    const deep = `${'('.repeat(MAX_QUERY_DEPTH + 1)}x${')'.repeat(MAX_QUERY_DEPTH + 1)}`;
    expect(syntaxError(deep).message).toMatch(/nested more than 32 levels/);
    const ok = `${'('.repeat(MAX_QUERY_DEPTH)}x${')'.repeat(MAX_QUERY_DEPTH)}`;
    expect(parsed(ok)).toBe('x');
    expect(() => parseQuery('x'.repeat(MAX_QUERY_LENGTH + 1))).toThrow(SearchliteError);
    expect(() => parseQuery(42 as unknown as string)).toThrow(/must be a string/);
  });
});
