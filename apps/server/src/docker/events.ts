import { dockerFetch } from './client.ts';
import { LABELS, MANAGED_FILTER } from './labels.ts';

export interface DockerEvent {
  Type: string;
  Action: string;
  Actor: { ID: string; Attributes: Record<string, string> };
  time: number;
  timeNano: number;
}

export interface ContainerEvent {
  action: 'start' | 'die' | 'stop' | 'destroy' | 'health_status' | 'oom' | string;
  containerId: string;
  serviceId: string | null;
  projectId: string | null;
  deploymentId: string | null;
  exitCode: number | null;
  name: string | null;
  at: number;
}

/**
 * Watches Docker for lifecycle changes on containers we manage, so a crash shows up
 * in the UI immediately instead of on the next poll. Reconnects on its own.
 */
export function watchContainerEvents(
  onEvent: (event: ContainerEvent) => void,
  signal?: AbortSignal,
): () => void {
  const controller = new AbortController();
  signal?.addEventListener('abort', () => controller.abort());
  let stopped = false;

  const run = async () => {
    let backoffMs = 1000;
    while (!stopped && !controller.signal.aborted) {
      try {
        const response = await dockerFetch('/events', {
          query: {
            filters: JSON.stringify({
              type: ['container'],
              label: [`${LABELS.managed}=true`],
            }),
          },
          signal: controller.signal,
        });
        if (!response.body) throw new Error('no event stream');
        backoffMs = 1000;

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!stopped) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            let raw: DockerEvent;
            try {
              raw = JSON.parse(line) as DockerEvent;
            } catch {
              continue;
            }
            const attrs = raw.Actor?.Attributes ?? {};
            const exit = attrs.exitCode;
            onEvent({
              action: raw.Action,
              containerId: raw.Actor?.ID ?? '',
              serviceId: attrs[LABELS.service] ?? null,
              projectId: attrs[LABELS.project] ?? null,
              deploymentId: attrs[LABELS.deployment] ?? null,
              exitCode: exit === undefined ? null : Number(exit),
              name: attrs.name ?? null,
              at: raw.time ? raw.time * 1000 : Date.now(),
            });
          }
        }
      } catch {
        // Docker restarted or the socket blipped, back off and reconnect.
      }
      if (stopped || controller.signal.aborted) break;
      await Bun.sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 15_000);
    }
  };

  void run();

  return () => {
    stopped = true;
    controller.abort();
  };
}

export { MANAGED_FILTER };
