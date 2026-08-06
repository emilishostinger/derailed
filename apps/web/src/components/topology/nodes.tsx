import type { Service } from '@derailed/shared';
import { Handle, type NodeProps, Position } from '@xyflow/react';
import { GitBranch, Globe, Lock, Package } from 'lucide-react';
import { useProjects } from '../../stores/projects.ts';
import { TechIcon } from '../TechIcon.tsx';
import { cx, Sparkline, StatusDot } from '../ui.tsx';
import { NODE_HEIGHT, NODE_WIDTH } from './layout.ts';

export interface ServiceNodeData extends Record<string, unknown> {
  service: Service;
}

const HANDLE_CLASS =
  '!h-2 !w-2 !border-2 !border-surface !bg-line-strong transition-colors hover:!bg-accent';

/** Shared shell so every node on the canvas has exactly one silhouette. */
function NodeShell({
  selected,
  busy,
  failed,
  children,
}: {
  selected?: boolean;
  busy?: boolean;
  failed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{ width: NODE_WIDTH, minHeight: NODE_HEIGHT }}
      className={cx(
        'relative flex cursor-pointer flex-col overflow-hidden rounded-[var(--radius-card)] border bg-surface text-left transition-[border-color,box-shadow] duration-150',
        selected
          ? 'border-accent shadow-[0_0_0_3px_var(--color-accent)]/20'
          : failed
            ? 'border-danger/40 hover:border-danger/70'
            : 'border-line hover:border-line-strong',
      )}
    >
      {/* An indeterminate track along the top edge while a deploy is in flight. */}
      {busy && (
        <div className="absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-busy/20">
          <div className="animate-track h-full w-1/3 bg-busy" />
        </div>
      )}
      {children}
    </div>
  );
}

export function AppNode({ data, selected }: NodeProps & { data: ServiceNodeData }) {
  const { service } = data;
  const stats = useProjects((s) => s.stats[service.id]);
  const status = service.status ?? 'stopped';
  const domain = (service.domains ?? [])[0];
  const repo = service.repoUrl
    ?.replace(/^https?:\/\/(www\.)?github\.com\//, '')
    .replace(/\.git$/, '');

  return (
    <NodeShell
      selected={selected}
      busy={status === 'deploying'}
      failed={status === 'failed' || status === 'crashed'}
    >
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />
      <Handle type="source" position={Position.Right} className={HANDLE_CLASS} />

      <div className="flex items-center gap-2 px-3 pt-2.5">
        <TechIcon service={service} className="h-6 w-6 text-[10px]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {service.name}
        </span>
        <StatusDot status={status} />
        {stats && (
          <span className="shrink-0 text-[11px] text-ink-faint tabular">
            {stats.cpuPercent.toFixed(0)}%
          </span>
        )}
      </div>

      <div className="flex items-center gap-1.5 px-3 pt-1.5">
        {service.source === 'image' ? (
          <>
            <Package className="h-3 w-3 shrink-0 text-ink-faint" />
            <span className="min-w-0 truncate text-[11px] text-ink-muted">{service.image}</span>
          </>
        ) : (
          <>
            <GitBranch className="h-3 w-3 shrink-0 text-ink-faint" />
            <span className="min-w-0 truncate text-[11px] text-ink-muted">
              {repo ?? 'No repository'}
            </span>
          </>
        )}
      </div>

      {status === 'failed' && service.latestDeployment?.errorSummary ? (
        <p className="mt-1.5 line-clamp-2 px-3 pb-2.5 text-[11px] text-danger">
          {service.latestDeployment.errorSummary}
        </p>
      ) : (
        <div className="mt-auto flex items-center gap-1.5 px-3 pt-1.5 pb-2.5">
          {domain ? (
            <>
              {domain.tlsStatus === 'active' ? (
                <Lock className="h-3 w-3 shrink-0 text-ok" />
              ) : (
                <Globe className="h-3 w-3 shrink-0 text-ink-faint" />
              )}
              <span className="min-w-0 truncate text-[11px] text-accent">{domain.hostname}</span>
            </>
          ) : (
            <span className="text-[11px] text-ink-faint">No web address yet</span>
          )}
          {stats && stats.history.length > 1 && (
            <Sparkline
              values={stats.history}
              className="ml-auto h-4 w-10 shrink-0 text-ink-faint"
            />
          )}
        </div>
      )}
    </NodeShell>
  );
}

export function DatabaseNode({ data, selected }: NodeProps & { data: ServiceNodeData }) {
  const { service } = data;
  const status = service.status ?? 'stopped';
  const connections = useProjects(
    (s) =>
      s.projects
        .find((project) => project.id === service.projectId)
        ?.links?.filter((link) => link.toServiceId === service.id).length ?? 0,
  );

  return (
    <NodeShell selected={selected} busy={status === 'creating'} failed={status === 'failed'}>
      <Handle type="target" position={Position.Left} className={HANDLE_CLASS} />

      <div className="flex items-center gap-2 px-3 pt-2.5">
        <TechIcon service={service} className="h-6 w-6 text-[10px]" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
          {service.name}
        </span>
        <StatusDot status={status} />
      </div>

      <div className="px-3 pt-1.5">
        <span className="text-[11px] text-ink-muted">
          {service.dbEngine} {service.dbVersion}
        </span>
      </div>

      <div className="mt-auto flex items-center gap-1.5 px-3 pt-1.5 pb-2.5">
        <span className="text-[11px] text-ink-faint">
          {connections === 0
            ? 'Not connected to anything'
            : `Connected to ${connections} app${connections === 1 ? '' : 's'}`}
        </span>
        {service.exposedPort && (
          <span className="ml-auto rounded-[4px] bg-warn-soft px-1.5 py-px text-[10px] font-medium text-warn">
            public
          </span>
        )}
      </div>
    </NodeShell>
  );
}

/** Where traffic comes from. Anchors the left edge so the flow reads one way. */
export function InternetNode() {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-[var(--radius-card)] border border-dashed border-line bg-surface/50 px-4 py-3">
      <Handle type="source" position={Position.Right} className={cx(HANDLE_CLASS, '!bg-line')} />
      <Globe className="h-4 w-4 text-ink-faint" />
      <span className="text-[11px] font-medium text-ink-muted">Internet</span>
    </div>
  );
}

export const nodeTypes = {
  app: AppNode,
  database: DatabaseNode,
  internet: InternetNode,
};
