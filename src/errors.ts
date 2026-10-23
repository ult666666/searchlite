/**
 * Machine-readable reason attached to every {@link SearchliteError}, so callers can branch on
 * `error.code` instead of parsing messages.
 */
export type ErrorCode =
  | 'INVALID_OPTIONS'
  | 'INVALID_ARGUMENT'
  | 'INVALID_DOCUMENT'
  | 'DUPLICATE_ID'
  | 'NOT_FOUND'
  | 'INVALID_SNAPSHOT'
  | 'QUERY_SYNTAX';

/** Base class for every error thrown deliberately by searchlite. */
export class SearchliteError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'SearchliteError';
    this.code = code;
  }
}

/**
 * Thrown when a query string cannot be parsed or refers to something the index does not have
 * (for example an unknown field). `column` is 1-based so it can be shown to users directly.
 */
export class QuerySyntaxError extends SearchliteError {
  /** 1-based column in the query string where the problem was detected. */
  readonly column: number;
  /** The query string that failed to parse. */
  readonly query: string;

  constructor(message: string, query: string, offset: number) {
    const column = offset + 1;
    super('QUERY_SYNTAX', `${message} (column ${column})`);
    this.name = 'QuerySyntaxError';
    this.column = column;
    this.query = query;
  }
}
