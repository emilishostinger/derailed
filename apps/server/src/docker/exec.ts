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
  /** Extra `KEY=value` entries. Secrets belong here, never inside `cmd`. */
  env?: string[];
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
      Env: ['TERM=xterm-256color', ...(options.env ?? [])],
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
): { cmd: string[]; env: string[]; label: string } {
  if (engine && credentials) {
    // No `sh -c` and no quoting: the arguments go to `exec` as a list, so nothing in a
    // credential can be read as shell. Derailed generates these passwords itself out
    // of letters and digits, so there is nothing to escape today, and this is here so
    // that stays true if they ever come from somewhere else.
    if (engine === 'postgres') {
      return {
        cmd: ['psql', '-U', credentials.user, '-d', credentials.dbName],
        env: [`PGPASSWORD=${credentials.password}`],
        label: 'psql',
      };
    }
    if (engine === 'mysql') {
      return {
        cmd: ['mysql', '-u', credentials.user, credentials.dbName],
        env: [`MYSQL_PWD=${credentials.password}`],
        label: 'mysql',
      };
    }
    if (engine === 'mariadb') {
      // The `mysql` name is a symlink that recent MariaDB images have dropped.
      return {
        cmd: ['mariadb', '-u', credentials.user, credentials.dbName],
        env: [`MYSQL_PWD=${credentials.password}`],
        label: 'mariadb',
      };
    }
    if (engine === 'mongodb') {
      return {
        cmd: [
          'mongosh',
          '--username',
          credentials.user,
          '--password',
          credentials.password,
          '--authenticationDatabase',
          'admin',
          credentials.dbName,
        ],
        env: [],
        label: 'mongosh',
      };
    }
    // `REDISCLI_AUTH` rather than `-a`, for the reason at the top of this branch: a
    // password in the argument list is a password in `ps`. Both names are set because
    // Valkey's fork of the tool answers to its own. An unauthenticated `redis-cli`
    // used to be what opened here, which connected and then refused every command
    // typed into it with NOAUTH.
    if (engine === 'redis' || engine === 'valkey') {
      const tool = engine === 'valkey' ? 'valkey-cli' : 'redis-cli';
      return {
        cmd: [tool],
        env: [`REDISCLI_AUTH=${credentials.password}`, `VALKEYCLI_AUTH=${credentials.password}`],
        label: tool,
      };
    }
  }
  // Try bash, fall back to sh. The image may have neither, and the terminal will
  // simply close, which the UI explains.
  return {
    cmd: ['/bin/sh', '-c', 'exec /bin/bash 2>/dev/null || exec /bin/sh'],
    env: [],
    label: 'shell',
  };
}
