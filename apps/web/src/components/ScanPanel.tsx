import type { ScanFinding, SecurityScan } from '@derailed/shared';
import { Check, ShieldAlert, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx, ErrorNote, Spinner } from './ui.tsx';

/**
 * Is anything leaking or known-broken?
 *
 * Two quiet scans, plain verdicts: things shaped like live keys where they should
 * never be, and known holes in the images behind the apps. The last run is shown on
 * arrival; the button runs a fresh one, which clones repositories and can take a
 * minute, so it says so.
 */
export function ScanPanel() {
  const [scan, setScan] = useState<SecurityScan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    endpoints
      .lastScan()
      .then((last) => setScan(last))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      setScan(await endpoints.runScan());
    } catch (err) {
      setError(err);
    } finally {
      setRunning(false);
    }
  }

  if (!loaded) return null;

  return (
    <div className="space-y-3">
      <div className="card flex items-center gap-3 p-4">
        {scan && scan.findings.length === 0 ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-ok" />
        ) : (
          <ShieldAlert
            className={cx(
              'h-4 w-4 shrink-0',
              scan && scan.findings.length > 0 ? 'text-warn' : 'text-ink-faint',
            )}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-ink">
            {scan
              ? scan.summary
              : 'Checks your variables and files for things shaped like live keys, and the images behind your apps for known holes.'}
          </p>
          {scan && (
            <p className="mt-0.5 text-[12px] text-ink-faint">
              Last checked {new Date(scan.at).toLocaleString()}.
              {scan.imageScanner === 'missing' &&
                ' Images were not checked: install Trivy and Derailed will use it.'}
              {scan.imageScanner === 'failed' && ' Some images could not be checked this time.'}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary shrink-0"
          disabled={running}
          onClick={() => void run()}
          title="Clones your repositories to look inside, so it can take a minute"
        >
          {running && <Spinner />}
          {running ? 'Scanning…' : 'Check now'}
        </button>
      </div>

      {scan && scan.findings.length > 0 && (
        <ul className="card divide-y divide-line">
          {scan.findings.map((finding) => (
            <Finding key={finding.id} finding={finding} />
          ))}
        </ul>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function Finding({ finding }: { finding: ScanFinding }) {
  return (
    <li className="flex items-start gap-3 p-4">
      {finding.severity === 'critical' ? (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
      ) : (
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
      )}
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-ink">{finding.verdict}</p>
        <p className="mt-0.5 text-[12px] text-ink-muted">{finding.action}</p>
        {finding.where && (
          <p className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
            {finding.where}
            {finding.evidence ? ` · ${finding.evidence}` : ''}
          </p>
        )}
      </div>
      {finding.kind === 'image-holes' && finding.updateHelps && finding.serviceId && (
        <UpdateNow serviceId={finding.serviceId} />
      )}
    </li>
  );
}

/** The update button that already exists, brought to where the reason is. */
function UpdateNow({ serviceId }: { serviceId: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'started'>('idle');
  return state === 'started' ? (
    <span className="flex items-center gap-1 text-[12px] text-ok">
      <Check className="h-3.5 w-3.5" /> Updating, backed up first
    </span>
  ) : (
    <button
      type="button"
      className="btn-secondary shrink-0"
      disabled={state === 'busy'}
      onClick={() => {
        setState('busy');
        endpoints
          .startAppUpdate(serviceId)
          .then(() => setState('started'))
          .catch(() => setState('idle'));
      }}
    >
      {state === 'busy' && <Spinner />}
      Update it
    </button>
  );
}
