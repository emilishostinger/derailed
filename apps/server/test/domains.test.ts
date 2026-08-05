/**
 * Phase 3's safety rules, without needing Docker or real DNS.
 *
 * Two of these matter a lot in production and are easy to regress:
 *   - a custom domain must not reach Caddy until DNS actually points here, or Caddy
 *     asks Let's Encrypt for a certificate it can never be issued, and repeated
 *     failures burn the account's rate limit;
 *   - the ready-made sslip.io hostnames must stay HTTP-only for the same reason.
 */
import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db/index.ts';
import { createDeployment, updateDeployment } from '../src/db/repo/deployments.ts';
import {
  allDomains,
  createDomain,
  deleteDomain,
  findDomainByHostname,
  updateDomainStatus,
} from '../src/db/repo/domains.ts';
import { createProject, deleteProject, listProjects } from '../src/db/repo/projects.ts';
import { createAppService, createDatabaseService, deleteService } from '../src/db/repo/services.ts';
import { SETTINGS, setSetting } from '../src/db/repo/settings.ts';
import { wwwVariant } from '../src/proxy/dns.ts';
import {
  generatedHostname,
  isIpBasedHostname,
  synthesizeCaddyConfig,
} from '../src/proxy/routes.ts';
import { currentRoutes } from '../src/proxy/sync.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-domains-'));

let projectId = '';
let serviceId = '';

beforeAll(() => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  setSetting(SETTINGS.serverIp, '203.0.113.7');
});

/** A project with one app that has a running deployment, so it is routable at all. */
beforeEach(() => {
  for (const project of listProjects()) deleteProject(project.id);
  // Domains you own outlive the app that used them, which is the point of them. The
  // clean slate this suite wants has to say so explicitly.
  for (const domain of allDomains()) deleteDomain(domain.id);

  projectId = createProject('Routing').id;
  serviceId = createAppService({
    projectId,
    name: 'web',
    repoUrl: 'https://github.com/example/app',
    branch: 'main',
  }).id;

  const deployment = createDeployment(serviceId, 'manual');
  updateDeployment(deployment.id, { status: 'running', containerId: 'abc123' });
});

describe('which domains reach Caddy', () => {
  test('a generated sslip.io address is routed immediately', () => {
    createDomain(serviceId, 'web.203-0-113-7.sslip.io', 'generated');

    const routes = currentRoutes();
    expect(routes.map((route) => route.hostname)).toEqual(['web.203-0-113-7.sslip.io']);
  });

  test('a generated address is served over plain HTTP, never HTTPS', () => {
    createDomain(serviceId, 'web.203-0-113-7.sslip.io', 'generated');

    const route = currentRoutes()[0];
    expect(route?.https).toBe(false);
  });

  test('a custom domain is NOT routed until its DNS points at this server', () => {
    const domain = createDomain(serviceId, 'shop.example.com', 'custom');

    // unchecked
    expect(currentRoutes()).toHaveLength(0);

    // pointing at someone else
    updateDomainStatus(domain.id, { dnsStatus: 'wrong_ip' });
    expect(currentRoutes()).toHaveLength(0);

    // no record at all
    updateDomainStatus(domain.id, { dnsStatus: 'no_record' });
    expect(currentRoutes()).toHaveLength(0);
  });

  test('a custom domain is routed, over HTTPS, once DNS is correct', () => {
    const domain = createDomain(serviceId, 'shop.example.com', 'custom');
    updateDomainStatus(domain.id, { dnsStatus: 'ok' });

    const routes = currentRoutes();
    expect(routes).toHaveLength(1);
    expect(routes[0]?.hostname).toBe('shop.example.com');
    expect(routes[0]?.https).toBe(true);
  });

  test('nothing is routed to a service that has no running deployment', () => {
    const idle = createAppService({
      projectId,
      name: 'idle',
      repoUrl: 'https://github.com/example/idle',
      branch: 'main',
    });
    const domain = createDomain(idle.id, 'idle.example.com', 'custom');
    updateDomainStatus(domain.id, { dnsStatus: 'ok' });

    // Routing it would give visitors a 502 instead of our plain-language 404.
    expect(currentRoutes().map((route) => route.hostname)).not.toContain('idle.example.com');
  });

  test('a database never gets routed even if a domain row somehow exists', () => {
    const database = createDatabaseService({
      projectId,
      name: 'postgres',
      engine: 'postgres',
      version: '17',
      dbName: 'app',
      dbUser: 'app',
      dbPassword: 'secret',
      port: 5432,
    });
    const domain = createDomain(database.id, 'db.example.com', 'custom');
    updateDomainStatus(domain.id, { dnsStatus: 'ok' });

    expect(currentRoutes().map((route) => route.hostname)).not.toContain('db.example.com');
  });
});

describe('the generated Caddy config', () => {
  test('keeps generated hostnames out of automatic HTTPS', () => {
    createDomain(serviceId, 'web.203-0-113-7.sslip.io', 'generated');
    const custom = createDomain(serviceId, 'shop.example.com', 'custom');
    updateDomainStatus(custom.id, { dnsStatus: 'ok' });

    const config = synthesizeCaddyConfig(currentRoutes(), {
      httpPort: 80,
      httpsPort: 443,
    });

    const server = Object.values(config.apps.http.servers)[0];
    expect(server?.automatic_https.skip).toContain('web.203-0-113-7.sslip.io');
    expect(server?.automatic_https.skip).not.toContain('shop.example.com');
  });

  test('always ends with the catch-all so an unknown host gets a real 404', () => {
    createDomain(serviceId, 'web.203-0-113-7.sslip.io', 'generated');

    const config = synthesizeCaddyConfig(currentRoutes(), {
      httpPort: 80,
      httpsPort: 443,
    });

    const server = Object.values(config.apps.http.servers)[0];
    const last = server?.routes.at(-1);
    expect(last?.match).toBeUndefined();
    expect(JSON.stringify(last)).toContain('Nothing is set up at this web address yet');
  });
});

describe('what happens to a domain when its app goes away', () => {
  test('the automatic address goes with it', () => {
    createDomain(serviceId, 'web.203-0-113-7.sslip.io', 'generated');
    deleteService(serviceId);
    expect(findDomainByHostname('web.203-0-113-7.sslip.io')).toBeNull();
  });

  test('a domain you own is kept, and freed for something else', () => {
    createDomain(serviceId, 'shop.example.com', 'custom', 'ok');
    deleteService(serviceId);

    const kept = findDomainByHostname('shop.example.com');
    expect(kept).not.toBeNull();
    expect(kept?.serviceId).toBeNull();
  });

  test('a freed domain is not routed anywhere', () => {
    createDomain(serviceId, 'shop.example.com', 'custom', 'ok');
    deleteService(serviceId);
    expect(currentRoutes().map((route) => route.hostname)).not.toContain('shop.example.com');
  });
});

describe('hostname helpers', () => {
  test('recognises addresses that spell out an IP, which cannot be secured', () => {
    expect(isIpBasedHostname('web.203-0-113-7.sslip.io')).toBe(true);
    expect(isIpBasedHostname('shop.example.com')).toBe(false);
  });

  test('hands out an address on the base domain when there is one', () => {
    expect(generatedHostname('web', '203.0.113.7')).toBe('web.203-0-113-7.sslip.io');
    expect(generatedHostname('web', '203.0.113.7', 'apps.example.com')).toBe(
      'web.apps.example.com',
    );
  });

  test('offers the www variant for an apex domain', () => {
    expect(wwwVariant('example.com')).toBe('www.example.com');
  });

  test('does not offer a www variant for something that already has a subdomain', () => {
    expect(wwwVariant('shop.example.com')).toBeNull();
    expect(wwwVariant('www.example.com')).toBeNull();
  });
});
