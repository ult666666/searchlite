import { QuerySyntaxError } from '../errors';

export type QueryTokenKind =
  'word' | 'phrase' | 'field' | 'lparen' | 'rparen' | 'and' | 'or' | 'not' | 'minus' | 'eof';

/** A lexical token of the query language. */
export interface QueryToken {
  kind: QueryTokenKind;
  /** Word text, phrase content without quotes, field name without the colon, or the operator. */
  text: string;
  /** Offset of the token's first character. */
  start: number;
  /** Offset just past the token's last character. */
  end: number;
}

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATORS: Readonly<Record<string, QueryTokenKind>> = { AND: 'and', OR: 'or', NOT: 'not' };

function isSpace(char: string): boolean {
  return /\s/u.test(char);
}

function endsWord(char: string): boolean {
  return isSpace(char) || char === '(' || char === ')' || char === '"';
}

/**
 * Splits a query string into tokens. Operators are only recognized in upper case, so the
 * lower-case words "and", "or" and "not" are ordinary (stopword) terms.
 */
export function lexQuery(query: string): QueryToken[] {
  const tokens: QueryToken[] = [];
  let i = 0;
  while (i < query.length) {
    const char = query.charAt(i);
    if (isSpace(char)) {
      i++;
    } else if (char === '(' || char === ')') {
      tokens.push({ kind: char === '(' ? 'lparen' : 'rparen', text: char, start: i, end: i + 1 });
      i++;
    } else if (char === '"') {
      const close = query.indexOf('"', i + 1);
      if (close === -1) {
        throw new QuerySyntaxError('Unterminated phrase: add a closing quote', query, i);
      }
      tokens.push({ kind: 'phrase', text: query.slice(i + 1, close), start: i, end: close + 1 });
      i = close + 1;
      if (query.charAt(i) === '~') {
        throw new QuerySyntaxError('Phrase proximity ("..."~N) is not supported', query, i);
      }
    } else if (char === '-' && i + 1 < query.length && !isSpace(query.charAt(i + 1))) {
      // A leading minus excludes the next term; a minus inside a word ("real-time") is just text.
      tokens.push({ kind: 'minus', text: '-', start: i, end: i + 1 });
      i++;
    } else {
      let end = i;
      while (end < query.length && !endsWord(query.charAt(end))) {
        end++;
      }
      const word = query.slice(i, end);
      const colon = word.indexOf(':');
      const afterColon = query.charAt(i + colon + 1);
      // "title:heap" scopes the next term to a field. A colon followed by a space or the end of
      // the query ("note: ...") is plain text, so typing a field name does not raise an error
      // before the term has been typed.
      if (
        colon > 0 &&
        afterColon !== '' &&
        !isSpace(afterColon) &&
        FIELD_NAME.test(word.slice(0, colon))
      ) {
        tokens.push({ kind: 'field', text: word.slice(0, colon), start: i, end: i + colon + 1 });
        i += colon + 1;
      } else {
        tokens.push({ kind: OPERATORS[word] ?? 'word', text: word, start: i, end });
        i = end;
      }
    }
  }
  tokens.push({ kind: 'eof', text: '', start: query.length, end: query.length });
  return tokens;
}
