/**
 * The Nixpacks path (deploying a repository that has no Dockerfile) is half of the
 * product's promise, and until now nothing exercised it.
 *
 * Detection is checked here unconditionally because it's pure filesystem work.
 * Generating the Dockerfile needs the pinned Nixpacks binary, which is downloaded on
 * first use, so that part only runs when a network is available.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepo } from '../src/build/detect.ts';
import { generateDockerfile, NIXPACKS_DOCKERFILE } from '../src/build/nixpacks.ts';

const FIXTURE_NODE = join(import.meta.dir, 'fixtures/hello-node');
const FIXTURE_DOCKER = join(import.meta.dir, 'fixtures/hello-dockerfile');

/** Nixpacks downloads a ~20 MB binary from GitHub the first time it's used. */
const online = await fetch('https://github.com', {
  method: 'HEAD',
  signal: AbortSignal.timeout(5000),
})
  .then((response) => response.ok)
  .catch(() => false);

describe('choosing a build strategy', () => {
  test('a repository with no Dockerfile is built with Nixpacks', async () => {
    const detected = await detectRepo({ dir: FIXTURE_NODE });

    expect(detected.strategy).toBe('nixpacks');
    expect(detected.dockerfilePath).toBeNull();
    // The summary is shown to the user before anything is created, so it has to
    // actually say something useful.
    expect(detected.summary.toLowerCase()).toContain('node');
  });

  test('a repository with a Dockerfile uses it instead', async () => {
    const detected = await detectRepo({ dir: FIXTURE_DOCKER });

    expect(detected.strategy).toBe('dockerfile');
    expect(detected.dockerfilePath).toBe('Dockerfile');
    // EXPOSE 3000 in the fixture is the port hint.
    expect(detected.port).toBe(3000);
  });

  test('suggests a name taken from the repository', async () => {
    const detected = await detectRepo({ dir: FIXTURE_NODE });
    expect(detected.suggestedName).toBeTruthy();
  });
});

describe.if(online)('generating a Dockerfile with Nixpacks', () => {
  test('writes one into the checkout for our own Docker build to use', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'derailed-nixpacks-'));
    try {
      await Bun.write(
        join(dir, 'package.json'),
        await readFile(join(FIXTURE_NODE, 'package.json')),
      );
      await Bun.write(join(dir, 'server.js'), await readFile(join(FIXTURE_NODE, 'server.js')));

      const lines: string[] = [];
      await generateDockerfile(dir, { PORT: '3000' }, (line) => lines.push(line));

      const dockerfile = await readFile(join(dir, NIXPACKS_DOCKERFILE), 'utf8');
      // Whatever else it decides, it has to produce something Docker can build.
      expect(dockerfile).toContain('FROM');

      // The one that actually broke a real deploy: Nixpacks defaults to emitting
      // `RUN --mount=type=cache,…`, which only BuildKit understands. Derailed builds
      // through the Engine's /build endpoint (the classic builder) where the first
      // mount kills the build with no usable error. Every repo without a Dockerfile
      // failed this way until it was caught on a real server.
      expect(dockerfile).not.toContain('--mount=');
      expect(dockerfile.length).toBeGreaterThan(50);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
