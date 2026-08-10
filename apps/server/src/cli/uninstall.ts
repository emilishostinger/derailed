import { existsSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { paths } from '../config.ts';
import { destroyContainer, listContainers } from '../docker/containers.ts';
import { listImages, removeImage } from '../docker/images.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { listNetworks, removeNetwork } from '../docker/networks.ts';
import { listVolumes, removeVolume } from '../docker/volumes.ts';

/**
 * `derailed uninstall`: put the machine back the way the installer found it.
 *
 * Everything Derailed made goes: the containers, networks, volumes and images it
 * created in Docker, the data directory, the service unit, and finally the binary
 * itself. Docker stays, even where the installer was the one that installed it,
 * because by now other things on the machine may depend on it, and removing a
 * daemon with other people's containers in it is not this command's call to make.
 *
 * The pieces are exported separately so tests can run the sweep against a scratch
 * data directory and a real Docker without also asking the test to delete itself.
 */

const UNIT_PATH = '/etc/systemd/system/derailed.service';
const OPENRC_PATH = '/etc/init.d/derailed';
const OPENRC_CONF = '/etc/conf.d/derailed';

/**
 * The filter for this installation's Docker objects.
 *
 * The install id is read straight from the file rather than through installId(),
 * which mints and writes a fresh id when the file is missing. Filtering by an id
 * invented seconds ago matches nothing, and the uninstall would report success
 * while leaving every container in place. When the id is genuinely gone, the only
 * honest fallback is everything Derailed-managed: no surviving id can tell two
 * installations apart anyway, and one installation is the overwhelmingly normal
 * case.
 */
export function uninstallFilter(dataDir: string = paths.dataDir): string {
  try {
    const id = readFileSync(join(dataDir, 'install.id'), 'utf8').trim();
    if (id) return labelFilter({ [LABELS.managed]: 'true', [LABELS.install]: id });
  } catch {
    // Fall through to the managed-only filter.
  }
  return labelFilter({ [LABELS.managed]: 'true' });
}

export interface SweepResult {
  containers: number;
  networks: number;
  volumes: number;
  images: number;
  /** Objects that refused to go, named so the person can finish the job by hand. */
  leftovers: string[];
}

/**
 * Removes every Docker object matching the filter. Containers first, since a
 * network with a container attached and a volume in use both refuse to be
 * removed. Images last, because nothing else depends on their absence.
 */
export async function sweepDocker(filter: string = uninstallFilter()): Promise<SweepResult> {
  const result: SweepResult = { containers: 0, networks: 0, volumes: 0, images: 0, leftovers: [] };

  for (const container of await listContainers(filter, true)) {
    try {
      await destroyContainer(container.Id, 5);
      result.containers++;
    } catch {
      result.leftovers.push(`container ${container.Names?.[0] ?? container.Id.slice(0, 12)}`);
    }
  }
  for (const network of await listNetworks(filter)) {
    try {
      await removeNetwork(network.Name);
      result.networks++;
    } catch {
      result.leftovers.push(`network ${network.Name}`);
    }
  }
  for (const volume of await listVolumes(filter)) {
    try {
      await removeVolume(volume.Name);
      result.volumes++;
    } catch {
      result.leftovers.push(`volume ${volume.Name}`);
    }
  }
  for (const image of await listImages(filter)) {
    try {
      await removeImage(image.Id);
      result.images++;
    } catch {
      result.leftovers.push(`image ${image.RepoTags?.[0] ?? image.Id.slice(7, 19)}`);
    }
  }
  return result;
}

function run(cmd: string[]): void {
  try {
    Bun.spawnSync(cmd, { stdout: 'ignore', stderr: 'ignore' });
  } catch {
    // A missing systemctl on a machine that never had the unit is not a failure.
  }
}

/**
 * Stops the service, takes it out of boot, and removes its files. Returns what it
 * actually removed, which on a machine that never had a service is nothing.
 */
export function removeService(): string[] {
  const removed: string[] = [];
  if (existsSync(UNIT_PATH)) {
    run(['systemctl', 'stop', 'derailed']);
    run(['systemctl', 'disable', 'derailed']);
    unlinkSync(UNIT_PATH);
    run(['systemctl', 'daemon-reload']);
    removed.push(UNIT_PATH);
  }
  if (existsSync(OPENRC_PATH)) {
    run(['rc-service', 'derailed', 'stop']);
    run(['rc-update', 'del', 'derailed', 'default']);
    unlinkSync(OPENRC_PATH);
    removed.push(OPENRC_PATH);
    if (existsSync(OPENRC_CONF)) {
      unlinkSync(OPENRC_CONF);
      removed.push(OPENRC_CONF);
    }
  }
  return removed;
}

export function removeData(dataDir: string = paths.dataDir): boolean {
  if (!existsSync(dataDir)) return false;
  rmSync(dataDir, { recursive: true, force: true });
  return true;
}

/**
 * The binary deletes itself last. Unlinking a running executable is fine on
 * Linux, the inode lives until the process exits. The basename guard is what
 * keeps this from deleting `bun` when someone runs the command from a source
 * checkout, where process.execPath is the runtime rather than a compiled
 * derailed.
 */
export function removeBinary(execPath: string = process.execPath): string | null {
  if (basename(execPath) !== 'derailed') return null;
  if (!existsSync(execPath)) return null;
  unlinkSync(execPath);
  return execPath;
}

export async function uninstall(argv: string[]): Promise<void> {
  const assumeYes = argv.includes('--yes') || argv.includes('-y');

  console.log('\n  This removes Derailed and everything it made on this machine:');
  console.log('  every app and database it runs, their data, its own settings,');
  console.log('  the service, and the binary. Docker itself stays.');
  console.log('\n  There is no undo. Backups written to other machines survive.\n');

  if (!assumeYes) {
    const answer = prompt('  Type "uninstall" to go ahead:');
    if (answer?.trim().toLowerCase() !== 'uninstall') {
      console.log('\n  Nothing was removed.\n');
      process.exit(1);
    }
  }

  const removedService = removeService();
  if (removedService.length) console.log('  Service stopped and removed.');

  let sweep: SweepResult | null = null;
  try {
    sweep = await sweepDocker();
    console.log(
      `  Docker cleaned: ${sweep.containers} containers, ${sweep.networks} networks, ` +
        `${sweep.volumes} volumes, ${sweep.images} images.`,
    );
  } catch {
    console.log('  Docker did not answer, so its containers, volumes and images were left.');
    console.log(
      '  Remove them later with: docker system prune (they are labelled derailed.managed)',
    );
  }

  if (removeData()) console.log(`  Removed ${paths.dataDir}.`);

  const binary = removeBinary();
  if (binary) console.log(`  Removed ${binary}.`);

  if (sweep?.leftovers.length) {
    console.log('\n  These refused to be removed and were left behind:');
    for (const name of sweep.leftovers) console.log(`    ${name}`);
  }

  console.log('\n  Derailed is gone. Thanks for giving it a spin.\n');
}
