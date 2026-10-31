import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export default function buildPackage(): void {
  const packageDir = fileURLToPath(new URL('..', import.meta.url));
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: packageDir, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
}
