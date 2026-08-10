import type { Service } from '@derailed/shared';
import { useState } from 'react';
import { cx } from './ui.tsx';

/**
 * What a project's sites actually look like.
 *
 * A card carrying a name, a status dot and a framework logo is a row in a process
 * list. The same card carrying the site's own icon and its own title is a thing you
 * made, and this is most of the difference between the dashboard feeling like a tool
 * and feeling like yours.
 */

const base = '/api/services/previews';

/** A row of the site icons for a project, with the title of the first one. */
/** Enough to recognise the project by, before the row turns into a smear. */
const SHOWN = 4;

export function ProjectPreview({ services }: { services: Service[] }) {
  const withPreview = services.filter((service) => service.preview?.iconPath);
  const title = services.find((service) => service.preview?.title)?.preview?.title;

  if (!withPreview.length && !title) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      {withPreview.length > 0 && (
        <div className="flex shrink-0 items-center -space-x-1.5">
          {withPreview.slice(0, SHOWN).map((service) => (
            <SiteIcon key={service.id} service={service} />
          ))}
          {/* Said rather than silently dropped. Four was already the limit, so a
              project with a hundred apps looked exactly like one with four: the row
              never grew and never admitted there was more. */}
          {withPreview.length > SHOWN && (
            <span
              className="flex h-5 items-center rounded-full border border-line bg-surface-2 pr-1.5 pl-2.5 text-[10px] text-ink-muted tabular"
              title={`${withPreview.length} apps with a site`}
            >
              +{withPreview.length - SHOWN}
            </span>
          )}
        </div>
      )}
      {title && <p className="min-w-0 flex-1 truncate text-[12px] text-ink-muted">{title}</p>}
    </div>
  );
}

/**
 * One site's own favicon.
 *
 * Hidden entirely if it fails to load rather than showing a broken image: an app
 * serving something that is not an image at /favicon.ico is a normal state of
 * affairs, not something to draw attention to.
 */
export function SiteIcon({ service, className }: { service: Service; className?: string }) {
  const [broken, setBroken] = useState(false);
  const path = service.preview?.iconPath;
  if (!path || broken) return null;

  return (
    <img
      src={`${base}/${path}`}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      className={cx('h-4 w-4 rounded-[3px] bg-surface object-contain ring-1 ring-line', className)}
    />
  );
}

/**
 * The screenshot, when one has been taken.
 *
 * 16:10 and cropped from the top, which is where a page puts the thing it is about.
 */
export function SiteShot({ service }: { service: Service }) {
  const [broken, setBroken] = useState(false);
  const path = service.preview?.shotPath;
  if (!path || broken) return null;

  return (
    <div className="overflow-hidden rounded-[var(--radius-control)] border border-line bg-surface-2">
      <img
        src={`${base}/${path}?v=${service.preview?.at ?? 0}`}
        alt={`${service.name} as it looks right now`}
        loading="lazy"
        onError={() => setBroken(true)}
        className="aspect-[16/10] w-full object-cover object-top"
      />
    </div>
  );
}
