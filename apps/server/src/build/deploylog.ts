import { createReadStream } from 'node:fs';
import { appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { LogLine, LogStream } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { paths } from '../config.ts';
import { logBatcher } from '../events/bus.ts';

/**
 * Deployment logs live in newline-delimited JSON files rather than SQLite: appending
 * is cheap, tailing is easy, and a chatty build never bloats the database.
 */
export function logPathFor(deploymentId: string): string {
  return join(paths.logs, `${deploymentId}.ndjson`);
}

export class DeploymentLog {
  private queue: Promise<void> = Promise.resolve();

  constructor(
    readonly deploymentId: string,
    readonly serviceId: string,
    readonly projectId: string,
  ) {}

  get path(): string {
    return logPathFor(this.deploymentId);
  }

  /** Appends a line and pushes it to anyone watching (batched every 100ms). */
  write(line: string, stream: LogStream = 'system'): void {
    const entry: LogLine = { ts: Date.now(), stream, line };

    this.queue = this.queue.then(() =>
      appendFile(this.path, `${JSON.stringify(entry)}\n`).catch(() => undefined),
    );

    logBatcher.push(
      this.deploymentId,
      [topics.deployment(this.deploymentId), topics.service(this.serviceId)],
      entry,
      (lines) => ({ type: 'deployment.logs', deploymentId: this.deploymentId, lines }),
    );
  }

  /** Waits for queued writes, then flushes any batched lines to subscribers. */
  async flush(): Promise<void> {
    await this.queue;
    logBatcher.flush(
      this.deploymentId,
      [topics.deployment(this.deploymentId), topics.service(this.serviceId)],
      (lines) => ({ type: 'deployment.logs', deploymentId: this.deploymentId, lines }),
    );
  }
}

/** Reads the last `tail` lines of a deployment log. */
export async function readDeploymentLog(deploymentId: string, tail = 500): Promise<LogLine[]> {
  const file = Bun.file(logPathFor(deploymentId));
  if (!(await file.exists())) return [];

  const lines: LogLine[] = [];
  const reader = createInterface({ input: createReadStream(logPathFor(deploymentId)) });
  for await (const raw of reader) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as LogLine);
    } catch {
      lines.push({ ts: Date.now(), stream: 'system', line: raw });
    }
    // Keep memory flat on a huge log by dropping from the front as we go.
    if (lines.length > tail * 2) lines.splice(0, lines.length - tail);
  }
  return lines.slice(-tail);
}

export interface LogSearch {
  /** Case-insensitive plain text. Not a regular expression, on purpose. */
  query?: string;
  /** Only lines that look like something went wrong. */
  errorsOnly?: boolean;
  limit?: number;
}

/**
 * What "an error" looks like, without knowing the language.
 *
 * Deliberately broad and deliberately shallow. Somebody filtering a log to errors
 * wants the count to drop from four thousand to twelve, and a line wrongly kept costs
 * them nothing while a line wrongly dropped costs them the answer.
 */
const ERROR_SHAPED = new RegExp(
  [
    // Words, on their own.
    String.raw`\b(error|err|fail(ed|ure)?|fatal|exception|panic|traceback|refused|denied`,
    String.raw`|timeout|timed out|cannot|could not|unable to|warn(ing)?)\b`,
    // And the POSIX error codes, which carry no word boundary of their own:
    // `ECONNREFUSED` does not match `\brefused\b`, and it is one of the most common
    // things a log has to say.
    String.raw`|\bE(CONNREFUSED|CONNRESET|NOENT|ACCES|PERM|ADDRINUSE|TIMEDOUT|PIPE|ROFS|NOSPC|AI_AGAIN)\b`,
  ].join(''),
  'i',
);

export function looksLikeAnError(line: string): boolean {
  return ERROR_SHAPED.test(line);
}

/**
 * Searches one deploy's log.
 *
 * Live tail was there; everything anybody does with a log when something is wrong was
 * not. Streamed line by line rather than read whole, because the log of a build that
 * printed a progress bar for ten minutes is not something to put in memory to grep.
 */
export async function searchDeploymentLog(
  deploymentId: string,
  search: LogSearch = {},
): Promise<{ lines: LogLine[]; matched: number; scanned: number }> {
  const file = Bun.file(logPathFor(deploymentId));
  if (!(await file.exists())) return { lines: [], matched: 0, scanned: 0 };

  const limit = search.limit ?? 500;
  const needle = search.query?.trim().toLowerCase();
  const lines: LogLine[] = [];
  let matched = 0;
  let scanned = 0;

  const reader = createInterface({ input: createReadStream(logPathFor(deploymentId)) });
  for await (const raw of reader) {
    if (!raw.trim()) continue;
    scanned++;

    let entry: LogLine;
    try {
      entry = JSON.parse(raw) as LogLine;
    } catch {
      entry = { ts: Date.now(), stream: 'system', line: raw };
    }

    if (needle && !entry.line.toLowerCase().includes(needle)) continue;
    if (search.errorsOnly && !looksLikeAnError(entry.line)) continue;

    matched++;
    lines.push(entry);
    // The most recent matches are the ones wanted, so older ones are dropped as we go
    // rather than the whole set being kept and sliced at the end.
    if (lines.length > limit) lines.shift();
  }

  return { lines, matched, scanned };
}

export async function deleteDeploymentLog(deploymentId: string): Promise<void> {
  await rm(logPathFor(deploymentId), { force: true }).catch(() => undefined);
}
