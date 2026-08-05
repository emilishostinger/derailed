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

export async function deleteDeploymentLog(deploymentId: string): Promise<void> {
  await rm(logPathFor(deploymentId), { force: true }).catch(() => undefined);
}
