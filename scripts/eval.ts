/**
 * Runs the glossary queries against several index configurations and prints an ablation table.
 *
 *   npm run eval
 *
 * The collection is tiny and the judgements were made by the author, so the numbers show how
 * the evaluation harness works; they are not evidence that one configuration is better in
 * general. The configurations were chosen up front and not tuned on these queries.
 */
import { GLOSSARY } from '../corpus/glossary';
import { QUERIES } from '../corpus/queries';
import { evaluate, type Qrels } from '../src/index';
import { CONFIGURATIONS, DEPTH, runConfiguration } from '../corpus/retrieval';

const qrels: Qrels = Object.fromEntries(QUERIES.map((query) => [query.id, query.judgements]));
const judgementCount = QUERIES.reduce(
  (sum, query) => sum + Object.keys(query.judgements).length,
  0,
);
const format = (value: number): string => value.toFixed(3);

console.log(
  `Corpus: ${GLOSSARY.length} documents, ${QUERIES.length} queries, ${judgementCount} graded judgements (1-3) by the author.`,
);
console.log(`P@5, R@10 and nDCG@10 use those cutoffs; MRR and MAP use the top ${DEPTH} results.\n`);
console.log('| Configuration | P@5 | R@10 | MRR | MAP | nDCG@10 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const configuration of CONFIGURATIONS) {
  const run = runConfiguration(configuration.id);
  const at5 = evaluate(run, qrels, { k: 5 }).mean;
  const at10 = evaluate(run, qrels, { k: 10 }).mean;
  const cells = [at5.precision, at10.recall, at10.reciprocalRank, at10.averagePrecision, at10.ndcg];
  console.log(`| ${configuration.name} | ${cells.map(format).join(' | ')} |`);
}
