import { QrCode as QrIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { qrSvg } from '../lib/qr.ts';

/**
 * Open what you just deployed, on your phone, without typing the address.
 *
 * Small feature, disproportionate relief. Typing `shop-web.203-0-113-7.sslip.io` into
 * a phone keyboard is about forty characters of getting it wrong twice, and the whole
 * point of a preview address is to look at it on the thing it will be looked at on.
 *
 * Drawn here rather than fetched from an online generator, which would tell somebody
 * else's server every address on this machine and stop working on a server with no
 * outbound internet.
 */
export function QrCode({ url, label }: { url: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const svg = useMemo(() => (open ? qrSvg(url, { size: 200, margin: 3 }) : ''), [open, url]);

  return (
    <div className="relative">
      <button
        type="button"
        className="btn-ghost shrink-0 px-2 py-1"
        title="Open this on your phone"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <QrIcon className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          {/* Clicking anywhere else puts it away, which is what everybody tries first. */}
          <button
            type="button"
            aria-label="Close"
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 z-50 mt-1 rounded-lg border border-line bg-surface p-3 shadow-lg">
            {/* The code is always on white, whatever the dashboard's theme. A dark
                one is a code half the scanners on earth will not look at. */}
            <div
              className="rounded bg-white p-2"
              // The SVG is built here from the address, character by character. There
              // is nothing in it that came from anywhere else.
              // biome-ignore lint/security/noDangerouslySetInnerHtml: built in this file from a string we made
              dangerouslySetInnerHTML={{ __html: svg }}
            />
            <p className="mt-2 max-w-[200px] truncate text-center text-[11px] text-ink-faint">
              {label ?? 'Point your phone at this'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
