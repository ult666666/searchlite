import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The README shows real output. These checks fail when a change to the engine or the corpus
// leaves it stale.
const root = fileURLToPath(new URL('..', import.meta.url));
const readme = readFileSync(join(root, 'README.md'), 'utf8');

function runScript(script: string): string {
  const result = spawnSync(
    process.execPath,
    [join(root, 'node_modules/tsx/dist/cli.mjs'), script],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** The body of the first fenced block of `language` after `marker` in the README. */
function blockAfter(marker: string, language: string): string {
  const start = readme.indexOf(marker);
  expect(start, marker).toBeGreaterThanOrEqual(0);
  const fence = '```' + language + '\n';
  const open = readme.indexOf(fence, start) + fence.length;
  return readme.slice(open, readme.indexOf('```', open));
}

describe('README', { timeout: 60_000 }, () => {
  it('shows the quick start code and the output that code prints', () => {
    const example = readFileSync(join(root, 'examples/quick-start.ts'), 'utf8');
    // The example imports the source instead of the package and starts with a usage comment.
    const asDocumented = example
      .slice(example.indexOf('\n') + 1)
      .replace("from '../src/index';", "from 'searchlite';");
    expect(blockAfter('## Quick start', 'ts')).toBe(asDocumented);
    expect(runScript('examples/quick-start.ts')).toBe(
      blockAfter('Output (from `npx tsx examples/quick-start.ts`', 'text'),
    );
  });

  it('shows the table that npm run eval prints', () => {
    const rows = (text: string): string[] =>
      text
        .split('\n')
        .filter((line) => line.startsWith('|') && !line.startsWith('| -'))
        .map((line) =>
          line
            .split('|')
            .map((cell) => cell.trim())
            .join('|'),
        );
    const printed = runScript('scripts/eval.ts');
    const section = readme.slice(readme.indexOf('`npm run eval` indexes the glossary'));
    expect(printed.startsWith(blockAfter('`npm run eval` indexes the glossary', 'text'))).toBe(
      true,
    );
    const documented = rows(section.slice(0, section.indexOf('**Read this as')));
    expect(documented).toHaveLength(7);
    expect(rows(printed)).toEqual(documented);
  });
});
