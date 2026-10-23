/**
 * The scoring functions of BM25 and BM25F, following S. Robertson and H. Zaragoza, "The
 * Probabilistic Relevance Framework: BM25 and Beyond", Foundations and Trends in Information
 * Retrieval 3(4), 2009.
 *
 * For a query term t and document d with fields f:
 *
 *   B_f    = 1 − b_f + b_f · len(d, f) / avglen(f)          length normalization per field
 *   tf̃     = Σ_f w_f · tf(t, d, f) / B_f                    weighted pseudo-frequency
 *   score  = idf(t) · (k1 + 1) · tf̃ / (k1 + tf̃)             saturation applied once, after fields
 *
 * Combining the fields *before* saturating is what distinguishes BM25F from adding up one
 * BM25 score per field: a term that appears in both the title and the body still saturates
 * towards a single limit, instead of being rewarded twice.
 */

/**
 * Inverse document frequency in the form used by Lucene:
 * ln(1 + (N − n + 0.5) / (n + 0.5)), where N is the number of documents and n the number that
 * contain the term. The classic Robertson–Sparck Jones weight omits the "1 +", which makes the
 * weight negative for terms in more than half of the documents; this variant stays positive.
 */
export function inverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * Length normalization B for one field: 1 for an average-length field, more for longer ones.
 * `b` = 0 turns normalization off; `b` = 1 normalizes fully.
 */
export function lengthNormalization(b: number, length: number, averageLength: number): number {
  if (averageLength <= 0) {
    return 1;
  }
  return 1 - b + (b * length) / averageLength;
}

/**
 * Term-frequency saturation (k1 + 1) · tf / (k1 + tf). It grows quickly for the first few
 * occurrences and then flattens towards k1 + 1, so repeating a word has diminishing returns.
 * k1 = 0 reduces to a binary "present or not" model.
 */
export function saturate(frequency: number, k1: number): number {
  if (frequency <= 0) {
    return 0;
  }
  return ((k1 + 1) * frequency) / (k1 + frequency);
}
