export { Analyzer, type AnalyzerOptions, type Token } from './analysis/analyzer';
export { normalizeText } from './analysis/normalize';
export { porterStem } from './analysis/porter';
export { ENGLISH_STOPWORDS } from './analysis/stopwords';
export { tokenize, type RawToken } from './analysis/tokenizer';
export { QuerySyntaxError, SearchliteError, type ErrorCode } from './errors';
export type {
  AndNode,
  FuzzyNode,
  LeafNode,
  NotNode,
  OrNode,
  PhraseNode,
  PrefixNode,
  QueryNode,
  TermNode,
} from './query/ast';
export {
  MAX_QUERY_DEPTH,
  MAX_QUERY_LENGTH,
  parseQuery,
  type DefaultOperator,
  type ParseOptions,
} from './query/parser';
export { osaDistance } from './structures/edit-distance';
