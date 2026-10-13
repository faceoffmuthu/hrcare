import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const children = [
  spawn(process.execPath, ['backend/src/server.js'], { cwd: root, stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/static-server.mjs'], { cwd: root, stdio: 'inherit' }),
];
let shuttingDown = false;
const shutdown = (code = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
};
for (const child of children) {
  child.on('error', (error) => { console.error('Could not start a local service:', error.message); shutdown(1); });
  child.on('exit', (code) => { if (!shuttingDown) shutdown(code || 0); });
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
console.log('Open HRs Portal at http://localhost:4173');
