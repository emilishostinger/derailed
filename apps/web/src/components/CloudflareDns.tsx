import { Cloud, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useSession } from '../stores/session.ts';
import { useToasts } from '../stores/toasts.ts';
import { ErrorNote, Spinner } from './ui.tsx';

/**
 * DNS records, written for you.
 *
 * Everything after "point your domain at this server" is Derailed's job, and that
 * sentence is the biggest onboarding cliff left. Connect Cloudflare once, pick the
 * domain from a dropdown, and the A record, the www CNAME and the wildcard write
 * themselves, DNS-only so certificates keep working.
 */
export function CloudflareDns() {
  const role = useSession((s) => s.user?.role);
  const push = useToasts((s) => s.push);
  const [state, setState] = useState<{
    configured: boolean;
    zones: { id: string; name: string }[];
    problem?: string;
  } | null>(null);
  const [pasted, setPasted] = useState('');
  const [zone, setZone] = useState('');
  const [wildcard, setWildcard] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .dnsState()
      .then((loaded) => {
        setState(loaded);
        setZone(loaded.zones[0]?.name ?? '');
      })
      .catch(() => setState({ configured: false, zones: [] }));
  }, []);

  if (!state || role !== 'owner') return null;

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      const next = await endpoints.setDnsToken(pasted.trim());
      setState(next);
      setZone(next.zones[0]?.name ?? '');
      setPasted('');
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function write() {
    setBusy(true);
    setError(null);
    try {
      const result = await endpoints.writeDns(zone, wildcard);
      push({
        message: `Wrote ${result.records.length} record${
          result.records.length === 1 ? '' : 's'
        } on ${result.zone}. DNS takes a few minutes to travel.`,
        tone: 'ok',
      });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      {!state.configured ? (
        <div className="flex flex-wrap items-center gap-3">
          <Cloud className="h-4 w-4 shrink-0 text-ink-faint" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
            Connect Cloudflare and the records write themselves: the A record, the www redirect, and
            the wildcard that gives every future app a real address. Make an API token with Zone.DNS
            edit rights and paste it here; it is stored encrypted and never shown again.
          </p>
          <input
            className="input w-64 font-mono text-[12px]"
            placeholder="Cloudflare API token"
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
          />
          <button
            type="button"
            className="btn-secondary shrink-0"
            disabled={busy || !pasted.trim()}
            onClick={() => void connect()}
          >
            {busy && <Spinner />}
            Connect
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <Cloud className="h-4 w-4 shrink-0 text-ok" />
          <p className="min-w-0 flex-1 text-[13px] text-ink-muted">
            {state.problem
              ? `Cloudflare is connected but unhappy: ${state.problem}`
              : 'Cloudflare is connected. Pick a domain and the records write themselves, DNS-only so certificates keep working.'}
          </p>
          <select
            className="input w-56"
            value={zone}
            onChange={(event) => setZone(event.target.value)}
          >
            {state.zones.map((entry) => (
              <option key={entry.id} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
          <label className="flex shrink-0 items-center gap-1.5 text-[12px] text-ink-muted">
            <input
              type="checkbox"
              checked={wildcard}
              onChange={(event) => setWildcard(event.target.checked)}
            />
            wildcard too
          </label>
          <button
            type="button"
            className="btn-primary shrink-0"
            disabled={busy || !zone}
            onClick={() => void write()}
          >
            {busy ? <Spinner /> : <Wand2 className="h-3.5 w-3.5" />}
            Write the records
          </button>
          <button
            type="button"
            className="btn-ghost shrink-0 text-[12px]"
            disabled={busy}
            onClick={() => {
              void endpoints.setDnsToken(null).then(() => {
                setState({ configured: false, zones: [] });
              });
            }}
          >
            Disconnect
          </button>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}
