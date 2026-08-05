/**
 * One Derailed must never tidy away another one's containers.
 *
 * Reconciliation removes containers whose service is not in the database, which is
 * right when a service was deleted and catastrophic when the database belongs to a
 * different installation. Running a second instance for ten seconds to smoke-test a
 * build deleted four running apps on the same machine, so every container now carries
 * the id of the installation that made it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from '../src/config.ts';
import { installId, LABELS, managedLabels } from '../src/docker/labels.ts';

describe('the installation id', () => {
  test('is written beside the database and reused', () => {
    const first = installId();
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(installId()).toBe(first);

    const file = join(paths.dataDir, 'install.id');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim()).toBe(first);
  });

  test('is stamped on everything Derailed creates', () => {
    const labels = managedLabels({ role: 'app', serviceId: 'abc' });
    expect(labels[LABELS.managed]).toBe('true');
    expect(labels[LABELS.install]).toBe(installId());
  });

  test('tells our containers apart from another installation on the same machine', () => {
    // The check reconcile makes before removing an orphan.
    const ours = managedLabels({ role: 'app', serviceId: 'gone' });
    const theirs = { ...ours, [LABELS.install]: 'a0a0a0a0a0a0a0a0' };
    const legacy = { ...ours };
    delete legacy[LABELS.install];

    const isOurs = (labels: Record<string, string>) => {
      const owner = labels[LABELS.install];
      return !owner || owner === installId();
    };

    expect(isOurs(ours)).toBe(true);
    expect(isOurs(theirs)).toBe(false);
    // Containers made before this label existed are still adopted, so an upgrade does
    // not orphan everything that is already running.
    expect(isOurs(legacy)).toBe(true);
  });
});
