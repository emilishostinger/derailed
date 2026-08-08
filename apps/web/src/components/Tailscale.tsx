import { Copy, ExternalLink, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.ts';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Field, Select, Spinner } from './ui.tsx';

/**
 * The cupboard computer: reachable from anywhere, no port forwarding, no DNS
 * knowledge. Private by default over the person's own tailnet; public per-app
 * through Funnel when they say so. Derailed never runs a relay of its own.
 */
export function Tailscale() {
  const projects = useProjects((s) => s.projects);
  const push = useToasts((s) => s.push);
  const [state, setState] = useState<Awaited<ReturnType<typeof endpoints.tailscale>> | null>(null);
  const [authKey, setAuthKey] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    endpoints.tailscale().then(setState).catch(setError);
  }, []);
  useEffect(load, [load]);

  if (!state) return null;

  const apps = projects.flatMap((project) =>
    (project.services ?? []).filter((service) => service.kind === 'app'),
  );

  return (
    <div className="space-y-3">
      <p className="text-[13px] text-ink-muted">
        A computer at home has no public address, and that is fine. Tailscale makes it reachable to{' '}
        <i>you</i> from anywhere in one step, and to everyone, one app at a time, if you want. Free
        for personal use; Derailed never sits between you and your visitors.
      </p>

      {!state.installed && (
        <button
          type="button"
          className="btn-secondary"
          disabled={busy !== null}
          onClick={() => {
            setBusy('install');
            setError(null);
            endpoints
              .installTailscale()
              .then(() => {
                push({ message: 'Installed.', tone: 'ok' });
                load();
              })
              .catch(setError)
              .finally(() => setBusy(null));
          }}
        >
          {busy === 'install' ? <Spinner /> : <Wifi className="h-3.5 w-3.5" />}
          Install Tailscale on this server
        </button>
      )}

      {state.installed && !state.connected && (
        <div className="space-y-2">
          <button
            type="button"
            className="btn-primary"
            disabled={busy !== null}
            onClick={() => {
              setBusy('connect');
              setError(null);
              setLoginUrl('');
              endpoints
                .connectTailscale(authKey || undefined)
                .then((answer) => {
                  if (answer.loginUrl) setLoginUrl(answer.loginUrl);
                  else {
                    push({ message: 'Connected.', tone: 'ok' });
                    load();
                  }
                })
                .catch(setError)
                .finally(() => setBusy(null));
            }}
          >
            {busy === 'connect' && <Spinner />}
            Connect to your tailnet
          </button>
          {loginUrl && (
            <p className="text-[13px] text-ink">
              Open this on any device that is already yours, then press Connect again:{' '}
              <a className="underline" href={loginUrl} target="_blank" rel="noreferrer">
                {loginUrl} <ExternalLink className="inline h-3 w-3" />
              </a>
            </p>
          )}
          <Field
            label="Or paste an auth key"
            hint="From the Tailscale admin console, for connecting without a browser dance."
          >
            <input
              className="input"
              value={authKey}
              placeholder="tskey-auth-…"
              onChange={(event) => setAuthKey(event.target.value)}
            />
          </Field>
        </div>
      )}

      {state.connected && (
        <div className="space-y-3">
          <p className="text-[13px] text-ink">
            This server is on your tailnet as <b>{state.dnsName ?? state.ip}</b>. The dashboard and
            every app are reachable from your devices, anywhere; the open internet is not involved.
          </p>
          {state.ip && (
            <button
              type="button"
              className="btn-secondary"
              disabled={busy !== null}
              onClick={() => {
                setBusy('address');
                setError(null);
                api
                  .patchSystem(state.ip!)
                  .then(() => {
                    push({
                      message:
                        'Done. Every app gets a working address on the tailnet within a minute.',
                      tone: 'ok',
                    });
                  })
                  .catch(setError)
                  .finally(() => setBusy(null));
              }}
            >
              {busy === 'address' ? <Spinner /> : <Copy className="h-3.5 w-3.5" />}
              Use the tailnet address for app links
            </button>
          )}

          <Field
            label="Share one app with the whole internet"
            hint={`Tailscale Funnel gives it real HTTPS at ${state.dnsName ?? 'your ts.net name'}, through no relay of ours, with no ports opened. Funnel needs one approval in your Tailscale admin console the first time.`}
          >
            <Select
              ariaLabel="Which app the funnel serves"
              value={state.funnelServiceId ?? 'off'}
              options={[
                { value: 'off', label: 'Nothing: stay private' },
                ...apps.map((app) => ({ value: app.id, label: app.name })),
              ]}
              onChange={(value) => {
                setBusy('funnel');
                setError(null);
                endpoints
                  .setFunnel(value === 'off' ? null : value)
                  .then(() => {
                    push({
                      message: value === 'off' ? 'The funnel is closed.' : 'Shared.',
                      tone: 'ok',
                    });
                    load();
                  })
                  .catch(setError)
                  .finally(() => setBusy(null));
              }}
            />
          </Field>
        </div>
      )}

      <ErrorNote error={error} />
    </div>
  );
}
