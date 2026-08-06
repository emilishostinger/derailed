import type { DrillResult, OffsiteSettings, OffsiteStatus } from '@derailed/shared';
import { Check, CloudOff, CloudUpload, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { formatBytes } from '../pages/Layout.tsx';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Spinner } from './ui.tsx';

/**
 * Backups that leave the building, and the proof that they can be read back.
 *
 * A backup on the same disk as the thing it backs up is a copy, not a backup: the
 * failure that actually loses people's data takes both at once. And a backup nobody
 * has ever read back is a promise, not a guarantee, which is what the drill is for.
 */
export function Offsite() {
  const [settings, setSettings] = useState<OffsiteSettings | null>(null);
  const [status, setStatus] = useState<OffsiteStatus | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [pathStyle, setPathStyle] = useState(true);
  const [busy, setBusy] = useState<'save' | 'test' | 'forget' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState(false);
  const push = useToasts((s) => s.push);

  useEffect(() => {
    endpoints
      .offsite()
      .then((result) => {
        setSettings(result.settings);
        setStatus(result.status);
        setForm({
          endpoint: result.settings.endpoint,
          bucket: result.settings.bucket,
          region: result.settings.region,
          accessKeyId: result.settings.accessKeyId,
          prefix: result.settings.prefix,
          secretAccessKey: '',
        });
        setPathStyle(result.settings.pathStyle);
        setEditing(!result.settings.endpoint);
      })
      .catch(() => undefined);
  }, []);

  async function save() {
    setBusy('save');
    setError(null);
    try {
      const result = await endpoints.saveOffsite({ ...form, pathStyle });
      setSettings(result.settings);
      setStatus(result.status);
      setForm((previous) => ({ ...previous, secretAccessKey: '' }));
      setEditing(false);
      push({ message: 'Saved. Press Test to check it works.', tone: 'ok' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    setBusy('test');
    setError(null);
    try {
      const { roundTripMs } = await endpoints.testOffsite();
      push({
        message: `Wrote a file, read it back and removed it, in ${roundTripMs} ms. This will work.`,
        tone: 'ok',
      });
      setStatus(await endpoints.offsite().then((result) => result.status));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function forget() {
    setBusy('forget');
    setError(null);
    try {
      const result = await endpoints.forgetOffsite();
      setSettings(result.settings);
      setStatus(result.status);
      setEditing(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  if (!settings) return null;
  const set = (key: string) => (event: { target: { value: string } }) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <div className="card p-4">
      {!settings.endpoint && !editing && (
        <div className="flex items-start gap-3">
          <CloudOff className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <p className="min-w-0 flex-1 text-[13px] text-ink">
            Your backups are on this server only. If the server dies, they die with it.
          </p>
          <button type="button" className="btn-secondary shrink-0" onClick={() => setEditing(true)}>
            Send a copy somewhere else
          </button>
        </div>
      )}

      {settings.endpoint && !editing && status && (
        <div className="flex items-start gap-3">
          <CloudUpload className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] text-ink">
              Copied to <span className="text-ink-muted">{settings.bucket}</span> after every
              backup.
            </p>
            <p className="mt-0.5 text-[12px] text-ink-faint">
              {status.error
                ? status.error
                : status.copies
                  ? `${status.copies} ${status.copies === 1 ? 'copy' : 'copies'} there, ${formatBytes(status.totalBytes)}.`
                  : 'Nothing copied there yet.'}
            </p>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => void test()}
            >
              {busy === 'test' && <Spinner />}
              Test
            </button>
            <button type="button" className="btn-ghost" onClick={() => setEditing(true)}>
              Change
            </button>
          </div>
        </div>
      )}

      {editing && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink-muted">
            Any S3-compatible storage works: Backblaze B2, Cloudflare R2, Wasabi, Storj, MinIO,
            Hetzner or Amazon. Most of them cost a few pence a month for a server's worth of
            backups.
          </p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Address"
              hint="From your provider, e.g. https://s3.us-west-004.backblazeb2.com"
            >
              <input className="input" value={form.endpoint ?? ''} onChange={set('endpoint')} />
            </Field>
            <Field label="Bucket">
              <input className="input" value={form.bucket ?? ''} onChange={set('bucket')} />
            </Field>
            <Field label="Region" hint="Leave as us-east-1 if your provider does not use regions.">
              <input className="input" value={form.region ?? ''} onChange={set('region')} />
            </Field>
            <Field
              label="Folder inside the bucket"
              hint="Optional. Lets one bucket hold several servers."
            >
              <input className="input" value={form.prefix ?? ''} onChange={set('prefix')} />
            </Field>
            <Field label="Access key">
              <input
                className="input"
                value={form.accessKeyId ?? ''}
                onChange={set('accessKeyId')}
              />
            </Field>
            <Field
              label="Secret key"
              hint={settings.hasSecret ? 'Leave blank to keep the one already saved.' : undefined}
            >
              <input
                className="input"
                type="password"
                autoComplete="off"
                value={form.secretAccessKey ?? ''}
                onChange={set('secretAccessKey')}
              />
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-ink">
            <input
              type="checkbox"
              checked={pathStyle}
              onChange={(event) => setPathStyle(event.target.checked)}
            />
            Put the bucket in the path
            <span className="text-[12px] text-ink-faint">
              (leave on unless you are using Amazon)
            </span>
          </label>

          <ErrorNote error={error} />

          <div className="flex items-center gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === 'save' && <Spinner />}
              Save
            </button>
            {settings.endpoint && (
              <>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={busy !== null}
                  onClick={() => void test()}
                >
                  {busy === 'test' && <Spinner />}
                  Test it
                </button>
                <button
                  type="button"
                  className="btn-ghost"
                  disabled={busy !== null}
                  onClick={() => void forget()}
                >
                  {busy === 'forget' && <Spinner />}
                  Stop copying
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!editing && <ErrorNote error={error} />}
    </div>
  );
}

/**
 * Whether the newest backup can actually be read back.
 *
 * Every backup tool tells you a backup was made. This is the only claim anyone
 * actually cares about, and it turns a backup from an act of faith into a fact.
 */
export function Drill() {
  const [drill, setDrill] = useState<DrillResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    endpoints
      .drill()
      .then(setDrill)
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      setDrill(await endpoints.runDrill());
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  if (!loaded) return null;

  const Icon = !drill ? ShieldCheck : drill.ok ? Check : TriangleAlert;
  const tone = !drill ? 'text-ink-faint' : drill.ok ? 'text-ok' : 'text-danger';

  return (
    <div className="card flex items-start gap-3 p-4">
      <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">
          {drill ? drill.summary : 'No backup has been checked yet.'}
        </p>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          {drill
            ? `Checked ${new Date(drill.at).toLocaleDateString()}. Derailed does this by itself once a month.`
            : 'Derailed opens the newest backup once a month and confirms every database dump and stored folder inside it is complete.'}
        </p>
        {drill && drill.problems.length > 0 && (
          <ul className="mt-2 space-y-1">
            {drill.problems.map((problem) => (
              <li key={problem} className="text-[12px] text-danger">
                {problem}
              </li>
            ))}
          </ul>
        )}
        <ErrorNote error={error} />
      </div>
      <button
        type="button"
        className="btn-secondary shrink-0"
        disabled={busy}
        onClick={() => void run()}
      >
        {busy && <Spinner />}
        Check now
      </button>
    </div>
  );
}
