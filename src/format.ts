import type { Explanation } from './search-index';

/**
 * Renders an {@link Explanation} as indented plain text, one line per clause and per field:
 *
 * ```text
 * heap: score 2.104 (k1 = 1.2)
 *   heap [heap] 2.104 = idf 1.674 × saturation(tf̃ 3.429)
 *     title: tf 1, length 2 (avg 1.85), boost 3, b 0.75 → 2.885
 * ```
 */
export function formatExplanation(explanation: Explanation, digits = 3): string {
  const n = (value: number): string => Number(value.toFixed(digits)).toString();
  if (!explanation.matched) {
    return `${explanation.id}: does not match`;
  }
  const lines = [`${explanation.id}: score ${n(explanation.score)} (k1 = ${n(explanation.k1)})`];
  for (const clause of explanation.clauses) {
    const weight = clause.weight === 1 ? '' : `${n(clause.weight)} × `;
    lines.push(
      `  ${clause.clause} [${clause.terms.join(' ')}] ${n(clause.score)} = ${weight}idf ${n(clause.idf)} × saturation(tf̃ ${n(clause.frequency)})`,
    );
    for (const field of clause.fields) {
      lines.push(
        `    ${field.field}: tf ${field.frequency}, length ${field.length} (avg ${n(field.averageLength)}), boost ${n(field.boost)}, b ${n(field.b)} → ${n(field.weightedFrequency)}`,
      );
    }
  }
  return lines.join('\n');
}
