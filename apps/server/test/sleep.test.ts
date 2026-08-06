import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import {
  lastSeen,
  MIN_MINUTES,
  markSeen,
  setSleepAfter,
  shouldSleep,
  sleepSettingFor,
} from '../src/runtime/sleep.ts';

/**
 * Apps that pause when nobody is looking.
 *
 * The judgement worth testing is when *not* to sleep. Pausing something nobody has
 * visited yet, or something with the setting switched off, is the difference between
 * a feature people leave on and one they turn off after the first surprise.
 */

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

describe('the setting', () => {
  test('is off until asked for', () => {
    expect(sleepSettingFor(anApp().id)).toBeNull();
  });

  test('refuses an interval too short to be worth it', () => {
    // Below this, waking costs more than the sleeping saved.
    const app = anApp();
    setSleepAfter(app.id, 1);
    expect(sleepSettingFor(app.id)).toBeNull();

    setSleepAfter(app.id, MIN_MINUTES);
    expect(sleepSettingFor(app.id)).toBe(MIN_MINUTES);
  });

  test('can be turned off again', () => {
    const app = anApp();
    setSleepAfter(app.id, 30);
    setSleepAfter(app.id, null);
    expect(sleepSettingFor(app.id)).toBeNull();
  });
});

describe('deciding to sleep', () => {
  const now = 1_700_000_000_000;

  test('never, when the setting is off', () => {
    const app = anApp();
    markSeen(app.id, now - 10 * 60 * 60 * 1000);
    expect(shouldSleep(app.id, now)).toBe(false);
  });

  test('not while it is still being visited', () => {
    const app = anApp();
    setSleepAfter(app.id, 30);
    markSeen(app.id, now - 5 * 60 * 1000);
    expect(shouldSleep(app.id, now)).toBe(false);
  });

  test('once it has been quiet for long enough', () => {
    const app = anApp();
    setSleepAfter(app.id, 30);
    markSeen(app.id, now - 45 * 60 * 1000);
    expect(shouldSleep(app.id, now)).toBe(true);
  });

  test('never, when nobody has ever visited it', () => {
    // Something deployed five minutes ago with no traffic yet is new, not idle.
    // Pausing it would be the worst possible first impression.
    const app = anApp();
    setSleepAfter(app.id, 30);
    expect(lastSeen(app.id)).toBeNull();
    expect(shouldSleep(app.id, now)).toBe(false);
  });
});
