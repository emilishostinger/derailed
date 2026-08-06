import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previewName, previewsEnabled, previewsFor, setPreviews } from '../src/build/previews.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * A copy of an app, per branch.
 *
 * A preview is an ordinary service with two extra columns, which is the whole design:
 * every existing screen works on it without being taught anything. So the tests are
 * about it being off by default, and about the name being something a person would
 * recognise on an address.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-previews-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function anApp() {
  const project = createProject('Shop');
  return createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'repo',
    repoUrl: 'https://github.com/someone/shop',
    branch: 'main',
  });
}

describe('the setting', () => {
  test('is off until asked for', () => {
    const app = anApp();
    expect(previewsEnabled(app.id)).toBe(false);
    expect(previewsFor(app.id)).toEqual([]);
  });

  test('can be turned on and off', () => {
    const app = anApp();
    setPreviews(app.id, true);
    expect(previewsEnabled(app.id)).toBe(true);
    setPreviews(app.id, false);
    expect(previewsEnabled(app.id)).toBe(false);
  });
});

describe('what a preview is called', () => {
  test('reads as the app plus the branch', () => {
    expect(previewName('Web', 'login-redesign')).toBe('Web · login-redesign');
  });

  test('drops the prefix people put on branches out of habit', () => {
    expect(previewName('Web', 'feature/login')).toBe('Web · login');
    expect(previewName('Web', 'fix/broken-thing')).toBe('Web · broken-thing');
  });

  test('turns anything that is not a letter or a number into a dash', () => {
    // The name ends up in a web address, so it has to survive being one.
    expect(previewName('Web', 'JIRA-123_thing')).toBe('Web · JIRA-123-thing');
    expect(previewName('Web', 'a//b')).toBe('Web · a-b');
  });

  test('does not run away with a very long branch name', () => {
    const name = previewName('Web', 'x'.repeat(200));
    expect(name.length).toBeLessThan(45);
  });
});
