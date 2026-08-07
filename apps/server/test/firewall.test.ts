import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { caddy } from '../src/config.ts';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createDatabaseService, updateService } from '../src/db/repo/services.ts';
import { explainPort, parseListening, publishedPorts } from '../src/system/firewall.ts';

/**
 * Which ports are open, and what each one is.
 *
 * A description rather than a firewall. Derailed does not enable ufw or write iptables
 * rules, because a tool that manages a firewall on a remote server has exactly one
 * catastrophic failure mode, and it is locking the owner out of the machine it is
 * running on. What people actually want here is "what is this port and do I need it",
 * and that can be answered without touching anything.
 */

const SS_OUTPUT = `State   Recv-Q  Send-Q   Local Address:Port    Peer Address:Port Process
LISTEN  0       4096           0.0.0.0:22           0.0.0.0:*     users:(("sshd",pid=700,fd=3))
LISTEN  0       4096           0.0.0.0:80           0.0.0.0:*     users:(("caddy",pid=901,fd=7))
LISTEN  0       4096              [::]:443             [::]:*     users:(("caddy",pid=901,fd=9))
LISTEN  0       4096         127.0.0.1:2019          0.0.0.0:*    users:(("caddy",pid=901,fd=5))
LISTEN  0       4096           0.0.0.0:33061        0.0.0.0:*     users:(("docker-proxy",pid=222,fd=4))
LISTEN  0       511            0.0.0.0:9000         0.0.0.0:*
`;

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

describe('reading what is listening', () => {
  test('finds the port and the process on each line', () => {
    const found = parseListening(SS_OUTPUT);
    expect(found.map((entry) => entry.port)).toEqual([22, 80, 443, 9000, 33061]);
    expect(found.find((entry) => entry.port === 80)?.process).toBe('caddy');
  });

  test('leaves out anything bound to loopback, which is not open', () => {
    // Caddy's admin socket is on 127.0.0.1. Listing it would bury the ports that
    // matter under a dozen that are not reachable from anywhere.
    expect(parseListening(SS_OUTPUT).map((entry) => entry.port)).not.toContain(2019);
  });

  test('handles a line with no process, which is what an unprivileged read gives', () => {
    const found = parseListening(SS_OUTPUT).find((entry) => entry.port === 9000);
    expect(found).toBeDefined();
    expect(found?.process).toBeNull();
  });

  test('counts a port once when it is listening on both v4 and v6', () => {
    const both = `State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
LISTEN 0      4096         0.0.0.0:443        0.0.0.0:*   users:(("caddy",pid=1,fd=1))
LISTEN 0      4096            [::]:443           [::]:*   users:(("caddy",pid=1,fd=2))
`;
    expect(parseListening(both)).toHaveLength(1);
  });

  test('says nothing at all about a machine it cannot read', () => {
    expect(parseListening('')).toEqual([]);
  });
});

describe('what each port is for', () => {
  const nothing = new Map<number, { name: string; serviceId: string }>();

  test('the web ports are needed, and say which is which', () => {
    // Taken from the config rather than written as 80 and 443: in development they
    // are 8080 and 8443, and a test that hardcodes them is testing the environment.
    expect(explainPort(caddy.httpsPort, nothing, 'caddy').needed).toBe(true);
    expect(explainPort(caddy.httpsPort, nothing, 'caddy').what).toContain('HTTPS');
    expect(explainPort(caddy.httpPort, nothing, 'caddy').what).toContain('certificates');
  });

  test('SSH says plainly what closing it would do', () => {
    // The port people close by accident, with a consequence no web page can undo.
    const ssh = explainPort(22, nothing, 'sshd');
    expect(ssh.needed).toBe(true);
    expect(ssh.action).toContain('locks you out');
  });

  test('a published database names itself and says where to close it', () => {
    const project = createProject('Shop');
    const database = createDatabaseService({
      projectId: project.id,
      name: 'shop-db',
      engine: 'postgres',
      version: '17',
      dbName: 'shop',
      dbUser: 'derailed',
      dbPassword: 'secret',
      port: 5432,
    });
    updateService(database.id, { exposedPort: 33061 });

    const explained = explainPort(33061, publishedPorts(), 'docker-proxy');
    expect(explained.what).toContain('shop-db');
    expect(explained.needed).toBe(false);
    expect(explained.action).toContain('Connection tab');
    expect(explained.serviceId).toBe(database.id);
  });

  test('something Derailed did not open says so, rather than guessing', () => {
    // Guessing wrong here means telling somebody a port is safe to close when it is
    // the thing their business runs on.
    const unknown = explainPort(9000, nothing, 'gunicorn');
    expect(unknown.what).toContain('gunicorn');
    expect(unknown.what).toContain('Derailed did not open this');
    expect(unknown.needed).toBe(false);
    expect(unknown.action).toContain('find out what it is');
  });

  test('and still says something useful when the process is unknown', () => {
    expect(explainPort(9000, nothing, null).what).toContain('Something is listening');
  });
});
