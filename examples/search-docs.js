// Run after `npm run build`. This consumer deliberately uses the package's public exports.
import * as fs from 'node:fs';
import path from 'node:path';
import { TextDecoder } from 'node:util';
import { SearchIndex, formatExplanation } from 'searchlite';

const FILE_BYTES = 128 * 1024;
const CORPUS_BYTES = 1024 * 1024;
const FILE_COUNT = 128;
const ENTRIES = 4096;
const DEPTH = 16;
const SNAPSHOT_BYTES = 16 * 1024 * 1024;
const EXCLUDED = new Set([
  'node_modules',
  'bower_components',
  'vendor',
  'dist',
  'build',
  'coverage',
  'out',
  'output',
  'target',
  'generated',
  '__pycache__',
]);
const USAGE =
  'node examples/search-docs.js index DIRECTORY SNAPSHOT\n' +
  'node examples/search-docs.js search SNAPSHOT QUERY\nBuild the package first with npm run build.';

class DocsError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}
function refuse(code, message) {
  throw new DocsError(code, message);
}

// Preserve our own layout, escaping every untrusted line independently.
function safe(text) {
  return String(text).replace(
    /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16).padStart(4, '0')}}`,
  );
}
function snippet(text) {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return safe(Array.from(flat).slice(0, 180).join('')) + (Array.from(flat).length > 180 ? '…' : '');
}
function unlinkedPath(file) {
  for (let current = file; ; current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink())
      refuse('UNSAFE_PATH', 'Linked paths are not supported.');
    if (path.dirname(current) === current) break;
  }
}
function identity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':');
}
function readBounded(file, limit, limitCode) {
  let descriptor;
  try {
    unlinkedPath(file);
    const initial = fs.lstatSync(file);
    if (!initial.isFile() || initial.nlink !== 1)
      refuse('UNSAFE_FILE', 'Choose one regular unlinked file.');
    if (initial.size > limit) refuse(limitCode, `File exceeds ${limit} bytes.`);
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
    );
    const opened = fs.fstatSync(descriptor);
    if (identity(initial) !== identity(opened))
      refuse('FILE_CHANGED', 'Input changed while opening.');
    const buffer = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(descriptor, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    unlinkedPath(file);
    if (
      used !== opened.size ||
      identity(opened) !== identity(fs.fstatSync(descriptor)) ||
      identity(opened) !== identity(fs.lstatSync(file))
    ) {
      refuse('FILE_CHANGED', 'Input changed while reading.');
    }
    return buffer.subarray(0, used);
  } catch (error) {
    if (error instanceof DocsError) throw error;
    refuse('FILE_UNREADABLE', `Unable to read ${path.basename(file)}.`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function decode(data, code) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    refuse(code, 'Input must contain valid UTF-8.');
  }
}
function excluded(name) {
  return name.startsWith('.') || EXCLUDED.has(name.toLowerCase());
}

function collect(root) {
  try {
    unlinkedPath(root);
    if (!fs.lstatSync(root).isDirectory())
      refuse('DIRECTORY_UNREADABLE', 'Choose a readable document directory.');
  } catch (error) {
    if (error instanceof DocsError) throw error;
    refuse('DIRECTORY_UNREADABLE', 'Choose a readable document directory.');
  }
  if (root.split(path.sep).some((part) => part && excluded(part))) {
    refuse(
      'EXCLUDED_ROOT',
      'The selected root is inside an excluded hidden/dependency/generated directory.',
    );
  }
  const documents = [];
  let visited = 0;
  let eligible = 0;
  let bytes = 0;
  function walk(directory, depth) {
    if (depth > DEPTH) refuse('DEPTH_LIMIT', 'Directory nesting exceeds 16 levels.');
    let handle;
    const entries = [];
    try {
      unlinkedPath(directory);
      handle = fs.opendirSync(directory);
      for (let entry; (entry = handle.readSync()) !== null;) {
        if (++visited > ENTRIES) refuse('ENTRY_LIMIT', 'Directory traversal exceeds 4096 entries.');
        entries.push(entry.name);
      }
    } catch (error) {
      if (error instanceof DocsError) throw error;
      refuse('DIRECTORY_UNREADABLE', 'An included directory could not be read.');
    } finally {
      handle?.closeSync();
    }
    entries.sort();
    for (const name of entries) {
      if (excluded(name)) continue;
      const file = path.join(directory, name);
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        refuse('FILE_UNREADABLE', `Unable to inspect ${name}.`);
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        walk(file, depth + 1);
        continue;
      }
      const extension = path.extname(name).toLowerCase();
      if (extension !== '.md' && extension !== '.txt') continue;
      if (++eligible > FILE_COUNT) refuse('DOCUMENT_LIMIT', 'Corpus exceeds 128 eligible files.');
      if (stat.size > FILE_BYTES) refuse('FILE_LIMIT', 'An eligible file exceeds 131072 bytes.');
      if (bytes + stat.size > CORPUS_BYTES)
        refuse('CORPUS_LIMIT', 'Eligible corpus exceeds 1048576 bytes.');
      const data = readBounded(file, FILE_BYTES, 'FILE_LIMIT');
      bytes += data.length;
      if (bytes > CORPUS_BYTES) refuse('CORPUS_LIMIT', 'Eligible corpus exceeds 1048576 bytes.');
      if (data.includes(0)) refuse('INVALID_TEXT', `NUL bytes are not supported in ${name}.`);
      const body = decode(data, 'INVALID_UTF8');
      if (!body.trim()) continue;
      documents.push({
        id: path.relative(root, file).split(path.sep).join('/'),
        title: path.basename(name, path.extname(name)),
        body,
      });
    }
  }
  walk(root, 0);
  if (!documents.length) refuse('NO_DOCUMENTS', 'No nonempty UTF-8 .md/.txt documents were found.');
  return { documents, bytes };
}
function publish(file, data) {
  try {
    unlinkedPath(path.dirname(file));
    // wx refuses existing files, symlinks and competing writers without replacing them.
    fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof DocsError) throw error;
    if (error.code === 'EEXIST')
      refuse('SNAPSHOT_EXISTS', 'Snapshot already exists; choose a new filename.');
    refuse('OUTPUT_UNWRITABLE', 'Snapshot parent must be an existing writable unlinked directory.');
  }
}
function indexDocuments(directory, output) {
  const root = path.resolve(directory);
  const { documents, bytes } = collect(root);
  const index = new SearchIndex({ fields: { title: { boost: 3 }, body: {} } });
  index.addAll(documents);
  const data = JSON.stringify(index.toJSON()) + '\n';
  if (Buffer.byteLength(data) > SNAPSHOT_BYTES)
    refuse('SNAPSHOT_LIMIT', 'Serialized index exceeds 16777216 bytes.');
  publish(path.resolve(output), data);
  console.log(`Indexed ${documents.length} documents (${bytes} UTF-8 bytes).`);
  console.log(`Snapshot: ${safe(path.resolve(output))}`);
}
function restore(file) {
  const data = readBounded(path.resolve(file), SNAPSHOT_BYTES, 'SNAPSHOT_LIMIT');
  try {
    const raw = JSON.parse(decode(data, 'INVALID_SNAPSHOT'));
    if (
      !raw ||
      raw.format !== 'searchlite' ||
      !Array.isArray(raw.documents) ||
      raw.documents.length < 1 ||
      raw.documents.length > FILE_COUNT ||
      !Array.isArray(raw.options?.fields) ||
      raw.options.fields.length !== 2 ||
      raw.options.fields[0]?.name !== 'title' ||
      raw.options.fields[1]?.name !== 'body' ||
      raw.options.vectorField !== undefined ||
      raw.options.idField !== 'id' ||
      JSON.stringify(raw.options.storeFields) !== '["title","body"]'
    ) {
      refuse('INVALID_SNAPSHOT', 'Snapshot is not a bounded title/body document index.');
    }
    let bytes = 0;
    for (const document of raw.documents) {
      const { id, stored } = document;
      if (
        typeof id !== 'string' ||
        id.length > 4096 ||
        path.posix.isAbsolute(id) ||
        id.split('/').some((part) => !part || part === '..' || part === '.') ||
        typeof stored?.title !== 'string' ||
        typeof stored.body !== 'string' ||
        stored.title.length > 1024 ||
        document.vector !== undefined
      ) {
        refuse('INVALID_SNAPSHOT', 'Snapshot document fields are malformed.');
      }
      const length = Buffer.byteLength(stored.body);
      if (length > FILE_BYTES || (bytes += length) > CORPUS_BYTES) {
        refuse('INVALID_SNAPSHOT', 'Snapshot document text exceeds the corpus limits.');
      }
    }
    return SearchIndex.fromJSON(raw);
  } catch {
    refuse('INVALID_SNAPSHOT', 'Snapshot is malformed or incompatible with this example.');
  }
}
function searchSnapshot(file, query) {
  if (!query.trim() || query.length > 1000)
    refuse('INVALID_QUERY', 'Use a nonempty query of at most 1000 characters.');
  const index = restore(file);
  let results;
  try {
    results = index.search(query, { limit: 5 });
  } catch {
    refuse('INVALID_QUERY', 'Query syntax is invalid. See the searchlite query grammar.');
  }
  console.log(`Loaded ${index.size} documents. Query: ${safe(query)}`);
  if (!results.length) {
    console.log('No results.');
    return;
  }
  results.forEach((result, position) => {
    console.log(`${position + 1}. ${safe(result.id)} score=${result.score.toFixed(3)}`);
    console.log(`   snippet: ${snippet(result.fields.body)}`);
    const explanation = index.explain(result.id, query);
    explanation.id = safe(explanation.id);
    for (const clause of explanation.clauses) {
      clause.clause = safe(clause.clause);
      clause.terms = clause.terms.map(safe);
      for (const field of clause.fields) field.field = safe(field.field);
    }
    console.log(formatExplanation(explanation));
  });
}
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') console.log(USAGE);
  else {
    const [command, first, second] = args;
    if (args.length !== 3 || !first || !second || !['index', 'search'].includes(command)) {
      throw new DocsError('USAGE', USAGE, 2);
    }
    if (command === 'index') indexDocuments(first, second);
    else searchSnapshot(first, second);
  }
} catch (error) {
  const known = error instanceof DocsError;
  const code = known ? error.code : 'OPERATION_FAILED';
  const message = known ? error.message : 'The operation could not be completed.';
  console.error(`${code}: ${code === 'USAGE' ? USAGE : safe(message)}`);
  process.exitCode = known ? error.exitCode : 1;
}
