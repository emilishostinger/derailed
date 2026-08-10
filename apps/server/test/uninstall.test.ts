/**
 * `derailed uninstall` must take everything this installation made and nothing
 * anyone else made. The Docker half runs against the real engine, with objects
 * carrying a made-up install id, so the sweep can be proven to respect the
 * boundary between installations without ever touching the developer's own.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  removeBinary,
  removeData,
  removeService,
  sweepDocker,
  uninstallFilter,
} from '../src/cli/uninstall.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, listContainers, startContainer } from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { LABELS, labelFilter } from '../src/docker/labels.ts';
import { ensureNetwork, listNetworks, removeNetwork } from '../src/docker/networks.ts';
import { ensureVolume, listVolumes, removeVolume } from '../src/docker/volumes.ts';

const scratch = () => mkdtempSync(join(tmpdir(), 'derailed-uninstall-'));

describe('the uninstall filter', () => {
  test('is scoped to this installation when the id file survives', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'install.id'), 'feedfacefeedface\n');
    expect(uninstallFilter(dir)).toBe(
      labelFilter({ [LABELS.managed]: 'true', [LABELS.install]: 'feedfacefeedface' }),
    );
  });

  test('falls back to everything managed when the id is gone', () => {
    // Through installId() a missing file would mint a fresh id, and a filter on an
    // id invented seconds ago matches nothing: the uninstall would claim success
    // with every container still running.
    expect(uninstallFilter(scratch())).toBe(labelFilter({ [LABELS.managed]: 'true' }));
  });

  test('an empty id file counts as gone', () => {
    const dir = scratch();
    writeFileSync(join(dir, 'install.id'), '\n');
    expect(uninstallFilter(dir)).toBe(labelFilter({ [LABELS.managed]: 'true' }));
  });
});

describe('removing the files', () => {
  test('the data dir goes, and going twice is calm about it', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'logs'));
    writeFileSync(join(dir, 'derailed.db'), 'not really a database');
    expect(removeData(dir)).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(removeData(dir)).toBe(false);
  });

  test('the binary only deletes itself when it really is the installed derailed', () => {
    const dir = scratch();
    const installed = join(dir, 'derailed');
    writeFileSync(installed, '#!/bin/sh\n');
    expect(removeBinary(installed)).toBe(installed);
    expect(existsSync(installed)).toBe(false);

    // From a source checkout, process.execPath is the runtime. Deleting bun
    // because someone tried the command in dev would be a memorable bug.
    const runtime = join(dir, 'bun');
    writeFileSync(runtime, '#!/bin/sh\n');
    expect(removeBinary(runtime)).toBeNull();
    expect(existsSync(runtime)).toBe(true);

    expect(removeBinary(join(dir, 'no-such', 'derailed'))).toBeNull();
  });

  test('a machine that never had a service has nothing to remove', () => {
    // On the Linux boxes this actually runs on, the unit is at a fixed path; on a
    // dev machine neither path exists, and the answer is an empty list, not an error.
    expect(removeService()).toEqual([]);
  });
});

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;

const IMAGE = 'alpine:3.20';
const RUN_ID = Math.random().toString(36).slice(2, 8);
const OUR_ID = `cafe${RUN_ID}cafe`;
const OTHER_ID = `bead${RUN_ID}bead`;

const ours = { [LABELS.managed]: 'true', [LABELS.install]: OUR_ID, [LABELS.role]: 'app' };
const theirs = { [LABELS.managed]: 'true', [LABELS.install]: OTHER_ID, [LABELS.role]: 'app' };

const OUR_NET = `derailed-unins-net-${RUN_ID}`;
const OUR_VOL = `derailed-unins-vol-${RUN_ID}`;
const THEIR_NET = `derailed-unins-other-${RUN_ID}`;

suite('the Docker sweep', () => {
  let dataDir: string;

  beforeAll(async () => {
    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);

    dataDir = scratch();
    writeFileSync(join(dataDir, 'install.id'), `${OUR_ID}\n`);

    await ensureNetwork(OUR_NET, ours);
    await ensureVolume(OUR_VOL, ours);
    await ensureNetwork(THEIR_NET, theirs);

    // Restart policy `always`, because that is what real apps run under, and the
    // whole point of uninstall is that nothing crawls back afterwards.
    const id = await createContainer({
      name: `derailed-unins-app-${RUN_ID}`,
      image: IMAGE,
      cmd: ['sleep', '600'],
      labels: ours,
      network: OUR_NET,
      restartPolicy: 'always',
    });
    await startContainer(id);
  });

  afterAll(async () => {
    // The sweep should have taken ours; the other installation's network we
    // remove ourselves, and anything the sweep missed goes with these too.
    await removeNetwork(THEIR_NET).catch(() => {});
    await removeNetwork(OUR_NET).catch(() => {});
    await removeVolume(OUR_VOL).catch(() => {});
  });

  test('takes everything ours and nothing anyone else made', async () => {
    const result = await sweepDocker(uninstallFilter(dataDir));

    expect(result.containers).toBe(1);
    expect(result.networks).toBe(1);
    expect(result.volumes).toBe(1);
    expect(result.leftovers).toEqual([]);

    const oursFilter = labelFilter({ [LABELS.install]: OUR_ID });
    expect(await listContainers(oursFilter, true)).toEqual([]);
    expect((await listNetworks(oursFilter)).length).toBe(0);
    expect((await listVolumes(oursFilter)).length).toBe(0);

    // The other installation is untouched.
    const theirNetworks = await listNetworks(labelFilter({ [LABELS.install]: OTHER_ID }));
    expect(theirNetworks.map((n) => n.Name)).toContain(THEIR_NET);
    // Alpine's sleep runs as PID 1 and shrugs off SIGTERM, so the graceful stop
    // runs its full five seconds before the kill, and under a parallel suite every
    // Docker call queues behind a hundred others. Generous on purpose.
  }, 120000);
});
