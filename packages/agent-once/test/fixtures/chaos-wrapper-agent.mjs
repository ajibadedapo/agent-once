import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [role, pidFile] = process.argv.slice(2);
if (role === 'child') {
  writeFileSync(pidFile, String(process.pid));
} else {
  spawn(process.execPath, [fileURLToPath(import.meta.url), 'child', pidFile], { stdio: ['ignore', 'ignore', 'inherit'] });
}
setInterval(() => {}, 60_000);
