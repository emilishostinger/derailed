import type { DoctorCheck, DoctorFix, DoctorReport } from '@derailed/shared';
import { Check, Stethoscope, TriangleAlert, XCircle } from 'lucide-react';
import { useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

/**
 * One button that checks everything and says what to do about what it finds.
 *
 * Most of these facts are on some other screen already. Having them in one list
 * matters on the day something is wrong and you do not know where to look, and the
 * all-green version matters on the day you are convinced the server is broken and it
 * is not.
 */
export function Doctor() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState(false);
  const [fixing, setFixing] = useState<DoctorFix | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setReport(await endpoints.doctor());
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  async function fix(action: DoctorFix) {
    setFixing(action);
    setError(null);
    try {
      setReport(await endpoints.doctorFix(action));
    } catch (err) {
      setError(err);
    } finally {
      setFixing(null);
    }
  }

  return (
    <div className="space-y-3">
      {!report && (
        <div className="card flex items-center gap-3 p-4">
          <Stethoscope className="h-4 w-4 shrink-0 text-ink-faint" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
            Checks Docker, the router, disk, memory, certificates, domains and backups, and says
            what to do about anything it finds.
          </p>
          <button
            type="button"
            className="btn-secondary shrink-0"
            disabled={running}
            onClick={() => void run()}
          >
            {running && <Spinner />}
            Check everything
          </button>
        </div>
      )}

      <ErrorNote error={error} />

      {report && (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-3">
            <p
              className={cx(
                'text-[13px]',
                report.level === 'bad'
                  ? 'text-danger'
                  : report.level === 'warn'
                    ? 'text-warn'
                    : 'text-ok',
              )}
            >
              {report.summary}
            </p>
            <button
              type="button"
              className="btn-ghost shrink-0"
              disabled={running}
              onClick={() => void run()}
            >
              {running && <Spinner />}
              Check again
            </button>
          </div>

          <ul className="mt-3 divide-y divide-line">
            {report.checks.map((check) => (
              <CheckRow
                key={check.id}
                check={check}
                busy={fixing !== null && fixing === check.fix?.action}
                disabled={fixing !== null}
                onFix={() => check.fix && void fix(check.fix.action)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const ICONS = {
  ok: { icon: Check, className: 'text-ok' },
  warn: { icon: TriangleAlert, className: 'text-warn' },
  bad: { icon: XCircle, className: 'text-danger' },
} as const;

function CheckRow({
  check,
  busy,
  disabled,
  onFix,
}: {
  check: DoctorCheck;
  busy: boolean;
  disabled: boolean;
  onFix: () => void;
}) {
  const { icon: Icon, className } = ICONS[check.status];

  return (
    <li className="flex items-start gap-3 py-2.5">
      <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', className)} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">{check.title}</p>
        <p className="mt-0.5 text-[12px] text-ink-faint">{check.detail}</p>
      </div>
      {check.fix && (
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={disabled}
          onClick={onFix}
        >
          {busy && <Spinner />}
          {check.fix.label}
        </button>
      )}
    </li>
  );
}
