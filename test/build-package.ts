import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Both real CLI suites consume dist. Build once before workers instead of racing clean builds. */
export default function buildPackage(): void {
  execFileSync('npm', ['run', 'build'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: 'pipe',
    timeout: 30_000,
  });
}
