import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject, findProject, setProjectLimits } from '../src/db/repo/projects.ts';
import { createAppService, updateService } from '../src/db/repo/services.ts';

/**
 * A ceiling for everything in a project.
 *
 * A memory limit already existed per app, and had to be set per app, which means it
 * was set on the app somebody was already worried about and on none of the others.
 * The app that takes a box down is by definition the one nobody expected.
 *
 * The only real decision here is what happens when both are set, and it has to be
 * that the app's own number wins. Somebody who typed a number on one app meant it,
 * and a project ceiling quietly lowering it would make the field on the app screen
 * a lie.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function setup() {
  const project = createProject('Shop');
  const app = createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
  return { project, app };
}

/** The same resolution the pipeline does when it builds a container spec. */
function effective(projectId: string, serviceMemory: number | null) {
  const project = findProject(projectId);
  return {
    memoryLimitMb: serviceMemory ?? project?.memoryLimitMb ?? null,
    cpuMillis: project?.cpuLimitMillis ?? null,
  };
}

describe('which limit a container gets', () => {
  test('none at all by default, which stays the default', () => {
    // A cap nobody asked for is a container killed for a reason nobody can find.
    const { project, app } = setup();
    expect(findProject(project.id)?.memoryLimitMb).toBeNull();
    expect(effective(project.id, app.memoryLimitMb)).toEqual({
      memoryLimitMb: null,
      cpuMillis: null,
    });
  });

  test("the project's, when the app has none of its own", () => {
    const { project, app } = setup();
    setProjectLimits(project.id, { memoryLimitMb: 512, cpuLimitMillis: 500 });

    expect(effective(project.id, app.memoryLimitMb)).toEqual({
      memoryLimitMb: 512,
      cpuMillis: 500,
    });
  });

  test("the app's own, when it has one, even if the project's is smaller", () => {
    // Not the smaller of the two. Somebody typed 1024 on this app on purpose, and
    // a ceiling silently overriding it makes that field mean nothing.
    const { project, app } = setup();
    setProjectLimits(project.id, { memoryLimitMb: 256 });
    updateService(app.id, { memoryLimitMb: 1024 });

    expect(effective(project.id, 1024).memoryLimitMb).toBe(1024);
    // And the project's is still there for everything else in it.
    expect(findProject(project.id)?.memoryLimitMb).toBe(256);
  });

  test('the processor ceiling is the project idea alone, since apps have no such field', () => {
    const { project, app } = setup();
    setProjectLimits(project.id, { cpuLimitMillis: 1500 });
    expect(effective(project.id, app.memoryLimitMb).cpuMillis).toBe(1500);
  });
});

describe('changing the ceiling', () => {
  test('each limit can be set without disturbing the other', () => {
    const { project } = setup();
    setProjectLimits(project.id, { memoryLimitMb: 512, cpuLimitMillis: 500 });
    setProjectLimits(project.id, { memoryLimitMb: 1024 });

    const after = findProject(project.id);
    expect(after?.memoryLimitMb).toBe(1024);
    expect(after?.cpuLimitMillis).toBe(500);
  });

  test('can be taken off again', () => {
    const { project } = setup();
    setProjectLimits(project.id, { memoryLimitMb: 512, cpuLimitMillis: 500 });
    setProjectLimits(project.id, { memoryLimitMb: null, cpuLimitMillis: null });

    const after = findProject(project.id);
    expect(after?.memoryLimitMb).toBeNull();
    expect(after?.cpuLimitMillis).toBeNull();
  });

  test('does not reach into another project', () => {
    const { project } = setup();
    const other = createProject('Other');
    setProjectLimits(project.id, { memoryLimitMb: 512 });
    expect(findProject(other.id)?.memoryLimitMb).toBeNull();
  });
});

/**
 * Docker counts cpu in billionths of a core and memory in bytes. Both conversions are
 * the sort that are quietly wrong by a factor of a thousand for a year.
 */
describe('what Docker is actually told', () => {
  const spec = (memoryLimitMb: number | null, cpuMillis: number | null) => ({
    Memory: memoryLimitMb ? memoryLimitMb * 1024 * 1024 : 0,
    NanoCpus: cpuMillis ? cpuMillis * 1_000_000 : 0,
  });

  test('megabytes become bytes', () => {
    expect(spec(512, null).Memory).toBe(536_870_912);
  });

  test('thousandths of a core become billionths', () => {
    expect(spec(null, 500).NanoCpus).toBe(500_000_000);
    expect(spec(null, 2000).NanoCpus).toBe(2_000_000_000);
  });

  test('no limit is zero, which is how Docker spells unlimited', () => {
    expect(spec(null, null)).toEqual({ Memory: 0, NanoCpus: 0 });
  });
});
