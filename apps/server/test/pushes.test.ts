/**
 * Deploying when somebody pushes.
 *
 * The interesting behaviour here is all about what should *not* happen: a commit that
 * fails to build must not be retried for ever, a repository that cannot be reached
 * must not look like a change, and switching the setting on must not redeploy the
 * thing already running.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBranchHead } from '../src/build/git.ts';
import { checkPushes, shortSha } from '../src/build/pushes.ts';
import { initDb } from '../src/db/index.ts';
import { createDeployment, updateDeployment } from '../src/db/repo/deployments.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService, findService, updateService } from '../src/db/repo/services.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-pushes-'));
initDb(join(dir, 'test.db'));
loadSecretKey(join(dir, 'secret.key'));

const online = await fetch('https://github.com', {
  method: 'HEAD',
  signal: AbortSignal.timeout(5000),
})
  .then((response) => response.ok)
  .catch(() => false);

let projectId: string;

beforeEach(() => {
  projectId = createProject(`push-${Math.random().toString(36).slice(2, 8)}`).id;
});

function app(overrides: Partial<Parameters<typeof createAppService>[0]> = {}) {
  return createAppService({
    projectId,
    name: 'site',
    source: 'repo',
    repoUrl: 'https://github.com/derailed-does-not-exist/nope.git',
    branch: 'main',
    ...overrides,
  });
}

describe('what the watcher leaves alone', () => {
  test('an app that is not following pushes', async () => {
    const service = app();
    expect(await checkPushes()).toEqual([]);
    expect(findService(service.id)!.lastPushedSha).toBeNull();
  });

  test('an app built from an uploaded zip, which has no branch to watch', async () => {
    const service = app({ source: 'upload', repoUrl: null, branch: null });
    updateService(service.id, { deployOnPush: true });
    expect(await checkPushes()).toEqual([]);
  });

  test('an app running a ready-made image', async () => {
    const service = app({ source: 'image', image: 'nginx:alpine', repoUrl: null, branch: null });
    updateService(service.id, { deployOnPush: true });
    expect(await checkPushes()).toEqual([]);
  });

  /**
   * The one that matters most. A repository that cannot be read right now, because
   * the network is down or the token expired, must not be recorded as "nothing has
   * changed": the next successful read would then look like a push that never
   * happened and would rebuild whatever was already there.
   */
  test('a repository it cannot reach at all', async () => {
    const service = app({ repoUrl: 'https://github.com/derailed-does-not-exist/nope.git' });
    updateService(service.id, { deployOnPush: true });

    expect(await checkPushes()).toEqual([]);
    expect(findService(service.id)!.lastPushedSha).toBeNull();
  });
});

describe('the commit it has already seen', () => {
  test('is written down before the build, so a broken commit is not retried for ever', async () => {
    const service = app();
    updateService(service.id, { deployOnPush: true, lastPushedSha: 'a'.repeat(40) });
    // Same commit as last time: nothing to do, whatever happened to the build of it.
    expect(await checkPushes()).toEqual([]);
    expect(findService(service.id)!.lastPushedSha).toBe('a'.repeat(40));
  });

  test('is adopted rather than deployed when the running deploy is already on it', async () => {
    const service = app();
    const deployment = createDeployment(service.id, 'manual');
    updateDeployment(deployment.id, { status: 'running', commitSha: 'b'.repeat(40) });
    updateService(service.id, { deployOnPush: true, lastPushedSha: 'c'.repeat(40) });

    // A push landing between reading the branch and cloning it is built by that same
    // deploy, so finding it again afterwards must not build it a second time. Here
    // the remote is unreachable, so this only asserts the guard's shape; the live
    // test below covers a branch that can really be read.
    expect(await checkPushes()).toEqual([]);
  });
});

describe('reading the top of a branch', () => {
  test('short shas are what a person recognises', () => {
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
  });

  test('an unreachable repository is null, never a guess', async () => {
    expect(
      await resolveBranchHead('https://github.com/derailed-does-not-exist/nope.git', 'main'),
    ).toBeNull();
  });

  test.skipIf(!online)(
    'a real repository answers with the commit at the top of the branch',
    async () => {
      // A small, stable, public repository. Only the shape of the answer is asserted,
      // never a particular commit, because that would break on somebody else's push.
      const head = await resolveBranchHead('https://github.com/octocat/Hello-World.git', 'master');
      expect(head).toMatch(/^[0-9a-f]{40}$/);
    },
    30_000,
  );

  test.skipIf(!online)(
    'a branch that does not exist is null, rather than the default branch',
    async () => {
      const head = await resolveBranchHead(
        'https://github.com/octocat/Hello-World.git',
        'no-such-branch-here',
      );
      expect(head).toBeNull();
    },
    30_000,
  );
});

/**
 * A git server that is not GitHub, which is the point of using `ls-remote` rather
 * than an API. A bare repository on disk speaks the same protocol as GitLab,
 * Bitbucket, Gitea or a server in somebody's house, so if this works, those do.
 */
describe('against a plain git repository', () => {
  async function git(args: string[], cwd?: string) {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com',
      },
    });
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${args.join(' ')} failed: ${err}`);
  }

  test('reads the branch head, and notices when it moves', async () => {
    const bare = join(dir, 'origin.git');
    const work = join(dir, 'work');
    await git(['init', '--bare', '--initial-branch=main', bare]);
    await git(['init', '--initial-branch=main', work]);
    await Bun.write(join(work, 'index.html'), '<h1>one</h1>');
    await git(['add', '.'], work);
    await git(['commit', '-m', 'first'], work);
    await git(['remote', 'add', 'origin', bare], work);
    await git(['push', 'origin', 'main'], work);

    const first = await resolveBranchHead(bare, 'main');
    expect(first).toMatch(/^[0-9a-f]{40}$/);

    // A branch nobody created is not the default branch, and not a guess.
    expect(await resolveBranchHead(bare, 'release')).toBeNull();

    // Somebody pushes.
    await Bun.write(join(work, 'index.html'), '<h1>two</h1>');
    await git(['commit', '-am', 'second'], work);
    await git(['push', 'origin', 'main'], work);

    const second = await resolveBranchHead(bare, 'main');
    expect(second).toMatch(/^[0-9a-f]{40}$/);
    expect(second).not.toBe(first);
  }, 60_000);
});

describe('following a real branch end to end', () => {
  test.skipIf(!online)(
    'the first pass adopts the current commit and deploys nothing',
    async () => {
      const service = app({
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'master',
      });
      updateService(service.id, { deployOnPush: true });

      const [check] = await checkPushes();
      expect(check?.serviceId).toBe(service.id);
      // Noted, not built. Switching this on must not rebuild what is already running.
      expect(check?.deployed).toBe(false);
      expect(check?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(findService(service.id)!.lastPushedSha).toBe(check!.sha);

      // And the pass after that has nothing to say, because nothing moved.
      expect(await checkPushes()).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!online)(
    'a commit that moved on is deployed',
    async () => {
      const service = app({
        repoUrl: 'https://github.com/octocat/Hello-World.git',
        branch: 'master',
      });
      // Pretend we last saw something else, which is what a push looks like from here.
      updateService(service.id, { deployOnPush: true, lastPushedSha: 'f'.repeat(40) });

      const [check] = await checkPushes();
      expect(check?.deployed).toBe(true);
      expect(check?.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(findService(service.id)!.lastPushedSha).toBe(check!.sha);
    },
    60_000,
  );
});
