import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import {
  createProject,
  findProject,
  findProjectBySlug,
  findProjectEvenIfDeleted,
  listProjects,
  restoreProject,
  softDeleteProject,
} from '../src/db/repo/projects.ts';
import {
  createAppService,
  findService,
  findServiceEvenIfDeleted,
  listServices,
  listServicesEvenIfDeleted,
  restoreService,
  softDeleteService,
} from '../src/db/repo/services.ts';
import { createVolume, listVolumesFor } from '../src/db/repo/volumes.ts';
import { isRecoverable, KEEP_FOR_MS, listTrash, restore } from '../src/runtime/trash.ts';

/**
 * Deleting, and changing your mind.
 *
 * The thing being protected is data: before this, deleting an app destroyed the
 * folders holding its files with no way back. So the tests that matter most are the
 * ones asserting that a delete leaves those rows alone, and that everything else
 * stops seeing the app immediately.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function app(projectId: string, name: string) {
  return createAppService({
    projectId,
    name,
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
}

describe('deleting a service', () => {
  test('hides it from every ordinary read, at once', () => {
    const project = createProject('Shop');
    const service = app(project.id, 'Storefront');

    softDeleteService(service.id);

    expect(findService(service.id)).toBeNull();
    expect(listServices(project.id)).toHaveLength(0);
    expect(listServices()).toHaveLength(0);
  });

  test('keeps the row, and everything hanging off it', () => {
    const project = createProject('Shop');
    const service = app(project.id, 'Storefront');
    const volume = createVolume(service.id, '/data');

    softDeleteService(service.id);

    // The whole point: the record of where the data lives survives, so the Docker
    // volume is still findable and still mounted where it was.
    const stored = findServiceEvenIfDeleted(service.id);
    expect(stored).not.toBeNull();
    expect(stored?.deletedAt).toBeNumber();
    expect(listServicesEvenIfDeleted(project.id)).toHaveLength(1);

    expect(listVolumesFor(service.id)).toHaveLength(1);
    expect(listVolumesFor(service.id)[0]?.name).toBe(volume.name);
  });

  test('can be put back', () => {
    const project = createProject('Shop');
    const service = app(project.id, 'Storefront');

    softDeleteService(service.id);
    restoreService(service.id);

    expect(findService(service.id)).not.toBeNull();
    expect(findService(service.id)?.deletedAt).toBeNull();
    expect(listServices(project.id)).toHaveLength(1);
  });

  test('frees its name, so a new app can take it', () => {
    const project = createProject('Shop');
    const first = app(project.id, 'Storefront');
    softDeleteService(first.id);

    // The old row still holds `storefront`, and (project_id, slug) is UNIQUE, so this
    // has to land on a different slug rather than fail on a constraint.
    const second = app(project.id, 'Storefront');
    expect(second.id).not.toBe(first.id);
    expect(second.slug).not.toBe(first.slug);
  });
});

describe('deleting a project', () => {
  test('takes its services with it', () => {
    const project = createProject('Shop');
    const one = app(project.id, 'Web');
    const two = app(project.id, 'Worker');

    softDeleteProject(project.id);

    expect(findProject(project.id)).toBeNull();
    expect(listProjects()).toHaveLength(0);
    expect(findService(one.id)).toBeNull();
    expect(findService(two.id)).toBeNull();
    expect(findServiceEvenIfDeleted(two.id)?.deletedAt).toBeNumber();
  });

  test('is not reachable by slug while deleted', () => {
    const project = createProject('Shop');
    softDeleteProject(project.id);
    expect(findProjectBySlug(project.slug)).toBeNull();
    expect(findProjectEvenIfDeleted(project.id)).not.toBeNull();
  });

  test('brings back only the services that went down with it', () => {
    const project = createProject('Shop');
    const together = app(project.id, 'Web');
    const earlier = app(project.id, 'Worker');

    // Deleted on its own, a while before the project was.
    softDeleteService(earlier.id, 1000);
    softDeleteProject(project.id, 2000);

    restoreProject(project.id);

    expect(findService(together.id)).not.toBeNull();
    // Still in the trash on its own account: restoring the project it happened to
    // live in is not a decision about it.
    expect(findService(earlier.id)).toBeNull();
  });

  test('leaves a fresh project able to reuse the name', () => {
    const first = createProject('Shop');
    softDeleteProject(first.id);
    const second = createProject('Shop');
    expect(second.slug).not.toBe(first.slug);
  });
});

describe('what the trash shows', () => {
  test('lists a deleted project once, not once per app inside it', () => {
    const project = createProject('Shop');
    app(project.id, 'Web');
    app(project.id, 'Worker');
    softDeleteProject(project.id);

    const items = listTrash();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('project');
    expect(items[0]?.whatIsKept.join(' ')).toContain('2 apps');
  });

  test('lists an app deleted on its own, naming the project it came from', () => {
    const project = createProject('Shop');
    const service = app(project.id, 'Storefront');
    createVolume(service.id, '/data');
    softDeleteService(service.id);

    const items = listTrash();
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe('service');
    expect(items[0]?.parentName).toBe('Shop');
    expect(items[0]?.whatIsKept.join(' ')).toContain('stored files');
  });

  test('says when it will be emptied', () => {
    const project = createProject('Shop');
    softDeleteProject(project.id, 5000);
    expect(listTrash()[0]?.purgeAt).toBe(5000 + KEEP_FOR_MS);
  });

  test('restoring an app also restores the project it needs to live in', () => {
    const project = createProject('Shop');
    const service = app(project.id, 'Storefront');
    softDeleteProject(project.id);

    // Restoring only the app would leave it inside a deleted project: listed nowhere,
    // routed nowhere, and impossible to find again.
    expect(restore('service', service.id)).toBe(true);
    expect(findProject(project.id)).not.toBeNull();
    expect(findService(service.id)).not.toBeNull();
  });

  test('refuses to restore something that was never deleted', () => {
    const project = createProject('Shop');
    expect(restore('project', project.id)).toBe(false);
    expect(restore('service', 'no-such-id')).toBe(false);
  });
});

describe('how long things are kept', () => {
  const deletedAt = 1_000_000;

  test('is recoverable inside the week', () => {
    expect(isRecoverable({ deletedAt }, deletedAt + KEEP_FOR_MS - 1)).toBe(true);
  });

  test('is not, after it', () => {
    expect(isRecoverable({ deletedAt }, deletedAt + KEEP_FOR_MS)).toBe(false);
  });

  test('says no for something that was never deleted', () => {
    expect(isRecoverable({ deletedAt: null })).toBe(false);
    expect(isRecoverable({})).toBe(false);
  });
});
