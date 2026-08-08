import { Boxes, Container, HardDrive, Network } from 'lucide-react';
import { DiskPanel } from '../components/DiskPanel.tsx';
import { Doctor } from '../components/Doctor.tsx';
import { OpenPorts } from '../components/OpenPorts.tsx';
import { ScanPanel } from '../components/ScanPanel.tsx';
import { ServerStats } from '../components/ServerStats.tsx';
import { SshPanel } from '../components/SshPanel.tsx';
import { cx } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { useSession } from '../stores/session.ts';
import { formatBytes, PageHeader } from './Layout.tsx';

/**
 * The machine itself, rather than the things running on it. Split out of Settings
 * because "how is my server doing" is a question people ask often, and Settings is
 * somewhere you go once.
 */
export function Server() {
  const system = useSession((s) => s.system);
  const projects = useProjects((s) => s.projects);

  const services = projects.flatMap((project) => project.services ?? []);
  const running = services.filter((service) => service.status === 'running').length;
  const databases = services.filter((service) => service.kind === 'database').length;
  const volumes = services.reduce((sum, service) => sum + (service.volumes?.length ?? 0), 0);

  return (
    <>
      <PageHeader title="Server" subtitle={system?.serverIp ?? undefined} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-5">
          <section>
            <p className="eyebrow mb-2.5">Right now</p>
            <ServerStats />
          </section>

          <section>
            <p className="eyebrow mb-2.5">What's on it</p>
            <div className="grid gap-3 sm:grid-cols-4">
              <Tile
                icon={<Boxes className="h-3.5 w-3.5" />}
                label="Projects"
                value={String(projects.length)}
              />
              <Tile
                icon={<Container className="h-3.5 w-3.5" />}
                label="Running"
                value={`${running} of ${services.length}`}
              />
              <Tile
                icon={<Network className="h-3.5 w-3.5" />}
                label="Databases"
                value={String(databases)}
              />
              <Tile
                icon={<HardDrive className="h-3.5 w-3.5" />}
                label="Stored folders"
                value={String(volumes)}
              />
            </div>
          </section>

          <section>
            <p className="eyebrow mb-2.5">Health</p>
            <Doctor />
          </section>

          <section>
            <p className="eyebrow mb-2.5">Leaks and known holes</p>
            <ScanPanel />
          </section>

          <section>
            <p className="eyebrow mb-2.5">Disk</p>
            <DiskPanel />
          </section>

          <section>
            <p className="eyebrow mb-2.5">What is open to the internet</p>
            <OpenPorts />
          </section>

          <section>
            <p className="eyebrow mb-2.5">Who can sign in to this machine</p>
            <SshPanel />
          </section>

          <section>
            <p className="eyebrow mb-2.5">The machine</p>
            <div className="card divide-y divide-line">
              <Row label="Public address" value={system?.serverIp ?? 'Unknown'} />
              <Row
                label="Docker"
                value={
                  system?.dockerOk ? `Running, version ${system.dockerVersion}` : 'Not reachable'
                }
                bad={!system?.dockerOk}
              />
              <Row
                label="Web traffic"
                value={system?.caddyOk ? 'Ready' : 'Not running'}
                bad={!system?.caddyOk}
              />
              <Row
                label="Disk"
                value={
                  system?.disk
                    ? `${formatBytes(system.disk.freeBytes)} free of ${formatBytes(system.disk.totalBytes)}`
                    : 'Unknown'
                }
              />
              <Row label="Derailed" value={`v${system?.version ?? '?'}`} />
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function Tile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="card p-3.5">
      <p className="flex items-center gap-1.5 text-[12px] text-ink-muted">
        <span className="text-ink-faint">{icon}</span>
        {label}
      </p>
      <p className="mt-1.5 text-[18px] font-semibold text-ink tabular">{value}</p>
    </div>
  );
}

function Row({ label, value, bad }: { label: string; value: string; bad?: boolean }) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5">
      <span className="w-36 shrink-0 text-[12px] text-ink-faint">{label}</span>
      <span className={cx('min-w-0 flex-1 truncate text-[13px]', bad ? 'text-danger' : 'text-ink')}>
        {value}
      </span>
    </div>
  );
}
