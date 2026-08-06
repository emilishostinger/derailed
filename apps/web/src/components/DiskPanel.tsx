import type { DiskReport, SwapState } from '@derailed/shared';
import { Sparkles, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

/**
 * What is using the disk, and the one button that tidies it up.
 *
 * A full disk on a small server breaks everything at once and silently, and Docker is
 * nearly always the reason. The honest version of this screen is not a pie chart: it
 * is a list saying what each pile *is*, and how much of it nothing would miss.
 */
export function DiskPanel() {
  const [report, setReport] = useState<DiskReport | null>(null);
  const [swap, setSwap] = useState<SwapState | null>(null);
  const [busy, setBusy] = useState<'reclaim' | 'swap' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  const load = useCallback(() => {
    endpoints
      .disk()
      .then(setReport)
      .catch(() => undefined);
    endpoints
      .swap()
      .then(setSwap)
      .catch(() => undefined);
  }, []);

  useEffect(load, [load]);

  async function reclaim() {
    setBusy('reclaim');
    setError(null);
    try {
      const result = await endpoints.reclaimDisk();
      load();
      push({
        message: result.freedBytes
          ? `Freed ${formatBytes(result.freedBytes)}. ${result.what.join('. ')}.`
          : result.what.join('. '),
        tone: 'ok',
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function makeSwap() {
    setBusy('swap');
    setError(null);
    try {
      const result = await endpoints.addSwap();
      setSwap(result.swap);
      push({ message: `Added ${formatBytes(result.added)} of swap.`, tone: 'ok' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!report) return null;

  const bar =
    report.level === 'full' ? 'bg-danger' : report.level === 'filling' ? 'bg-warn' : 'bg-accent';

  return (
    <div className="space-y-3">
      <div className="card p-4">
        <div className="flex items-baseline justify-between gap-3">
          <p className="text-[13px] text-ink">{report.summary}</p>
          <p className="shrink-0 text-[12px] text-ink-faint tabular">{report.percentUsed}%</p>
        </div>

        <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
          <div
            className={cx('h-full rounded-full transition-[width]', bar)}
            style={{ width: `${Math.min(100, report.percentUsed)}%` }}
          />
        </div>

        {report.categories.length > 0 && (
          <ul className="mt-4 divide-y divide-line">
            {report.categories.map((category) => (
              <li key={category.kind} className="flex items-start gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] text-ink">{category.label}</p>
                  <p className="mt-0.5 text-[12px] text-ink-faint">{category.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[13px] text-ink tabular">{formatBytes(category.bytes)}</p>
                  {category.reclaimableBytes > 0 && (
                    <p className="text-[12px] text-ink-faint tabular">
                      {formatBytes(category.reclaimableBytes)} spare
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        <ErrorNote error={error} />

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null || report.reclaimableBytes === 0}
            onClick={() => void reclaim()}
          >
            {busy === 'reclaim' ? <Spinner /> : <Sparkles className="h-3.5 w-3.5" />}
            {report.reclaimableBytes > 0
              ? `Free up ${formatBytes(report.reclaimableBytes)}`
              : 'Nothing to tidy up'}
          </button>
          {report.reclaimableBytes > 0 && (
            <span className="text-[12px] text-ink-faint">
              Removes unused images and build scraps. Never your data or your backups.
            </span>
          )}
        </div>
      </div>

      {swap?.recommended && (
        <div className="card flex items-start gap-3 border-warn/30 bg-warn-soft p-4">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">{swap.reason}</p>
            <p className="mt-1 text-[12px] text-ink-faint">
              Derailed can add a {formatBytes(swap.suggestedBytes)} swap file, which survives a
              reboot. It costs disk space and nothing else.
            </p>
            <div className="mt-2.5">
              <button
                type="button"
                className="btn-secondary"
                disabled={busy !== null || !swap.canAdd}
                onClick={() => void makeSwap()}
              >
                {busy === 'swap' && <Spinner />}
                {swap.canAdd ? 'Add swap' : 'Only on a Linux server'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
