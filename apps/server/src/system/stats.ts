import { readFile } from 'node:fs/promises';
import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os';

/**
 * How the server itself is doing.
 *
 * Read from /proc where possible so the numbers are the real ones rather than
 * whatever Docker reports for a container. Everything is phrased so it can be shown
 * to someone who does not know what a load average is.
 */
export interface ServerStats {
  at: number;
  uptimeSeconds: number;
  cpu: {
    cores: number;
    /** 0–100, across all cores. */
    percent: number;
    load1: number;
  };
  memory: { totalBytes: number; usedBytes: number; percent: number };
  swap: { totalBytes: number; usedBytes: number } | null;
  /** A short, human sentence about the overall state. */
  summary: string;
  level: 'ok' | 'busy' | 'strained';
}

interface CpuSample {
  idle: number;
  total: number;
}

let previous: CpuSample | null = null;

async function sampleCpu(): Promise<CpuSample | null> {
  try {
    const text = await readFile('/proc/stat', 'utf8');
    const line = text.split('\n').find((entry) => entry.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0);
    const total = parts.reduce((sum, value) => sum + value, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

async function readMeminfo(): Promise<Record<string, number> | null> {
  try {
    const text = await readFile('/proc/meminfo', 'utf8');
    const values: Record<string, number> = {};
    for (const line of text.split('\n')) {
      const [key, rest] = line.split(':');
      if (!key || !rest) continue;
      values[key] = Number.parseInt(rest.trim(), 10) * 1024;
    }
    return values;
  } catch {
    return null;
  }
}

export async function serverStats(): Promise<ServerStats> {
  const cores = cpus().length || 1;

  // CPU is a rate, so it needs two readings. The first call after boot compares
  // against nothing and falls back to load average.
  const sample = await sampleCpu();
  let percent = 0;
  if (sample && previous && sample.total > previous.total) {
    const idleDelta = sample.idle - previous.idle;
    const totalDelta = sample.total - previous.total;
    percent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  } else {
    percent = Math.min(100, ((loadavg()[0] ?? 0) / cores) * 100);
  }
  if (sample) previous = sample;

  const meminfo = await readMeminfo();
  const totalBytes = meminfo?.MemTotal ?? totalmem();
  const availableBytes = meminfo?.MemAvailable ?? freemem();
  const usedBytes = Math.max(0, totalBytes - availableBytes);

  const swapTotal = meminfo?.SwapTotal ?? 0;
  const swapFree = meminfo?.SwapFree ?? 0;

  const memoryPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  const load1 = loadavg()[0] ?? 0;

  return {
    at: Date.now(),
    uptimeSeconds: Math.round(uptime()),
    cpu: { cores, percent: Math.round(percent), load1: Number(load1.toFixed(2)) },
    memory: {
      totalBytes,
      usedBytes,
      percent: Math.round(memoryPercent),
    },
    swap: swapTotal > 0 ? { totalBytes: swapTotal, usedBytes: swapTotal - swapFree } : null,
    ...describe(percent, memoryPercent),
  };
}

/** The number is for people who want it; the sentence is for everyone else. */
function describe(
  cpuPercent: number,
  memoryPercent: number,
): {
  summary: string;
  level: ServerStats['level'];
} {
  if (memoryPercent > 90) {
    return {
      level: 'strained',
      summary: 'This server is nearly out of memory. Builds may fail until something is stopped.',
    };
  }
  if (cpuPercent > 90) {
    return { level: 'strained', summary: 'This server is working very hard right now.' };
  }
  if (memoryPercent > 75 || cpuPercent > 70) {
    return { level: 'busy', summary: 'This server is busy, but coping.' };
  }
  return { level: 'ok', summary: 'This server has plenty of room.' };
}
