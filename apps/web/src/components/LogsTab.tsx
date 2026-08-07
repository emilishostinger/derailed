import type { LogLine, Service } from '@derailed/shared';
import { useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { live } from '../api/ws.ts';
import { LogViewer } from './LogViewer.tsx';
import { Spinner } from './ui.tsx';

/**
 * What the app is printing, now.
 *
 * The one kind of log this product did not show. Build output was a tab deep in the
 * deploy history and the running program's own output was reachable only from the
 * command line, which is no use to somebody whose site is misbehaving at eleven at
 * night.
 *
 * The backlog arrives over HTTP so the tab is not empty on arrival, and everything
 * after that comes down the socket the drawer is already subscribed to.
 */
export function LogsTab({ service }: { service: Service }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);

  useEffect(() => {
    let live = true;
    endpoints
      .serviceLogs(service.id)
      .then((result) => live && setLines(result.lines))
      .catch(() => live && setLines([]));
    return () => {
      live = false;
    };
  }, [service.id]);

  useEffect(() => {
    return live.on((event) => {
      if (event.type !== 'service.logs' || event.serviceId !== service.id) return;
      setLines((previous) => {
        const next = [...(previous ?? []), ...event.lines];
        // The same ceiling the server keeps, so a chatty app cannot grow this tab
        // until the tab is the problem.
        return next.length > 500 ? next.slice(-500) : next;
      });
    });
  }, [service.id]);

  if (!lines) return <Spinner />;

  return (
    <LogViewer
      lines={lines}
      className="h-[60vh]"
      emptyMessage={
        service.status === 'running'
          ? 'Nothing printed yet. Anything this app writes shows up here as it happens.'
          : 'This app is not running, so it is not printing anything.'
      }
    />
  );
}
