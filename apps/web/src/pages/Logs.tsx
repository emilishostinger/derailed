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

  const apps = useMemo(
    () => options.filter((option) => option.value).map((option) => ({ id: option.value })),
    [options],
  );

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
        title="Logs"
        subtitle={
          lines.length === 0
            ? 'Nothing yet'
            : `${lines.length} line${lines.length === 1 ? '' : 's'} from ${apps.length} app${apps.length === 1 ? '' : 's'}`
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-3 p-5">
          {apps.length > 1 && (
            <ScopePicker
              label="Showing"
              value={only ?? ''}
              options={options}
              onChange={(next) => setOnly(next || null)}
            />
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
