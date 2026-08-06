import type { QueryResult, Service, TableSummary } from '@derailed/shared';
import { Play, Table2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

/**
 * Looking inside a database.
 *
 * Databases were one click to create and then a black box for ever, which left "is my
 * data actually in there?" answerable only by installing a client and remembering a
 * connection string. That was the last real reason to open a terminal.
 */
export function BrowseTab({ service }: { service: Service }) {
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [sql, setSql] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .tables(service.id)
      .then((list) => {
        setTables(list);
        if (list[0]) setSelected(list[0].name);
      })
      .catch((err) => {
        setError(err);
        setTables([]);
      });
  }, [service.id]);

  useEffect(() => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    endpoints
      .readTable(service.id, selected)
      .then(setResult)
      .catch(setError)
      .finally(() => setBusy(false));
  }, [service.id, selected]);

  if (tables === null) return <Spinner />;

  return (
    <div className="space-y-4">
      {tables.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          This database has no tables yet. Once your app has created some, they will be here.
        </p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {tables.map((table) => (
            <button
              key={table.name}
              type="button"
              className={cx(
                'flex items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 py-1 text-[12px]',
                selected === table.name
                  ? 'border-accent bg-accent/10 text-ink'
                  : 'border-line text-ink-muted',
              )}
              onClick={() => setSelected(table.name)}
            >
              <Table2 className="h-3 w-3" />
              {table.name}
              {table.approximateRows > 0 && (
                <span className="text-ink-faint">~{table.approximateRows}</span>
              )}
            </button>
          ))}
        </div>
      )}

      <ErrorNote error={error} />

      {busy ? <Spinner /> : result && <Rows result={result} />}

      <div className="border-t border-line pt-4">
        <p className="eyebrow mb-2">Ask a question</p>
        <textarea
          className="input h-20 font-mono text-[12px]"
          value={sql}
          placeholder="select count(*) from users"
          onChange={(event) => setSql(event.target.value)}
        />
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary"
            disabled={busy || !sql.trim()}
            onClick={() => {
              setBusy(true);
              setError(null);
              endpoints
                .runQuery(service.id, sql)
                .then(setResult)
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            <Play className="h-3.5 w-3.5" />
            Run it
          </button>
          {/* Said before it is discovered, not after a refusal. */}
          <span className="text-[12px] text-ink-faint">
            Only questions that read. Use the Terminal tab to change anything.
          </span>
        </div>
      </div>
    </div>
  );
}

function Rows({ result }: { result: QueryResult }) {
  if (result.columns.length === 0) {
    return <p className="text-[13px] text-ink-faint">Nothing came back. The table is empty.</p>;
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-[var(--radius-control)] border border-line">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr className="bg-surface-2">
              {result.columns.map((column) => (
                <th
                  key={column}
                  className="whitespace-nowrap border-b border-line px-2.5 py-1.5 text-left font-medium text-ink"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, rowIndex) => (
              // Row order is the only identity a result set has; a cell value could
              // repeat and would make a worse key.
              // biome-ignore lint/suspicious/noArrayIndexKey: see above
              <tr key={rowIndex} className="border-b border-line last:border-0">
                {row.map((cell, cellIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: see above
                  <td key={cellIndex} className="max-w-xs truncate px-2.5 py-1.5 text-ink-muted">
                    {cell === '' ? <span className="text-ink-faint">empty</span> : cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-1.5 text-[12px] text-ink-faint">
        {result.rows.length} row{result.rows.length === 1 ? '' : 's'}
        {result.truncated && ', and there are more'}
      </p>
    </div>
  );
}
