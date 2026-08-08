import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addKey,
  fingerprintOf,
  listKeys,
  parseKeyLine,
  passwordLoginState,
  removeKey,
  SshError,
  setPasswordLogin,
} from '../src/system/ssh.ts';

/**
 * The server's door keys, and the toggle that matters.
 *
 * The joints worth testing: the fingerprint must be OpenSSH's own (checked against
 * `ssh-keygen -lf` output baked in below), a corrupted or private key must be
 * refused, and the switch must obey its two laws: never off while no key could
 * still get in, and always first in the include order, because sshd's first match
 * wins and cloud-init's file is already there saying yes.
 */

// Real keys, generated for this test, never used anywhere.
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJ6H4fhvDWuPW3FuWx7jQZ127DzXxsr+xgwszEiGSdUE you@laptop';
const ED25519_FINGERPRINT = 'SHA256:5nINygR6+WqdUi1F1rkT+u7QL2R3gs+Fvn+MFgOd2pA';
const RSA =
  'ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC/0E+y1kqaWJ0i1YhEXzbL70GRNvTcM8Y4S0OVxj2aB1e9xV7woYvShgM8pzV687QHa/pgpnH2V0U+So7EpSOgmt4OTkPuovONa7CtpJelWrpzd64G9pLOYbxsk/iuZ5v2JJf3fSphaADWgRN8FKVTJ40IyoouADle/2yGl9A73I0yvzaELgay3AE2GSaLojOkwWbcjcb7RyP7aEJc2ZTB3JTR9flsA+oo57DlDSYohhnIJBqGzbAKELo6HiizrJ3caN3LTNK1ZGI9FsGyAIZcunbAOin18WohQ4Getd89eoM/j/a+Rt1vomj0hihtTzjmFq3ONS1mzUxFtkcRLM/R old@box';
const RSA_FINGERPRINT = 'SHA256:NNKb5DdeAVO7/8WltVlQemYkt+I2xdoUMY4vqNmKJyc';

let dir: string;
let keysFile: string;
let sshdMain: string;
let sshdDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'derailed-ssh-'));
  keysFile = join(dir, 'authorized_keys');
  sshdMain = join(dir, 'sshd_config');
  sshdDir = join(dir, 'sshd_config.d');
  mkdirSync(sshdDir, { recursive: true });
  writeFileSync(sshdMain, 'Include /etc/ssh/sshd_config.d/*.conf\nPort 22\n');
});

const sshd = () => ({ main: sshdMain, dir: sshdDir, validate: false, reload: false });

describe('reading keys', () => {
  test('the fingerprint is exactly what ssh-keygen -lf prints', () => {
    expect(parseKeyLine(ED25519)?.fingerprint).toBe(ED25519_FINGERPRINT);
    expect(parseKeyLine(RSA)?.fingerprint).toBe(RSA_FINGERPRINT);
  });

  test('an options prefix and a spaced comment both survive', () => {
    const key = parseKeyLine(`no-pty,from="203.0.113.7" ${ED25519} extra words`);
    expect(key?.type).toBe('ssh-ed25519');
    expect(key?.options).toBe('no-pty,from="203.0.113.7"');
    expect(key?.fingerprint).toBe(ED25519_FINGERPRINT);
  });

  test('comments and blanks and rubbish are not keys', () => {
    expect(parseKeyLine('# a comment')).toBeNull();
    expect(parseKeyLine('')).toBeNull();
    expect(parseKeyLine('ssh-ed25519 not!base64 x')).toBeNull();
  });

  test('a paste that lost characters is refused, not half-kept', () => {
    // Same line with a chunk cut out of the blob: still base64, wrong contents.
    const damaged = ED25519.replace('AAAAIJ6H4fhv', 'AAAAIJ6H');
    expect(parseKeyLine(damaged)).toBeNull();
  });

  test('fingerprintOf refuses what is not a key at all', () => {
    expect(fingerprintOf('AAAA')).toBeNull();
  });
});

describe('adding and removing', () => {
  test('a key is added once, however often it is pasted', async () => {
    await addKey(ED25519, keysFile);
    await addKey(ED25519, keysFile);
    expect(await listKeys(keysFile)).toHaveLength(1);
  });

  test('a private key is refused with the loudest possible sentence', async () => {
    const paste = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n';
    await expect(addKey(paste, keysFile)).rejects.toThrow(/does not look like|PRIVATE/);
    expect(await listKeys(keysFile)).toHaveLength(0);
  });

  test('removing a key leaves the others exactly as written', async () => {
    await addKey(ED25519, keysFile);
    await addKey(RSA, keysFile);
    await removeKey(ED25519_FINGERPRINT, keysFile, sshd());
    const kept = await listKeys(keysFile);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.fingerprint).toBe(RSA_FINGERPRINT);
    expect(readFileSync(keysFile, 'utf8')).toContain('old@box');
  });

  test('the last key cannot go while passwords are off', async () => {
    await addKey(ED25519, keysFile);
    await setPasswordLogin(false, keysFile, sshd());
    await expect(removeKey(ED25519_FINGERPRINT, keysFile, sshd())).rejects.toThrow(/only key/);
    // Turn passwords back on and the same removal is allowed.
    await setPasswordLogin(true, keysFile, sshd());
    await removeKey(ED25519_FINGERPRINT, keysFile, sshd());
    expect(await listKeys(keysFile)).toHaveLength(0);
  });
});

describe('the toggle that matters', () => {
  test('refuses to turn passwords off while no key could get in', async () => {
    await expect(setPasswordLogin(false, keysFile, sshd())).rejects.toThrow(SshError);
    expect(await passwordLoginState(sshd())).toBe('on');
  });

  test('lands first in the include order, so cloud-init cannot outvote it', async () => {
    // The file cloud images actually ship, already saying yes.
    writeFileSync(join(sshdDir, '50-cloud-init.conf'), 'PasswordAuthentication yes\n');
    await addKey(ED25519, keysFile);

    await setPasswordLogin(false, keysFile, sshd());
    // sshd takes the FIRST occurrence of a keyword, reading includes in name
    // order; ours must sort before 50-cloud-init.conf or the switch is wired to
    // nothing at all.
    expect(readFileSync(join(sshdDir, '00-derailed.conf'), 'utf8')).toContain(
      'PasswordAuthentication no',
    );
    expect(await passwordLoginState(sshd())).toBe('off');

    await setPasswordLogin(true, keysFile, sshd());
    expect(await passwordLoginState(sshd())).toBe('on');
  });

  test('a config that never includes the directory is edited between markers', async () => {
    writeFileSync(sshdMain, 'Port 22\nPasswordAuthentication yes\n');
    await addKey(ED25519, keysFile);

    await setPasswordLogin(false, keysFile, sshd());
    const text = readFileSync(sshdMain, 'utf8');
    expect(text).toContain('derailed-managed: begin');
    // Ours sits above the distro's yes, and first match wins.
    expect(text.indexOf('PasswordAuthentication no')).toBeLessThan(
      text.indexOf('PasswordAuthentication yes'),
    );
    expect(await passwordLoginState(sshd())).toBe('off');

    await setPasswordLogin(true, keysFile, sshd());
    expect(readFileSync(sshdMain, 'utf8')).not.toContain('derailed-managed');
    expect(await passwordLoginState(sshd())).toBe('on');
  });

  test('an unset directive means what sshd means by it: yes', async () => {
    writeFileSync(sshdMain, 'Port 22\n');
    expect(await passwordLoginState(sshd())).toBe('on');
  });

  test('a machine with no sshd config says unknown rather than guessing', async () => {
    expect(await passwordLoginState({ main: join(dir, 'nope'), dir: sshdDir })).toBe('unknown');
  });
});
