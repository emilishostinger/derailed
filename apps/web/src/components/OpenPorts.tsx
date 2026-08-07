import { Lock, ShieldAlert, Unlock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { cx } from './ui.tsx';

type Report = Awaited<ReturnType<typeof endpoints.openPorts>>;

/**
 * What this machine is listening on, and what each one is for.
 *
 * A description rather than a firewall, and the difference is deliberate. Derailed
 * does not enable ufw, write iptables rules or touch firewalld: a tool that manages a
 * firewall on a remote server has exactly one catastrophic failure mode, which is
 * locking the owner out of the machine it is running on, and that is not a risk worth
 * taking for a feature whose real job is answering "what is this port and do I need
 * it".
 *
 * So it says. And where Derailed opened the port itself, it says where to close it,
 * which is the only case it can be sure about.
 */
export function OpenPorts() {
  const [report, setReport] = useState<Report | null>(null);

  useEffect(() => {
    endpoints
      .openPorts()
      .then(setReport)
      .catch(() => setReport({ ports: [], readable: false }));
  }, []);

  if (!report) return null;

  if (!report.readable) {
    // Better than an empty list, which reads as "nothing is open".
    return (
      <p className="hint">
        Derailed could not read this machine's open ports. That needs <code>ss</code>, which most
        systems have; without it there is nothing to show rather than nothing open.
      </p>
    );
  }

  return (
    <div className="space-y-2">
      <div className="card divide-y divide-line">
        {report.ports.map((entry) => (
          <div key={entry.port} className="flex items-start gap-3 px-4 py-3">
            {entry.needed ? (
              <Lock className="mt-0.5 h-4 w-4 shrink-0 text-ok" />
            ) : (
              <Unlock className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
            )}
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink">
                <span className="tabular">{entry.port}</span>
                <span className={cx('ml-2', entry.needed ? 'text-ink-muted' : 'text-ink')}>
                  {entry.what}
                </span>
              </p>
              {entry.action && <p className="mt-0.5 text-[12px] text-ink-faint">{entry.action}</p>}
            </div>
          </div>
        ))}
      </div>

      <p className="flex items-start gap-2 text-[12px] text-ink-faint">
        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        Derailed does not change your firewall. Managing one from a web page has a single
        catastrophic mistake available to it, and it is locking you out of your own server.
      </p>
    </div>
  );
}
