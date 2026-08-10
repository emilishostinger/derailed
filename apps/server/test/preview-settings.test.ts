/**
 * Screenshots default to on. The setting only exists to turn them off, and a
 * value written by an older version (either way) keeps meaning what it meant.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { deleteSetting, SETTINGS, setBoolSetting } from '../src/db/repo/settings.ts';
import { previewShotsEnabled } from '../src/runtime/preview.ts';

beforeAll(() => {
  initDb(join(mkdtempSync(join(tmpdir(), 'derailed-previews-')), 'test.db'));
});

describe('the screenshots default', () => {
  test('an absent setting means on', () => {
    deleteSetting(SETTINGS.previewShots);
    expect(previewShotsEnabled()).toBe(true);
  });

  test('an explicit off is honoured', () => {
    setBoolSetting(SETTINGS.previewShots, false);
    expect(previewShotsEnabled()).toBe(false);
  });

  test('turning it back on works', () => {
    setBoolSetting(SETTINGS.previewShots, true);
    expect(previewShotsEnabled()).toBe(true);
  });
});
