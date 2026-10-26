import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, after } from 'node:test';
const root = fileURLToPath(new URL('..', import.meta.url)),
  temporary = realpathSync(mkdtempSync(join(tmpdir(), 'searchlite-release-pipeline-')));
after(() => rmSync(temporary, { recursive: true, force: true }));
const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8').split('\n');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
function step(name) {
  assert(
    ['Pack the tarball', 'Write checksums', 'Smoke-test the portable workflow'].includes(name),
  );
  const start = workflow.findIndex((line) => line.trim() === '- name: ' + name);
  assert(start >= 0, 'missing step ' + name);
  const next = workflow.findIndex((line, i) => i > start && line.startsWith('      - '));
  const section = workflow.slice(start + 1, next < 0 ? workflow.length : next);
  const index = section.findIndex((line) => line.trim().startsWith('run: '));
  assert(index >= 0, 'missing selected run: ' + name);
  const value = section[index].trim().slice(5);
  const code =
    value === '|'
      ? section
          .slice(index + 1)
          .map((line) => line.slice(10))
          .join('\n')
      : value;
  assert(!/\bgh\s/.test(code), 'publication commands must never run in fixture tests');
  return code;
}
const run = (code, cwd, env) =>
  spawnSync('bash', ['-e', '-c', code], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 2 * 1024 * 1024,
  });
for (const portable of [true, false])
  test(
    `actual release shell produces coherent ${portable ? 'portable' : 'legacy'} artifacts`,
    { timeout: 180000 },
    () => {
      const folder = join(temporary, portable ? 'portable' : 'legacy');
      mkdirSync(folder);
      const archive = execFileSync('git', ['archive', 'HEAD'], {
        cwd: root,
        maxBuffer: 8 * 1024 * 1024,
      });
      execFileSync('tar', ['-xf', '-', '-C', folder], { input: archive });
      symlinkSync(join(root, 'node_modules'), join(folder, 'node_modules'), 'dir');
      if (!portable) rmSync(join(folder, 'scripts/package_local_review.py'));
      const runner = join(folder, 'runner');
      mkdirSync(runner);
      const env = {
        ...process.env,
        GITHUB_WORKSPACE: folder,
        RUNNER_TEMP: runner,
        TAG: 'v' + version,
      };
      delete env.GH_TOKEN;
      delete env.GITHUB_TOKEN;
      delete env.GH_REPO;
      const packed = run(step('Pack the tarball'), folder, env);
      assert.equal(packed.status, 0, packed.stderr);
      const checks = run(step('Write checksums'), join(folder, 'release'), env);
      assert.equal(checks.status, 0, checks.stderr);
      const files = readdirSync(join(folder, 'release')).sort();
      const tgz = `searchlite-${version}.tgz`;
      const zip = `searchlite-local-review-${version}.zip`;
      const raw = readFileSync(join(folder, 'release', tgz)),
        hash = createHash('sha256').update(raw).digest('hex');
      assert(
        readFileSync(join(folder, 'release', 'SHA256SUMS.txt'), 'utf8').includes(hash + '  ' + tgz),
      );
      if (portable) {
        assert.deepEqual(files, ['SHA256SUMS', 'SHA256SUMS.txt', tgz, zip]);
        assert.deepEqual(
          readFileSync(join(folder, 'release', 'SHA256SUMS')),
          readFileSync(join(folder, 'release', 'SHA256SUMS.txt')),
        );
        const zipHash = createHash('sha256')
          .update(readFileSync(join(folder, 'release', zip)))
          .digest('hex');
        assert(
          readFileSync(join(folder, 'release', 'SHA256SUMS'), 'utf8').includes(
            zipHash + '  ' + zip,
          ),
        );
        const verified = spawnSync(
          'python3',
          [
            '-c',
            "import hashlib,json,sys,zipfile; from pathlib import Path; p=Path(sys.argv[1]); v=sys.argv[2]; name='searchlite-'+v+'.tgz'; z=zipfile.ZipFile(p/('searchlite-local-review-'+v+'.zip')); prefix='searchlite-local-review-'+v+'/'; raw=(p/name).read_bytes(); assert z.read(prefix+name)==raw; m=json.loads(z.read(prefix+'bundle-manifest.json')); assert m['files'][name]['sha256']==hashlib.sha256(raw).hexdigest()",
            join(folder, 'release'),
            version,
          ],
          { encoding: 'utf8' },
        );
        assert.equal(verified.status, 0, verified.stderr);
        const smoke = run(step('Smoke-test the portable workflow'), folder, env);
        assert.equal(smoke.status, 0, smoke.stderr);
      } else assert.deepEqual(files, ['SHA256SUMS.txt', tgz]);
    },
  );
