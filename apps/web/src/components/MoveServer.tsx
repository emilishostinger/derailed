import { Download, Upload } from 'lucide-react';
import { useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * Taking everything to another machine.
 *
 * People hesitate to commit to a tool that makes their setup unportable, and the
 * hesitation is reasonable. This is the answer to "what if this project dies", and
 * being able to say it out loud is most of its value.
 */
export function MoveServer() {
  const [busy, setBusy] = useState<string | null>(null);
  const [made, setMade] = useState<{ file: string; sizeBytes: number } | null>(null);
  const [result, setResult] = useState<Awaited<ReturnType<typeof endpoints.importInstall>> | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);

  return (
    <div className="space-y-4">
      <section>
        <p className="mb-2.5 text-[13px] text-ink-muted">
          One file with everything: your projects, apps, databases, storage, domains, and an
          ordinary backup of each project. It opens with <code className="text-ink">tar</code>, so
          it is worth having whether or not you ever move.
        </p>

        {made ? (
          <div className="rounded-[var(--radius-card)] border border-ok/30 bg-ok-soft p-3.5">
            <p className="text-[13px] text-ink">
              Made <span className="text-ink-muted">{made.file}</span>,{' '}
              {formatBytes(made.sizeBytes)}. It is on the Backups page to download.
            </p>
          </div>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy !== null}
            onClick={async () => {
              setBusy('export');
              setError(null);
              try {
                setMade(await endpoints.exportInstall());
              } catch (err) {
                setError(err);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'export' ? <Spinner /> : <Download className="h-3.5 w-3.5" />}
            Make the file
          </button>
        )}
      </section>

      <section className="border-t border-line pt-4">
        <p className="eyebrow mb-2">Moving in</p>
        <p className="mb-2.5 text-[13px] text-ink-muted">
          On a new server, upload the <code className="text-ink">derailed.json</code> from inside
          that file. Everything is recreated, and nothing is started: you deploy each app when you
          are ready.
        </p>

        <label className="btn-secondary inline-flex cursor-pointer">
          <Upload className="h-3.5 w-3.5" />
          {busy === 'import' ? 'Reading…' : 'Choose the file'}
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setBusy('import');
              setError(null);
              try {
                setResult(await endpoints.importInstall(JSON.parse(await file.text())));
              } catch (err) {
                setError(err);
              } finally {
                setBusy(null);
              }
            }}
          />
        </label>

        {result && (
          <div className="mt-3 space-y-2 rounded-[var(--radius-card)] border border-line p-3.5">
            <p className="text-[13px] text-ink">
              Brought in {result.projects} project{result.projects === 1 ? '' : 's'},{' '}
              {result.services} app{result.services === 1 ? '' : 's'} and databases, and{' '}
              {result.domains} address{result.domains === 1 ? '' : 'es'}.
            </p>
            {result.afterwards.length > 0 && (
              <>
                <p className="eyebrow">Still to do</p>
                <ul className="space-y-1">
                  {result.afterwards.map((line) => (
                    <li key={line} className="text-[12px] text-ink-muted">
                      {line}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.warnings.map((line) => (
              <p key={line} className="text-[12px] text-warn">
                {line}
              </p>
            ))}
          </div>
        )}
      </section>

      <ErrorNote error={error} />
    </div>
  );
}
