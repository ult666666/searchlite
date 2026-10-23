export { Analyzer, type AnalyzerOptions, type Token } from './analysis/analyzer';
export { normalizeText } from './analysis/normalize';
export { porterStem } from './analysis/porter';
export { ENGLISH_STOPWORDS } from './analysis/stopwords';
export { tokenize, type RawToken } from './analysis/tokenizer';
export type { ClauseExplanation, FieldExplanation } from './engine/execute';
export { escapeHtml, type HighlightOptions } from './engine/highlight';
export { QuerySyntaxError, SearchliteError, type ErrorCode } from './errors';
export { formatExplanation } from './format';
export {
  cosineSimilarity,
  reciprocalRankFusion,
  type FusedResult,
  type FusionOptions,
} from './hybrid';
export type {
  FieldOptions,
  IndexOptions,
  ResolvedFieldOptions,
  ResolvedIndexOptions,
} from './options';
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
export {
  SNAPSHOT_VERSION,
  SearchIndex,
  type Explanation,
  type FieldStats,
  type HybridResult,
  type HybridSearchOptions,
  type IndexSnapshot,
  type IndexStats,
  type SearchDocument,
  type SearchOptions,
  type SearchResult,
  type SnapshotDocument,
} from './search-index';
export { osaDistance } from './structures/edit-distance';
