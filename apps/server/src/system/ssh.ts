import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * The server's door keys, and the toggle that matters.
 *
 * The single highest-value hardening act on a VPS is turning off password login for
 * SSH: it ends the dictionary that has been knocking since minute one. Every guide
 * says to do it; almost nobody does, because it means editing a config file over the
 * very connection the file controls, with the lockout risk making people freeze.
 *
 * So Derailed shows the keys that can open the machine, takes a new one, and offers
 * password login as one honest switch, with the one guard that matters: it will not
 * turn passwords off while there is no key that could still get you in.
 *
 * What it deliberately does not do: manage keys for other accounts, or offer any
 * other sshd setting. One switch, because the second switch is where the lockouts
 * live.
 */

export interface SshKey {
  /** `ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256`, and friends. */
  type: string;
  /** OpenSSH's own format: `SHA256:` and 43 characters, matching `ssh-keygen -lf`. */
  fingerprint: string;
  comment: string | null;
  /** Options prefix, kept verbatim so re-writing the file loses nothing. */
  options: string | null;
  /** The whole line, kept so edits rewrite rather than reconstruct. */
  line: string;
}

const KEY_TYPES = [
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com',
  'ssh-dss',
];

/** Where root's keys live. Derailed runs as root on a server, so these are its door. */
export function defaultKeysFile(): string {
  return join(homedir(), '.ssh', 'authorized_keys');
}

const SSHD_MAIN = '/etc/ssh/sshd_config';
const SSHD_DIR = '/etc/ssh/sshd_config.d';
/**
 * 00-, not 60-: sshd honours the FIRST occurrence of a keyword, and the include
 * directory is read in name order with cloud-init's 50- file often already there
 * saying yes. A drop-in that sorts after it would be a switch wired to nothing.
 */
const DROPIN = '00-derailed.conf';
const MARKER_BEGIN = '# derailed-managed: begin (do not edit between markers)';
const MARKER_END = '# derailed-managed: end';

/** OpenSSH's fingerprint: base64 SHA256 of the decoded blob, padding trimmed. */
export function fingerprintOf(base64Key: string): string | null {
  try {
    const blob = Buffer.from(base64Key, 'base64');
    if (blob.length < 8) return null;
    return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * One authorized_keys line, understood.
 *
 * The grammar allows an options prefix (`no-pty,from="..." ssh-ed25519 AAAA...`),
 * so the type is found rather than assumed to be first. The decoded blob must name
 * its own type in its first field and agree with the text, because that mismatch is
 * what a corrupted paste looks like.
 */
export function parseKeyLine(line: string): SshKey | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  // One line means one line. `trim` only takes the ends, so a newline that survives
  // is one buried in the middle of a paste, and `split(/\s+/)` would read across it and
  // validate the first key while a second line, with its own `command=`/`environment=`
  // options, rode along into root's authorized_keys verbatim. Refuse the whole paste.
  if (/[\r\n]/.test(trimmed)) return null;

  const tokens = trimmed.split(/\s+/);
  const typeIndex = tokens.findIndex((token) => KEY_TYPES.includes(token));
  if (typeIndex === -1 || typeIndex + 1 >= tokens.length) return null;

  const type = tokens[typeIndex]!;
  const base64 = tokens[typeIndex + 1]!;
  const fingerprint = fingerprintOf(base64);
  if (!fingerprint) return null;

  // The blob is a sequence of length-prefixed fields, the first naming its own
  // type. A paste that lost characters mid-line still decodes as base64, so the
  // honest check is structural: walk the fields and demand they land exactly on
  // the end of the buffer, which truncation never does.
  try {
    const blob = Buffer.from(base64, 'base64');
    const nameLength = blob.readUInt32BE(0);
    if (nameLength < 1 || nameLength > 64 || 4 + nameLength > blob.length) return null;
    if (blob.subarray(4, 4 + nameLength).toString('ascii') !== type) return null;
    let offset = 0;
    let fields = 0;
    while (offset + 4 <= blob.length) {
      const length = blob.readUInt32BE(offset);
      offset += 4 + length;
      fields++;
      if (fields > 16) return null;
    }
    if (offset !== blob.length || fields < 2) return null;
  } catch {
    return null;
  }

  return {
    type,
    fingerprint,
    comment: tokens.slice(typeIndex + 2).join(' ') || null,
    options: typeIndex > 0 ? tokens.slice(0, typeIndex).join(' ') : null,
    line: trimmed,
  };
}

export async function listKeys(file = defaultKeysFile()): Promise<SshKey[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map(parseKeyLine)
    .filter((key): key is SshKey => key !== null);
}

export class SshError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.hint = hint;
  }
}

/** Adds one public key. Idempotent by fingerprint: pasting twice is one key. */
export async function addKey(pasted: string, file = defaultKeysFile()): Promise<SshKey> {
  const key = parseKeyLine(pasted);
  if (!key) {
    throw new SshError(
      'That does not look like a public key.',
      'It should start with something like ssh-ed25519 and be one line. The .pub file, not the private one.',
    );
  }
  // The one paste that must be caught loudly: a private key is a secret, and a
  // secret pasted here was meant to be its public half.
  if (/PRIVATE KEY/.test(pasted)) {
    throw new SshError(
      'That is a PRIVATE key.',
      'Never paste that anywhere. The matching public key ends in .pub.',
    );
  }

  const existing = await listKeys(file);
  const already = existing.find((entry) => entry.fingerprint === key.fingerprint);
  if (already) return already;

  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const current = await readFile(file, 'utf8').catch(() => '');
  const glue = current.length === 0 || current.endsWith('\n') ? '' : '\n';
  await appendFile(file, `${glue}${key.line}\n`, { mode: 0o600 });
  return key;
}

export async function removeKey(
  fingerprint: string,
  file = defaultKeysFile(),
  sshd: SshdPaths = {},
): Promise<void> {
  const keys = await listKeys(file);
  const target = keys.find((entry) => entry.fingerprint === fingerprint);
  if (!target) throw new SshError('That key is not on the list.');

  // Removing the last key while passwords are off is locking the door from
  // outside and posting the key through the letterbox.
  if (keys.length === 1 && (await passwordLoginState(sshd)) === 'off') {
    throw new SshError(
      'That is the only key, and password login is off.',
      'Removing it would lock everyone out. Add another key first, or turn password login back on.',
    );
  }

  const text = await readFile(file, 'utf8').catch(() => '');
  const kept = text
    .split('\n')
    .filter((line) => parseKeyLine(line)?.fingerprint !== fingerprint)
    .join('\n');
  await writeFile(file, kept.endsWith('\n') || kept === '' ? kept : `${kept}\n`, { mode: 0o600 });
}

export interface SshdPaths {
  main?: string;
  dir?: string;
  /** Skips `sshd -t`. For tests, whose throwaway configs have no host keys. */
  validate?: boolean;
  /** Skips the reload. For tests. */
  reload?: boolean;
}

/**
 * What sshd would actually do with a password right now.
 *
 * Read the way sshd reads it: includes in name order, first occurrence of the
 * keyword wins, unset means yes. Parsed from the files rather than `sshd -T`
 * because -T needs root and host keys, and the files are the truth the running
 * daemon was started from.
 */
export async function passwordLoginState(paths: SshdPaths = {}): Promise<'on' | 'off' | 'unknown'> {
  const main = paths.main ?? SSHD_MAIN;
  if (!existsSync(main)) return 'unknown';

  const value = await firstPasswordDirective(main, paths.dir ?? SSHD_DIR);
  if (value === null) return 'on';
  return value.toLowerCase() === 'no' ? 'off' : 'on';
}

async function firstPasswordDirective(main: string, dir: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(main, 'utf8');
  } catch {
    return null;
  }

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#') || line === '') continue;

    // Include is honoured where it stands, the way sshd honours it.
    const include = /^Include\s+(.+)$/i.exec(line);
    if (include) {
      const pattern = include[1]!.trim();
      // The one shape distros use: a whole directory of .conf files.
      const included = await confFilesFor(pattern, dir);
      for (const file of included) {
        const inner = await firstDirectiveInFile(file);
        if (inner !== null) return inner;
      }
      continue;
    }

    const match = /^PasswordAuthentication\s+(\S+)/i.exec(line);
    if (match) return match[1]!;
  }
  return null;
}

async function confFilesFor(pattern: string, dir: string): Promise<string[]> {
  // Resolve the conventional `/etc/ssh/sshd_config.d/*.conf` include against the
  // directory we were told about, so tests can point everything at a sandbox.
  if (!pattern.includes('sshd_config.d')) return [];
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith('.conf')).sort();
    return names.map((name) => join(dir, name));
  } catch {
    return [];
  }
}

async function firstDirectiveInFile(file: string): Promise<string | null> {
  try {
    const text = await readFile(file, 'utf8');
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.startsWith('#')) continue;
      const match = /^PasswordAuthentication\s+(\S+)/i.exec(line);
      if (match) return match[1]!;
    }
  } catch {
    // unreadable file, no opinion
  }
  return null;
}

/** Whether this machine's ssh can be managed at all. A Mac running dev cannot. */
export function canManage(paths: SshdPaths = {}): boolean {
  return existsSync(paths.main ?? SSHD_MAIN);
}

/**
 * The switch itself.
 *
 * Turning passwords OFF refuses to run while no key could still open the door.
 * The change lands in a drop-in named to sort first (see DROPIN), or between
 * marked lines at the top of the main file on a machine whose config never
 * includes the directory. `sshd -t` proves the result parses before the daemon is
 * asked to reload it, and a failed check puts everything back, because a config
 * sshd refuses to start on is a locked door of its own.
 */
export async function setPasswordLogin(
  enabled: boolean,
  keysFile = defaultKeysFile(),
  paths: SshdPaths = {},
): Promise<'on' | 'off' | 'unknown'> {
  const main = paths.main ?? SSHD_MAIN;
  const dir = paths.dir ?? SSHD_DIR;
  if (!existsSync(main)) {
    throw new SshError('This machine does not have an SSH server Derailed can see.');
  }

  if (!enabled && (await listKeys(keysFile)).length === 0) {
    throw new SshError(
      'No key could open this machine yet.',
      'Add your public key above and check it works (ssh in from another terminal) before turning passwords off.',
    );
  }

  const mainBefore = await readFile(main, 'utf8');
  const dropinPath = join(dir, DROPIN);
  const dropinBefore = existsSync(dropinPath) ? await readFile(dropinPath, 'utf8') : null;
  const usesIncludes = /^\s*Include\s+.*sshd_config\.d/im.test(mainBefore);

  const body = enabled
    ? null
    : ['PasswordAuthentication no', 'KbdInteractiveAuthentication no'].join('\n');

  try {
    if (usesIncludes) {
      if (body === null) {
        await rm(dropinPath, { force: true });
      } else {
        await mkdir(dir, { recursive: true });
        await writeFile(dropinPath, `${MARKER_BEGIN}\n${body}\n${MARKER_END}\n`, { mode: 0o644 });
      }
    } else {
      const stripped = stripMarkedBlock(mainBefore);
      const next =
        body === null ? stripped : `${MARKER_BEGIN}\n${body}\n${MARKER_END}\n${stripped}`;
      await writeFile(main, next, { mode: 0o644 });
    }

    if (paths.validate !== false) await proveConfigParses(main);
  } catch (err) {
    // Whatever happened, put the files back the way the running daemon knows them.
    await writeFile(main, mainBefore, { mode: 0o644 }).catch(() => undefined);
    if (dropinBefore === null) await rm(dropinPath, { force: true }).catch(() => undefined);
    else await writeFile(dropinPath, dropinBefore, { mode: 0o644 }).catch(() => undefined);
    throw err instanceof SshError
      ? err
      : new SshError(
          'The SSH configuration would not have been valid, so nothing was changed.',
          err instanceof Error ? err.message : undefined,
        );
  }

  if (paths.reload !== false) await reloadSshd();
  return passwordLoginState(paths);
}

function stripMarkedBlock(text: string): string {
  const begin = text.indexOf(MARKER_BEGIN);
  if (begin === -1) return text;
  const end = text.indexOf(MARKER_END);
  if (end === -1) return text;
  return text.slice(0, begin) + text.slice(end + MARKER_END.length).replace(/^\n/, '');
}

async function proveConfigParses(main: string): Promise<void> {
  const sshd = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((path) => existsSync(path));
  if (!sshd) return;
  const proc = Bun.spawn([sshd, '-t', '-f', main], { stdout: 'pipe', stderr: 'pipe' });
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    throw new SshError('sshd refused the new configuration, so nothing was changed.', err.trim());
  }
}

async function reloadSshd(): Promise<void> {
  // Reload, never restart: a reload that fails leaves every open session (this one
  // included) exactly where it was.
  for (const args of [
    ['systemctl', 'reload', 'ssh'],
    ['systemctl', 'reload', 'sshd'],
    ['service', 'ssh', 'reload'],
  ]) {
    try {
      const proc = Bun.spawn(args as string[], { stdout: 'ignore', stderr: 'ignore' });
      if ((await proc.exited) === 0) return;
    } catch {
      // try the next spelling
    }
  }
  // No spelling worked. The change is on disk and correct; it simply waits for the
  // next daemon reload. Saying so beats failing the whole request.
}
