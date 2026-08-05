/**
 * Test preload (see bunfig.toml): every test run gets its own throwaway data dir,
 * set before src/config.ts is imported anywhere.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DERAILED_DATA ??= mkdtempSync(join(tmpdir(), 'derailed-test-'));
process.env.DERAILED_DEV = '1';

// The Nixpacks binary is 20 MB and lives under the data dir, so a fresh temp dir per
// run means downloading it again every time, and the test that uses it timing out on
// any connection that is not fast. Cached once per machine instead.
const nixpacksCache = join(tmpdir(), 'derailed-nixpacks-cache');
mkdirSync(nixpacksCache, { recursive: true });
process.env.DERAILED_BIN ??= nixpacksCache;

// Integration tests drive a real Caddy container. Give it its own name, network and
// ports so a test run never touches a Derailed install on the same machine.
process.env.DERAILED_CADDY_NAME ??= 'derailed-test-caddy';
process.env.DERAILED_CADDY_NETWORK ??= 'derailed-test-proxy';
process.env.DERAILED_CADDY_HTTP ??= '18080';
process.env.DERAILED_CADDY_HTTPS ??= '18443';
process.env.DERAILED_CADDY_ADMIN ??= '12019';
