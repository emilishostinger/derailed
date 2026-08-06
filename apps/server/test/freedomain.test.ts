import { describe, expect, test } from 'bun:test';
import { expectedDigest, legoTarget, needsRenewal, parseNotAfter } from '../src/proxy/acme.ts';
import { hostnameFor, isValidName, normalizeName } from '../src/proxy/duckdns.ts';
import { synthesizeCaddyConfig } from '../src/proxy/routes.ts';

/**
 * The free secured address.
 *
 * The parsing tests matter more than they look: reading the expiry out of a
 * certificate by hand is the one piece here with no library behind it, and getting it
 * wrong means either renewing every twelve hours for ever or never renewing at all.
 */

describe('duckdns names', () => {
  test('takes the bare label out of whatever was pasted', () => {
    for (const input of [
      'mybox',
      'MyBox',
      '  mybox  ',
      'mybox.duckdns.org',
      'mybox.duckdns.org.',
      'https://mybox.duckdns.org',
      'https://mybox.duckdns.org/some/path',
    ]) {
      expect(normalizeName(input)).toBe('mybox');
    }
  });

  test('builds the full hostname', () => {
    expect(hostnameFor('mybox.duckdns.org')).toBe('mybox.duckdns.org');
    expect(hostnameFor('MyBox')).toBe('mybox.duckdns.org');
  });

  test('rejects things that are not a single label', () => {
    for (const bad of ['', '-nope', 'nope-', 'has.a.dot', 'has space', 'UPPER!', 'x'.repeat(64)]) {
      expect(isValidName(normalizeName(bad))).toBe(false);
    }
    // Every length from one to sixty-three is a legal label, and refusing one DuckDNS
    // would have given out is a worse mistake than passing one it turns down.
    for (const good of ['a', 'ab', 'my-box', 'box123', 'x'.repeat(63)]) {
      expect(isValidName(good)).toBe(true);
    }
  });
});

describe('certificate expiry', () => {
  // A real self-signed certificate, valid 2026-08-06 to 2026-11-04 18:38:25 UTC.
  // Generated with openssl, so the bytes are what a certificate actually looks like
  // rather than what we imagine one looks like.
  const PEM = `-----BEGIN CERTIFICATE-----
MIIDLTCCAhWgAwIBAgIUNBbTd5EbSFOKht3ZkEEUojnn7sUwDQYJKoZIhvcNAQEL
BQAwJjEkMCIGA1UEAwwbKi5kZXJhaWxlZC10ZXN0LmR1Y2tkbnMub3JnMB4XDTI2
MDgwNjE4MzgyNVoXDTI2MTEwNDE4MzgyNVowJjEkMCIGA1UEAwwbKi5kZXJhaWxl
ZC10ZXN0LmR1Y2tkbnMub3JnMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKC
AQEAuCv61xWUkAzP6gXHWz2wJsADluwsxPrrx0/izk+OoQPIt2lZv9gfSM7NhtCD
2jIb3X8dyqJBi6L1h+KajkMUWhGVfb9Wv8x4dqbehlvqK6poqqZ1VqfcrvXahN2c
LyjW+vMJ4Z0BVOzUiMKB5feKoQpgGEvYsE42SAk6wbVE3QdQDhEF1wBpSHLtAn9z
0aml60XkOQeNduz48k+2BkfyA5QBQ0anijCi+ymdfaN1ICd3pzztHS+nUqpjbbMd
ldnpUUSh4gnG1Q5Uj7FZY1w7G3K4FINKdNhQeo0D/OUjsfoxjnfYVOMLDjFAUNDE
DiyfB35SNraGhscLEV+ZltwVVwIDAQABo1MwUTAdBgNVHQ4EFgQUq76HicJiQYSz
2dj/EeNqwQIOZKEwHwYDVR0jBBgwFoAUq76HicJiQYSz2dj/EeNqwQIOZKEwDwYD
VR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAfs8n4A/yByZRcLu5Ondz
sWap1NSU98TDRll0bJmClxJ/G/FJXerYzEwrJscJ2W0cEgdt4M3GCOmKPU2VWwxh
Xxo+nIpWuSOcZwrL0WO1FJwVYMqi7gOqoO0JohysDrNBp9iZNxVslstmjDwY82o4
uMlC3h75y7/AtgMFzlbkYqdOfHjaseSYACOFT7ZoxnxVvQIY2fGxsgUjX71lZOGR
DiUyWira7FC9Jk5fAfwbbG9Q1wDmSdcDEfk26tJwhRsLRvnuj2aHoTcoe33jfF4V
Ol+TFRLJ4yandAZxwoX39MUGY0zZgNfxFBncncmJzZ4p8SUuPLZYHzXrHtrjKeTt
Bw==
-----END CERTIFICATE-----`;

  test('reads the expiry, not the start date', () => {
    expect(parseNotAfter(PEM)).toBe(Date.UTC(2026, 10, 4, 18, 38, 25));
  });

  test('agrees with openssl on a freshly made certificate', async () => {
    // Independent confirmation, skipped where openssl is not installed rather than
    // failing: this checks our parser against a real one, it is not a Derailed bug
    // if the machine running the suite has no openssl.
    const dir = `${process.env.TMPDIR ?? '/tmp'}/derailed-cert-${Date.now()}`;
    const made = Bun.spawnSync([
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-keyout',
      `${dir}.key`,
      '-out',
      `${dir}.crt`,
      '-days',
      '47',
      '-nodes',
      '-subj',
      '/CN=example.test',
    ]);
    if (made.exitCode !== 0) return;

    const read = Bun.spawnSync(['openssl', 'x509', '-in', `${dir}.crt`, '-noout', '-enddate']);
    const stated = read.stdout.toString().trim().replace('notAfter=', '');
    const ours = parseNotAfter(await Bun.file(`${dir}.crt`).text());

    expect(ours).not.toBeNull();
    expect(ours).toBe(new Date(`${stated} UTC`).getTime());
  });

  test('says nothing rather than guessing when the input is not a certificate', () => {
    expect(parseNotAfter('')).toBeNull();
    expect(parseNotAfter('-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----'));
    expect(parseNotAfter('hello')).toBeNull();
  });
});

describe('renewal timing', () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.UTC(2026, 0, 1);

  test('renews inside the last thirty days', () => {
    expect(needsRenewal(now + 29 * day, now)).toBe(true);
    expect(needsRenewal(now + 31 * day, now)).toBe(false);
  });

  test('treats an expired or missing certificate as needing one', () => {
    expect(needsRenewal(now - day, now)).toBe(true);
    expect(needsRenewal(null, now)).toBe(true);
  });
});

describe('the pinned certificate tool', () => {
  test('has a checked build for every platform Derailed runs on', () => {
    for (const target of ['linux_amd64', 'linux_arm64']) {
      expect(expectedDigest(target)).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('names the asset this machine would download', () => {
    expect(legoTarget()).toMatch(/^(linux|darwin)_(amd64|arm64)$/);
  });

  test('refuses a platform it has no digest for', () => {
    expect(expectedDigest('plan9_sparc')).toBeNull();
  });
});

describe('serving a certificate we obtained ourselves', () => {
  const options = { httpPort: 80, httpsPort: 443 };

  test('tells Caddy not to go looking for one it already has', () => {
    const config = synthesizeCaddyConfig(
      [
        {
          hostname: 'blog.mybox.duckdns.org',
          upstream: 'c1',
          port: 3000,
          https: true,
          providedCert: true,
        },
        { hostname: 'shop.example.com', upstream: 'c2', port: 3000, https: true },
      ],
      {
        ...options,
        certificates: [{ certificate: '/certs/x.crt', key: '/certs/x.key' }],
      },
    );

    const server = config.apps.http.servers.derailed;
    // Ours is skipped, the real domain is left to Caddy as before.
    expect(server?.automatic_https.skip_certificates).toEqual(['blog.mybox.duckdns.org']);
    expect(config.apps.tls?.certificates.load_files).toEqual([
      { certificate: '/certs/x.crt', key: '/certs/x.key' },
    ]);
  });

  test('leaves the tls section out entirely when there is nothing to load', () => {
    const config = synthesizeCaddyConfig(
      [{ hostname: 'shop.example.com', upstream: 'c1', port: 3000, https: true }],
      options,
    );
    // Naming a file Caddy cannot open makes it reject the whole config, which would
    // take every site down over a feature nobody had set up.
    expect(config.apps.tls).toBeUndefined();
    expect(config.apps.http.servers.derailed?.automatic_https.skip_certificates).toBeUndefined();
  });

  test('still keeps plain-HTTP addresses out of HTTPS altogether', () => {
    const config = synthesizeCaddyConfig(
      [{ hostname: 'app.203-0-113-9.sslip.io', upstream: 'c1', port: 3000, https: false }],
      options,
    );
    const server = config.apps.http.servers.derailed;
    expect(server?.automatic_https.skip).toEqual(['app.203-0-113-9.sslip.io']);
    expect(server?.automatic_https.skip_certificates).toBeUndefined();
  });
});
