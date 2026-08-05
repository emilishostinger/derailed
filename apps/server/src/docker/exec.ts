import { connect } from 'node:net';
import { dockerSocket } from '../config.ts';
import { dockerJson } from './client.ts';

/**
 * An interactive shell inside a running container.
 *
 * Docker's exec API hijacks the HTTP connection and hands back a raw bidirectional
 * stream, which `fetch` cannot express. So this speaks HTTP/1.1 over the unix socket
 * by hand (one small, well-understood request) and then treats the socket as a pipe.
 */
export interface ExecSession {
  write(data: string): void;
  resize(cols: number, rows: number): Promise<void>;
  close(): void;
}

export interface ExecOptions {
  containerId: string;
  cmd: string[];
  onData: (chunk: string) => void;
  onClose: () => void;
}

/** Shells, most-preferred first. Alpine images have no bash; scratch images have neither. */
export const SHELL_CANDIDATES = ['/bin/bash', '/bin/sh'];

export async function createExec(options: ExecOptions): Promise<ExecSession> {
  const { Id } = await dockerJson<{ Id: string }>(`/containers/${options.containerId}/exec`, {
    method: 'POST',
    json: {
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: options.cmd,
      Env: ['TERM=xterm-256color'],
    },
  });

  const socket = connect(dockerSocket);
  let closed = false;

  const done = () => {
    if (closed) return;
    closed = true;
    options.onClose();
    socket.destroy();
  };

  await new Promise<void>((resolve, reject) => {
    socket.once('error', reject);
    socket.once('connect', () => {
      const body = JSON.stringify({ Detach: false, Tty: true });
      socket.write(
        `POST /v1.44/exec/${Id}/start HTTP/1.1\r\n` +
          'Host: docker\r\n' +
          'Content-Type: application/json\r\n' +
          'Connection: Upgrade\r\n' +
          'Upgrade: tcp\r\n' +
          `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
          body,
      );
      resolve();
    });
  });

  // Everything before the blank line is the HTTP response to the upgrade; after it,
  // the socket is the terminal.
  let headersDone = false;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk: Buffer) => {
    if (headersDone) {
      options.onData(chunk.toString('utf8'));
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    const split = buffer.indexOf('\r\n\r\n');
    if (split < 0) return;
    headersDone = true;
    const rest = buffer.subarray(split + 4);
    buffer = Buffer.alloc(0);
    if (rest.length) options.onData(rest.toString('utf8'));
  });

  socket.on('close', done);
  socket.on('error', done);

  return {
    write(data) {
      if (!closed) socket.write(data);
    },
    async resize(cols, rows) {
      // Without this, anything full-screen (top, a pager, an editor) draws at 80x24.
      await dockerJson(`/exec/${Id}/resize?h=${rows}&w=${cols}`, { method: 'POST' }).catch(
        () => undefined,
      );
    },
    close: done,
  };
}

/**
 * The command to run for a given service. Dropping a non-technical person at a bare
 * `#` prompt inside a database container helps nobody; putting them straight into
 * `psql` is the thing they actually wanted.
 */
export function shellCommandFor(
  engine: string | null,
  credentials?: {
    user: string;
    dbName: string;
    password: string;
  },
): { cmd: string[]; label: string } {
  if (engine && credentials) {
    if (engine === 'postgres') {
      return {
        cmd: [
          'sh',
          '-c',
          `PGPASSWORD='${credentials.password}' psql -U '${credentials.user}' -d '${credentials.dbName}'`,
        ],
        label: 'psql',
      };
    }
    if (engine === 'mysql' || engine === 'mariadb') {
      return {
        cmd: [
          'sh',
          '-c',
          `mysql -u '${credentials.user}' -p'${credentials.password}' '${credentials.dbName}'`,
        ],
        label: 'mysql',
      };
    }
    if (engine === 'redis') {
      return { cmd: ['redis-cli'], label: 'redis-cli' };
    }
  }
  // Try bash, fall back to sh. The image may have neither, and the terminal will
  // simply close, which the UI explains.
  return {
    cmd: ['/bin/sh', '-c', 'exec /bin/bash 2>/dev/null || exec /bin/sh'],
    label: 'shell',
  };
}
