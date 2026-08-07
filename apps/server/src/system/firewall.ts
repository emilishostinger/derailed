import { caddy, port as panelPort } from '../config.ts';
import { listServices } from '../db/repo/services.ts';

/**
 * What this machine is listening on, and whether it should be.
 *
 * Deliberately a description rather than a firewall. Derailed does not enable ufw,
 * write iptables rules or touch firewalld, and the reason is the one port nobody
 * thinks about until it is gone: a tool that manages a firewall on a remote server
 * has exactly one catastrophic failure mode, which is locking the owner out of the
 * machine it is running on, and no amount of care makes that risk worth taking for a
 * feature whose real job is answering "what is this port and do I need it".
 *
 * So it says what is open, what each one is for in plain language, and offers to close
 * the ones Derailed itself opened, which are the only ones it can close without
 * guessing.
 */

export interface OpenPort {
  port: number;
  /** What it is, in words somebody who did not open it would understand. */
  what: string;
  /** Whether closing it would break something Derailed is doing. */
  needed: boolean;
  /** What to do about it, when there is something to do. */
  action: string | null;
  /** The service whose published port this is, when Derailed opened it. */
  serviceId?: string;
  /** The process holding it, when the machine will say. */
  process?: string | null;
}

/** One line of `ss -tlnp`, as far as anything here cares. */
export function parseListening(output: string): { port: number; process: string | null }[] {
  const found = new Map<number, string | null>();

  for (const line of output.split('\n').slice(1)) {
    // `0.0.0.0:443`, `[::]:443`, `127.0.0.1:2019`. The last colon is the port.
    const address = line.trim().split(/\s+/)[3];
    if (!address) continue;
    const port = Number(address.slice(address.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port <= 0) continue;

    // Only what is reachable from outside. A service bound to loopback is not open,
    // and listing it would bury the three that matter under a dozen that do not.
    const host = address.slice(0, address.lastIndexOf(':'));
    if (host === '127.0.0.1' || host === '[::1]') continue;

    const name = /users:\(\("([^"]+)"/.exec(line)?.[1] ?? null;
    if (!found.has(port) || (name && !found.get(port))) found.set(port, name);
  }

  return [...found.entries()]
    .map(([port, process]) => ({ port, process }))
    .sort((a, b) => a.port - b.port);
}

/**
 * What a port is for.
 *
 * Ordered so the specific answers win over the general ones: a database Derailed
 * published on 33061 should say which database, not "something is listening".
 */
export function explainPort(
  port: number,
  published: Map<number, { name: string; serviceId: string }>,
  process: string | null,
): OpenPort {
  const database = published.get(port);
  if (database) {
    return {
      port,
      what: `${database.name}, reachable from the internet because you published it.`,
      needed: false,
      action: 'Close it on that database’s Connection tab when you are done with it.',
      serviceId: database.serviceId,
      process,
    };
  }
  if (port === caddy.httpPort || port === caddy.httpsPort) {
    return {
      port,
      what:
        port === caddy.httpsPort
          ? 'Your websites, over HTTPS. This is the one that matters.'
          : 'Your websites, over plain HTTP. Also how certificates are renewed.',
      needed: true,
      action: null,
      process,
    };
  }
  if (port === panelPort) {
    return {
      port,
      what: 'This dashboard.',
      needed: true,
      action: 'Give it a domain under Settings, and it moves behind HTTPS on 443.',
      process,
    };
  }
  if (port === 22) {
    return {
      port,
      what: 'SSH, which is how you get into this machine.',
      needed: true,
      // Said plainly, because this is the port people close by accident and the
      // consequence is not recoverable from a web page.
      action: 'Leave this open. Closing it locks you out of the server.',
      process,
    };
  }
  return {
    port,
    what: process
      ? `${process} is listening here. Derailed did not open this.`
      : 'Something is listening here. Derailed did not open this.',
    needed: false,
    action: 'If you do not recognise it, find out what it is before closing anything.',
    process,
  };
}

/** Every published database port, by port number. */
export function publishedPorts(): Map<number, { name: string; serviceId: string }> {
  const map = new Map<number, { name: string; serviceId: string }>();
  for (const service of listServices()) {
    if (service.kind === 'database' && service.exposedPort) {
      map.set(service.exposedPort, { name: service.name, serviceId: service.id });
    }
  }
  return map;
}

export async function openPorts(): Promise<{ ports: OpenPort[]; readable: boolean }> {
  let output = '';
  try {
    const proc = Bun.spawn(['ss', '-tlnp'], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), 10_000);
    output = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
  } catch {
    output = '';
  }

  if (!output.trim()) {
    // A machine without `ss`, or a container that cannot see the host's sockets.
    // Saying so beats an empty list that reads like "nothing is open".
    return { ports: [], readable: false };
  }

  const published = publishedPorts();
  return {
    ports: parseListening(output).map((entry) => explainPort(entry.port, published, entry.process)),
    readable: true,
  };
}
