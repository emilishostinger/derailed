/**
 * The "what changed since it last worked" diff.
 *
 * `diffDeploys` is attached to a failure automatically, so it runs at the worst possible
 * moment and gets read by someone already frustrated. It has to be right about three
 * things (which commits landed, which variables moved, whether the image changed), and
 * it has one rule it must never break: it compares variable *values* but never returns
 * one. A password that leaked into a diff would ride along into every screenshot pasted
 * into a chat asking for help.
 *
 * The diff is pure over the deployments table, so this drives the real function against
 * real rows, with no Docker in sight. Rows are created a couple of milliseconds apart on
 * purpose: the history is ordered by `created_at`, and same-millisecond ties would make
 * "the one before this" ambiguous.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diffDeploys } from '../src/build/diff.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createDeployment, updateDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-deploydiff-'));
let serviceId = '';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  // A fresh service per test so one test's history is never another's "before".
  const project = createProject('Diffed');
  serviceId = createAppService({
    projectId: project.id,
    name: 'web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  }).id;
});

/** A shipped deployment, a beat after the previous one so the ordering is unambiguous. */
async function shipped(patch: {
  commitSha?: string;
  commitMessage?: string;
  imageTag?: string;
  status?: 'running' | 'superseded';
}) {
  await Bun.sleep(2);
  const deployment = createDeployment(serviceId, 'manual');
  return updateDeployment(deployment.id, {
    status: patch.status ?? 'running',
    commitSha: patch.commitSha ?? null,
    commitMessage: patch.commitMessage ?? null,
    imageTag: patch.imageTag ?? null,
    finishedAt: Date.now(),
  })!;
}

describe('diffing two deploys', () => {
  test('an unknown deployment id has no diff', () => {
    expect(diffDeploys('does-not-exist')).toBeNull();
  });

  test('the very first deploy has no "before" and says so', async () => {
    const first = await shipped({ commitSha: 'aaaa111', commitMessage: 'initial' });
    const diff = diffDeploys(first.id)!;
    expect(diff.from).toBeNull();
    expect(diff.to.id).toBe(first.id);
    expect(diff.summary).toMatch(/first version/i);
  });

  test('the commits between two deploys are listed, newest first', async () => {
    await shipped({ commitSha: 'old0000', commitMessage: 'old base' });
    const mid = await shipped({ commitSha: 'mid1111', commitMessage: 'a middle change' });
    const head = await shipped({ commitSha: 'new2222', commitMessage: 'the latest thing' });

    const diff = diffDeploys(head.id)!;
    expect(diff.from?.id).toBe(mid.id);
    // The window is [head, mid): the head commit itself, not the "before" one.
    const shas = diff.commits.map((c) => c.sha);
    expect(shas).toContain('new2222');
    expect(shas).not.toContain('mid1111');
    expect(diff.summary).toMatch(/commit/i);
  });

  test('a changed image is reported as changed', async () => {
    await shipped({ commitSha: 'p', imageTag: 'app:1' });
    const head = await shipped({ commitSha: 'q', imageTag: 'app:2' });
    expect(diffDeploys(head.id)!.imageChanged).toBe(true);
  });

  test('the same image across two deploys is not a change', async () => {
    await shipped({ commitSha: 'p', imageTag: 'app:1' });
    const head = await shipped({ commitSha: 'q', imageTag: 'app:1' });
    expect(diffDeploys(head.id)!.imageChanged).toBe(false);
  });
});

describe('the variables in a diff', () => {
  test('added, removed and changed keys are each classified', async () => {
    await shipped({ commitSha: 'p' });
    const head = await shipped({ commitSha: 'q' });
    const before = { KEPT: 'same', MOVED: 'one', GONE: 'bye' };
    const after = { KEPT: 'same', MOVED: 'two', ADDED: 'hi' };

    const changed = diffDeploys(head.id, before, after)!.envChanged;
    const byKey = new Map(changed.map((c) => [c.key, c.change]));
    expect(byKey.get('ADDED')).toBe('added');
    expect(byKey.get('GONE')).toBe('removed');
    expect(byKey.get('MOVED')).toBe('changed');
    // A variable whose value never moved is not mentioned at all.
    expect(byKey.has('KEPT')).toBe(false);
  });

  test('a variable value never appears anywhere in the diff', async () => {
    await shipped({ commitSha: 'p' });
    const head = await shipped({ commitSha: 'q' });
    const secret = 'super-secret-password-value';
    const before = { DB_PASSWORD: 'old-secret-value' };
    const after = { DB_PASSWORD: secret };

    const diff = diffDeploys(head.id, before, after)!;
    // The key is named; neither the old nor the new value is anywhere in the payload.
    const serialized = JSON.stringify(diff);
    expect(serialized).toContain('DB_PASSWORD');
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain('old-secret-value');
    expect(diff.envChanged.find((c) => c.key === 'DB_PASSWORD')?.change).toBe('changed');
  });

  test('with no env given, there are no variable changes', async () => {
    await shipped({ commitSha: 'p' });
    const head = await shipped({ commitSha: 'q' });
    expect(diffDeploys(head.id)!.envChanged).toEqual([]);
  });
});
