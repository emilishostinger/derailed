import type { ServerWebSocket } from 'bun';
import { findEngine } from '../catalog/databases.ts';
import { findService } from '../db/repo/services.ts';
import { inspectContainer, listContainers } from '../docker/containers.ts';
import { LABELS, labelFilter } from '../docker/labels.ts';

/**
 * A tunnel to your database from your laptop.
 *
 * `derailed tunnel blog-db`, and TablePlus connects to localhost. No port is opened
 * to the internet: the laptop holds a websocket to the panel, the panel dials the
 * database container over the project network it already sits on, and the bytes flow
 * both ways. Every connection is a websocket the audit log and the token check have
 * already seen, which is the difference between this and publishing the port.
 *
 * The panel reaches the container by its address on the Docker network, the same
 * way Caddy reaches every app. That address is a private one, so this is a door for
 * the owner's own laptop, not a hole in the wall.
 */

export interface TunnelData {
  kind: 'tunnel';
  serviceId: string;
  target: { host: string; port: number };
  socket?: import('bun').Socket<undefined>;
  /** Bytes that arrived before the TCP socket finished opening. */
  pending: Uint8Array[];
  /** Total size of `pending`, in bytes, so the cap bounds memory not message count. */
  pendingBytes: number;
  open: boolean;
}

export class TunnelError extends Error {}

/**
 * Where a database answers, on the network the panel shares with it.
 *
 * The host is the container's own IP on its project network (Linux servers can
 * reach it directly, the same assumption the whole managed-network design rests
 * on); the port is the engine's standard one, read from the catalogue rather than
 * from anything the caller sent.
 */
export async function tunnelTargetFor(serviceId: string): Promise<{ host: string; port: number }> {
  const service = findService(serviceId);
  if (!service) throw new TunnelError('That database no longer exists.');
  if (service.kind !== 'database') {
    throw new TunnelError('Tunnels are for databases. An app is reached at its web address.');
  }
  const engine = findEngine(service.dbEngine ?? '');
  if (!engine) throw new TunnelError('Derailed does not know how to reach that engine.');

  const containers = await listContainers(labelFilter({ [LABELS.service]: serviceId })).catch(
    () => [],
  );
  const running = containers.find((container) => container.State === 'running');
  if (!running) {
    throw new TunnelError('That database is not running, so there is nothing to connect to.');
  }
  const inspected = await inspectContainer(running.Id);
  const networks = inspected?.NetworkSettings.Networks ?? {};
  const ip = Object.values(networks).find((entry) => entry.IPAddress)?.IPAddress;
  if (!ip) {
    throw new TunnelError('That database is running but has no network address yet.');
  }
  return { host: ip, port: engine.port };
}

/**
 * How much unsent data a not-yet-connected tunnel may hold, in bytes.
 *
 * A byte ceiling rather than a message count. `MAX_PENDING = 256` capped how many
 * websocket frames could queue, but each frame is unbounded, so 256 frames of a
 * megabyte each was 256 MB the cap said nothing about. Dialing a container on the
 * local Docker network is near-instant, so a real client sends almost nothing before
 * the socket opens; a couple of megabytes is a generous window and a cheap ceiling.
 */
const MAX_PENDING_BYTES = 2 * 1024 * 1024;

/**
 * The bridge, once the socket is upgraded: dial the database, then pipe.
 *
 * Bytes from the laptop that arrive before the TCP connection is up are held (a
 * bounded buffer, so a flood cannot grow it without limit) and flushed on connect.
 * Either side closing closes the other, so a tunnel never half-lingers.
 */
export const tunnelHandlers = {
  async open(ws: ServerWebSocket<TunnelData>): Promise<void> {
    ws.data.pending = [];
    ws.data.pendingBytes = 0;
    ws.data.open = false;
    try {
      const { host, port } = ws.data.target;
      ws.data.socket = await Bun.connect({
        hostname: host,
        port,
        socket: {
          data(_socket, chunk) {
            try {
              ws.sendBinary(chunk);
            } catch {
              // the websocket is gone; the close below will tidy up
            }
          },
          open(socket) {
            ws.data.open = true;
            for (const chunk of ws.data.pending) socket.write(chunk);
            ws.data.pending = [];
            ws.data.pendingBytes = 0;
          },
          close() {
            try {
              ws.close();
            } catch {
              // already closed
            }
          },
          error() {
            try {
              ws.close();
            } catch {
              // already closed
            }
          },
        },
      });
    } catch {
      try {
        ws.close(1011, 'the database could not be reached');
      } catch {
        // already closed
      }
    }
  },

  message(ws: ServerWebSocket<TunnelData>, raw: string | Buffer): void {
    const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw;
    const socket = ws.data.socket;
    if (ws.data.open && socket) {
      socket.write(chunk);
      return;
    }
    // Not connected yet: hold a little, then give up rather than grow without bound.
    // The limit is on total held bytes, so one enormous frame trips it just as a
    // flood of small ones would.
    if (ws.data.pendingBytes + chunk.length <= MAX_PENDING_BYTES) {
      ws.data.pending.push(new Uint8Array(chunk));
      ws.data.pendingBytes += chunk.length;
    } else {
      try {
        ws.close(1011, 'too much data before the connection opened');
      } catch {
        // already closed
      }
    }
  },

  close(ws: ServerWebSocket<TunnelData>): void {
    try {
      ws.data.socket?.end();
    } catch {
      // already closed
    }
  },
};
