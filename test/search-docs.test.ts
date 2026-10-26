import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(REPO, 'examples/search-docs.js');
let temporary: string;
let docs: string;
let snapshot: string;

beforeEach(() => {
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'searchlite-docs-')));
  docs = join(temporary, 'notes');
  mkdirSync(docs);
  snapshot = join(temporary, 'notes.json');
});
afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

function write(name: string, text: string | Buffer): string {
  const file = join(docs, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}
function indexed() {
  const result = run('index', docs, snapshot);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(readFileSync(snapshot, 'utf8')) as {
    format: string;
    version: number;
    documents: { id: string; stored: { title: string; body: string } }[];
  };
}
function failure(result: ReturnType<typeof run>, code: string) {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(code);
  expect(result.stderr).not.toMatch(/\n\s+at /u);
}

describe('local-documents built-package consumer', () => {
  it('writes a real snapshot and searches it with a hand-derived score and explanation', () => {
    write('a.md', 'quartzoverride instructions');
    write('sub/b.txt', 'invoice retention');
    const saved = indexed();
    expect(saved.format).toBe('searchlite');
    expect(saved.version).toBe(1);
    expect(saved.documents.map((d) => d.id)).toEqual(['a.md', 'sub/b.txt']);
    expect(saved.documents[0]?.stored).toEqual({ title: 'a', body: 'quartzoverride instructions' });
    rmSync(docs, { recursive: true });
    const found = run('search', snapshot, 'quartzoverride');
    expect(found.status, found.stderr).toBe(0);
    expect(found.stdout).toContain('a.md score=0.693'); // ln(1 + 1.5/1.5), tf/normalization = 1.
    expect(found.stdout).toContain('quartzoverride instructions');
    expect(found.stdout).toContain('idf 0.693');
    expect(found.stdout).toContain('body: tf 1, length 2 (avg 2)');
    expect(found.stdout).not.toContain('sub/b.txt score=');
  });

  it('uses deterministic path order for ties and stable IDs across selected roots', () => {
    write('zeta.TXT', 'quartzoverride instructions');
    write('alpha.md', 'quartzoverride instructions');
    const original = indexed();
    const other = join(temporary, 'elsewhere');
    mkdirSync(other);
    writeFileSync(join(other, 'alpha.md'), 'quartzoverride instructions');
    writeFileSync(join(other, 'zeta.TXT'), 'quartzoverride instructions');
    const second = join(temporary, 'second.json');
    expect(run('index', other, second).status).toBe(0);
    expect(readFileSync(second, 'utf8')).toBe(readFileSync(snapshot, 'utf8'));
    expect(original.documents.map((d) => d.id)).toEqual(['alpha.md', 'zeta.TXT']);
    const found = run('search', snapshot, 'quartzoverride');
    expect(found.stdout.indexOf('alpha.md score=')).toBeLessThan(
      found.stdout.indexOf('zeta.TXT score='),
    );
  });

  it('skips hidden files, dependency/generated folders, unsupported files and empty text', () => {
    write('real.md', 'quartzoverride instructions');
    for (const name of [
      '.private.md',
      '.hidden/secret.txt',
      'node_modules/pkg/readme.md',
      'vendor/secret.md',
      'dist/secret.md',
      'build/secret.md',
      'coverage/secret.md',
      'out/secret.md',
      'output/secret.md',
      'target/secret.md',
      'generated/secret.md',
      'bower_components/secret.md',
      '__pycache__/secret.txt',
      'ignored.json',
    ]) {
      write(name, 'excludedsecret');
    }
    write('empty.txt', ' \n\t');
    expect(indexed().documents.map((d) => d.id)).toEqual(['real.md']);
    const found = run('search', snapshot, 'excludedsecret');
    expect(found.status).toBe(0);
    expect(found.stdout).toContain('No results.');
  });

  it.skipIf(process.platform === 'win32')(
    'skips linked files and directories without following them',
    () => {
      write('real.md', 'quartzoverride');
      const outside = join(temporary, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'private.md'), 'excludedsecret');
      symlinkSync(join(outside, 'private.md'), join(docs, 'linked.md'));
      symlinkSync(outside, join(docs, 'linked-directory'));
      expect(indexed().documents.map((d) => d.id)).toEqual(['real.md']);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses linked roots and snapshots', () => {
    write('real.md', 'quartzoverride');
    const linkedRoot = join(temporary, 'linked-root');
    symlinkSync(docs, linkedRoot);
    failure(run('index', linkedRoot, snapshot), 'UNSAFE_PATH');
    indexed();
    const linkedSnapshot = join(temporary, 'linked.json');
    symlinkSync(snapshot, linkedSnapshot);
    failure(run('search', linkedSnapshot, 'quartzoverride'), 'UNSAFE_PATH');
  });

  it('refuses multiply-linked eligible files', () => {
    const original = write('original.md', 'quartzoverride');
    linkSync(original, join(docs, 'second.md'));
    failure(run('index', docs, snapshot), 'UNSAFE_FILE');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('escapes terminal control and bidirectional characters in content, paths and queries', () => {
    write('x\u001b[31m.md', 'quartzoverride\u001b[2J\u202E <script>literal</script>');
    indexed();
    const found = run('search', snapshot, 'quartzoverride');
    expect(found.status).toBe(0);
    expect(found.stdout).not.toContain('\u001b');
    expect(found.stdout).not.toContain('\u202e');
    expect(found.stdout).toContain('\\u{001b}');
    expect(found.stdout).toContain('\\u{202e}');
    expect(found.stdout).toContain('<script>literal</script>');
    const badQuery = run('search', snapshot, '(\u001b[2J');
    failure(badQuery, 'INVALID_QUERY');
    expect(badQuery.stderr).not.toContain('\u001b');
  });

  it('bounds snippets and limits result output to five documents', () => {
    for (let i = 0; i < 7; i++) write(`${i}.txt`, 'quartzoverride ' + 'details '.repeat(100));
    indexed();
    const found = run('search', snapshot, 'quartzoverride');
    expect(found.status).toBe(0);
    expect(found.stdout.match(/^\d\. .* score=/gm)).toHaveLength(5);
    expect(
      found.stdout
        .split('\n')
        .filter((line) => line.startsWith('   snippet: '))
        .every((line) => line.length < 300),
    ).toBe(true);
  });

  it.each([Buffer.from([0xff]), Buffer.from('before\0after')])(
    'rejects invalid text before publishing an index',
    (data) => {
      write('valid.md', 'quartzoverride');
      write('invalid.txt', data);
      const result = run('index', docs, snapshot);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/INVALID_UTF8|INVALID_TEXT/u);
      expect(existsSync(snapshot)).toBe(false);
    },
  );

  it('rejects missing roots, file roots, empty corpora and excluded roots clearly', () => {
    failure(run('index', join(temporary, 'missing'), snapshot), 'DIRECTORY_UNREADABLE');
    const regular = write('file.md', 'quartzoverride');
    failure(run('index', regular, snapshot), 'DIRECTORY_UNREADABLE');
    rmSync(regular);
    failure(run('index', docs, snapshot), 'NO_DOCUMENTS');
    const generated = join(temporary, 'dist');
    mkdirSync(generated);
    writeFileSync(join(generated, 'generated.md'), 'quartzoverride');
    failure(run('index', generated, snapshot), 'EXCLUDED_ROOT');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'reports unreadable eligible input without partial snapshot output',
    () => {
      const file = write('unreadable.md', 'quartzoverride');
      chmodSync(file, 0);
      try {
        failure(run('index', docs, snapshot), 'FILE_UNREADABLE');
      } finally {
        chmodSync(file, 0o600);
      }
      expect(existsSync(snapshot)).toBe(false);
    },
  );

  it('refuses existing snapshot outputs and absent output directories', () => {
    write('real.md', 'quartzoverride');
    writeFileSync(snapshot, 'original bytes');
    failure(run('index', docs, snapshot), 'SNAPSHOT_EXISTS');
    expect(readFileSync(snapshot, 'utf8')).toBe('original bytes');
    failure(run('index', docs, join(temporary, 'missing', 'snapshot.json')), 'OUTPUT_UNWRITABLE');
  });

  it('enforces the 128 KiB per-file limit', () => {
    write('too-large.txt', Buffer.alloc(128 * 1024 + 1, 120));
    failure(run('index', docs, snapshot), 'FILE_LIMIT');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('enforces the 1 MiB eligible-corpus byte limit', () => {
    for (let i = 0; i < 9; i++) write(`${i}.txt`, Buffer.alloc(128 * 1024, 120));
    failure(run('index', docs, snapshot), 'CORPUS_LIMIT');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('enforces the 128 eligible-file limit', () => {
    for (let i = 0; i < 129; i++) write(`${i}.txt`, 'x');
    failure(run('index', docs, snapshot), 'DOCUMENT_LIMIT');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('enforces the traversal entry limit even for unsupported files', () => {
    for (let i = 0; i < 4097; i++) write(`${i}.bin`, 'x');
    failure(run('index', docs, snapshot), 'ENTRY_LIMIT');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('enforces directory depth before walking indefinitely', () => {
    write(Array.from({ length: 17 }, () => 'nested').join('/') + '/deep.md', 'quartzoverride');
    failure(run('index', docs, snapshot), 'DEPTH_LIMIT');
    expect(existsSync(snapshot)).toBe(false);
  });

  it('rejects malformed, incompatible and oversized snapshots without modifying them', () => {
    writeFileSync(snapshot, '{"private":"sensitive malformed');
    failure(run('search', snapshot, 'quartzoverride'), 'INVALID_SNAPSHOT');
    expect(readFileSync(snapshot, 'utf8')).toBe('{"private":"sensitive malformed');
    expect(run('search', snapshot, 'quartzoverride').stderr).not.toContain('sensitive');
    writeFileSync(snapshot, '{"format":"searchlite","version":999}');
    failure(run('search', snapshot, 'quartzoverride'), 'INVALID_SNAPSHOT');
    truncateSync(snapshot, 16 * 1024 * 1024 + 1);
    failure(run('search', snapshot, 'quartzoverride'), 'SNAPSHOT_LIMIT');
  });

  it('reports missing/nonregular snapshots and invalid queries clearly', () => {
    failure(run('search', snapshot, 'quartzoverride'), 'FILE_UNREADABLE');
    failure(run('search', docs, 'quartzoverride'), 'UNSAFE_FILE');
    write('real.md', 'quartzoverride');
    indexed();
    failure(run('search', snapshot, '('), 'INVALID_QUERY');
    failure(run('search', snapshot, ' '), 'INVALID_QUERY');
    failure(run('search', snapshot, 'x'.repeat(1001)), 'INVALID_QUERY');
  });

  it.each(
    [
      [],
      ['index'],
      ['search'],
      ['index', 'one'],
      ['search', 'one', 'two', 'extra'],
      ['unknown', 'one', 'two'],
    ].map((args) => ({ args })),
  )('returns usage exit 2 for invalid arguments $args', ({ args }) => {
    const result = run(...args);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('USAGE');
    expect(existsSync(snapshot)).toBe(false);
  });
});

it('does not turn newlines in filenames into explanation or diagnostic lines', () => {
  write('x\nFORGED.md', 'quartzoverride instructions');
  indexed();
  const found = run('search', snapshot, 'quartzoverride');
  expect(found.status).toBe(0);
  expect(found.stdout).not.toContain('\nFORGED');
  expect(found.stdout).toContain('\\u{000a}FORGED');
  const missing = run('search', join(temporary, 'missing\nFORGED.json'), 'quartzoverride');
  failure(missing, 'FILE_UNREADABLE');
  expect(missing.stderr).not.toContain('\nFORGED');
  expect(missing.stderr).toContain('\\u{000a}FORGED');
});

it('skips case variants of dependency and generated folder names', () => {
  write('real.md', 'quartzoverride');
  write('Node_Modules/package/secret.md', 'excludedsecret');
  write('DIST/secret.md', 'excludedsecret');
  expect(indexed().documents.map((document) => document.id)).toEqual(['real.md']);
});

it('accepts exactly 128 KiB while preserving the original document bytes', () => {
  const body = 'quartzoverride' + ' '.repeat(128 * 1024 - 14);
  const original = write('boundary.txt', body);
  indexed();
  expect(readFileSync(original, 'utf8')).toBe(body);
  expect(run('search', snapshot, 'quartzoverride').status).toBe(0);
});

it('refuses an output path colliding with a source file and preserves all input bytes', () => {
  const body = 'quartzoverride instructions';
  const original = write('source.txt', body);
  const other = write('other.md', 'invoice retention');
  failure(run('index', docs, original), 'SNAPSHOT_EXISTS');
  expect(readFileSync(original, 'utf8')).toBe(body);
  expect(readFileSync(other, 'utf8')).toBe('invoice retention');
});
