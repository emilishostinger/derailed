import type {
  BrowseKind,
  KeyEntry,
  KeyValue,
  QueryResult,
  SavedQuery,
  Service,
  TableSummary,
} from '@derailed/shared';
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Key,
  Play,
  Search,
  Table2,
  Trash2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useToasts } from '../stores/toasts.ts';
import { cx, ErrorNote, Modal, Spinner } from './ui.tsx';

/**
 * Looking inside a database.
 *
 * Databases were one click to create and then a black box for ever, which left "is my
 * data actually in there?" answerable only by installing a client and remembering a
 * connection string. That was the last real reason to open a terminal.
 *
 * One screen for six engines. Three of them keep rows, one keeps documents and two
 * keep keys, and pretending those are the same thing produces a screen that is wrong
 * for all of them. So the questions are the same and the shape of the answer changes:
 * a grid of rows you can edit, a list of documents you open as JSON, a key browser.
 */
export function BrowseTab({ service }: { service: Service }) {
  const [kind, setKind] = useState<BrowseKind | null>(null);
  const [tables, setTables] = useState<TableSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    setTables(null);
    setSelected(null);
    endpoints
      .tables(service.id)
      .then((result) => {
        setKind(result.kind);
        setTables(result.tables);
        if (result.tables[0]) setSelected(result.tables[0].name);
      })
      .catch((err) => {
        setError(err);
        setTables([]);
      });
  }, [service.id]);

  if (tables === null) return <Spinner />;

  return (
    <div className="space-y-4">
      <ErrorNote error={error} />

      {kind === 'keys' ? (
        <KeyBrowser service={service} />
      ) : tables.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          {kind === 'documents'
            ? 'This database has no collections yet. Once your app has created some, they will be here.'
            : 'This database has no tables yet. Once your app has created some, they will be here.'}
        </p>
      ) : (
        <>
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
          {selected && <TableView service={service} table={selected} kind={kind ?? 'sql'} />}
        </>
      )}

      <QueryBox service={service} kind={kind ?? 'sql'} />
    </div>
  );
}

const PAGE = 50;

/** One table or collection, a page at a time. */
function TableView({
  service,
  table,
  kind,
}: {
  service: Service;
  table: string;
  kind: BrowseKind;
}) {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [document, setDocument] = useState<string | null>(null);

  const load = useCallback(
    (at: number) => {
      setBusy(true);
      setError(null);
      endpoints
        .readTable(service.id, table, PAGE, at)
        .then(setResult)
        .catch(setError)
        .finally(() => setBusy(false));
    },
    [service.id, table],
  );

  // A new table starts at its beginning, not at whatever page the last one was on.
  useEffect(() => {
    setOffset(0);
    load(0);
  }, [load]);

  const total = result?.total ?? null;
  const shown = result?.rows.length ?? 0;
  const hasMore = total !== null ? offset + shown < total : shown >= PAGE;

  const go = (at: number) => {
    setOffset(at);
    load(at);
  };

  return (
    <div className="space-y-2">
      <ErrorNote error={error} />
      {busy && !result ? (
        <Spinner />
      ) : (
        result && (
          <Rows
            result={result}
            onEdit={
              result.readOnly
                ? undefined
                : (key, column, value) =>
                    endpoints
                      .updateCell(service.id, table, key, column, value)
                      .then(() => load(offset))
            }
            onOpen={kind === 'documents' ? (id) => setDocument(id) : undefined}
          />
        )
      )}

      {result && (shown > 0 || offset > 0) && (
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-ghost"
            disabled={offset === 0 || busy}
            onClick={() => go(Math.max(0, offset - PAGE))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <button
            type="button"
            className="btn-ghost"
            disabled={!hasMore || busy}
            onClick={() => go(offset + PAGE)}
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <p className="text-[12px] text-ink-faint tabular">
            {shown === 0
              ? 'Nothing on this page'
              : `${offset + 1} to ${offset + shown}${total === null ? '' : ` of ${total}`}`}
          </p>
          {busy && <Spinner />}
        </div>
      )}

      {result?.readOnlyReason && (
        <p className="text-[12px] text-ink-faint">{result.readOnlyReason}</p>
      )}

      {document && (
        <DocumentEditor
          service={service}
          collection={table}
          documentId={document}
          onClose={() => setDocument(null)}
          onSaved={() => {
            setDocument(null);
            load(offset);
          }}
        />
      )}
    </div>
  );
}

/**
 * The grid.
 *
 * A cell is a button rather than an always-live input. A table of two hundred live
 * inputs is a page that scrolls badly and a row that can be changed by a stray click,
 * and the common case here is reading rather than editing.
 */
function Rows({
  result,
  onEdit,
  onOpen,
}: {
  result: QueryResult;
  onEdit?: (
    key: Record<string, string | null>,
    column: string,
    value: string | null,
  ) => Promise<unknown>;
  onOpen?: (id: string) => void;
}) {
  const [editing, setEditing] = useState<{ row: number; column: number } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  if (result.columns.length === 0) {
    return <p className="text-[13px] text-ink-faint">Nothing came back. It is empty.</p>;
  }

  const keyFor = (row: (string | null)[]): Record<string, string | null> => {
    const key: Record<string, string | null> = {};
    for (const column of result.primaryKey ?? []) {
      key[column] = row[result.columns.indexOf(column)] ?? null;
    }
    return key;
  };

  const commit = (rowIndex: number, columnIndex: number, value: string | null) => {
    const row = result.rows[rowIndex];
    const column = result.columns[columnIndex];
    if (!onEdit || !row || !column) return;

    setSaving(true);
    setError(null);
    onEdit(keyFor(row), column, value)
      .then(() => {
        push({ message: 'Saved.', tone: 'ok' });
        setEditing(null);
      })
      .catch(setError)
      .finally(() => setSaving(false));
  };

  return (
    <div>
      <ErrorNote error={error} />
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
                  {(result.primaryKey ?? []).includes(column) && !result.readOnly && (
                    <span className="ml-1 text-ink-faint" title="Identifies the row">
                      key
                    </span>
                  )}
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
                {row.map((cell, cellIndex) => {
                  const isEditing = editing?.row === rowIndex && editing.column === cellIndex;
                  const isId = onOpen && result.columns[cellIndex] === '_id';

                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: see above
                    <td key={cellIndex} className="max-w-xs px-0 py-0 text-ink-muted">
                      {isEditing ? (
                        <input
                          // Focused because it replaced the cell the pointer is already on.
                          autoFocus
                          className="w-full bg-elevated px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none"
                          value={draft}
                          disabled={saving}
                          onChange={(event) => setDraft(event.target.value)}
                          onBlur={() => setEditing(null)}
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') setEditing(null);
                            if (event.key === 'Enter') commit(rowIndex, cellIndex, draft);
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          disabled={!onEdit && !isId}
                          className={cx(
                            'block w-full truncate px-2.5 py-1.5 text-left',
                            (onEdit || isId) && 'hover:bg-surface-2',
                            isId && 'text-accent underline underline-offset-2',
                          )}
                          onClick={() => {
                            if (isId) {
                              onOpen?.(cell ?? '');
                              return;
                            }
                            if (!onEdit) return;
                            setDraft(cell ?? '');
                            setEditing({ row: rowIndex, column: cellIndex });
                          }}
                        >
                          {cell === null ? (
                            // A null is not an empty string, and the difference is
                            // usually the thing somebody opened this screen to check.
                            <span className="text-ink-faint italic">null</span>
                          ) : cell === '' ? (
                            <span className="text-ink-faint">empty</span>
                          ) : (
                            cell
                          )}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && onEdit && (
        <p className="mt-1.5 text-[12px] text-ink-faint">
          Enter to save, Escape to leave it alone.
          <button
            type="button"
            className="ml-2 underline underline-offset-2"
            onMouseDown={(event) => {
              // `mousedown`, because the input's own blur would close this first.
              event.preventDefault();
              commit(editing.row, editing.column, null);
            }}
          >
            Set to null
          </button>
        </p>
      )}
    </div>
  );
}

/** One MongoDB document, as the JSON somebody would edit. */
function DocumentEditor({
  service,
  collection,
  documentId,
  onClose,
  onSaved,
}: {
  service: Service;
  collection: string;
  documentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints.readDocument(service.id, collection, documentId).then(setJson).catch(setError);
  }, [collection, documentId, service.id]);

  return (
    <Modal
      title="This document"
      subtitle="Edited whole. A field you remove here really goes."
      wide
      onClose={onClose}
    >
      <div className="space-y-3">
        {json === null ? (
          <Spinner />
        ) : (
          <textarea
            className="input h-80 font-mono text-[12px]"
            value={json}
            onChange={(event) => setJson(event.target.value)}
          />
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || json === null}
            onClick={() => {
              setBusy(true);
              setError(null);
              endpoints
                .saveDocument(service.id, collection, documentId, json ?? '')
                .then(() => {
                  push({ message: 'Saved.', tone: 'ok' });
                  onSaved();
                })
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            {busy && <Spinner />}
            Save it
          </button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Keys, for Redis and Valkey.
 *
 * Paged by cursor rather than by page number, because that is what `SCAN` gives.
 * The alternative is `KEYS *`, which blocks the server for as long as it takes to
 * walk every key, and a screen whose purpose is looking should not be able to take a
 * site down.
 */
function KeyBrowser({ service }: { service: Service }) {
  const [pattern, setPattern] = useState('*');
  const [applied, setApplied] = useState('*');
  const [keys, setKeys] = useState<KeyEntry[] | null>(null);
  const [cursors, setCursors] = useState<string[]>(['0']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(
    (match: string, cursor: string, trail: string[]) => {
      setBusy(true);
      setError(null);
      endpoints
        .browseKeys(service.id, match, cursor)
        .then((page) => {
          setKeys(page.keys);
          setCursors(trail.concat(page.cursor ?? ''));
        })
        .catch(setError)
        .finally(() => setBusy(false));
    },
    [service.id],
  );

  useEffect(() => {
    load('*', '0', ['0']);
  }, [load]);

  const next = cursors[cursors.length - 1] ?? '';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 text-ink-faint" />
          <input
            className="input pl-8 font-mono text-[12px]"
            value={pattern}
            placeholder="session:*"
            onChange={(event) => setPattern(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              setApplied(pattern);
              load(pattern, '0', ['0']);
            }}
          />
        </div>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            setApplied(pattern);
            load(pattern, '0', ['0']);
          }}
        >
          {busy ? <Spinner /> : <Search className="h-3.5 w-3.5" />}
          Find
        </button>
      </div>

      <ErrorNote error={error} />

      {keys === null ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          Nothing matched {applied === '*' ? 'yet' : applied}.{' '}
          {next && 'There is more to look through, so try Next.'}
        </p>
      ) : (
        <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
          {keys.map((entry) => (
            <li key={entry.name}>
              <button
                type="button"
                className="flex w-full items-center gap-2.5 px-3 py-2 text-left hover:bg-surface-2"
                onClick={() => setOpen(entry.name)}
              >
                <Key className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">
                  {entry.name}
                </span>
                <span className="shrink-0 text-[12px] text-ink-faint">{entry.type}</span>
                {entry.expiresIn !== null && (
                  <span className="shrink-0 text-[12px] text-ink-faint tabular">
                    {formatTtl(entry.expiresIn)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-ghost"
          disabled={!next || busy}
          onClick={() => load(applied, next, cursors)}
        >
          Next
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <p className="text-[12px] text-ink-faint">
          {next
            ? 'Keys are walked a slice at a time, so a page can be short and still have more after it.'
            : 'That is all of them.'}
        </p>
      </div>

      {open && (
        <KeyEditor
          service={service}
          name={open}
          onClose={() => setOpen(null)}
          onChanged={() => {
            setOpen(null);
            load(applied, cursors[cursors.length - 2] ?? '0', cursors.slice(0, -1));
          }}
        />
      )}
    </div>
  );
}

function formatTtl(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function KeyEditor({
  service,
  name,
  onClose,
  onChanged,
}: {
  service: Service;
  name: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [value, setValue] = useState<KeyValue | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .readKey(service.id, name)
      .then((result) => {
        setValue(result);
        setDraft(result.entries[0]?.value ?? '');
      })
      .catch(setError);
  }, [name, service.id]);

  return (
    <Modal
      title={name}
      subtitle={
        value
          ? `${value.type}${value.expiresIn === null ? ', no expiry' : `, expires in ${formatTtl(value.expiresIn)}`}`
          : undefined
      }
      wide
      onClose={onClose}
    >
      <div className="space-y-3">
        {value === null ? (
          <Spinner />
        ) : value.editable ? (
          <textarea
            className="input h-48 font-mono text-[12px]"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
        ) : (
          <>
            <div className="max-h-80 overflow-y-auto rounded-[var(--radius-control)] border border-line">
              <table className="w-full border-collapse text-[12px]">
                <tbody>
                  {value.entries.map((entry, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity here.
                    <tr key={index} className="border-b border-line last:border-0">
                      {entry.field !== null && (
                        <td className="whitespace-nowrap px-2.5 py-1.5 font-mono text-ink">
                          {entry.field}
                        </td>
                      )}
                      <td className="px-2.5 py-1.5 font-mono text-ink-muted">{entry.value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-ink-faint">
              A {value.type} is shown but not edited here. Editing one member through a text box is
              a way to lose its position or its score. The Terminal tab has the full client.
            </p>
            {value.truncated && (
              <p className="text-[12px] text-ink-faint">Only the first part is shown.</p>
            )}
          </>
        )}

        <ErrorNote error={error} />

        <div className="flex justify-between gap-2">
          <button
            type="button"
            className="btn-ghost text-danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              endpoints
                .deleteKey(service.id, name)
                .then(() => {
                  push({ message: `${name} deleted.`, tone: 'ok' });
                  onChanged();
                })
                .catch(setError)
                .finally(() => setBusy(false));
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
            Delete it
          </button>
          <div className="flex gap-2">
            <button type="button" className="btn-ghost" onClick={onClose}>
              Close
            </button>
            {value?.editable && (
              <button
                type="button"
                className="btn-primary"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError(null);
                  endpoints
                    .saveKey(service.id, name, draft)
                    .then(() => {
                      push({ message: 'Saved.', tone: 'ok' });
                      onChanged();
                    })
                    .catch(setError)
                    .finally(() => setBusy(false));
                }}
              >
                {busy && <Spinner />}
                Save it
              </button>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

const PLACEHOLDERS: Record<BrowseKind, string> = {
  sql: 'select count(*) from users',
  documents: 'db.users.find({ active: true })',
  keys: 'hgetall session:abc',
};

const RULES: Record<BrowseKind, string> = {
  sql: 'Only questions that read. Use the Terminal tab to change anything.',
  documents: 'Only expressions that read. Use the Terminal tab to change anything.',
  keys: 'Only commands that read. Use the Terminal tab to change anything.',
};

/**
 * The query box, and the queries worth keeping.
 *
 * A box you type into and then lose is a box people stop using. The query somebody
 * actually wants is the same three every time, and retyping them from memory is the
 * reason they give up and install a client instead.
 */
function QueryBox({ service, kind }: { service: Service; kind: BrowseKind }) {
  const [body, setBody] = useState('');
  const [result, setResult] = useState<QueryResult | null>(null);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .savedQueries(service.id)
      .then(setSaved)
      .catch(() => setSaved([]));
  }, [service.id]);

  const run = () => {
    setBusy(true);
    setError(null);
    endpoints
      .runQuery(service.id, body)
      .then(setResult)
      .catch(setError)
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-2 border-t border-line pt-4">
      <p className="eyebrow mb-2">Ask a question</p>

      {saved.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {saved.map((query) => (
            <span
              key={query.id}
              className="flex items-center gap-1 rounded-[var(--radius-control)] border border-line py-1 pr-1 pl-2.5 text-[12px] text-ink-muted"
            >
              <button
                type="button"
                className="max-w-48 truncate"
                onClick={() => setBody(query.body)}
              >
                {query.name}
              </button>
              <button
                type="button"
                aria-label={`Forget ${query.name}`}
                className="rounded-[4px] p-0.5 text-ink-faint hover:bg-surface-2 hover:text-ink"
                onClick={() => {
                  endpoints
                    .deleteSavedQuery(service.id, query.id)
                    .then(() => setSaved((current) => current.filter((q) => q.id !== query.id)))
                    .catch(setError);
                }}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        className="input h-20 font-mono text-[12px]"
        value={body}
        placeholder={PLACEHOLDERS[kind]}
        onChange={(event) => setBody(event.target.value)}
      />

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={busy || !body.trim()}
          onClick={run}
        >
          {busy ? <Spinner /> : <Play className="h-3.5 w-3.5" />}
          Run it
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={!body.trim()}
          onClick={() => {
            setName('');
            setNaming(true);
          }}
        >
          <Bookmark className="h-3.5 w-3.5" />
          Keep it
        </button>
        {/* Said before it is discovered, not after a refusal. */}
        <span className="text-[12px] text-ink-faint">{RULES[kind]}</span>
      </div>

      <ErrorNote error={error} />
      {result && <Rows result={result} />}

      {naming && (
        <Modal
          title="Keep this query"
          subtitle="Kept against this database, so whoever looks after it next finds it too."
          onClose={() => setNaming(false)}
        >
          <div className="space-y-3">
            {/* The only field in a modal that was opened in order to fill it in. */}
            <input
              autoFocus
              className="input text-[13px]"
              value={name}
              placeholder="Orders stuck in pending"
              onChange={(event) => setName(event.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button type="button" className="btn-ghost" onClick={() => setNaming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={!name.trim()}
                onClick={() => {
                  endpoints
                    .saveNamedQuery(service.id, name.trim(), body)
                    .then((query) => {
                      setSaved((current) => [
                        ...current.filter((entry) => entry.name !== query.name),
                        query,
                      ]);
                      push({ message: 'Kept.', tone: 'ok' });
                      setNaming(false);
                    })
                    .catch(setError);
                }}
              >
                Keep it
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
