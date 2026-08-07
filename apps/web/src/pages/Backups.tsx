import {
  Archive,
  ChevronRight,
  Database,
  Download,
  HardDrive,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { Drill, Offsite } from '../components/Offsite.tsx';
import { cx, EmptyState, ErrorNote, Modal, Reveal, Select, Spinner } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { formatBytes, PageHeader } from './Layout.tsx';

export interface BackupSummary {
  id: string;
  projectId: string;
  projectName: string;
  createdAt: number;
  sizeBytes: number;
  databases: number;
  volumes: number;
  warnings?: string[];
}

type Schedule = 'off' | 'daily' | 'weekly';

export interface BackupsResponse {
  backups: BackupSummary[];
  schedules: { projectId: string; projectName: string; schedule: Schedule }[];
  retention: { keep: number; keepDays: number };
  lastRunAt: number | null;
  nextRunAt: number | null;
}

/** How many of a project's copies are shown before the rest fold away. */
const VISIBLE_PER_PROJECT = 3;

/**
 * Copies of your content, kept as ordinary tar.gz files with a readable manifest, a
 * SQL dump per database and a tar per stored folder. Deliberately boring formats: if
 * Derailed ever goes away, everything in one of these opens with tools you already
 * have.
 *
 * Grouped by project rather than listed by date. Seven copies each across a dozen
 * projects is a wall of near-identical cards, and the question someone arrives with is
 * "is this project safe", not "what happened on Tuesday".
 */
export function Backups() {
  const projects = useProjects((s) => s.projects);
  const [data, setData] = useState<BackupsResponse | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [restoring, setRestoring] = useState<BackupSummary | null>(null);
  // Without this the page says "No copies yet" while it is still counting them, which
  // is the one sentence it must never say by mistake.
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setData(await endpoints.backups().catch(() => null));
    setLoading(false);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: loaded once; `refresh` is recreated every render.
  useEffect(() => {
    void refresh();
  }, []);

  async function backup(projectId: string) {
    setBusy(projectId);
    setError(null);
    try {
      await endpoints.createBackup(projectId);
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const scheduleOf = (projectId: string): Schedule =>
    data?.schedules.find((entry) => entry.projectId === projectId)?.schedule ?? 'off';

  const backupsOf = (projectId: string) =>
    (data?.backups ?? []).filter((backup) => backup.projectId === projectId);

  // Copies whose project has since been deleted still deserve a home: they are often
  // the only remaining trace of it, and the point of a backup is to outlive the thing.
  const orphaned = (data?.backups ?? []).filter(
    (backup) => !projects.some((project) => project.id === backup.projectId),
  );

  const total = (data?.backups ?? []).reduce((sum, backup) => sum + backup.sizeBytes, 0);

  return (
    <>
      <PageHeader
        title="Backups"
        subtitle={
          data?.backups.length ? `${data.backups.length} kept · ${formatBytes(total)}` : undefined
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-2.5 p-5">
          <ErrorNote error={error} />

          {loading && (
            <div className="flex justify-center py-16 text-ink-faint">
              <Spinner className="h-5 w-5" />
            </div>
          )}

          {!loading && projects.length === 0 && orphaned.length === 0 && (
            <EmptyState
              icon={<Archive className="h-5 w-5" />}
              title="Nothing to back up yet"
              body="A backup holds your databases and every folder you asked Derailed to keep. Once you have a project, you can make one here."
            />
          )}

          {!loading &&
            projects.map((project) => (
              <ProjectBackups
                key={project.id}
                name={project.name}
                schedule={scheduleOf(project.id)}
                backups={backupsOf(project.id)}
                busy={busy === project.id}
                disabled={busy !== null}
                onBackUp={() => void backup(project.id)}
                onSchedule={async (schedule) => {
                  await endpoints.setBackupSchedule(project.id, schedule).catch(() => undefined);
                  await refresh();
                }}
                onRestore={setRestoring}
                onChange={refresh}
              />
            ))}

          {/* Underneath, not on top. These two decide whether the copies above are
              worth anything: are they anywhere else, and has anybody ever read one
              back. Both are worth doing and neither is what you came to this page for,
              so they wait here rather than greeting you with a form. */}
          {!loading && (
            <div className="space-y-2.5 pt-3">
              <p className="eyebrow">Worth doing</p>
              <Offsite />
              <Drill />
            </div>
          )}

          {!loading && orphaned.length > 0 && (
            <ProjectBackups
              name="Projects you have deleted"
              schedule="off"
              backups={orphaned}
              onRestore={setRestoring}
              onChange={refresh}
            />
          )}

          {!loading && data && <RetentionSettings retention={data.retention} onSaved={refresh} />}

          {data?.lastRunAt && (
            <p className="pt-2 text-[12px] text-ink-faint">
              Last automatic run {new Date(data.lastRunAt).toLocaleString()}
              {data.nextRunAt ? `, next around ${new Date(data.nextRunAt).toLocaleString()}` : ''}.
            </p>
          )}
        </div>
      </div>

      {restoring && (
        <RestoreDialog
          backup={restoring}
          onClose={() => setRestoring(null)}
          onDone={() => {
            setRestoring(null);
            void refresh();
          }}
        />
      )}
    </>
  );
}

function ProjectBackups({
  name,
  schedule,
  backups,
  busy,
  disabled,
  onBackUp,
  onSchedule,
  onRestore,
  onChange,
}: {
  name: string;
  schedule: Schedule;
  backups: BackupSummary[];
  busy?: boolean;
  disabled?: boolean;
  onBackUp?: () => void;
  onSchedule?: (schedule: Schedule) => void;
  onRestore: (backup: BackupSummary) => void;
  onChange: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const newest = backups[0] ?? null;
  const size = backups.reduce((sum, backup) => sum + backup.sizeBytes, 0);
  const shown = showAll ? backups : backups.slice(0, VISIBLE_PER_PROJECT);
  const hidden = backups.length - VISIBLE_PER_PROJECT;

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-2.5 px-4 py-3 text-left transition-colors hover:bg-surface-2/50"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          className={cx(
            'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{name}</span>
          <span className="mt-0.5 block truncate text-[12px] text-ink-muted">
            {newest
              ? `${backups.length} ${backups.length === 1 ? 'copy' : 'copies'} · newest ${relative(newest.createdAt)} · ${formatBytes(size)}`
              : 'No copies yet'}
          </span>
        </span>
        {schedule !== 'off' && (
          <span className="shrink-0 rounded-full border border-ok/30 bg-ok-soft px-2 py-0.5 text-[11px] text-ok">
            {schedule === 'daily' ? 'Every day' : 'Every week'}
          </span>
        )}
      </button>

      <Reveal open={open}>
        <div className="border-t border-line px-4 py-3.5">
          {onSchedule && (
            <div className="mb-4">
              <p className="eyebrow mb-2">Back it up on its own</p>
              <div className="flex gap-1.5">
                {(['off', 'daily', 'weekly'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={cx(
                      'btn flex-1 border text-[12px]',
                      schedule === option
                        ? 'border-accent bg-accent-soft text-ink'
                        : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink',
                    )}
                    onClick={() => onSchedule(option)}
                  >
                    {option === 'off' ? 'Never' : option === 'daily' ? 'Every day' : 'Every week'}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-faint">
                Older copies are removed as new ones arrive, so this cannot fill the disk. How many
                are kept is set at the bottom of this page.
              </p>
            </div>
          )}

          {onBackUp && (
            <button
              type="button"
              className="btn-secondary mb-4 text-[12px]"
              disabled={disabled}
              onClick={onBackUp}
            >
              {busy && <Spinner />}
              Back it up now
            </button>
          )}

          {backups.length === 0 ? (
            <p className="hint">Nothing kept for this project yet.</p>
          ) : (
            <div className="space-y-2">
              {shown.map((backup) => (
                <BackupRow
                  key={backup.id}
                  backup={backup}
                  onRestore={() => onRestore(backup)}
                  onChange={onChange}
                />
              ))}
              {hidden > 0 && (
                <button
                  type="button"
                  className="btn-ghost text-[12px]"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll
                    ? 'Show fewer'
                    : `Show ${hidden} older ${hidden === 1 ? 'copy' : 'copies'}`}
                </button>
              )}
            </div>
          )}
        </div>
      </Reveal>
    </div>
  );
}

function BackupRow({
  backup,
  onRestore,
  onChange,
}: {
  backup: BackupSummary;
  onRestore: () => void;
  onChange: () => void;
}) {
  return (
    <div className="rounded-[var(--radius-control)] border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-ink-muted">
        <span className="text-[13px] text-ink tabular">
          {new Date(backup.createdAt).toLocaleString()}
        </span>
        <span className="tabular">{formatBytes(backup.sizeBytes)}</span>
        {backup.databases > 0 && (
          <span className="flex items-center gap-1">
            <Database className="h-3 w-3" />
            {backup.databases}
          </span>
        )}
        {backup.volumes > 0 && (
          <span className="flex items-center gap-1">
            <HardDrive className="h-3 w-3" />
            {backup.volumes}
          </span>
        )}
      </div>

      {backup.warnings && backup.warnings.length > 0 && (
        <div className="mt-2 space-y-1 rounded-[var(--radius-control)] border border-warn/30 bg-warn-soft p-2.5 text-[12px] text-ink-muted">
          {backup.warnings.map((warning) => (
            <p key={warning} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0 text-warn" />
              {warning}
            </p>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex flex-wrap gap-1.5">
        <a className="btn-secondary text-[12px]" href={`/api/backups/${backup.id}/download`}>
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
        <button type="button" className="btn-ghost text-[12px]" onClick={onRestore}>
          <RotateCcw className="h-3.5 w-3.5" />
          Restore
        </button>
        <button
          type="button"
          className="btn-ghost ml-auto px-1.5 text-[12px] text-danger"
          onClick={async () => {
            await endpoints.deleteBackup(backup.id).catch(() => undefined);
            onChange();
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/**
 * How much history to keep.
 *
 * Two limits, because they answer different worries. A count is what people picture,
 * and an age is what they actually want when a project is backed up often: "the last
 * seven" of an hourly backup is seven hours of history, which is no history at all.
 */
function RetentionSettings({
  retention,
  onSaved,
}: {
  retention: { keep: number; keepDays: number };
  onSaved: () => void;
}) {
  const [keep, setKeep] = useState(String(retention.keep));
  const [keepDays, setKeepDays] = useState(retention.keepDays ? String(retention.keepDays) : '');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const changed =
    Number(keep) !== retention.keep || Number(keepDays || 0) !== (retention.keepDays ?? 0);

  async function save() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await endpoints.setRetention(Number(keep), Number(keepDays || 0));
      setNote(
        result.removed > 0
          ? `Saved. ${result.removed} older ${result.removed === 1 ? 'copy was' : 'copies were'} removed.`
          : 'Saved.',
      );
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-4 p-4">
      <p className="eyebrow mb-2.5">How much to keep</p>
      <div className="flex flex-wrap items-end gap-4">
        <label className="block">
          <span className="label">Copies per project</span>
          <input
            className="input w-28 tabular"
            type="number"
            min={1}
            max={100}
            value={keep}
            onChange={(event) => setKeep(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="label">Also remove after</span>
          <div className="flex items-center gap-2">
            <input
              className="input w-28 tabular"
              type="number"
              min={0}
              max={3650}
              placeholder="Never"
              value={keepDays}
              onChange={(event) => setKeepDays(event.target.value)}
            />
            <span className="text-[12px] text-ink-muted">days</span>
          </div>
        </label>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !changed || !keep}
          onClick={() => void save()}
        >
          {busy && <Spinner />}
          Save
        </button>
      </div>
      <p className="mt-2.5 text-[12px] text-ink-faint">
        Leave the days blank to keep them by count alone. The newest copy of a project is never
        removed for being old, however long it has been.
      </p>
      {note && <p className="mt-2 text-[12px] text-ok">{note}</p>}
      <ErrorNote error={error} />
    </div>
  );
}

/** "2 hours ago" reads faster than a timestamp when scanning a list. */
function relative(ts: number): string {
  const seconds = Math.max(1, Math.round((Date.now() - ts) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days} days ago`;
  return `${Math.round(days / 7)} weeks ago`;
}

function RestoreDialog({
  backup,
  onClose,
  onDone,
}: {
  backup: BackupSummary;
  onClose: () => void;
  onDone: () => void;
}) {
  const projects = useProjects((s) => s.projects);
  const [target, setTarget] = useState(backup.projectId || projects[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [report, setReport] = useState<{
    databases: number;
    volumes: number;
    warnings: string[];
  } | null>(null);

  async function restore() {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.restoreBackup(backup.id, target);
      setReport(result.report);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Restore this backup" onClose={onClose}>
      {report ? (
        <div className="space-y-3">
          <p className="text-[13px] text-ink">
            Restored {report.databases} database{report.databases === 1 ? '' : 's'} and{' '}
            {report.volumes} folder{report.volumes === 1 ? '' : 's'}.
          </p>
          {report.warnings.length > 0 && (
            <div className="rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft p-3 text-[12px] text-ink-muted">
              {report.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          )}
          <p className="hint">
            Anything running was stopped while its files went back, and started again afterwards.
          </p>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" onClick={onDone}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-ink">
            This replaces what is in the chosen project right now with the contents of this backup,
            taken {new Date(backup.createdAt).toLocaleString()}. Anything newer is overwritten.
          </p>

          <label className="block">
            <span className="label">Restore into</span>
            <Select
              ariaLabel="Which project"
              value={target}
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              onChange={setTarget}
            />
          </label>

          <ErrorNote error={error} />

          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-danger"
              onClick={() => void restore()}
              disabled={busy || !target}
            >
              {busy && <Spinner />}
              Overwrite and restore
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
