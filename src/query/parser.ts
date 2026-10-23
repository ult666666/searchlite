import { QuerySyntaxError, SearchliteError } from '../errors';
import { at } from '../internal/at';
import type { LeafNode, QueryNode } from './ast';
import { lexQuery, type QueryToken } from './lexer';

/** Operator applied between two terms that have no explicit AND/OR between them. */
export type DefaultOperator = 'AND' | 'OR';

export interface ParseOptions {
  /** How `a b` is read: as `a OR b` (default) or `a AND b`. */
  defaultOperator?: DefaultOperator;
  /** When given, `field:` prefixes must name one of these fields. */
  fields?: readonly string[];
}

/** Longest accepted query, in UTF-16 code units. Keeps recursion and expansion work bounded. */
export const MAX_QUERY_LENGTH = 2000;

/** Deepest accepted nesting of parentheses and NOTs, so hostile input cannot blow the stack. */
export const MAX_QUERY_DEPTH = 32;

/**
 * Parses a query string into a {@link QueryNode} tree, or returns `null` for an empty query.
 *
 * The parser is recursive descent over this grammar (EBNF; see docs/DESIGN.md for details):
 *
 * ```text
 * query   = [ or ] ;
 * or      = and { ( "OR" | implicit-or ) and } ;
 * and     = unary { ( "AND" | implicit-and ) unary } ;
 * unary   = ( "NOT" | "-" ) unary | primary ;
 * primary = "(" or ")" | FIELD ":" ( WORD | PHRASE | "(" or ")" ) | WORD | PHRASE ;
 * ```
 *
 * Juxtaposed terms (`a b`) use the default operator and bind at that operator's precedence, so
 * with the default OR, `a b AND c` means `a OR (b AND c)`. NOT binds tightest.
 *
 * @throws {QuerySyntaxError} with a 1-based `column` when the query is malformed.
 */
export function parseQuery(query: string, options: ParseOptions = {}): QueryNode | null {
  if (typeof query !== 'string') {
    throw new SearchliteError('INVALID_ARGUMENT', 'The query must be a string');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new SearchliteError(
      'INVALID_ARGUMENT',
      `The query is ${query.length} characters long; the limit is ${MAX_QUERY_LENGTH}`,
    );
  }
  return new Parser(query, options).parse();
}

function startsOperand(token: QueryToken): boolean {
  switch (token.kind) {
    case 'word':
    case 'phrase':
    case 'field':
    case 'lparen':
    case 'not':
    case 'minus':
      return true;
    default:
      return false;
  }
}

function describe(token: QueryToken): string {
  switch (token.kind) {
    case 'eof':
      return 'end of query';
    case 'phrase':
      return `"${token.text}"`;
    case 'field':
      return `"${token.text}:"`;
    default:
      return `"${token.text}"`;
  }
}

class Parser {
  readonly #query: string;
  readonly #tokens: QueryToken[];
  readonly #defaultOperator: DefaultOperator;
  readonly #fields: readonly string[] | undefined;
  #position = 0;
  #depth = 0;
  /** Field from an enclosing `field:( ... )` group, applied to every leaf inside it. */
  #scope: string | undefined;

  constructor(query: string, options: ParseOptions) {
    this.#query = query;
    this.#tokens = lexQuery(query);
    this.#defaultOperator = options.defaultOperator ?? 'OR';
    this.#fields = options.fields;
  }

  parse(): QueryNode | null {
    if (this.#peek().kind === 'eof') {
      return null;
    }
    const node = this.#parseOr();
    const leftover = this.#peek();
    if (leftover.kind !== 'eof') {
      // Every other token kind is consumed by the loops above, so only a stray ")" remains.
      throw this.#error('Unexpected ")" without a matching "("', leftover);
    }
    return node;
  }

  #parseOr(): QueryNode {
    const first = this.#parseAnd();
    const children = [first];
    for (;;) {
      const token = this.#peek();
      if (token.kind === 'or') {
        this.#advance();
        this.#expectOperandAfter('OR');
      } else if (!(this.#defaultOperator === 'OR' && startsOperand(token))) {
        break;
      }
      children.push(this.#parseAnd());
    }
    return children.length === 1 ? first : { type: 'or', children };
  }

  #parseAnd(): QueryNode {
    const first = this.#parseUnary();
    const children = [first];
    for (;;) {
      const token = this.#peek();
      if (token.kind === 'and') {
        this.#advance();
        this.#expectOperandAfter('AND');
      } else if (!(this.#defaultOperator === 'AND' && startsOperand(token))) {
        break;
      }
      children.push(this.#parseUnary());
    }
    return children.length === 1 ? first : { type: 'and', children };
  }

  #parseUnary(): QueryNode {
    const token = this.#peek();
    if (token.kind === 'not' || token.kind === 'minus') {
      this.#advance();
      this.#expectOperandAfter(token.kind === 'not' ? 'NOT' : '"-"');
      return this.#nested(token, () => ({ type: 'not', child: this.#parseUnary() }));
    }
    return this.#parsePrimary();
  }

  #parsePrimary(): QueryNode {
    const token = this.#advance();
    switch (token.kind) {
      case 'word':
        return this.#wordLeaf(token);
      case 'phrase':
        return this.#leaf('phrase', token.text, token);
      case 'lparen':
        return this.#parseGroup(token);
      case 'field':
        return this.#parseFieldScope(token);
      case 'rparen':
        throw this.#error('Unexpected ")" without a matching "("', token);
      case 'and':
      case 'or':
        throw this.#error(`Expected a search term before ${token.text}`, token);
      default:
        throw this.#error(`Expected a search term but found ${describe(token)}`, token);
    }
  }

  #parseGroup(open: QueryToken): QueryNode {
    if (this.#peek().kind === 'rparen') {
      throw this.#error('Empty parentheses', open);
    }
    const inner = this.#nested(open, () => this.#parseOr());
    const close = this.#advance();
    if (close.kind !== 'rparen') {
      throw this.#error(`Missing ")" to close the "(" at column ${open.start + 1}`, close);
    }
    return inner;
  }

  #parseFieldScope(field: QueryToken): QueryNode {
    if (this.#fields && !this.#fields.includes(field.text)) {
      throw this.#error(
        `Unknown field "${field.text}"; searchable fields are: ${this.#fields.join(', ')}`,
        field,
      );
    }
    if (this.#scope !== undefined) {
      throw this.#error(
        `Field scopes cannot be nested ("${field.text}:" inside "${this.#scope}:")`,
        field,
      );
    }
    const next = this.#peek();
    if (next.kind !== 'word' && next.kind !== 'phrase' && next.kind !== 'lparen') {
      throw this.#error(
        `Expected a word, phrase or group after "${field.text}:" but found ${describe(next)}`,
        next,
      );
    }
    this.#scope = field.text;
    try {
      return this.#parsePrimary();
    } finally {
      this.#scope = undefined;
    }
  }

  /** Interprets a word's trailing `*` (prefix) or `~N` (fuzzy) modifier. */
  #wordLeaf(token: QueryToken): LeafNode {
    const raw = token.text;
    const star = raw.indexOf('*');
    if (star !== -1) {
      if (star !== raw.length - 1) {
        throw this.#error('"*" is only supported at the end of a word, as in data*', token, star);
      }
      if (star === 0) {
        throw this.#error('Expected a word before "*"', token);
      }
      return this.#leaf('prefix', raw.slice(0, -1), token);
    }
    const tilde = raw.lastIndexOf('~');
    if (tilde !== -1) {
      if (tilde === 0) {
        throw this.#error('Expected a word before "~"', token);
      }
      const suffix = raw.slice(tilde + 1);
      if (!/^\d*$/.test(suffix)) {
        throw this.#error(
          `Expected an edit distance after "~" but found "${suffix}"`,
          token,
          tilde,
        );
      }
      const maxEdits = suffix === '' ? 1 : Number(suffix);
      if (maxEdits > 2) {
        throw this.#error(`Fuzzy edit distance must be 0, 1 or 2, not ${maxEdits}`, token, tilde);
      }
      return { ...this.#leaf('fuzzy', raw.slice(0, tilde), token), maxEdits };
    }
    return this.#leaf('term', raw, token);
  }

  #leaf<T extends 'term' | 'phrase' | 'prefix' | 'fuzzy'>(
    type: T,
    text: string,
    token: QueryToken,
  ): { type: T; text: string; field?: string; start: number; end: number } {
    const leaf = { type, text, start: token.start, end: token.end };
    return this.#scope === undefined ? leaf : { ...leaf, field: this.#scope };
  }

  #nested(token: QueryToken, parse: () => QueryNode): QueryNode {
    if (this.#depth >= MAX_QUERY_DEPTH) {
      throw this.#error(`Query is nested more than ${MAX_QUERY_DEPTH} levels deep`, token);
    }
    this.#depth++;
    try {
      return parse();
    } finally {
      this.#depth--;
    }
  }

  #expectOperandAfter(operator: string): void {
    const next = this.#peek();
    if (!startsOperand(next)) {
      throw this.#error(
        `Expected a search term after ${operator} but found ${describe(next)}`,
        next,
      );
    }
  }

  #peek(): QueryToken {
    // The token list always ends with "eof" and #advance never moves past it.
    return at(this.#tokens, this.#position);
  }

  #advance(): QueryToken {
    const token = this.#peek();
    if (token.kind !== 'eof') {
      this.#position++;
    }
    return token;
  }

  #error(message: string, token: QueryToken, offsetInToken = 0): QuerySyntaxError {
    return new QuerySyntaxError(message, this.#query, token.start + offsetInToken);
  }
}
