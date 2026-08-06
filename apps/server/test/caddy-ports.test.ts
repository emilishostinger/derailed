import { describe, expect, test } from 'bun:test';
import { caddyAdminOverSocket } from '../src/config.ts';
import { caddyAdminListen, explainPortConflict } from '../src/proxy/caddy.ts';

/**
 * Starting the proxy when the machine is not empty.
 *
 * All of this exists because of one failure that is genuinely hard to diagnose from
 * the outside: a proxy that is running, has its ports mapped, and answers nothing.
 * Two separate causes were found, and both are covered here.
 */

describe('explaining a port that is taken', () => {
  test('recognises what Docker says when a published port is gone', () => {
    const message = explainPortConflict(
      new Error(
        'failed to set up container networking: driver failed programming external ' +
          'connectivity on endpoint derailed-caddy (abc123): Bind for 0.0.0.0:8080 ' +
          'failed: port is already allocated',
      ),
    );
    expect(message).toContain('Port 8080');
    // The point of the message is the next action, not the diagnosis.
    expect(message).toContain('Apache or nginx');
  });

  test('recognises the other wording Docker uses, on loopback', () => {
    const message = explainPortConflict(
      new Error(
        'ports are not available: exposing port TCP 127.0.0.1:2019 -> 127.0.0.1:0: ' +
          'listen tcp4 127.0.0.1:2019: bind: address already in use',
      ),
    );
    expect(message).toContain('Port 2019');
  });

  test('still says something useful when it cannot find the port number', () => {
    const message = explainPortConflict(new Error('bind: address already in use'));
    expect(message).toContain('already being used');
  });

  test('keeps out of the way of every other kind of failure', () => {
    expect(explainPortConflict(new Error('no such image: caddy:2-alpine'))).toBeNull();
    expect(explainPortConflict(new Error('permission denied'))).toBeNull();
    expect(explainPortConflict('something odd')).toBeNull();
  });
});

describe('where the admin API is told to listen', () => {
  test('is the port inside the container, never the one published on the host', () => {
    // The two used to be the same number, and the bug that hid in that was fatal: move
    // the host port, and Caddy was told to listen somewhere the mapping did not point,
    // leaving a proxy that runs and cannot be reached for the rest of its life.
    const listen = caddyAdminListen();
    if (caddyAdminOverSocket) {
      expect(listen).toStartWith('unix/');
    } else {
      expect(listen).toBe('0.0.0.0:2019');
    }
  });
});
