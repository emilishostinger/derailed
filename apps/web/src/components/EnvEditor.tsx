import type { EnvHistoryEntry, EnvVar } from '@derailed/shared';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

interface Row {
  /** Stable across edits so React keeps each input's DOM node when a row above is removed. */
  id: string;
  key: string;
  value: string;
  revealed: boolean;
}

let rowSeq = 0;
const newRow = (row: Omit<Row, 'id'>): Row => ({ id: `row-${++rowSeq}`, ...row });

/** Parses pasted .env text. The same rules the server uses. */
export function parseDotEnv(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    out.push({ key, value });
  }
  return out;
}

export function EnvEditor({ serviceId, onSaved }: { serviceId: string; onSaved?: () => void }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [linked, setLinked] = useState<EnvVar[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pasting, setPasting] = useState(false);
  const [pasted, setPasted] = useState('');
  /** Set when the project reviews changes: the save is waiting, not applied. */
  const [staged, setStaged] = useState<number | null>(null);
  const [history, setHistory] = useState<EnvHistoryEntry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    endpoints
      .env(serviceId)
      .then((vars) => {
        if (cancelled) return;
        setRows(
          vars
            .filter((entry) => entry.source === 'user')
            .map((entry) => newRow({ key: entry.key, value: entry.value, revealed: false })),
        );
        setLinked(vars.filter((entry) => entry.source !== 'user'));
        setDirty(false);
      })
      .catch(setError)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  function update(index: number, patch: Partial<Row>) {
    setRows((current) => current.map((row, i) => (i === index ? { ...row, ...patch } : row)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const vars = rows
        .filter((row) => row.key.trim())
        .map((row) => ({ key: row.key.trim(), value: row.value }));
      const result = await endpoints.saveEnv(serviceId, vars);
      setDirty(false);
      setStaged(result.staged ? (result.pending ?? 1) : null);
      onSaved?.();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="hint">Loading…</p>;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {rows.map((row, index) => (
          <div key={row.id} className="flex gap-2">
            <input
              className="input text-xs"
              value={row.key}
              placeholder="NAME"
              onChange={(event) => update(index, { key: event.target.value })}
            />
            <input
              className="input text-xs"
              type={row.revealed ? 'text' : 'password'}
              value={row.value}
              placeholder="value"
              onChange={(event) => update(index, { value: event.target.value })}
            />
            <button
              type="button"
              className="btn-ghost shrink-0 px-2"
              onClick={() => update(index, { revealed: !row.revealed })}
            >
              {row.revealed ? 'Hide' : 'Show'}
            </button>
            <button
              type="button"
              className="btn-ghost shrink-0 px-2 text-danger"
              onClick={() => {
                setRows((current) => current.filter((_, i) => i !== index));
                setDirty(true);
              }}
            >
              Remove
            </button>
          </div>
        ))}
        {rows.length === 0 && (
          <p className="hint">
            No variables yet. These are the secrets and settings your app reads at runtime.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            setRows((current) => [...current, newRow({ key: '', value: '', revealed: true })]);
            setDirty(true);
          }}
        >
          Add a variable
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setPasting((current) => !current)}
        >
          Paste a .env file
        </button>
        <button
          type="button"
          className={cx('btn-primary ml-auto', !dirty && 'opacity-50')}
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {saving && <Spinner />}
          Save
        </button>
      </div>

      {pasting && (
        <div className="space-y-2">
          <textarea
            className="input h-32 text-xs"
            placeholder={'DATABASE_URL=postgres://…\nSECRET_KEY=…'}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              const parsed = parseDotEnv(pasted);
              setRows((current) => {
                const merged = new Map(current.map((row) => [row.key, row]));
                for (const entry of parsed) {
                  // Keep the existing row's id when overwriting so its inputs don't remount.
                  const existing = merged.get(entry.key);
                  merged.set(entry.key, {
                    id: existing?.id ?? newRow({ key: '', value: '', revealed: false }).id,
                    key: entry.key,
                    value: entry.value,
                    revealed: false,
                  });
                }
                return [...merged.values()];
              });
              setPasted('');
              setPasting(false);
              setDirty(true);
            }}
          >
            Add these {parseDotEnv(pasted).length || ''} variables
          </button>
        </div>
      )}

      {dirty && (
        <p className="rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft px-3 py-2 text-sm text-ink">
          Save, then redeploy for these to take effect.
        </p>
      )}

      {staged !== null && !dirty && (
        <p className="rounded-[var(--radius-card)] border border-accent/30 bg-accent/10 px-3 py-2 text-sm text-ink">
          Saved for review. This project collects changes: {staged} waiting on the project page,
          applied together when you say so.
        </p>
      )}

      {/* The night after something broke, the question is "what changed and when".
          Keys only, never values: history is where secrets would go to be forgotten
          about. */}
      <div>
        <button
          type="button"
          className="btn-ghost px-0 text-[12px] text-ink-faint"
          onClick={() => {
            if (history !== null) {
              setHistory(null);
              return;
            }
            endpoints
              .envHistory(serviceId)
              .then(setHistory)
              .catch(() => setHistory([]));
          }}
        >
          {history === null ? 'What changed before' : 'Hide the history'}
        </button>
        {history !== null &&
          (history.length === 0 ? (
            <p className="hint mt-1">No saved changes recorded yet.</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {history.map((entry) => (
                <li key={entry.id} className="text-[12px] text-ink-muted">
                  <span className="text-ink-faint">{new Date(entry.at).toLocaleString()}</span>
                  {entry.by ? ` · ${entry.by}` : ''} ·{' '}
                  {entry.changes.map((change) => `${change.key} ${change.change}`).join(', ')}
                </li>
              ))}
            </ul>
          ))}
      </div>

      {/* Shown rather than hidden, because the question this screen answers is "what
          will be set when this runs". A shared variable that is invisible here is one
          somebody sets again by hand and then wonders about. */}
      {linked.length > 0 && (
        <div>
          <p className="eyebrow mb-2">Set for you</p>
          <div className="space-y-1">
            {linked.map((entry) => (
              <div
                key={entry.id}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted"
              >
                <span className="text-accent">{entry.source === 'project' ? '◇' : '⛓'}</span>
                <span className="text-ink">{entry.key}</span>
                <span className="ml-auto">
                  {entry.source === 'project'
                    ? 'shared by this project'
                    : 'from a connected service'}
                </span>
              </div>
            ))}
          </div>
          {linked.some((entry) => entry.source === 'project') && (
            // The escape hatch, said out loud. Otherwise the only way people find it
            // is by trying it and being surprised that it worked.
            <p className="mt-2 text-[12px] text-ink-faint">
              Adding one above with the same name overrides it for this app only.
            </p>
          )}
        </div>
      )}

      <ErrorNote error={error} />
    </div>
  );
}
