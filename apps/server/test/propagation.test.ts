import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ServerEvent } from '@derailed/shared';
import { closeDb, initDb } from '../src/db/index.ts';
import { createDomain, updateDomainStatus } from '../src/db/repo/domains.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { onPublish } from '../src/events/bus.ts';
import { announce } from '../src/proxy/domainwatch.ts';
import { currentRoutes } from '../src/proxy/sync.ts';

/**
 * Not asking for a certificate that can never be issued.
 *
 * Caddy will keep asking Let's Encrypt for a certificate for any name it is told to
 * serve over https, and Let's Encrypt counts failures: five failed validations for a
 * hostname in an hour and it stops answering for the rest of it. So a name that does
 * not resolve here must not reach the proxy at all, and that rule is worth a test
 * because it is one `continue` in the middle of a function that keeps growing.
 */

beforeEach(() => {
  initDb(':memory:');
});

afterEach(() => {
  closeDb();
});

function anAppWithDomain(hostname: string, dnsStatus: 'ok' | 'no_record' | 'wrong_ip') {
  const project = createProject('Shop');
  const service = createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'nginx:alpine',
    repoUrl: null,
    branch: null,
  });
  const domain = createDomain(service.id, hostname, 'custom');
  updateDomainStatus(domain.id, { dnsStatus, tlsStatus: 'pending', checked: true });
  return { service, domain };
}

describe('which domains reach the proxy', () => {
  test('a domain that does not resolve anywhere is not served', () => {
    anAppWithDomain('example.com', 'no_record');
    expect(currentRoutes().map((route) => route.hostname)).not.toContain('example.com');
  });

  test('a domain that resolves somewhere else is not served either', () => {
    // This is the one that costs something: the name works, so Caddy would try, and
    // every attempt is a failed validation counted against the hour.
    anAppWithDomain('example.com', 'wrong_ip');
    expect(currentRoutes().map((route) => route.hostname)).not.toContain('example.com');
  });
});

/**
 * Setting up a domain means going away to somebody else's website, changing a record,
 * and coming back not knowing whether it took. These two moments are the ones worth
 * interrupting for, and both are announced on the change rather than on the state, or
 * a server that has been up for a month would say them on every sweep.
 */
describe('saying so when a domain starts working', () => {
  /** Captures what the watcher would publish for a given before/after pair. */
  async function noticesFor(
    before: { dnsStatus: 'no_record' | 'ok'; tlsStatus: 'pending' | 'active' },
    after: { dnsStatus: 'no_record' | 'ok'; tlsStatus: 'pending' | 'active' },
  ) {
    const seen: ServerEvent[] = [];
    const stop = onPublish((_topic, event) => {
      if (event.type === 'notice') seen.push(event);
    });

    announce(
      { hostname: 'example.com', ...before } as never,
      { hostname: 'example.com', ...after } as never,
    );
    stop();
    return seen.map((event) => (event.type === 'notice' ? event.message : ''));
  }

  test('says when it starts pointing here', async () => {
    const notices = await noticesFor(
      { dnsStatus: 'no_record', tlsStatus: 'pending' },
      { dnsStatus: 'ok', tlsStatus: 'pending' },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('now points at this server');
  });

  test('says again when the padlock arrives', async () => {
    const notices = await noticesFor(
      { dnsStatus: 'ok', tlsStatus: 'pending' },
      { dnsStatus: 'ok', tlsStatus: 'active' },
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('live, with a padlock');
  });

  test('says both when a check catches up on both at once', async () => {
    const notices = await noticesFor(
      { dnsStatus: 'no_record', tlsStatus: 'pending' },
      { dnsStatus: 'ok', tlsStatus: 'active' },
    );
    expect(notices).toHaveLength(2);
  });

  test('stays quiet when nothing changed', async () => {
    // Every thirty seconds, for as long as the server is up. This is the difference
    // between a notification and a nuisance.
    expect(
      await noticesFor(
        { dnsStatus: 'ok', tlsStatus: 'active' },
        { dnsStatus: 'ok', tlsStatus: 'active' },
      ),
    ).toEqual([]);
    expect(
      await noticesFor(
        { dnsStatus: 'no_record', tlsStatus: 'pending' },
        { dnsStatus: 'no_record', tlsStatus: 'pending' },
      ),
    ).toEqual([]);
  });

  test('stays quiet when a working domain stops working', async () => {
    // Losing DNS is worth knowing about, but it is the alerts feature's job and it
    // has channels and a send-on-change discipline. A toast in a dashboard nobody is
    // looking at is not a way to be told your site is down.
    expect(
      await noticesFor(
        { dnsStatus: 'ok', tlsStatus: 'active' },
        { dnsStatus: 'no_record', tlsStatus: 'pending' },
      ),
    ).toEqual([]);
  });
});
