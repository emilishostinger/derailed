import type { Job, JobRun, Service } from '@derailed/shared';
import { Clock, Play, Plus, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { cx, ErrorNote, Field, Spinner } from './ui.tsx';

/**
 * Things that run on a schedule.
 *
 * The biggest thing Derailed could not do: no WordPress cron, no nightly cleanup, no
 * "email me a report". The screen asks two questions, what to run and how often, and
 * the "how often" is a list of choices rather than five asterisks.
 */
type JobWithWords = Job & { scheduleInWords?: string };

const PRESETS = [
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every day at 03:00', value: '0 3 * * *' },
  { label: 'Every Monday at 03:00', value: '0 3 * * 1' },
];

export function JobsTab({ service }: { service: Service }) {
  const [jobs, setJobs] = useState<JobWithWords[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');
  const [schedule, setSchedule] = useState(PRESETS[2]!.value);
  const [custom, setCustom] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .jobs(service.id)
      .then(setJobs)
      .catch(() => setJobs([]));
  }, [service.id]);

  useEffect(load, [load]);

  async function act(what: string, run: () => Promise<void>) {
    setBusy(what);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!jobs) return <Spinner />;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-ink-muted">
        Runs a command inside this app, on a schedule. It has the app's files and its variables,
        exactly as if you had typed it on the Terminal tab.
      </p>

      {jobs.length > 0 && (
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {jobs.map((job) => (
            <JobRow
              key={job.id}
              job={job}
              busy={busy}
              onRun={() =>
                act(`run-${job.id}`, async () => {
                  const { result } = await endpoints.runJob(job.id);
                  push({
                    message: result.ok
                      ? `"${job.name}" finished.`
                      : `"${job.name}" exited with code ${result.run.exitCode}.`,
                    tone: result.ok ? 'ok' : 'danger',
                  });
                  load();
                })
              }
              onToggle={() =>
                act(`toggle-${job.id}`, async () => {
                  await endpoints.updateJob(job.id, { enabled: !job.enabled });
                  load();
                })
              }
              onDelete={() =>
                act(`rm-${job.id}`, async () => {
                  await endpoints.deleteJob(job.id);
                  load();
                })
              }
            />
          ))}
        </ul>
      )}

      <ErrorNote error={error} />

      {adding ? (
        <div className="space-y-3 rounded-[var(--radius-card)] border border-line p-3.5">
          <Field label="What is this?" hint="A name you will recognise in six months.">
            <input
              className="input"
              value={name}
              placeholder="Clear out old sessions"
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label="What to run" hint="Runs through a shell, so pipes and && work.">
            <input
              className="input font-mono text-[12px]"
              value={command}
              placeholder="php artisan schedule:run"
              onChange={(event) => setCommand(event.target.value)}
            />
          </Field>

          <div>
            <span className="label">How often</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={cx(
                    'rounded-[var(--radius-control)] border px-2.5 py-1.5 text-[12px]',
                    !custom && schedule === preset.value
                      ? 'border-accent bg-accent/10 text-ink'
                      : 'border-line text-ink-muted',
                  )}
                  onClick={() => {
                    setCustom(false);
                    setSchedule(preset.value);
                  }}
                >
                  {preset.label}
                </button>
              ))}
              <button
                type="button"
                className={cx(
                  'rounded-[var(--radius-control)] border px-2.5 py-1.5 text-[12px]',
                  custom ? 'border-accent bg-accent/10 text-ink' : 'border-line text-ink-muted',
                )}
                onClick={() => setCustom(true)}
              >
                Something else
              </button>
            </div>
            {custom && (
              <input
                className="input mt-2 font-mono text-[12px]"
                value={schedule}
                placeholder="0 3 * * *"
                onChange={(event) => setSchedule(event.target.value)}
              />
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null || !name.trim() || !command.trim()}
              onClick={() =>
                act('add', async () => {
                  await endpoints.createJob({
                    serviceId: service.id,
                    name: name.trim(),
                    command: command.trim(),
                    schedule,
                  });
                  setAdding(false);
                  setName('');
                  setCommand('');
                  load();
                })
              }
            >
              {busy === 'add' && <Spinner />}
              Add it
            </button>
            <button type="button" className="btn-ghost" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn-secondary" onClick={() => setAdding(true)}>
          <Plus className="h-3.5 w-3.5" />
          Run something on a schedule
        </button>
      )}
    </div>
  );
}

function JobRow({
  job,
  busy,
  onRun,
  onToggle,
  onDelete,
}: {
  job: JobWithWords;
  busy: string | null;
  onRun: () => void;
  onToggle: () => void;
  onDelete: () => void;
}) {
  const [runs, setRuns] = useState<JobRun[] | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <li className="px-3.5 py-3">
      <div className="flex items-start gap-3">
        <Clock
          className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', job.enabled ? 'text-ok' : 'text-ink-faint')}
        />
        <div className="min-w-0 flex-1">
          <p className={cx('text-[13px]', job.enabled ? 'text-ink' : 'text-ink-faint')}>
            {job.name}
          </p>
          <p className="truncate font-mono text-[11px] text-ink-faint">{job.command}</p>
          <p className="mt-0.5 text-[12px] text-ink-faint">
            {job.scheduleInWords ?? job.schedule}
            {job.lastRunAt && `. Last ran ${new Date(job.lastRunAt).toLocaleString()}`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            className="btn-ghost"
            disabled={busy !== null}
            onClick={() => {
              setOpen((previous) => !previous);
              if (!runs) void endpoints.runsFor(job.id).then(setRuns);
            }}
          >
            History
          </button>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={onRun}>
            {busy === `run-${job.id}` ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
            Run now
          </button>
          <button type="button" className="btn-ghost" disabled={busy !== null} onClick={onToggle}>
            {job.enabled ? 'Pause' : 'Resume'}
          </button>
          <button
            type="button"
            aria-label="Delete"
            className="text-ink-faint hover:text-danger"
            disabled={busy !== null}
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {open && (
        <div className="mt-2.5 space-y-1.5">
          {runs === null ? (
            <Spinner />
          ) : runs.length === 0 ? (
            <p className="text-[12px] text-ink-faint">It has not run yet.</p>
          ) : (
            runs.map((run) => (
              <details key={run.id} className="rounded-[var(--radius-control)] bg-surface-2 p-2">
                <summary className="cursor-pointer text-[12px] text-ink-muted">
                  <span className={run.exitCode === 0 ? 'text-ok' : 'text-danger'}>
                    {run.exitCode === 0 ? 'Worked' : `Failed (${run.exitCode})`}
                  </span>
                  {' · '}
                  {new Date(run.startedAt).toLocaleString()}
                  {run.trigger === 'manual' && ' · by hand'}
                </summary>
                <pre className="mt-2 max-h-40 overflow-auto text-[11px] text-ink-muted">
                  {run.output || 'It printed nothing.'}
                </pre>
              </details>
            ))
          )}
        </div>
      )}
    </li>
  );
}
