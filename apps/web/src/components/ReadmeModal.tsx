import type { Service } from '@derailed/shared';
import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { LinkResolver, render } from '../help/markdown.tsx';
import { docsUrlFor } from './docsUrl.ts';
import { Modal, Spinner } from './ui.tsx';

/**
 * The app's README, read without leaving the dashboard.
 *
 * Rendered by the handbook's own renderer, which builds React elements and
 * never touches innerHTML, so a README from anywhere on the internet cannot
 * inject markup here. Relative links are resolved against the repository page
 * when there is one to resolve against, and rendered as plain words when not:
 * a dead link dressed as a live one helps nobody.
 */
export function ReadmeModal({ service, onClose }: { service: Service; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null | undefined>(undefined);
  const docsUrl = docsUrlFor(service);
  const isGithub = docsUrl?.startsWith('https://github.com/') ?? false;

  useEffect(() => {
    endpoints
      .readme(service.id)
      .then(setMarkdown)
      .catch(() => setMarkdown(null));
  }, [service.id]);

  const resolve = (href: string): string | null => {
    if (/^https?:\/\//i.test(href)) return href;
    if (!isGithub || href.startsWith('#')) return null;
    return `${docsUrl}/blob/HEAD/${href.replace(/^\.?\//, '')}`;
  };

  return (
    <Modal title={`${service.name} readme`} onClose={onClose} wide>
      {markdown === undefined && (
        <div className="flex items-center gap-2 py-8 text-sm text-ink-muted">
          <Spinner />
          Fetching it…
        </div>
      )}

      {markdown === null && (
        <div className="py-6 text-sm text-ink-muted">
          <p>No readme came with this app.</p>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-2 inline-flex items-center gap-1.5 text-accent hover:underline"
            >
              Its page may say more
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      )}

      {typeof markdown === 'string' && (
        <>
          <div className="max-h-[65vh] space-y-3 overflow-y-auto pr-1 text-sm leading-relaxed text-ink-muted">
            <LinkResolver.Provider value={resolve}>{render(markdown)}</LinkResolver.Provider>
          </div>
          {docsUrl && (
            <a
              href={docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-4 inline-flex items-center gap-1.5 text-[12px] text-ink-faint hover:text-ink"
            >
              Open the original
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </>
      )}
    </Modal>
  );
}
