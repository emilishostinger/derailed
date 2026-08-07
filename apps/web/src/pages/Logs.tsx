import type { LogLine } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { LogViewer } from '../components/LogViewer.tsx';
import { cx } from '../components/ui.tsx';
import { useProjects } from '../stores/projects.ts';
import { PageHeader } from './Layout.tsx';

/**
 * Everything every app is printing, in one place.
 *
 * "Something on this server is complaining and I do not know which" is a real
 * question, and until now the only way to answer it was to open each app in turn and
 * read its Logs tab. Which is fine with two apps and is the reason nobody does it with
 * nine.
 *
 * Each line carries the app it came from, so the page can label it and filter to one
 * without going anywhere else.
 */
export function Logs() {
  const projects = useProjects((s) => s.projects);
  const [lines, setLines] = useState<(LogLine & { serviceId: string; serviceName: string })[]>([]);
  const [only, setOnly] = useState<string | null>(null);

  /**
   * Every app, labelled so no two buttons read the same.
   *
   * Three apps called `index.html` give three identical filter buttons, and a filter
   * you cannot tell from the one beside it is not a filter. The project name alone
   * does not fix it, because they were all three in the same project; the slug is the
   * only handle guaranteed unique, so a collision falls back to that.
   */
  const apps = useMemo(() => {
    const all = projects.flatMap((project) =>
      (project.services ?? [])
        .filter((service) => service.kind === 'app')
        .map((service) => ({
          id: service.id,
          name: service.name,
          slug: service.slug,
          project: project.name,
        })),
    );
    const seen = new Map<string, number>();
    for (const app of all) seen.set(app.name, (seen.get(app.name) ?? 0) + 1);

    return all.map((app) => ({
      id: app.id,
      name: (seen.get(app.name) ?? 0) > 1 ? `${app.project} / ${app.slug}` : app.name,
    }));
  }, [projects]);

  useEffect(() => {
    endpoints
      .serverLogs()
      .then(setLines)
      .catch(() => setLines([]));
  }, []);

  /**
   * Live lines arrive per app, so this subscribes to every app rather than to one
   * topic. The alternative is a server-wide log topic, which would send every line to
   * everybody looking at anything, including the eight people not on this page.
   */
  useEffect(() => {
    if (apps.length === 0) return;
    const stop = live.subscribe(apps.map((app) => topics.service(app.id)));
    const off = live.on((event) => {
      if (event.type !== 'service.logs') return;
      const app = apps.find((entry) => entry.id === event.serviceId);
      if (!app) return;
      setLines((current) =>
        [
          ...current,
          ...event.lines.map((line) => ({
            ...line,
            serviceId: event.serviceId,
            serviceName: app.name,
          })),
        ].slice(-2000),
      );
    });
    return () => {
      off();
      stop();
    };
  }, [apps]);

  const shown = only ? lines.filter((line) => line.serviceId === only) : lines;

  /**
   * The app's name goes into the line itself rather than into a column beside it.
   *
   * `LogViewer` already searches, follows the tail and collapses the noisy lines, and
   * all of that works on the text. A name in a separate column would be invisible to
   * every one of those, so searching for an app would find nothing.
   */
  const labelled = useMemo(
    () =>
      shown.map((line) => ({
        ...line,
        line: only ? line.line : `${line.serviceName}  ${line.line}`,
      })),
    [shown, only],
  );

  return (
    <>
      <PageHeader
        title="Output"
        subtitle={
          lines.length === 0
            ? 'Nothing yet'
            : `${lines.length} line${lines.length === 1 ? '' : 's'} from ${apps.length} app${apps.length === 1 ? '' : 's'}`
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-5">
          {apps.length > 1 && (
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                className={cx(
                  'btn border text-[12px]',
                  only === null
                    ? 'border-accent bg-accent-soft text-ink'
                    : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink',
                )}
                onClick={() => setOnly(null)}
              >
                Everything
              </button>
              {apps.map((app) => (
                <button
                  key={app.id}
                  type="button"
                  className={cx(
                    'btn border text-[12px]',
                    only === app.id
                      ? 'border-accent bg-accent-soft text-ink'
                      : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink',
                  )}
                  onClick={() => setOnly(app.id)}
                >
                  {app.name}
                </button>
              ))}
            </div>
          )}

          <LogViewer
            lines={labelled}
            className="h-[calc(100vh-16rem)]"
            emptyMessage="Nothing has been printed yet. Anything your apps write shows up here as it happens."
          />
        </div>
      </div>
    </>
  );
}
