import { normalizeText } from './normalize';
import { porterStem } from './porter';
import { ENGLISH_STOPWORDS } from './stopwords';
import { tokenize } from './tokenizer';

/** Per-field text analysis settings. */
export interface AnalyzerOptions {
  /** Reduce words to their Porter stem ("indexing" → "index"). Default `true`. */
  stemming?: boolean;
  /**
   * `true` removes {@link ENGLISH_STOPWORDS}, `false` keeps every word, and an array supplies a
   * custom list. Default `true`.
   */
  stopwords?: boolean | readonly string[];
}

/** A word after analysis, still tied to its location in the original text. */
export interface Token {
  /** The normalized (and possibly stemmed) term that is stored in the index. */
  term: string;
  /**
   * Ordinal of the word in the original text. Removed stopwords keep their slot, so in
   * "bank of america" the terms "bank" and "america" are two positions apart. Phrase matching
   * relies on this.
   */
  position: number;
  /** UTF-16 offset of the word's first character in the original text. */
  start: number;
  /** UTF-16 offset just past the word's last character. */
  end: number;
}

/**
 * Turns text into index terms: tokenize → normalize (NFKD, strip marks, lowercase) → drop
 * stopwords → stem. The same analyzer must be used for a field's documents and for queries
 * against that field, otherwise "Indexing" in a query would never meet "index" in the index.
 */
export class Analyzer {
  readonly stemming: boolean;
  readonly #stopwords: ReadonlySet<string>;

  constructor(options: AnalyzerOptions = {}) {
    this.stemming = options.stemming ?? true;
    const stopwords = options.stopwords ?? true;
    if (stopwords === true) {
      this.#stopwords = ENGLISH_STOPWORDS;
    } else if (stopwords === false) {
      this.#stopwords = new Set();
    } else {
      this.#stopwords = new Set(stopwords.map((word) => normalizeText(word)));
    }
  }

  /** Runs the full pipeline over a piece of text. */
  analyze(text: string): Token[] {
    const tokens: Token[] = [];
    for (const raw of tokenize(text)) {
      const normalized = normalizeText(raw.text);
      if (normalized === '' || this.#stopwords.has(normalized)) {
        continue;
      }
      tokens.push({
        term: this.stemming ? porterStem(normalized) : normalized,
        position: raw.position,
        start: raw.start,
        end: raw.end,
      });
    }
    return tokens;
  }

  /**
   * Normalizes and stems a single word without stopword removal. Fuzzy queries use this so that
   * a misspelled query word is compared with stems, which is what the index stores.
   */
  analyzeWord(word: string): string {
    const normalized = normalizeText(word);
    return this.stemming ? porterStem(normalized) : normalized;
  }
}
