/**
 * The server updating itself.
 *
 * `derailed update` reaches GitHub, downloads the binary for this machine's
 * architecture and libc, checks it against the published checksums, and swaps it into
 * place. It is the most dangerous thing the product does to itself: the file it
 * replaces is the one running as root, on a machine whose service is set to restart it
 * forever, so a mistake here does not fail one request, it bricks the install or, worse,
 * installs whatever a tampered download contained. So every refusal is tested by name,
 * and the one success path is checked byte for byte.
 *
 * `selfUpdate` takes the target path as an argument (defaulting to the running binary)
 * precisely so this can point it at a throwaway file and drive the real code, `fetch`
 * and filesystem and all, rather than a mock of it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/config.ts';
import { assetName, isNewer, selfUpdate } from '../src/update.ts';

// A plausible "next" version, one minor above whatever is current, so `newer` is true.
function nextVersion(): string {
  const [maj = 0, min = 0] = VERSION.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return `${maj}.${min + 1}.0`;
}

const NEXT = nextVersion();
const ASSET = assetName();
// A binary is anything over a megabyte, per the code's own floor.
const GOOD_BINARY = new Uint8Array(1_200_000).fill(7);
const GOOD_SHA = new Bun.CryptoHasher('sha256').update(GOOD_BINARY).digest('hex');

let dir: string;
let target: string;
const realFetch = globalThis.fetch;

/**
 * Stand in for GitHub. Each field says how to answer the three requests selfUpdate
 * makes: the release API, the binary download, and checksums.txt. A field left out is
 * answered normally (a valid release, the good binary, a matching checksum file).
 */
function githubReturning(
  opts: {
    releaseTag?: string | null;
    releaseStatus?: number;
    binary?: Uint8Array | null;
    binaryStatus?: number;
    checksums?: string | null;
    checksumsStatus?: number;
  } = {},
) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/releases/latest')) {
      const tag = opts.releaseTag === undefined ? `v${NEXT}` : opts.releaseTag;
      return new Response(JSON.stringify({ tag_name: tag, html_url: 'https://x', body: null }), {
        status: opts.releaseStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith(`/${ASSET}`)) {
      const body = opts.binary === undefined ? GOOD_BINARY : opts.binary;
      return new Response(body ?? new Uint8Array(0), { status: opts.binaryStatus ?? 200 });
    }
    if (url.endsWith('/checksums.txt')) {
      const text = opts.checksums === undefined ? `${GOOD_SHA}  ${ASSET}\n` : opts.checksums;
      return new Response(text ?? '', { status: opts.checksumsStatus ?? 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'derailed-selfupdate-'));
  // A throwaway "installed binary". Its name must not contain "bun" or the code treats
  // the run as development and refuses before it does anything.
  target = join(dir, 'derailed');
  writeFileSync(target, new Uint8Array(1_100_000).fill(1));
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  await rm(dir, { recursive: true, force: true });
});

function lines(): { log: (l: string) => void; out: string[] } {
  const out: string[] = [];
  return { log: (l: string) => out.push(l), out };
}

describe('picking the newer version', () => {
  test('a higher version is newer, an equal or lower one is not', () => {
    expect(isNewer('0.13.0', '0.12.0')).toBe(true);
    expect(isNewer('0.12.0', '0.12.0')).toBe(false);
    expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    expect(isNewer('v1.0.0', '0.99.0')).toBe(true);
  });
});

describe('a self-update that must not happen', () => {
  test('a development run (the target is bun) changes nothing', async () => {
    const { log, out } = lines();
    expect(await selfUpdate(log, '/usr/local/bin/bun')).toBe(false);
    expect(out.join(' ')).toMatch(/development run|installed Derailed binary/i);
  });

  test('when GitHub cannot be reached, nothing is installed', async () => {
    githubReturning({ releaseStatus: 500 });
    const before = readFileSync(target);
    expect(await selfUpdate(lines().log, target)).toBe(false);
    expect(readFileSync(target)).toEqual(before);
  });

  test('when the release is not newer, nothing is installed', async () => {
    githubReturning({ releaseTag: `v${VERSION}` });
    const before = readFileSync(target);
    expect(await selfUpdate(lines().log, target)).toBe(false);
    expect(readFileSync(target)).toEqual(before);
  });

  test('a failed binary download leaves the current binary in place', async () => {
    githubReturning({ binaryStatus: 404 });
    const before = readFileSync(target);
    const { log, out } = lines();
    expect(await selfUpdate(log, target)).toBe(false);
    expect(out.join(' ')).toMatch(/download failed|Nothing was changed/i);
    expect(readFileSync(target)).toEqual(before);
  });

  test('a download too small to be a build is refused', async () => {
    githubReturning({ binary: new Uint8Array(500).fill(9) });
    const before = readFileSync(target);
    expect(await selfUpdate(lines().log, target)).toBe(false);
    expect(readFileSync(target)).toEqual(before);
  });

  test('a missing checksums file means nothing is installed (never install unverified)', async () => {
    githubReturning({ checksumsStatus: 404 });
    const before = readFileSync(target);
    const { log, out } = lines();
    expect(await selfUpdate(log, target)).toBe(false);
    expect(out.join(' ')).toMatch(/checksums/i);
    expect(readFileSync(target)).toEqual(before);
  });

  test('a checksums file with no line for this asset is refused', async () => {
    githubReturning({ checksums: 'deadbeef  some-other-asset\n' });
    const before = readFileSync(target);
    expect(await selfUpdate(lines().log, target)).toBe(false);
    expect(readFileSync(target)).toEqual(before);
  });

  test('a download that does not match its checksum is thrown away', async () => {
    // The checksum file names a hash that is not the binary's.
    githubReturning({ checksums: `${'0'.repeat(64)}  ${ASSET}\n` });
    const before = readFileSync(target);
    const { log, out } = lines();
    expect(await selfUpdate(log, target)).toBe(false);
    expect(out.join(' ')).toMatch(/didn't match its checksum|thrown away/i);
    expect(readFileSync(target)).toEqual(before);
  });
});

describe('a self-update that should happen', () => {
  test('a newer, correctly-checksummed build replaces the binary and keeps the old one', async () => {
    githubReturning(); // all good
    const { log, out } = lines();
    expect(await selfUpdate(log, target)).toBe(true);
    expect(out.join(' ')).toMatch(/Checksum verified/i);
    expect(out.join(' ')).toMatch(new RegExp(`Installed ${NEXT.replace(/\./g, '\\.')}`));
    // The binary on disk is now, byte for byte, the downloaded build.
    expect(new Uint8Array(readFileSync(target))).toEqual(GOOD_BINARY);
    // And the previous one was kept beside it.
    const previous = readFileSync(`${target}.previous`);
    expect(previous.byteLength).toBe(1_100_000);
  });
});
