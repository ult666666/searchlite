import type { Token } from '../analysis/analyzer';
import { at } from '../internal/at';

export interface HighlightOptions {
  /**
   * Target snippet length in characters of source text (markup not counted). The snippet is cut
   * at word boundaries, so it can be slightly shorter. Default 160; `Infinity` keeps everything.
   */
  maxLength?: number;
  /** Text inserted where the snippet cuts the source. It is HTML-escaped. Default "…". */
  ellipsis?: string;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes the five characters that are significant in HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** A term or phrase to highlight, with phrase offsets as in the query plan. */
export interface HighlightTarget {
  terms: readonly string[];
  offsets: readonly number[];
}

/**
 * Selects the tokens to highlight: every occurrence of a single-term target, and for a phrase
 * only the tokens that actually form the phrase (not every stray "binary" in a text that
 * contains "binary heap" once). Returns tokens in text order.
 */
export function markTokens(tokens: readonly Token[], targets: readonly HighlightTarget[]): Token[] {
  const byPosition = new Map(tokens.map((token) => [token.position, token]));
  const marked = new Set<Token>();
  for (const target of targets) {
    for (const token of tokens) {
      if (token.term !== target.terms[0]) {
        continue;
      }
      const members = target.offsets.map((offset) => byPosition.get(token.position + offset));
      if (members.every((member, i) => member?.term === target.terms[i])) {
        for (const member of members) {
          if (member) {
            marked.add(member);
          }
        }
      }
    }
  }
  return tokens.filter((token) => marked.has(token));
}

/**
 * Builds an HTML snippet of `text` around the best cluster of marked tokens, wrapping them in
 * `<mark>`. Every piece of source text is escaped, so the only markup in the result is the
 * `<mark>` tags this function adds.
 *
 * The window is chosen with two pointers over the marked tokens: for each mark as the left
 * edge, extend right while the span fits in `maxLength`, and keep the window that covers the
 * most distinct terms (then the most marks). Leftover room is split between context before and
 * after the matches.
 */
export function buildSnippet(
  text: string,
  tokens: readonly Token[],
  marked: readonly Token[],
  options: HighlightOptions = {},
): string {
  const maxLength = options.maxLength ?? 160;
  const ellipsis = escapeHtml(options.ellipsis ?? '…');
  const [start, end] = chooseWindow(text, tokens, marked, maxLength);

  let html = start > 0 ? ellipsis : '';
  let cursor = start;
  for (const [markStart, markEnd] of mergeAdjacent(text, marked, start, end)) {
    html += `${escapeHtml(text.slice(cursor, markStart))}<mark>${escapeHtml(text.slice(markStart, markEnd))}</mark>`;
    cursor = markEnd;
  }
  html += escapeHtml(text.slice(cursor, end));
  return end < text.length ? html + ellipsis : html;
}

function chooseWindow(
  text: string,
  tokens: readonly Token[],
  marked: readonly Token[],
  maxLength: number,
): [number, number] {
  if (text.length <= maxLength) {
    return [0, text.length];
  }
  if (marked.length === 0) {
    return [0, contextEnd(text, tokens, maxLength, 0)];
  }

  let best = { from: 0, to: 1, distinct: 0, count: 0 };
  const termCounts = new Map<string, number>();
  let to = 0;
  for (let from = 0; from < marked.length; from++) {
    const left = at(marked, from);
    if (to <= from) {
      // Always include the left edge, even if that single token is longer than maxLength.
      termCounts.set(left.term, (termCounts.get(left.term) ?? 0) + 1);
      to = from + 1;
    }
    while (to < marked.length && at(marked, to).end - left.start <= maxLength) {
      const term = at(marked, to).term;
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
      to++;
    }
    const distinct = termCounts.size;
    const count = to - from;
    if (distinct > best.distinct || (distinct === best.distinct && count > best.count)) {
      best = { from, to, distinct, count };
    }
    const remaining = (termCounts.get(left.term) ?? 1) - 1;
    if (remaining === 0) {
      termCounts.delete(left.term);
    } else {
      termCounts.set(left.term, remaining);
    }
  }

  const firstMark = at(marked, best.from);
  const lastMark = at(marked, best.to - 1);
  const slack = Math.max(0, maxLength - (lastMark.end - firstMark.start));
  const start = contextStart(tokens, firstMark.start - Math.floor(slack / 2));
  return [start, contextEnd(text, tokens, start + maxLength, lastMark.end)];
}

/**
 * Start of the first token at or after `earliest`, or 0 if the window reaches the beginning.
 * The first marked token always qualifies, so the snippet never starts after the matches.
 */
function contextStart(tokens: readonly Token[], earliest: number): number {
  if (earliest <= 0) {
    return 0;
  }
  return tokens.find((token) => token.start >= earliest)?.start ?? earliest;
}

/** End of the last token that finishes by `latest`, but never before `minimum`. */
function contextEnd(
  text: string,
  tokens: readonly Token[],
  latest: number,
  minimum: number,
): number {
  if (latest >= text.length) {
    return text.length;
  }
  let end = minimum;
  for (const token of tokens) {
    if (token.end > latest) {
      break;
    }
    end = Math.max(end, token.end);
  }
  return end;
}

/** Marked spans inside [start, end), merging neighbours separated only by whitespace. */
function mergeAdjacent(
  text: string,
  marked: readonly Token[],
  start: number,
  end: number,
): [number, number][] {
  const spans: [number, number][] = [];
  for (const token of marked) {
    if (token.start < start || token.end > end) {
      continue;
    }
    const previous = spans.at(-1);
    if (previous && /^\s*$/.test(text.slice(previous[1], token.start))) {
      previous[1] = token.end;
    } else {
      spans.push([token.start, token.end]);
    }
  }
  return spans;
}
