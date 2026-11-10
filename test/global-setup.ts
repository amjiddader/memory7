import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** Build once before any test file runs. Test files that spawn dist/index.js must not each rebuild (tsup cleans dist). */
export default function setup(): void {
  execFileSync('npm', ['run', 'build'], { cwd: join(import.meta.dirname, '..'), stdio: 'ignore', shell: process.platform === 'win32' });
}
