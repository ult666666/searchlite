import { createComparison, serializeComparison } from '../examples/relevance-comparison';
import { CONFIGURATIONS } from '../corpus/retrieval';

const USAGE = 'Usage: npm run --silent eval:compare -- [--baseline=ID] [--candidate=ID]';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log(USAGE);
  console.log(`Configuration IDs: ${CONFIGURATIONS.map((c) => c.id).join(', ')}`);
  console.log(
    'Defaults: baseline=bm25f, candidate=no-stemming. Writes JSON only; no file or network access.',
  );
} else {
  try {
    const options = new Map<string, string>();
    for (const arg of args) {
      const match = /^--(baseline|candidate)=([a-z0-9-]+)$/.exec(arg);
      if (!match?.[1] || !match[2] || options.has(match[1])) {
        throw new Error('usage');
      }
      options.set(match[1], match[2]);
    }
    process.stdout.write(
      serializeComparison(createComparison(options.get('baseline'), options.get('candidate'))),
    );
  } catch {
    console.error(`Invalid comparison options. ${USAGE}`);
    process.exitCode = 2;
  }
}
