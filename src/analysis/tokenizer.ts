/** A word found in a piece of text, before normalization. */
export interface RawToken {
  /** The word exactly as it appears in the source text. */
  text: string;
  /** 0-based ordinal of the word within the text. */
  position: number;
  /** UTF-16 offset of the first character in the source text. */
  start: number;
  /** UTF-16 offset just past the last character, so `text === source.slice(start, end)`. */
  end: number;
}

// A word is a maximal run of Unicode letters, digits and combining marks. Everything else
// (spaces, punctuation, symbols, emoji) separates words.
const WORD = /[\p{L}\p{N}\p{M}]+/gu;

/**
 * Splits text into words and records where each one starts and ends.
 *
 * Offsets refer to the original string rather than to a normalized copy, because normalization
 * can change string length (the "ﬁ" ligature becomes two letters) and highlighting needs to
 * mark the user's original text.
 */
export function tokenize(text: string): RawToken[] {
  const tokens: RawToken[] = [];
  for (const match of text.matchAll(WORD)) {
    const word = match[0];
    tokens.push({
      text: word,
      position: tokens.length,
      start: match.index,
      end: match.index + word.length,
    });
  }
  return tokens;
}
