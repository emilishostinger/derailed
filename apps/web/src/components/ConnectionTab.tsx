import type { Service } from '@derailed/shared';
import { AlertTriangle, Database, Eye, EyeOff, Link2, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { CopyButton, cx, ErrorNote, Spinner } from './ui.tsx';

interface Connection {
  host: string;
  port: number;
  user: string;
  password: string;
  dbName: string;
  url: string;
  exposedPort: number | null;
}

/**
 * Databases show their credentials here. Apps show which databases they can reach.
 * Both sides of a connection are visible from either end, because "what can talk to
 * what" is the question people actually have.
 */
export function ConnectionTab({ service }: { service: Service }) {
  return service.kind === 'database' ? (
    <DatabaseConnection service={service} />
  ) : (
    <AppConnections service={service} />
  );
}

function DatabaseConnection({ service }: { service: Service }) {
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const load = useProjects((s) => s.load);

  const project = useProjects((s) => s.projects.find((entry) => entry.id === service.projectId));
  const consumers = (project?.links ?? [])
    .filter((link) => link.toServiceId === service.id)
    .map((link) => ({
      link,
      app: (project?.services ?? []).find((entry) => entry.id === link.fromServiceId),
    }));

  useEffect(() => {
    let cancelled = false;
    endpoints
      .connection(service.id)
      .then((result) => !cancelled && setConnection(result.connection))
      .catch((err) => !cancelled && setError(err));
    return () => {
      cancelled = true;
    };
  }, [service.id]);

  async function setExposed(exposed: boolean) {
    setBusy(true);
    setError(null);
    try {
      await endpoints.setExposed(service.id, exposed);
      const result = await endpoints.connection(service.id);
      setConnection(result.connection);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (error) return <ErrorNote error={error} />;
  if (!connection) {
    return (
      <p className="hint flex items-center gap-2">
        <Spinner />
        Reading the connection details…
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow mb-2">Connection details</p>
        <div className="card divide-y divide-line">
          <Row label="Host" value={connection.host} />
          <Row label="Port" value={String(connection.port)} />
          <Row label="Database" value={connection.dbName} />
          <Row label="User" value={connection.user} />
          <Row
            label="Password"
            value={connection.password}
            secret
            revealed={revealed}
            onReveal={() => setRevealed((value) => !value)}
          />
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-muted">
            {revealed ? connection.url : connection.url.replace(connection.password, '••••••••')}
          </code>
          <CopyButton value={connection.url} label="URL" />
        </div>
        <p className="mt-2 text-[12px] text-ink-faint">
          Apps in this project reach it at <span className="font-mono">{connection.host}</span>.
          Connect one below and Derailed sets this up as an environment variable for you.
        </p>
      </section>

      <section>
        <p className="eyebrow mb-2">Used by</p>
        {consumers.length === 0 ? (
          <p className="hint">
            Nothing is connected yet. Open an app and connect it, or drag a line on the canvas.
          </p>
        ) : (
          <div className="space-y-1.5">
            {consumers.map(({ link, app }) => (
              <div
                key={link.id}
                className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-[13px]"
              >
                <Link2 className="h-3.5 w-3.5 shrink-0 text-accent" />
                <span className="min-w-0 flex-1 truncate text-ink">{app?.name ?? 'An app'}</span>
                <button
                  type="button"
                  className="btn-ghost px-1.5 text-[12px] text-danger"
                  onClick={async () => {
                    await endpoints.deleteLink(link.id).catch(() => undefined);
                    await load();
                  }}
                >
                  <Unlink className="h-3.5 w-3.5" />
                  Disconnect
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <p className="eyebrow mb-2">Reaching it from your own machine</p>
        {connection.exposedPort ? (
          <div className="rounded-[var(--radius-card)] border border-warn/30 bg-warn-soft p-4">
            <p className="flex items-center gap-2 text-[13px] font-medium text-ink">
              <AlertTriangle className="h-4 w-4 text-warn" />
              This database is open to the internet
            </p>
            <p className="mt-1.5 text-[12px] text-ink-muted">
              Anyone who finds port{' '}
              <span className="font-mono text-ink">{connection.exposedPort}</span> can try to log
              in. Turn this off when you're done.
            </p>
            <button
              type="button"
              className="btn-secondary mt-3"
              disabled={busy}
              onClick={() => void setExposed(false)}
            >
              {busy && <Spinner />}
              Close it off again
            </button>
          </div>
        ) : (
          <div className="card p-4">
            <p className="text-[13px] text-ink">Only apps in this project can reach it.</p>
            <p className="mt-1.5 text-[12px] text-ink-muted">
              That's the safe default. You can open a port if you need to connect with a database
              tool from your laptop. But anyone on the internet can then try to log in too.
            </p>
            <button
              type="button"
              className="btn-secondary mt-3"
              disabled={busy}
              onClick={() => void setExposed(true)}
            >
              {busy && <Spinner />}
              Open a port anyway
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function AppConnections({ service }: { service: Service }) {
  const load = useProjects((s) => s.load);
  const project = useProjects((s) => s.projects.find((entry) => entry.id === service.projectId));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [discrete, setDiscrete] = useState(false);

  const services = project?.services ?? [];
  const links = (project?.links ?? []).filter((link) => link.fromServiceId === service.id);
  const linkedIds = new Set(links.map((link) => link.toServiceId));
  const available = services.filter(
    (entry) => entry.kind === 'database' && !linkedIds.has(entry.id),
  );

  async function connect(databaseId: string) {
    setBusy(databaseId);
    setError(null);
    try {
      await endpoints.createLink(service.id, databaseId, undefined, discrete);
      await load();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <p className="eyebrow mb-2">Connected databases</p>
        {links.length === 0 ? (
          <p className="hint">
            {service.name} isn't connected to anything yet.
            {available.length > 0 && ' Pick one below.'}
          </p>
        ) : (
          <div className="space-y-1.5">
            {links.map((link) => {
              const database = services.find((entry) => entry.id === link.toServiceId);
              return (
                <div
                  key={link.id}
                  className="flex items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface-2 px-3 py-2 text-[13px]"
                >
                  <Database className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1 truncate text-ink">
                    {database?.name ?? 'A database'}
                  </span>
                  <code className="shrink-0 font-mono text-[11px] text-accent">
                    {link.injectAs ?? 'DATABASE_URL'}
                  </code>
                  <button
                    type="button"
                    className="btn-ghost px-1.5 text-[12px] text-danger"
                    onClick={async () => {
                      await endpoints.deleteLink(link.id).catch(() => undefined);
                      await load();
                    }}
                  >
                    <Unlink className="h-3.5 w-3.5" />
                  </button>
                </div>
              );
            })}
            <p className="pt-1 text-[12px] text-ink-faint">
              Each connection adds an environment variable. Redeploy for changes to take effect.
            </p>
          </div>
        )}
      </section>

      {available.length > 0 && (
        <section>
          <p className="eyebrow mb-2">Connect a database</p>
          <label className="mb-2 flex items-start gap-2 text-[12px] text-ink-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={discrete}
              onChange={(event) => setDiscrete(event.target.checked)}
            />
            <span>
              Also set separate host, port, name, user and password variables.
              <span className="block text-ink-faint">
                Some apps (WordPress among them) don't read a single connection URL.
              </span>
            </span>
          </label>
          <div className="space-y-1.5">
            {available.map((database) => (
              <button
                key={database.id}
                type="button"
                disabled={busy !== null}
                onClick={() => void connect(database.id)}
                className={cx(
                  'flex w-full items-center gap-2 rounded-[var(--radius-control)] border border-line',
                  'bg-surface px-3 py-2 text-left text-[13px] transition-colors',
                  'hover:border-line-strong hover:bg-surface-2 disabled:opacity-50',
                )}
              >
                <Database className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1 truncate text-ink">{database.name}</span>
                <span className="shrink-0 text-[12px] text-ink-faint">
                  {database.dbEngine} {database.dbVersion}
                </span>
                {busy === database.id ? (
                  <Spinner />
                ) : (
                  <Link2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
                )}
              </button>
            ))}
          </div>
        </section>
      )}

      <ErrorNote error={error} />
    </div>
  );
}

function Row({
  label,
  value,
  secret,
  revealed,
  onReveal,
}: {
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  onReveal?: () => void;
}) {
  const shown = secret && !revealed ? '••••••••••••' : value;
  return (
    <div className="flex items-center gap-2 px-3 py-2">
      <span className="w-20 shrink-0 text-[12px] text-ink-faint">{label}</span>
      <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink">{shown}</code>
      {secret && (
        <button type="button" className="btn-ghost px-1.5" onClick={onReveal}>
          {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
      )}
      <CopyButton value={value} label={label} />
    </div>
  );
}
