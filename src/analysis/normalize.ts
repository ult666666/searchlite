const COMBINING_MARKS = /\p{M}/gu;

/**
 * Folds text into the form used for matching: Unicode compatibility decomposition (NFKD), then
 * combining marks removed, then lowercase.
 *
 * NFKD splits an accented letter into its base letter plus a combining mark ("é" becomes
 * "e" + U+0301), so removing the marks makes "café" match "cafe". The compatibility part maps
 * presentation variants to plain characters: the "ﬁ" ligature becomes "fi" and full-width "Ａ"
 * becomes "A".
 */
export function normalizeText(text: string): string {
  return text.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();
}
