#!/usr/bin/env bun
/**
 * Runs the server (watched) and Vite side by side.
 * Open http://localhost:5173, Vite proxies /api and the WebSocket to :8422.
 */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

const children = [
  spawn('bun', ['--watch', 'apps/server/src/index.ts', 'serve'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DERAILED_DEV: '1' },
  }),
  spawn('bun', ['run', '--cwd', 'apps/web', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
  }),
];

function stopAll(code = 0) {
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code) => stopAll(code ?? 0));
}
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log('\n  Dashboard (dev)  →  http://localhost:5173');
console.log('  API              →  http://localhost:8422\n');
