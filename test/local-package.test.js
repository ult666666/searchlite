import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/package_local_review.py');
const python = execFileSync('python3', ['-c', 'import sys; print(sys.executable)'], {
  encoding: 'utf8',
}).trim();
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'searchlite-package-')));
after(() => rmSync(temporary, { recursive: true, force: true }));
const run = (executable, args, cwd = root, env = process.env) =>
  spawnSync(executable, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 150000,
    maxBuffer: 4 * 1024 * 1024,
  });
const sha = (raw) => createHash('sha256').update(raw).digest('hex');

test('package builder help/usage and output refusals preserve existing files before npm work', () => {
  assert.equal(run(python, [script, '--help']).status, 0);
  assert.equal(run(python, [script]).status, 2);
  const existing = join(temporary, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep.txt'), 'keep');
  const link = join(temporary, 'broken-link');
  symlinkSync(join(temporary, 'absent'), link);
  for (const destination of [existing, link, join(temporary, 'missing-parent', 'output')]) {
    const result = run(python, [script, destination], root, { ...process.env, PATH: '' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /OUTPUT/);
  }
  assert.equal(readFileSync(join(existing, 'keep.txt'), 'utf8'), 'keep');
  assert.deepEqual(readdirSync(existing), ['keep.txt']);
});

test('missing npm fails before any destination is published', () => {
  const destination = join(temporary, 'cannot-build');
  const result = run(python, [script, destination], root, { ...process.env, PATH: '' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /BUILD/);
  assert(!readdirSync(temporary).includes('cannot-build'));
});

test(
  'actual bundle has exact public payload and installs/runs all local workflows with empty offline cache',
  { timeout: 180000 },
  () => {
    const destination = join(temporary, 'release');
    const built = run(python, [script, destination]);
    assert.equal(built.status, 0, built.stderr);
    const receipt = JSON.parse(built.stdout);
    const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    assert.equal(receipt.version, version);
    const names = [`searchlite-${version}.tgz`, `searchlite-local-review-${version}.zip`];
    assert.deepEqual(readdirSync(destination).sort(), [...names, 'SHA256SUMS'].sort());
    const sums = readFileSync(join(destination, 'SHA256SUMS'), 'utf8');
    for (const name of names) {
      const raw = readFileSync(join(destination, name));
      assert(sums.includes(`${sha(raw)}  ${name}\n`));
    }
    const extraction = join(temporary, 'extracted');
    const unpack = run(python, [
      '-c',
      `import json,sys,zipfile,stat
from pathlib import PurePosixPath
with zipfile.ZipFile(sys.argv[1]) as z:
 for i in z.infolist():
  p=PurePosixPath(i.filename)
  assert not p.is_absolute() and '..' not in p.parts
  assert stat.S_ISREG(i.external_attr >> 16)
 z.extractall(sys.argv[2]); print(json.dumps(z.namelist()))`,
      join(destination, names[1]),
      extraction,
    ]);
    assert.equal(unpack.status, 0, unpack.stderr);
    const prefix = `searchlite-local-review-${version}/`;
    const entries = JSON.parse(unpack.stdout).map((name) => {
      assert(name.startsWith(prefix));
      return name.slice(prefix.length);
    });
    const copied = [
      'LICENSE',
      'docs/LOCAL_COMPARISON.md',
      'docs/LOCAL_RELEVANCE.md',
      'examples/search-docs.js',
      'examples/fixtures/relevance-notes/recovery.md',
      'examples/fixtures/relevance-notes/retention.md',
      'examples/fixtures/relevance-notes/webhooks.md',
      'examples/fixtures/relevance-notes/judgments.json',
      'examples/fixtures/relevance-notes/judgments-unmet.json',
    ];
    assert.deepEqual(
      entries.sort(),
      [
        ...copied,
        `searchlite-${version}.tgz`,
        'README.md',
        'package.json',
        'bundle-manifest.json',
      ].sort(),
    );
    const consumer = join(extraction, prefix);
    const manifest = JSON.parse(readFileSync(join(consumer, 'bundle-manifest.json'), 'utf8'));
    assert.equal(manifest.schema, 'searchlite.local-review-bundle/1');
    assert.equal(manifest.version, version);
    assert.deepEqual(
      Object.keys(manifest.files).sort(),
      entries.filter((x) => x !== 'bundle-manifest.json').sort(),
    );
    for (const [name, expected] of Object.entries(manifest.files)) {
      const raw = readFileSync(join(consumer, name));
      assert.deepEqual(expected, { bytes: raw.length, sha256: sha(raw) });
    }
    for (const name of copied)
      assert.deepEqual(readFileSync(join(consumer, name)), readFileSync(join(root, name)), name);
    const packageFile = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8'));
    assert.equal(packageFile.private, true);
    assert.equal(packageFile.type, 'module');
    assert(!packageFile.scripts);
    assert.deepEqual(packageFile.dependencies, { searchlite: `file:./searchlite-${version}.tgz` });
    const installed = run(
      'npm',
      [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        join(temporary, 'empty-cache'),
      ],
      consumer,
      { ...process.env, npm_config_registry: 'http://127.0.0.1:9/' },
    );
    assert.equal(installed.status, 0, installed.stderr);
    assert.deepEqual(
      readdirSync(join(consumer, 'node_modules')).filter((n) => !n.startsWith('.')),
      ['searchlite'],
    );
    const api = run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import assert from 'node:assert/strict';import * as ESM from 'searchlite';import {createRequire}from'node:module';import{readFileSync}from'node:fs';const CJS=createRequire(import.meta.url)('searchlite');for(const lib of[ESM,CJS]){const i=new lib.SearchIndex({fields:['body'],vectorField:'v'});i.addAll([{id:'orthogonal',body:'o',v:[0,1e308]},{id:'aligned',body:'a',v:[1e308,0]}]);assert.equal(i.searchHybrid({vector:[1e308,0],k:1})[0].id,'aligned');assert.equal(lib.cosineSimilarity([1e-200,0],[1e-200,0]),1);}const p=JSON.parse(readFileSync('node_modules/searchlite/package.json','utf8'));assert.deepEqual(p.dependencies??{},{});assert.equal(p.version,${JSON.stringify(version)});`,
      ],
      consumer,
    );
    assert.equal(api.status, 0, api.stderr);
    const cli = join(consumer, 'examples/search-docs.js'),
      notes = join(consumer, 'notes.json');
    const corpus = join(consumer, 'examples/fixtures/relevance-notes');
    const labels = join(consumer, 'labels.json'),
      unmet = join(consumer, 'unmet.json');
    writeFileSync(labels, readFileSync(join(corpus, 'judgments.json')));
    writeFileSync(unmet, readFileSync(join(corpus, 'judgments-unmet.json')));
    const invoke = (...args) => run(process.execPath, [cli, ...args], consumer);
    const indexed = invoke('index', corpus, notes);
    assert.equal(indexed.status, 0, indexed.stderr);
    const searched = invoke('search', notes, '"invoice retention"');
    assert.equal(searched.status, 0, searched.stderr);
    assert.match(searched.stdout, /retention.md/);
    rmSync(corpus, { recursive: true });
    const before = [notes, labels, unmet].map((f) => sha(readFileSync(f)));
    for (const command of ['evaluate', 'compare'])
      for (const [label, expected] of [
        [labels, 0],
        [unmet, 3],
      ]) {
        const args = command === 'compare' ? [notes, notes, label] : [notes, label];
        const result = invoke(command, ...args);
        assert.equal(result.status, expected, result.stderr);
        const report = JSON.parse(result.stdout);
        assert.equal(report.status, expected === 0 ? 'pass' : 'fail');
        assert.equal(invoke(command, ...args).stdout, result.stdout);
      }
    assert.deepEqual(
      [notes, labels, unmet].map((f) => sha(readFileSync(f))),
      before,
    );
  },
);

for (const mode of ['deadline', 'interrupt']) {
  test(
    `build ${mode} terminates its owned process group, including a spawned worker`,
    { timeout: 10000 },
    () => {
      const fixture = join(temporary, `hanging-${mode}.py`),
        pidFile = join(temporary, `${mode}.pid`);
      writeFileSync(
        fixture,
        `import json,os,subprocess,sys,time\np=subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)','searchlite-package-worker'])\nopen(sys.argv[1],'w').write(json.dumps({'worker':p.pid,'group':os.getpid()}))\ntime.sleep(60)\n`,
      );
      const result = run(python, [
        '-c',
        `import importlib.util,json,os,signal,subprocess,sys,threading,time
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('pack',sys.argv[1]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
started=time.monotonic(); timer=None
try:
 if sys.argv[4]=='interrupt':
  timer=threading.Timer(0.75,lambda:os.kill(os.getpid(),signal.SIGINT)); timer.start()
 try: module.run_build([sys.executable,sys.argv[2],sys.argv[3]],0.75 if timer is None else 120)
 except (module.Refusal,KeyboardInterrupt): pass
 else: raise AssertionError('build did not refuse')
 assert time.monotonic()-started < 3
 pid=json.load(open(sys.argv[3]))['worker']
 deadline=time.monotonic()+2
 while time.monotonic()<deadline:
  status=subprocess.run(['ps','-p',str(pid),'-o','stat='],capture_output=True,text=True)
  if status.returncode or status.stdout.strip().startswith('Z'): break
  time.sleep(0.02)
 else: raise AssertionError('owned worker survived '+sys.argv[4])
 print('owned descendant cleanup passed')
finally:
 if timer: timer.cancel()
 if os.path.exists(sys.argv[3]):
  ids=json.load(open(sys.argv[3])); args=subprocess.run(['ps','-p',str(ids['worker']),'-o','args='],capture_output=True,text=True).stdout
  parent=subprocess.run(['ps','-p',str(ids['group']),'-o','args='],capture_output=True,text=True).stdout
  if 'searchlite-package-worker' in args or sys.argv[2] in parent:
   try: os.killpg(ids['group'],signal.SIGKILL)
   except ProcessLookupError: pass`,
        script,
        fixture,
        pidFile,
        mode,
      ]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /owned descendant cleanup passed/);
    },
  );
}
