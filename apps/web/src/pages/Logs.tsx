import type { LogLine } from '@derailed/shared';
import { topics } from '@derailed/shared';
import { useEffect, useMemo, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { LogViewer } from '../components/LogViewer.tsx';
import { type ScopeOption, ScopePicker } from '../components/ScopePicker.tsx';
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
   * One option per app, grouped by project, plus everything.
   *
   * Names are not unique: three apps here are called `index.html`, all in one
   * project, so a duplicated name falls back to the slug, which is the only handle
   * guaranteed unique within a project.
   */
  const options = useMemo<ScopeOption[]>(() => {
    const counted = new Map<string, number>();
    for (const project of projects) {
      for (const service of project.services ?? []) {
        if (service.kind === 'app') counted.set(service.name, (counted.get(service.name) ?? 0) + 1);
      }
    }

    return [
      { value: '', label: 'Every app' },
      ...projects.flatMap((project) =>
        (project.services ?? [])
          .filter((service) => service.kind === 'app')
          .map((service) => ({
            value: service.id,
            label: (counted.get(service.name) ?? 0) > 1 ? service.slug : service.name,
            group: project.name,
          })),
      ),
    ];
  }, [projects]);

  /**
   * The label each app's lines are tagged with, taken from the picker's own options so
   * the name in front of a line is the name in the list you filter by. The three apps
   * called `index.html` would otherwise be three identical prefixes.
   */
  const names = useMemo(
    () =>
      new Map(
        options.filter((option) => option.value).map((option) => [option.value, option.label]),
      ),
    [options],
  );

  const apps = useMemo(
    () => options.filter((option) => option.value).map((option) => ({ id: option.value })),
    [options],
  );

  /** The backlog, so the page is not empty while waiting for something to be printed. */
  useEffect(() => {
    let current = true;
    endpoints
      .serverLogs()
      .then((result) => current && setLines(result))
      .catch(() => current && setLines([]));
    return () => {
      current = false;
    };
  }, []);

  /**
   * Everything after that comes down the socket.
   *
   * Log lines are published on each app's own topic, which nothing on this page is
   * otherwise subscribed to, so the subscription has to be made here and for every app
   * at once. That is the whole point of the page.
   */
  useEffect(() => {
    if (apps.length === 0) return;
    return live.subscribe(apps.map((app) => topics.service(app.id)));
  }, [apps]);

  useEffect(() => {
    return live.on((event) => {
      if (event.type !== 'service.logs') return;
      const name = names.get(event.serviceId);
      // An app that is not in the sidebar yet has no name to label its lines with, and
      // an unlabelled line in a page whose whole job is saying which app said it is
      // worse than no line.
      if (!name) return;
      setLines((previous) => {
        const next = [
          ...previous,
          ...event.lines.map((line) => ({
            ...line,
            serviceId: event.serviceId,
            serviceName: name,
          })),
        ];
        // The ceiling the server keeps for one app, times a plausible number of apps.
        // Without it a chatty deploy grows this array until the tab is the problem, and
        // this is the one page that is left open in the background for hours.
        return next.length > 2000 ? next.slice(-2000) : next;
      });
    });
  }, [names]);

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
        // Through the same map as the live lines: the backlog arrives labelled with the
        // app's plain name, and two apps can share one.
        line: only ? line.line : `${names.get(line.serviceId) ?? line.serviceName}  ${line.line}`,
      })),
    [shown, only, names],
  );

  return (
    <>
      <PageHeader
        title="Logs"
        subtitle={
          lines.length === 0
            ? 'Nothing yet'
            : `${lines.length} line${lines.length === 1 ? '' : 's'} from ${apps.length} app${apps.length === 1 ? '' : 's'}`
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="p-5">
          <LogViewer
            lines={labelled}
            className="h-[calc(100vh-13rem)]"
            emptyMessage="Nothing has been printed yet. Anything your apps write shows up here as it happens."
            // Which app, and which words in it, are one question. They sit on one row.
            toolbar={
              apps.length > 1 ? (
                <ScopePicker
                  label="Showing"
                  className="shrink-0"
                  value={only ?? ''}
                  options={options}
                  onChange={(next) => setOnly(next || null)}
                />
              ) : undefined
            }
          />
        </div>
      </div>
    </>
  );
}
