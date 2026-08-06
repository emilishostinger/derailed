import type { CostComparison } from '@derailed/shared';
import { ChevronDown, PiggyBank } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx } from './ui.tsx';

/**
 * What all this would cost somewhere that sends a bill.
 *
 * The value of your own server is invisible: nothing turns up every month to remind
 * you it is worth having. This is the reminder, and it is deliberately conservative,
 * because the first person to check the figure and find it flattering stops believing
 * everything else on the screen.
 */
export function CostCounter() {
  const [cost, setCost] = useState<CostComparison | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    endpoints
      .cost()
      .then(setCost)
      .catch(() => undefined);
  }, []);

  // Nothing running means nothing worth saying, and an enthusiastic "$0 saved!" on an
  // empty server reads as a product trying too hard.
  if (!cost || (cost.apps === 0 && cost.databases === 0)) return null;

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-4 text-left"
        onClick={() => setOpen((previous) => !previous)}
      >
        <PiggyBank className="h-4 w-4 shrink-0 text-ok" />
        <p className="min-w-0 flex-1 text-[13px] text-ink">{cost.summary}</p>
        <ChevronDown
          className={cx(
            'h-3.5 w-3.5 shrink-0 text-ink-faint transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div className="border-t border-line px-4 py-3">
          <ul className="divide-y divide-line">
            {cost.elsewhere.map((entry) => (
              <li key={entry.name} className="flex items-baseline gap-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
                  {entry.name}
                  {entry.note && (
                    <span className="ml-1.5 text-[12px] text-ink-faint">{entry.note}</span>
                  )}
                </span>
                <span className="shrink-0 text-[13px] text-ink tabular">${entry.monthly}/mo</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[12px] text-ink-faint">
            Published list prices as of {cost.pricesCheckedAt}, for the cheapest plan that would
            hold {cost.apps} app{cost.apps === 1 ? '' : 's'}
            {cost.databases > 0 && `, ${cost.databases} database${cost.databases === 1 ? '' : 's'}`}
            {cost.storageGb > 0 && ` and ${cost.storageGb} GB of storage`}. Bandwidth, support and
            anything you would actually need at scale are not counted, so the real figures are
            higher than these.
          </p>
        </div>
      )}
    </div>
  );
}
