import { beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uploadDir } from '../src/build/upload.ts';
import { initDb } from '../src/db/index.ts';
import { setEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createApp } from '../src/http/app.ts';
import { mayCall } from '../src/http/permissions.ts';
import { runScan, scanText, summarizeTrivy, WEAK_SECRETS } from '../src/system/scan.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

/**
 * Is anything leaking or known-broken?
 *
 * A live password reached this very repository once and was caught by luck. These
 * tests are the luck, built in: key-shaped strings must be found in files, the
 * password nobody changed must be called out, a secret leading a double life
 * (env var and file at once) must be caught, and documentation examples must NOT
 * be flagged, because a scanner that cries wolf twice is one nobody reads a third
 * time.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-scan-test-'));
let app: ReturnType<typeof createApp>;

// Shaped like the real things, invented for this test.
const FAKE_AWS = 'AKIA'.concat('IOSFODNN7DERAIL0');
const FAKE_GITHUB = 'ghp_'.concat('a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  await app.request('/api/auth/setup', {
    method: 'POST',
    headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
  });
});

describe('things shaped like live keys', () => {
  test('are recognised in text, with the place named', () => {
    const found = scanText(
      `config:\n  aws_key: ${FAKE_AWS}\n  fine: nothing here\n`,
      (line) => `config.yml:${line}`,
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.patternId).toBe('aws-key');
    expect(found[0]!.where).toBe('config.yml:2');
  });

  test('a documentation example is left alone', () => {
    const found = scanText(
      `# example: AKIAIOSFODNN7EXAMPLE\naws_key: AKIAIOSFODNN7REALKEY # this is an example\n`,
      (line) => `readme.md:${line}`,
    );
    expect(found).toHaveLength(0);
  });

  test('a database address with its password written in is caught', () => {
    const found = scanText(
      'DATABASE_URL=postgres://shop:s3cr3tpass@db.internal:5432/shop\n',
      (line) => `.env:${line}`,
    );
    expect(found.some((entry) => entry.patternId === 'url-password')).toBe(true);
  });

  test('a private key announces itself', () => {
    const found = scanText('-----BEGIN OPENSSH PRIVATE KEY-----\n', (line) => `id_ed25519:${line}`);
    expect(found.some((entry) => entry.patternId === 'private-key')).toBe(true);
  });
});

describe('the whole scan', () => {
  test('finds a key in uploaded files, a password nobody changed, and a double life', async () => {
    const project = createProject('Scan me');
    const service = createAppService({
      projectId: project.id,
      name: 'Shop',
      source: 'upload',
      repoUrl: null,
      branch: null,
    });

    // The uploaded files hold a key, and a copy of a value that is also a variable.
    const files = uploadDir(service.id);
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'settings.py'), `AWS_KEY = "${FAKE_AWS}"\n`);
    writeFileSync(join(files, 'deploy.sh'), `export TOKEN=${FAKE_GITHUB}\n`);
    mkdirSync(join(files, 'node_modules'), { recursive: true });
    writeFileSync(
      join(files, 'node_modules', 'planted.js'),
      // A key inside node_modules is a dependency's test fixture, not your leak.
      'const key = "AKIA'.concat('IOSFODNN7SKIPME00";\n'),
    );

    setEnv(service.id, 'ADMIN_PASSWORD', 'changeme');
    setEnv(service.id, 'GITHUB_TOKEN', FAKE_GITHUB);

    const scan = await runScan();

    const kinds = scan.findings.map((finding) => finding.kind);
    expect(kinds).toContain('repo-secret');
    expect(kinds).toContain('env-weak');
    expect(kinds).toContain('env-in-repo');

    const weak = scan.findings.find((finding) => finding.kind === 'env-weak')!;
    expect(weak.verdict).toContain('ADMIN_PASSWORD');
    expect(weak.verdict).toContain('changeme');

    const doubled = scan.findings.find((finding) => finding.kind === 'env-in-repo')!;
    expect(doubled.verdict).toContain('GITHUB_TOKEN');
    expect(doubled.where).toContain('deploy.sh');

    // The full key never appears anywhere in the report.
    const raw = JSON.stringify(scan);
    expect(raw).not.toContain(FAKE_AWS);
    expect(raw).not.toContain('SKIPME');

    // What was looked at is on the report, so "nothing found" would carry weight.
    expect(scan.checked.repos).toBe(1);
    expect(scan.checked.envVars).toBeGreaterThanOrEqual(2);

    // Finding ids are stable, so "new since last scan" means something.
    const again = await runScan();
    expect(again.findings.map((finding) => finding.id).sort()).toEqual(
      scan.findings.map((finding) => finding.id).sort(),
    );
  });

  test('the last run is kept and served', async () => {
    const setup = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'x-requested-with': 'derailed', 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-horse' }),
    });
    const cookie = (setup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    const response = await app.request('/api/system/scan', {
      headers: { 'x-requested-with': 'derailed', cookie },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { scan: { findings: unknown[] } | null };
    expect(body.scan).not.toBeNull();
    expect(body.scan!.findings.length).toBeGreaterThan(0);
  });
});

describe('who may look', () => {
  test('the report is a map to the secrets, so viewers are refused', () => {
    expect(mayCall('viewer', 'GET', '/api/system/scan').ok).toBe(false);
    expect(mayCall('member', 'GET', '/api/system/scan').ok).toBe(true);
  });

  test('running one is changing what the server does, so it is an owner button', () => {
    // Covered by the standing "/system writes are an owner's" rule; pinned here so
    // loosening that rule someday does not quietly hand members a repo-cloning button.
    expect(mayCall('member', 'POST', '/api/system/scan').ok).toBe(false);
    expect(mayCall('viewer', 'POST', '/api/system/scan').ok).toBe(false);
    expect(mayCall('owner', 'POST', '/api/system/scan').ok).toBe(true);
  });
});

describe('the image half', () => {
  test('a Trivy report is reduced to the counts that matter', () => {
    const summary = summarizeTrivy({
      Results: [
        {
          Vulnerabilities: [
            { VulnerabilityID: 'CVE-1', Severity: 'CRITICAL', FixedVersion: '1.2.3' },
            { VulnerabilityID: 'CVE-2', Severity: 'HIGH' },
            { VulnerabilityID: 'CVE-3', Severity: 'HIGH', FixedVersion: '2.0.0' },
          ],
        },
        { Vulnerabilities: [{ VulnerabilityID: 'CVE-4', Severity: 'CRITICAL' }] },
      ],
    });
    expect(summary).toEqual({ critical: 2, high: 2, fixable: 2 });
  });

  test('an empty report is an honest zero', () => {
    expect(summarizeTrivy({})).toEqual({ critical: 0, high: 0, fixable: 0 });
  });
});

describe('the passwords nobody changed', () => {
  test('the list holds the classics', () => {
    for (const classic of ['changeme', 'password', 'admin', '123456']) {
      expect(WEAK_SECRETS.has(classic)).toBe(true);
    }
  });
});
