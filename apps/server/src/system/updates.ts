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

/** Debian and Ubuntu ship this; it is the same data `apt` prints on login. */
async function systemUpdates(): Promise<UpdateItem[]> {
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

  // No apt-check: fall back to asking apt directly.
  const simulated = await run(['apt-get', '-s', 'upgrade'], 90_000);
  const count = (simulated.out.match(/^Inst /gm) ?? []).length;
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
          detail: `A newer build of ${image} has been published. Updating redeploys the app.`,
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

export async function checkUpdates(): Promise<UpdateReport> {
  const [system, images, derailed] = await Promise.all([
    systemUpdates().catch(() => []),
    imageUpdates().catch(() => []),
    derailedUpdate().catch(() => []),
  ]);

  const items = [...system, ...images, ...derailed];
  const rebootRequired = existsSync('/var/run/reboot-required');
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
    const result = await run(
      [
        'sh',
        '-c',
        'DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get -y -qq upgrade',
      ],
      900_000,
    );
    return {
      ok: result.code === 0,
      message:
        result.code === 0
          ? 'System packages updated. A restart may be needed to finish.'
          : "The system update didn't finish. Run apt-get upgrade on the server to see why.",
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

    const { pullImage } = await import('../docker/images.ts');
    const { queueDeployment } = await import('../build/pipeline.ts');
    const lines: string[] = [];
    try {
      await pullImage(service.image!, (line) => lines.push(line));
    } catch (err) {
      return {
        ok: false,
        message: `Couldn't fetch the new image: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    queueDeployment(service.id, 'redeploy');
    return { ok: true, message: `${service.name} is redeploying with the new image.` };
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
