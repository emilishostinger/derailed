#!/usr/bin/env bun
import { runCli } from './cli.ts';

runCli(process.argv.slice(2)).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
