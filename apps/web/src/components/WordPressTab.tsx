import type { Service } from '@derailed/shared';
import { ArrowUpRight, Copy, KeyRound, RefreshCw, Rocket } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * WordPress superpowers: four buttons on an app that already exists.
 *
 * Sign in without a password, update behind the backup-first promise, a staging
 * copy, and push-to-live. Each button says what it will actually do, because the
 * push in particular is a restore in a party hat and should read like one.
 */
export function WordPressTab({ service }: { service: Service }) {
  const load = useProjects((s) => s.load);
  const push = useToasts((s) => s.push);
  const [staging, setStaging] = useState<{ id: string; name: string } | null>(null);
  const [updates, setUpdates] = useState<{
    core: { current: string; available: string | null };
    plugins: { name: string; version: string; available: string }[];
    themes: { name: string; version: string; available: string }[];
  } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .wordPressState(service.id)
      .then((state) => setStaging(state.staging))
      .catch(() => undefined);
  }, [service.id]);

  async function act(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  const waiting =
    (updates?.plugins.length ?? 0) +
    (updates?.themes.length ?? 0) +
    (updates?.core.available ? 1 : 0);

  return (
    <div className="space-y-4">
      <div className="card flex items-center gap-3 p-4">
        <KeyRound className="h-4 w-4 shrink-0 text-ink-faint" />
        <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
          Open wp-admin signed in as the site's administrator. The link works once and dies in five
          minutes.
        </p>
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={busy !== null}
          onClick={() =>
            void act('login', async () => {
              const { url } = await endpoints.wordPressLogin(service.id);
              window.open(url, '_blank', 'noopener');
            })
          }
        >
          {busy === 'login' ? <Spinner /> : <ArrowUpRight className="h-3.5 w-3.5" />}
          Sign in to wp-admin
        </button>
      </div>

      <div className="card p-4">
        <div className="flex items-center gap-3">
          <RefreshCw className="h-4 w-4 shrink-0 text-ink-faint" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
            {updates === null
              ? 'Plugin, theme and core updates, applied behind a backup of the whole project.'
              : waiting === 0
                ? 'Everything is up to date.'
                : `${waiting} update${waiting === 1 ? '' : 's'} waiting.`}
          </p>
          {updates === null ? (
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={busy !== null}
              onClick={() =>
                void act('check', async () => {
                  const { updates: found } = await endpoints.wordPressUpdates(service.id);
                  setUpdates(found);
                })
              }
            >
              {busy === 'check' && <Spinner />}
              Check for updates
            </button>
          ) : (
            waiting > 0 && (
              <button
                type="button"
                className="btn-primary shrink-0"
                disabled={busy !== null}
                onClick={() =>
                  void act('update', async () => {
                    const result = await endpoints.wordPressUpdate(service.id, 'all');
                    push({ message: `Updated. ${result.report}`, tone: 'ok' });
                    setUpdates(null);
                  })
                }
              >
                {busy === 'update' && <Spinner />}
                Update everything, backed up first
              </button>
            )
          )}
        </div>
        {updates !== null && waiting > 0 && (
          <ul className="mt-3 space-y-1 border-t border-line pt-3">
            {updates.core.available && (
              <li className="text-[12px] text-ink-muted">
                WordPress itself: {updates.core.current} to {updates.core.available}
              </li>
            )}
            {[...updates.plugins, ...updates.themes].map((item) => (
              <li key={item.name} className="text-[12px] text-ink-muted">
                {item.name}: {item.version} to {item.available}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-4">
        <div className="flex items-center gap-3">
          <Copy className="h-4 w-4 shrink-0 text-ink-faint" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
            {staging
              ? `${staging.name} is running, with its own copy of the database and files.`
              : 'A staging copy: the same site with its own copy of the database and files, on its own address, for trying things where breaking them is free.'}
          </p>
          {staging === null ? (
            <button
              type="button"
              className="btn-secondary shrink-0"
              disabled={busy !== null}
              onClick={() =>
                void act('staging', async () => {
                  const made = await endpoints.wordPressStaging(service.id);
                  setStaging({ id: made.staging.id, name: made.staging.name });
                  await load();
                  push({ message: 'Staging copy is up.', tone: 'ok' });
                })
              }
            >
              {busy === 'staging' ? <Spinner /> : <Copy className="h-3.5 w-3.5" />}
              Create a staging copy
            </button>
          ) : (
            <button
              type="button"
              className="btn-primary shrink-0"
              disabled={busy !== null}
              title="Backs up the whole project first, then writes staging's database and files over the live site's"
              onClick={() =>
                void act('push', async () => {
                  await endpoints.wordPressPush(service.id);
                  await load();
                  push({
                    message: 'Pushed to live. The backup taken first is on the Backups page.',
                    tone: 'ok',
                  });
                })
              }
            >
              {busy === 'push' ? <Spinner /> : <Rocket className="h-3.5 w-3.5" />}
              Push staging to live
            </button>
          )}
        </div>
        {staging && (
          <p className="mt-2 text-[12px] text-ink-faint">
            Pushing backs the whole project up first, then staging's database and files become the
            live site's, links rewritten. Delete the staging app like any other when you are done.
          </p>
        )}
      </div>
      {busy === 'staging' && (
        <p className="text-[12px] text-ink-faint">
          Copying the database and files and starting the copy. This takes a minute or two.
        </p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
