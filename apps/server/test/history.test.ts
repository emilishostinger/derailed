import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { looksLikeAnError } from '../src/build/deploylog.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { historyFor, pruneMetrics, recordSample } from '../src/runtime/metrics.ts';

/**
 * Keeping a record of what happened.
 *
 * CPU and memory were live-only, so "was it slow last night?" and "is this getting
 * worse?" were both unanswerable. The tests that matter are the ones about the peak
 * surviving averaging, since an average alone hides exactly the spike somebody is
 * looking for.
 */

const HOUR = 60 * 60 * 1000;

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function anApp() {
  const project = createProject('Shop');
  return createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
}

describe('folding samples into hours', () => {
  test('averages within the hour and keeps the peak separately', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;

    recordSample(app.id, 10, 100, 1000, hour + 60_000);
    recordSample(app.id, 20, 200, 1000, hour + 120_000);
    // The spike. An average alone would bury it at 40%, which is the whole reason
    // both figures are kept.
    recordSample(app.id, 90, 900, 1000, hour + 180_000);

    const point = historyFor(app.id, '24h').points[0];
    expect(point?.cpuAverage).toBe(40);
    expect(point?.cpuPeak).toBe(90);
    expect(point?.memoryAverage).toBe(400);
    expect(point?.memoryPeak).toBe(900);
  });

  test('keeps hours apart', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    recordSample(app.id, 10, 100, 1000, hour - HOUR + 60_000);
    recordSample(app.id, 50, 500, 1000, hour + 60_000);

    const points = historyFor(app.id, '24h').points;
    expect(points).toHaveLength(2);
    expect(points[0]?.cpuAverage).toBe(10);
    expect(points[1]?.cpuAverage).toBe(50);
  });

  test('leaves out anything older than the window', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    recordSample(app.id, 10, 100, 1000, hour - 40 * HOUR);
    recordSample(app.id, 20, 200, 1000, hour);

    expect(historyFor(app.id, '24h').points).toHaveLength(1);
    expect(historyFor(app.id, '7d').points).toHaveLength(2);
  });

  test('takes the newest memory limit, since it can change between deploys', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    recordSample(app.id, 10, 100, 1000, hour + 60_000);
    recordSample(app.id, 10, 100, 4000, hour + 120_000);
    expect(historyFor(app.id, '24h').points[0]?.memoryLimit).toBe(4000);
  });
});

describe('what it says about the shape', () => {
  test('admits when there is not enough to go on', () => {
    const app = anApp();
    recordSample(app.id, 10, 100, 1000);
    expect(historyFor(app.id, '24h').summary).toContain('Not enough history');
  });

  test('names a leak when memory climbs and stays up', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    // Eight hours of memory going up and never coming back down.
    for (let index = 0; index < 8; index++) {
      recordSample(app.id, 5, 100 * (index + 1), 10_000, hour - (7 - index) * HOUR + 60_000);
    }
    expect(historyFor(app.id, '24h').summary).toContain('leak');
  });

  test('says steady when it is', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    for (let index = 0; index < 8; index++) {
      recordSample(app.id, 4, 500, 10_000, hour - (7 - index) * HOUR + 60_000);
    }
    expect(historyFor(app.id, '24h').summary).toContain('Steady');
  });
});

describe('not growing without bound', () => {
  test('drops anything past a month', () => {
    const app = anApp();
    const hour = Math.floor(Date.now() / HOUR) * HOUR;
    recordSample(app.id, 10, 100, 1000, hour - 40 * 24 * HOUR);
    recordSample(app.id, 10, 100, 1000, hour);

    expect(pruneMetrics()).toBe(1);
    expect(historyFor(app.id, '30d').points).toHaveLength(1);
  });
});

describe('spotting an error in a log line', () => {
  test('catches the shapes an error actually takes', () => {
    for (const line of [
      "Error: Cannot find module 'express'",
      'FATAL: password authentication failed',
      'connect ECONNREFUSED 127.0.0.1:5432',
      'Traceback (most recent call last):',
      'panic: runtime error: index out of range',
      'warning: something looks off',
      'Unable to write to /data',
      'the request timed out',
    ]) {
      expect(looksLikeAnError(line)).toBe(true);
    }
  });

  test('leaves ordinary output alone', () => {
    // Broad on purpose: a line wrongly kept costs nothing, a line wrongly dropped
    // costs somebody the answer. But it still has to cut the volume down.
    for (const line of [
      'Listening on port 3000',
      'GET /index.html 200 4ms',
      'Compiled successfully in 812ms',
      'Server started',
    ]) {
      expect(looksLikeAnError(line)).toBe(false);
    }
  });
});
