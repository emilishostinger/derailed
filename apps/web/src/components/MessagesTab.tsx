import type { Service } from '@derailed/shared';
import { Download, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { ErrorNote, Switch } from './ui.tsx';

type State = Awaited<ReturnType<typeof endpoints.messages>>;

/**
 * What people typed into the site's forms. A table, an export, and the one
 * setting. The copy explains the whole trick, because "add one attribute and it
 * works" deserves to be said where the person will see it.
 */
export function MessagesTab({ service }: { service: Service }) {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    endpoints.messages(service.id).then(setState).catch(setError);
  }, [service.id]);

  useEffect(load, [load]);
  useEffect(
    () =>
      live.on((event) => {
        if (event.type === 'service.message' && event.serviceId === service.id) load();
      }),
    [service.id, load],
  );

  if (!state) return null;

  return (
    <div className="space-y-4">
      <Switch
        label="Catch this site's forms"
        hint={
          <>
            Add <code>data-derailed="contact"</code> to any form and what people submit lands here,
            with an email if email is set up. For sites without their own backend; an app that
            answers its own POSTs should keep doing so.
          </>
        }
        checked={state.enabled}
        disabled={busy}
        onChange={(next) => {
          setBusy(true);
          setError(null);
          endpoints
            .setFormsEnabled(service.id, next)
            .then(load)
            .catch(setError)
            .finally(() => setBusy(false));
        }}
      />

      <ErrorNote error={error} />

      {state.submissions.length === 0 ? (
        <p className="text-[13px] text-ink-faint">
          {state.enabled
            ? 'Nothing yet. The next form submission on the site will appear here.'
            : 'Messages people submit will appear here once forms are on.'}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-[13px] text-ink-muted">
              {state.total} {state.total === 1 ? 'message' : 'messages'}
            </p>
            <a className="btn-secondary" href={`/api/services/${service.id}/messages/export`}>
              <Download className="h-3.5 w-3.5" />
              Download as CSV
            </a>
          </div>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {state.submissions.map((submission) => (
              <li key={submission.id} className="px-3 py-2">
                <button
                  type="button"
                  className="flex w-full items-center gap-3 text-left"
                  onClick={() => setOpen(open === submission.id ? null : submission.id)}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] text-ink">{preview(submission.fields)}</p>
                    <p className="text-[12px] text-ink-faint">
                      {new Date(submission.createdAt).toLocaleString()}
                      {submission.form !== 'form' ? ` · ${submission.form}` : ''}
                    </p>
                  </div>
                  <Trash2
                    role="button"
                    aria-label="Delete this message"
                    className="h-3.5 w-3.5 shrink-0 text-ink-faint hover:text-danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      endpoints.deleteMessage(service.id, submission.id).then(load).catch(setError);
                    }}
                  />
                </button>
                {open === submission.id && (
                  <dl className="mt-2 space-y-1 border-t border-line pt-2">
                    {Object.entries(submission.fields).map(([key, value]) => (
                      <div key={key} className="grid grid-cols-[8rem_1fr] gap-2">
                        <dt className="truncate text-[12px] text-ink-faint">{key}</dt>
                        <dd className="text-[13px] whitespace-pre-wrap text-ink">{value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="text-[12px] text-ink-faint">
        A hidden field called <code>_gotcha</code> quietly filters bots, and each visitor is limited
        to a few messages a minute. A field called <code>_redirect</code> sends people to a page of
        your site after submitting, instead of the plain thank-you page.
      </p>
    </div>
  );
}

function preview(fields: Record<string, string>): string {
  const interesting = Object.entries(fields).filter(([, value]) => value.trim());
  if (!interesting.length) return '(empty message)';
  return interesting
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ')
    .slice(0, 160);
}
