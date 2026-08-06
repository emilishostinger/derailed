import type { MetricPoint, MetricsHistory } from '@derailed/shared';
import { db } from '../db/index.ts';
import { listDeployments } from '../db/repo/deployments.ts';

/**
 * What things looked like an hour ago.
 *
 * CPU and memory were live-only, which made "was it slow last night?" and "is this
 * getting worse?" both unanswerable. Neither is an exotic question; they are the two
 * questions anybody asks about a server.
 *
 * The average and the peak are both kept, because an average on its own hides exactly
 * the spike somebody is looking for: an app that sits at 4% and touches 100% once an
 * hour is a very different app from one that sits at 6%.
 *
 * And deploys are returned alongside, which is the whole point. "Memory started
 * climbing on Tuesday" is a sentence; "memory started climbing right after that
 * deploy" is a diagnosis, and the only difference is a vertical line on a chart.
 */

const HOUR_MS = 60 * 60 * 1000;
/** A month. Long enough to see a trend, short enough to stay small on a small disk. */
const KEEP_MS = 31 * 24 * HOUR_MS;

function hourOf(at: number): number {
  return Math.floor(at / HOUR_MS) * HOUR_MS;
}

/**
 * Folds one live sample into the hour it belongs to.
 *
 * Called from the monitor's existing five-second sampler, so this adds no polling of
 * its own: it is arithmetic on a number that was already being collected and thrown
 * away.
 */
export function recordSample(
  serviceId: string,
  cpuPercent: number,
  memoryBytes: number,
  memoryLimitBytes: number,
  at = Date.now(),
): void {
  const hour = hourOf(at);
  db()
    .query(
      `INSERT INTO metrics_hourly
         (service_id, hour_start, samples, cpu_total, cpu_peak, memory_total, memory_peak, memory_limit)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(service_id, hour_start) DO UPDATE SET
         samples      = samples + 1,
         cpu_total    = cpu_total + excluded.cpu_total,
         cpu_peak     = MAX(cpu_peak, excluded.cpu_peak),
         memory_total = memory_total + excluded.memory_total,
         memory_peak  = MAX(memory_peak, excluded.memory_peak),
         -- The limit can change between deploys, and the latest is the one that makes
         -- the older figures readable as a percentage.
         memory_limit = excluded.memory_limit`,
    )
    .run(
      serviceId,
      hour,
      cpuPercent,
      cpuPercent,
      Math.round(memoryBytes),
      Math.round(memoryBytes),
      Math.round(memoryLimitBytes),
    );
}

export type Range = '24h' | '7d' | '30d';

const SPANS: Record<Range, number> = {
  '24h': 24 * HOUR_MS,
  '7d': 7 * 24 * HOUR_MS,
  '30d': 30 * 24 * HOUR_MS,
};

/** The history for one app, with the deploys that happened during it. */
export function historyFor(serviceId: string, range: Range = '24h'): MetricsHistory {
  const since = hourOf(Date.now() - SPANS[range]);

  const rows = db()
    .query<
      {
        hour_start: number;
        samples: number;
        cpu_total: number;
        cpu_peak: number;
        memory_total: number;
        memory_peak: number;
        memory_limit: number;
      },
      [string, number]
    >(
      `SELECT * FROM metrics_hourly
        WHERE service_id = ? AND hour_start >= ?
        ORDER BY hour_start`,
    )
    .all(serviceId, since);

  const points: MetricPoint[] = rows.map((row) => ({
    at: row.hour_start,
    cpuAverage: row.samples ? Number((row.cpu_total / row.samples).toFixed(1)) : 0,
    cpuPeak: Number(row.cpu_peak.toFixed(1)),
    memoryAverage: row.samples ? Math.round(row.memory_total / row.samples) : 0,
    memoryPeak: row.memory_peak,
    memoryLimit: row.memory_limit || null,
  }));

  // Only the ones inside the window, and only the ones that actually shipped: a
  // failed deploy changed nothing, so a line for it would be a false explanation.
  const deploys = listDeployments(serviceId, 200)
    .filter((deployment) => deployment.status === 'running' || deployment.status === 'superseded')
    .filter((deployment) => (deployment.finishedAt ?? deployment.createdAt) >= since)
    .map((deployment) => ({
      id: deployment.id,
      at: deployment.finishedAt ?? deployment.createdAt,
      commitSha: deployment.commitSha,
      commitMessage: deployment.commitMessage,
    }));

  return { range, points, deploys, summary: summarise(points) };
}

/**
 * One sentence about the shape of it.
 *
 * Comparing the last quarter of the window with the first, because "it is using more
 * than it was" is the thing a chart is being read for, and reading it off a chart is
 * exactly what somebody who has never opened a terminal will not do.
 */
function summarise(points: MetricPoint[]): string {
  if (points.length < 4) return 'Not enough history yet to say anything useful.';

  const quarter = Math.max(1, Math.floor(points.length / 4));
  const mean = (list: MetricPoint[], pick: (point: MetricPoint) => number) =>
    list.reduce((sum, point) => sum + pick(point), 0) / list.length;

  const early = points.slice(0, quarter);
  const late = points.slice(-quarter);

  const memoryEarly = mean(early, (point) => point.memoryAverage);
  const memoryLate = mean(late, (point) => point.memoryAverage);
  const cpuLate = mean(late, (point) => point.cpuAverage);

  const growth = memoryEarly > 0 ? (memoryLate - memoryEarly) / memoryEarly : 0;

  if (growth > 0.5) {
    return `Memory has grown by about ${Math.round(growth * 100)}% over this period and has not come back down, which is what a leak looks like.`;
  }
  if (cpuLate > 80) {
    return 'This app has been busy for most of the recent period.';
  }
  return `Steady. Around ${cpuLate.toFixed(1)}% of a core, and memory is not trending up.`;
}

/** Drops anything older than a month. Called from the existing housekeeping sweep. */
export function pruneMetrics(now = Date.now()): number {
  const result = db()
    .query('DELETE FROM metrics_hourly WHERE hour_start < ?')
    .run(hourOf(now - KEEP_MS));
  return result.changes;
}
