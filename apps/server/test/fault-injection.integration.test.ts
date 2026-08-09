/**
 * The real-container half of fault injection.
 *
 * A command inside a container can fail, hang, or have the ground pulled out from under
 * it when the container dies. None of those may hang the panel or come back as a raw
 * error. Driven against a real Docker so the failure modes are the genuine ones, not a
 * mock's idea of them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { exec } from '../src/catalog/dbclient.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, destroyContainer, startContainer } from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const IMAGE = 'alpine:3.20';

suite('a command in a real container that goes wrong', () => {
  const NAME = `derailed-fault-${Math.random().toString(36).slice(2, 8)}`;
  let containerId = '';

  // A minimal session shape is not needed: `exec` from dbclient takes a container id.
  const session = () => containerId;

  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    containerId = await createContainer({
      name: NAME,
      image: IMAGE,
      cmd: ['sleep', '600'],
      labels: managedLabels({ role: 'build' }),
      restartPolicy: 'no',
    });
    await startContainer(containerId);
  }, 120_000);

  afterAll(async () => {
    if (containerId) await destroyContainer(containerId).catch(() => undefined);
  }, 60_000);

  test('a command that exits non-zero comes back with its code, not a hang', async () => {
    const started = Date.now();
    const { code } = await exec(session(), ['sh', '-c', 'echo oops >&2; exit 3']);
    expect(code).toBe(3);
    // It returned promptly rather than blocking.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  test('a slow command is abandoned at its timeout, not waited on forever', async () => {
    const started = Date.now();
    const outcome = await exec(session(), ['sleep', '30'], [], 1500).then(
      () => 'returned',
      (err: Error) => err.message,
    );
    // Either the exec is cut off (an error) or it returns, but never after the full
    // thirty seconds: the timeout must bite well before then.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(typeof outcome).toBe('string');
  }, 20_000);

  test('an operation on a container that no longer exists is a clean error', async () => {
    const gone = await createContainer({
      name: `${NAME}-gone`,
      image: IMAGE,
      cmd: ['sleep', '600'],
      labels: managedLabels({ role: 'build' }),
      restartPolicy: 'no',
    });
    await startContainer(gone);
    await destroyContainer(gone);
    // The container is gone; exec-ing into it must fail cleanly rather than throw
    // something unhandled or hang.
    const err = await exec(gone, ['echo', 'hi']).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message).length).toBeGreaterThan(0);
  }, 60_000);

  test('a container killed mid-command does not leave the call hanging', async () => {
    const victim = await createContainer({
      name: `${NAME}-victim`,
      image: IMAGE,
      cmd: ['sleep', '600'],
      labels: managedLabels({ role: 'build' }),
      restartPolicy: 'no',
    });
    await startContainer(victim);
    const started = Date.now();
    // Start a long command with its own generous timeout, then pull the container out
    // from under it. The point is that the call resolves when the container dies rather
    // than waiting out the full sleep.
    const running = exec(victim, ['sleep', '30'], [], 25_000).then(
      () => 'returned',
      (err: Error) => err.message,
    );
    await Bun.sleep(1000);
    await destroyContainer(victim).catch(() => undefined);
    const outcome = await running;
    expect(typeof outcome).toBe('string');
    expect(Date.now() - started).toBeLessThan(28_000);
  }, 45_000);
});
