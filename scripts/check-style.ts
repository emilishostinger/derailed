#!/usr/bin/env bun
/**
 * House style, enforced rather than requested.
 *
 * One rule so far: no em dashes, and no en dashes standing in for them. They are the
 * tell of copy that was pasted from somewhere or generated, they render as different
 * widths in a terminal, and they are a nuisance to type on most keyboards. A comma, a
 * colon, a full stop or a pair of brackets always says the same thing more plainly.
 *
 * A style rule nobody can check is a style rule that lasts until the second
 * contributor, so this runs as part of `bun run lint` and fails the build.
 */
import { readFileSync } from 'node:fs';

const BANNED = [
  { char: '—', name: 'em dash', instead: 'a comma, a colon, a full stop, or brackets' },
  { char: '–', name: 'en dash', instead: '"to" for a range, or a hyphen' },
];

const EXTENSIONS = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.md',
  '.json',
  '.yml',
  '.yaml',
  '.sh',
  '.html',
  '.css',
];

/** Only files git knows about, so build output and dependencies are never scanned. */
function trackedFiles(): string[] {
  const listed = Bun.spawnSync(['git', 'ls-files']).stdout.toString().split('\n');
  return listed.filter((file) => file && EXTENSIONS.some((ext) => file.endsWith(ext)));
}

let found = 0;

for (const file of trackedFiles()) {
  // This file names the characters it bans, which is the one place they belong.
  if (file === 'scripts/check-style.ts') continue;

  let contents: string;
  try {
    contents = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  contents.split('\n').forEach((line, index) => {
    for (const banned of BANNED) {
      if (!line.includes(banned.char)) continue;
      found++;
      console.error(`${file}:${index + 1}  ${banned.name}`);
      console.error(`  ${line.trim().slice(0, 100)}`);
      console.error(`  use ${banned.instead} instead\n`);
    }
  });
}

if (found > 0) {
  console.error(`${found} ${found === 1 ? 'line needs' : 'lines need'} rewriting.`);
  console.error('See docs/contributing.md for why this is a rule.');
  process.exit(1);
}

console.log('style: no em dashes, no en dashes');
