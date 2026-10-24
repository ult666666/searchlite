// Run with `npx tsx examples/quick-start.ts`. In your own project, import from 'searchlite'.
import { SearchIndex, formatExplanation } from '../src/index';

const index = new SearchIndex({
  fields: { title: { boost: 3 }, body: {}, tags: { boost: 2, stemming: false } },
});

index.addAll([
  {
    id: 'heap',
    title: 'Binary heap',
    body: 'A complete binary tree stored in an array, and the usual way to build a priority queue.',
    tags: ['data-structures'],
  },
  {
    id: 'trie',
    title: 'Trie',
    body: 'A prefix tree that shares common prefixes between strings, used for autocomplete.',
    tags: ['data-structures', 'strings'],
  },
  {
    id: 'npv',
    title: 'Net present value',
    body: 'Future cash flows discounted back to today, minus the initial investment.',
    tags: ['finance'],
  },
]);

for (const result of index.search('priority queue OR prefix*')) {
  console.log(result.id, result.score.toFixed(3), result.terms);
}
console.log(index.highlight('heap', 'body', '"priority queue"'));
console.log(formatExplanation(index.explain('heap', 'priority queue')));
