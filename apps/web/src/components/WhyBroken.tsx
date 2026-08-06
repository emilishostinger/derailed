import type { Diagnosis } from '@derailed/shared';
import { Lightbulb, Stethoscope } from 'lucide-react';
import { useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * "Why did this break?"
 *
 * The rest of Derailed already tries to say what went wrong in plain language. This
 * is that promise applied to the one place it was hardest to keep: the tail of a build
 * log, which is where somebody who has never opened a terminal gives up.
 *
 * It is deliberately a button rather than something that appears on its own. Reading
 * the log is the right first move for anybody who can, and a box that pushes an
 * opinion in front of that is in the way.
 */
export function WhyBroken({ deploymentId }: { deploymentId: string }) {
  const [result, setResult] = useState<{ diagnosis: Diagnosis | null; lines: string[] } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [fixing, setFixing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      setResult(await endpoints.whyBroken(deploymentId));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function applyFix(fix: 'add-swap' | 'reclaim-disk') {
    setFixing(true);
    setError(null);
    try {
      await endpoints.doctorFix(fix);
      push({
        message:
          fix === 'add-swap'
            ? 'Swap added. Deploy again and it should get further.'
            : 'Space freed. Deploy again and it should get further.',
        tone: 'ok',
      });
    } catch (err) {
      setError(err);
    } finally {
      setFixing(false);
    }
  }

  if (!result) {
    return (
      <div>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => void ask()}>
          {busy ? <Spinner /> : <Stethoscope className="h-3.5 w-3.5" />}
          Why did this break?
        </button>
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-card)] border border-line bg-surface-2/40 p-3.5">
      {result.diagnosis ? (
        <div className="flex items-start gap-2.5">
          <Lightbulb className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{result.diagnosis.summary}</p>
            <p className="mt-1 text-[13px] text-ink-muted">{result.diagnosis.action}</p>

            {result.diagnosis.fix && (
              <button
                type="button"
                className="btn-secondary mt-2.5"
                disabled={fixing}
                onClick={() => void applyFix(result.diagnosis!.fix!)}
              >
                {fixing && <Spinner />}
                {result.diagnosis.fix === 'add-swap' ? 'Add swap now' : 'Free up space now'}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-2.5">
          <Stethoscope className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1">
            {/* Saying "I do not know" plainly. An invented answer would send somebody
                off for an hour on whatever it happened to name. */}
            <p className="text-[13px] text-ink">Derailed does not recognise this one.</p>
            <p className="mt-1 text-[13px] text-ink-muted">
              The lines below are the ones worth reading, with the stack frames and warnings taken
              out. If you work out what it was, it is worth reporting so Derailed can recognise it
              next time.
            </p>
          </div>
        </div>
      )}

      {result.lines.length > 0 && (
        <pre className="mt-3 max-h-48 overflow-auto rounded-[var(--radius-control)] bg-surface p-2.5 text-[11px] leading-relaxed text-ink-muted">
          {result.lines.join('\n')}
        </pre>
      )}

      <ErrorNote error={error} />
    </div>
  );
}
