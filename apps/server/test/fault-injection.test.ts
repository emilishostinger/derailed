/**
 * What happens when Docker itself misbehaves.
 *
 * A panel that runs everything through a Docker daemon is at that daemon's mercy: it can
 * be down, it can answer 500, it can run out of disk halfway through a build. None of
 * those may reach a person as a stack trace or, worse, a hang. This mirrors SQLite's
 * I/O-error harness in spirit: induce the failure, and assert the code turns it into a
 * plain sentence and stops, rather than pressing on into a half-made state.
 *
 * This file induces the failures by standing in for the Docker socket with a `fetch`
 * that answers however the test wants. The real-container half is in
 * `fault-injection.integration.test.ts`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { DockerError } from '../src/docker/client.ts';
import { createContainer } from '../src/docker/containers.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Answer every Docker request with the given failure. */
function dockerFails(kind: 'unreachable' | { status: number; body: string }) {
  globalThis.fetch = (async () => {
    if (kind === 'unreachable') throw new Error('ECONNREFUSED');
    return new Response(kind.body, { status: kind.status });
  }) as unknown as typeof fetch;
}

describe('when the Docker daemon cannot be reached', () => {
  test('the error says Docker might not be running, not a raw socket error', async () => {
    dockerFails('unreachable');
    const err = await createContainer({
      name: 'x',
      image: 'alpine',
      labels: {},
    }).catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect(String((err as Error).message)).toMatch(/docker/i);
    expect(String((err as Error).message)).toMatch(/running/i);
  });
});

describe('when the Docker daemon answers an error', () => {
  test("a 500 with Docker's own message surfaces that message, not the raw body", async () => {
    // Disk-full is the failure the plan names: Docker reports it in a JSON `message`.
    dockerFails({ status: 500, body: JSON.stringify({ message: 'no space left on device' }) });
    const err = await createContainer({ name: 'x', image: 'alpine', labels: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as DockerError).status).toBe(500);
    expect((err as Error).message).toBe('no space left on device');
  });

  test('a 500 with a plain-text body still surfaces something readable', async () => {
    dockerFails({ status: 500, body: 'internal server error' });
    const err = await createContainer({ name: 'x', image: 'alpine', labels: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(DockerError);
    expect((err as Error).message).toBe('internal server error');
  });

  test('a 409 name conflict is carried through with its status, not flattened', async () => {
    dockerFails({ status: 409, body: JSON.stringify({ message: 'name already in use' }) });
    const err = await createContainer({ name: 'x', image: 'alpine', labels: {} }).catch((e) => e);
    expect((err as DockerError).status).toBe(409);
    expect((err as Error).message).toMatch(/already in use/);
  });
});
