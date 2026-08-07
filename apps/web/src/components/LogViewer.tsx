import type { LogLine } from '@derailed/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { cx } from './ui.tsx';

/**
 * Build and runtime output. Follows the tail by default but gets out of the way the
 * moment someone scrolls up to read something.
 *
 * Rows are virtualised: a chatty build can emit tens of thousands of lines, and
 * rendering them all is what makes a log viewer freeze the tab.
 */
export function LogViewer({
  lines,
  emptyMessage = 'Nothing here yet.',
  className,
  /** Start collapsed to the plain-language lines, with the rest a click away. */
  summarise,
  /**
   * Goes in front of the search box, on the same row.
   *
   * Anything that narrows what is in the viewer belongs beside the thing that
   * searches it, not stacked above it: they are one question asked twice, they are
   * the same height, and a row of its own costs a line of log output for a control
   * that is mostly empty space.
   */
  toolbar,
}: {
  lines: LogLine[];
  emptyMessage?: string;
  className?: string;
  summarise?: boolean;
  toolbar?: React.ReactNode;
}) {
  const [showAll, setShowAll] = useState(!summarise);
  const [search, setSearch] = useState('');
  const [follow, setFollow] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const visible = useMemo(() => {
    // Derailed's own narration is `system`; the rest is Docker and the build tool
    // talking to itself. Someone who just wants to know whether it worked needs the
    // former, and the latter only when it didn't.
    const base = showAll ? lines : lines.filter((line) => line.stream === 'system');
    if (!search.trim()) return base;
    const needle = search.toLowerCase();
    return base.filter((line) => line.line.toLowerCase().includes(needle));
  }, [lines, search, showAll]);

  const hiddenCount = showAll ? 0 : lines.length - visible.length;

  const matchCount = search.trim() ? visible.length : null;

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scroller.current,
    // Most lines are one row tall; measureElement corrects the ones that wrap.
    estimateSize: () => 19,
    overscan: 24,
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: pinning to the bottom must react to the line list changing, which `visible.length` already stands in for.
  useEffect(() => {
    if (!follow || visible.length === 0) return;
    virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
  }, [visible.length, follow, virtualizer]);

  function onScroll() {
    const element = scroller.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    if (atBottom !== follow) setFollow(atBottom);
  }

  const rows = virtualizer.getVirtualItems();

  return (
    <div className={cx('flex min-h-0 flex-col', className)}>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        {toolbar}
        <div className="relative min-w-0 flex-1 basis-48">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
          <input
            className="input h-8 py-1 pl-8 text-[12px]"
            placeholder="Search the output…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {matchCount !== null && (
          <span className="shrink-0 text-[12px] text-ink-faint tabular">{matchCount} found</span>
        )}
        {summarise && (
          <button
            type="button"
            className="btn h-8 shrink-0 border border-line bg-surface-2 text-[12px] text-ink-muted hover:text-ink"
            onClick={() => setShowAll((value) => !value)}
          >
            {showAll
              ? 'Just the summary'
              : `Show full output${hiddenCount ? ` (${hiddenCount})` : ''}`}
          </button>
        )}
        <button
          type="button"
          title={follow ? 'Following new output' : 'Jump back to the newest output'}
          className={cx(
            'btn h-8 shrink-0 border border-line bg-surface-2 text-[12px]',
            follow ? 'text-ink-muted' : 'text-ink hover:border-line-strong',
          )}
          onClick={() => {
            setFollow(true);
            if (visible.length > 0) {
              virtualizer.scrollToIndex(visible.length - 1, { align: 'end' });
            }
          }}
        >
          <ArrowDownToLine className={cx('h-3.5 w-3.5', follow && 'text-ok')} />
          {follow ? 'Following' : 'Follow'}
        </button>
      </div>

      <div
        ref={scroller}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto rounded-[var(--radius-card)] border border-line bg-sunken p-3 font-mono text-[12px] leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="text-ink-faint">{search ? 'Nothing matches that.' : emptyMessage}</p>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {rows.map((row) => {
              const line = visible[row.index];
              if (!line) return null;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${row.start}px)`,
                  }}
                  className={cx(
                    'whitespace-pre-wrap break-words',
                    line.stream === 'system' && 'text-accent',
                    line.stream === 'runtime' && 'text-ink-muted',
                  )}
                >
                  {line.line}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
