import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { VERSION } from '../config.ts';
import { listServices } from '../db/repo/services.ts';
import { dockerJson } from '../docker/client.ts';
import { listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';
import { checkForUpdate } from '../update.ts';

/**
 * What on this machine is out of date.
 *
 * Covers the three things that actually matter on a small server: the operating
 * system's own packages, the images behind the apps, and Derailed itself. Everything
 * is reported in plain language, and nothing is ever updated without being asked.
 */
export type UpdateKind = 'system' | 'image' | 'derailed';

export interface UpdateItem {
  id: string;
  kind: UpdateKind;
  name: string;
  /** One line saying what this is and why it matters. */
  detail: string;
  /** True when this needs attention rather than merely being available. */
  security?: boolean;
  current?: string | null;
  available?: string | null;
  /** Whether Derailed can apply this itself. */
  actionable: boolean;
}

export interface UpdateReport {
  checkedAt: number;
  items: UpdateItem[];
  rebootRequired: boolean;
  /** Plain-language summary, so the UI leads with a sentence rather than a count. */
  summary: string;
}

async function run(cmd: string[], timeoutMs = 120_000): Promise<{ code: number; out: string }> {
  try {
    const proc = Bun.spawn(cmd, { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    return { code, out };
  } catch {
    return { code: 1, out: '' };
  }
}

/**
 * The package manager this machine uses, worked out once.
 *
 * Derailed is one static binary and runs anywhere, so this is the only part of it
 * that has to know what distribution it landed on. A machine whose manager is not
 * here still works: it simply does not offer to update the operating system, which
 * is better than offering and then running the wrong command as root.
 */
export type PackageManager = 'apt' | 'dnf' | 'yum' | 'pacman' | 'apk' | 'zypper';

const MANAGER_BINARIES: Record<PackageManager, string> = {
  apt: '/usr/bin/apt-get',
  dnf: '/usr/bin/dnf',
  yum: '/usr/bin/yum',
  pacman: '/usr/bin/pacman',
  apk: '/sbin/apk',
  zypper: '/usr/bin/zypper',
};

let cachedManager: PackageManager | null | undefined;

export function packageManager(): PackageManager | null {
  if (cachedManager !== undefined) return cachedManager;
  cachedManager =
    (Object.keys(MANAGER_BINARIES) as PackageManager[]).find((name) => {
      const path = MANAGER_BINARIES[name];
      return existsSync(path) || existsSync(path.replace('/usr/bin/', '/usr/sbin/'));
    }) ?? null;
  return cachedManager;
}

/** How to ask each manager what is waiting, without changing anything. */
export function countPendingUpdates(manager: PackageManager, output: string, code: number): number {
  switch (manager) {
    case 'apt':
      return (output.match(/^Inst /gm) ?? []).length;
    case 'dnf':
    case 'yum':
      // Exit 100 means "there are updates", 0 means none. The listing has a header
      // and blank lines, so rows are counted rather than lines.
      if (code === 0) return 0;
      return output.split('\n').filter((line) => /^\S+\.\S+\s+\S+\s+\S+$/.test(line.trim())).length;
    case 'pacman':
      return output.split('\n').filter((line) => line.trim()).length;
    case 'apk':
      // `apk version -l '<'` prints a header line and then one row per package.
      return output
        .split('\n')
        .filter((line) => line.trim() && !line.startsWith('Installed:') && line.includes('<'))
        .length;
    case 'zypper':
      return output.split('\n').filter((line) => line.startsWith('v |')).length;
  }
}

function checkCommand(manager: PackageManager): string[] {
  switch (manager) {
    case 'apt':
      return ['apt-get', '-s', 'upgrade'];
    case 'dnf':
      return ['dnf', '-q', 'check-update'];
    case 'yum':
      return ['yum', '-q', 'check-update'];
    case 'pacman':
      return ['pacman', '-Qu'];
    case 'apk':
      return ['apk', 'version', '-l', '<'];
    case 'zypper':
      return ['zypper', '--non-interactive', 'list-updates'];
  }
}

/**
 * Security updates only, where the manager can tell the difference.
 *
 * Three of these six can: apt through `unattended-upgrade`, which is the same tool
 * Debian ships for exactly this, and dnf and yum through `--security`. Pacman and apk
 * have no notion of a security update at all: Arch and Alpine ship one stream, and
 * asking either for "just the security ones" gets you everything or nothing depending
 * on how you spell it.
 *
 * So this returns null for those two rather than quietly upgrading the whole machine
 * on a timer under a heading that says security. Somebody who wants that on Arch can
 * still press the button, which says what it does.
 */
export function securityUpgradeCommand(manager: PackageManager): string[] | null {
  switch (manager) {
    case 'apt':
      return [
        'sh',
        '-c',
        'DEBIAN_FRONTEND=noninteractive unattended-upgrade -v 2>/dev/null || ' +
          'DEBIAN_FRONTEND=noninteractive apt-get update -qq && ' +
          "DEBIAN_FRONTEND=noninteractive apt-get -y -qq --only-upgrade install $(apt-get -s upgrade | grep -i securi | awk '{print $2}' | tr '\\n' ' ')",
      ];
    case 'dnf':
      return ['dnf', '-y', '--security', 'upgrade'];
    case 'yum':
      return ['yum', '-y', '--security', 'update'];
    case 'zypper':
      return ['zypper', '--non-interactive', 'patch', '--category', 'security'];
    default:
      return null;
  }
}

/** How to actually apply them. */
export function upgradeCommand(manager: PackageManager): string[] {
  switch (manager) {
    case 'apt':
      return [
        'sh',
        '-c',
        'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -qq upgrade',
      ];
    case 'dnf':
      return ['dnf', '-y', 'upgrade'];
    case 'yum':
      return ['yum', '-y', 'update'];
    case 'pacman':
      return ['pacman', '-Syu', '--noconfirm'];
    case 'apk':
      return ['sh', '-c', 'apk update && apk upgrade'];
    case 'zypper':
      return ['zypper', '--non-interactive', 'update'];
  }
}

async function systemUpdates(): Promise<UpdateItem[]> {
  const manager = packageManager();
  if (!manager) return [];

  // Debian and Ubuntu ship this, and it is the only one of these that separates out
  // the security updates, which is the number worth leading with.
  if (manager === 'apt') {
    const { code, out } = await run(
      ['/usr/lib/update-notifier/apt-check', '--human-readable'],
      60_000,
    );
    if (code === 0 && out.trim()) {
      const packages = Number(out.match(/(\d+)\s+package/)?.[1] ?? 0);
      const security = Number(out.match(/(\d+)\s+.*securit/i)?.[1] ?? 0);
      if (packages === 0) return [];
      return [
        {
          id: 'system-packages',
          kind: 'system',
          name: `${packages} system package${packages === 1 ? '' : 's'}`,
          detail:
            security > 0
              ? `${security} of them are security updates, so this is worth doing soon.`
              : 'Routine updates to the operating system.',
          security: security > 0,
          actionable: true,
        },
      ];
    }
  }

  const checked = await run(checkCommand(manager), 90_000);
  const count = countPendingUpdates(manager, checked.out, checked.code);
  if (count === 0) return [];
  return [
    {
      id: 'system-packages',
      kind: 'system',
      name: `${count} system package${count === 1 ? '' : 's'}`,
      detail: 'Routine updates to the operating system.',
      actionable: true,
    },
  ];
}

/**
 * Whether a newer image exists, without downloading it.
 *
 * Docker's `/distribution/{name}/json` asks the registry for the manifest descriptor,
 * so comparing its digest with the local one is a cheap, exact answer.
 */
async function imageUpdates(): Promise<UpdateItem[]> {
  const items: UpdateItem[] = [];
  const services = listServices().filter((service) => service.source === 'image' && service.image);

  const seen = new Set<string>();
  for (const service of services) {
    const image = service.image!;
    if (seen.has(image)) continue;
    seen.add(image);

    // Only images actually in use are worth reporting on.
    const running = await listContainers(labelFilter({ [LABELS.service]: service.id })).catch(
      () => [],
    );
    if (!running.some((container) => container.State === 'running')) continue;

    try {
      const [local, remote] = await Promise.all([
        dockerJson<{ RepoDigests?: string[] }>(`/images/${encodeURIComponent(image)}/json`),
        dockerJson<{ Descriptor?: { digest?: string } }>(
          `/distribution/${encodeURIComponent(image)}/json`,
        ),
      ]);

      const remoteDigest = remote.Descriptor?.digest;
      const localDigests = (local.RepoDigests ?? []).map((entry) => entry.split('@')[1]);
      if (!remoteDigest || localDigests.length === 0) continue;

      if (!localDigests.includes(remoteDigest)) {
        items.push({
          id: `image:${service.id}`,
          kind: 'image',
          name: service.name,
          detail: `A newer build of ${image} has been published. Derailed will back the app up first, update it, and check it still answers.`,
          current: localDigests[0]?.slice(7, 19) ?? null,
          available: remoteDigest.slice(7, 19),
          actionable: true,
        });
      }
    } catch {
      // Private registry, rate limit, or no network. Silence is better than a
      // scary-looking failure for something that is only informational.
    }
  }
  return items;
}

async function derailedUpdate(): Promise<UpdateItem[]> {
  const release = await checkForUpdate();
  if (!release?.newer) return [];
  return [
    {
      id: 'derailed',
      kind: 'derailed',
      name: `Derailed ${release.version}`,
      detail: 'A new version of Derailed itself. Your apps keep running while it updates.',
      current: VERSION,
      available: release.version,
      actionable: true,
    },
  ];
}

/**
 * Whether the machine needs restarting to finish what it has installed.
 *
 * Debian and Ubuntu drop a file. The Red Hat family has a command that answers with
 * its exit status. Everywhere else nothing is claimed, which is what was already
 * happening on every distribution but one, only now on purpose.
 */
async function needsReboot(): Promise<boolean> {
  if (existsSync('/var/run/reboot-required')) return true;

  const manager = packageManager();
  if (manager === 'dnf' || manager === 'yum') {
    // Exit 1 means a reboot is needed, 0 means it is not. Anything else (the plugin
    // is not installed) is not an answer, so it is not treated as one.
    const { code } = await run([manager, 'needs-restarting', '-r'], 60_000);
    return code === 1;
  }
  return false;
}

export async function checkUpdates(): Promise<UpdateReport> {
  const [system, images, derailed, rebootRequired] = await Promise.all([
    systemUpdates().catch(() => []),
    imageUpdates().catch(() => []),
    derailedUpdate().catch(() => []),
    needsReboot().catch(() => false),
  ]);

  const items = [...system, ...images, ...derailed];
  const security = items.some((item) => item.security);

  return {
    checkedAt: Date.now(),
    items,
    rebootRequired,
    summary: security
      ? 'There are security updates waiting.'
      : rebootRequired
        ? 'Everything is up to date, but the server needs restarting to finish.'
        : items.length === 0
          ? 'Everything is up to date.'
          : `${items.length} thing${items.length === 1 ? '' : 's'} can be updated.`,
  };
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  output?: string[];
}

/** Applies one update. Deliberately one at a time, so a failure is easy to attribute. */
export async function applyUpdate(id: string): Promise<ApplyResult> {
  if (id === 'system-packages') {
    const manager = packageManager();
    if (!manager) {
      return { ok: false, message: "Derailed doesn't know how to update packages on this system." };
    }
    const command = upgradeCommand(manager);
    const result = await run(command, 900_000);
    return {
      ok: result.code === 0,
      message:
        result.code === 0
          ? 'System packages updated. A restart may be needed to finish.'
          : `The system update didn't finish. Run ${command[0] === 'sh' ? 'the upgrade' : command.join(' ')} on the server to see why.`,
      output: result.out.split('\n').filter(Boolean).slice(-20),
    };
  }

  if (id === 'derailed') {
    const { selfUpdate } = await import('../update.ts');
    const lines: string[] = [];
    const ok = await selfUpdate((line) => lines.push(line));
    return {
      ok,
      message: ok
        ? 'Downloaded. Restart Derailed to run the new version.'
        : "The update didn't complete.",
      output: lines,
    };
  }

  if (id.startsWith('image:')) {
    const serviceId = id.slice(6);
    const service = listServices().find((entry) => entry.id === serviceId);
    if (!service) return { ok: false, message: 'That app no longer exists.' };

    // Through the backup-first machinery, never around it. Updating from this page
    // and updating from the app's own screen are the same act, and both keep the
    // same three promises: a copy first, a health check, and the way back recorded.
    const { beginAppUpdate } = await import('./appupdate.ts');
    try {
      const { done } = await beginAppUpdate(service.id, 'manual');
      void done.catch(() => undefined);
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    return {
      ok: true,
      message: `${service.name} is being backed up, then updated. Its screen shows how it goes.`,
    };
  }

  return { ok: false, message: 'There is nothing to update with that name.' };
}

/** Debian records the reason here; showing it is friendlier than a bare flag. */
export async function rebootReason(): Promise<string | null> {
  try {
    const text = await readFile('/var/run/reboot-required.pkgs', 'utf8');
    const packages = [...new Set(text.split('\n').filter(Boolean))];
    if (packages.length === 0) return null;
    return `Updated: ${packages.slice(0, 6).join(', ')}${packages.length > 6 ? ', and more' : ''}.`;
  } catch {
    return null;
  }
}
