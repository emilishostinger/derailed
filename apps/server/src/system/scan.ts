import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { ScanFinding, SecurityScan, Service } from '@derailed/shared';
import { raise } from '../alerts/notify.ts';
import { cloneRepo } from '../build/git.ts';
import { hasUpload, uploadDir } from '../build/upload.ts';
import { listEnv } from '../db/repo/env.ts';
import { listServices, repoToken } from '../db/repo/services.ts';
import { getSetting, SETTINGS, setSetting } from '../db/repo/settings.ts';
import { checkAvailability } from './appupdate.ts';

/**
 * Is anything leaking or known-broken?
 *
 * Two quiet scans with plain verdicts. The first looks for things shaped like live
 * keys where they should never be: committed to a repository, or doubled up between
 * an env var and the repo. It also calls out the password nobody changed, because
 * "changeme" guarding a database is the commonest leak of all. The second asks
 * whether the images behind the apps have known holes, and wires the answer to the
 * update button that already exists.
 *
 * A live password reached this very repository once and was caught by luck. This
 * builds the luck in.
 *
 * What it deliberately is not: a compliance report. Every finding is one sentence a
 * person can act on, and a clean scan says what was actually looked at, because
 * "nothing found" from a scanner that looked at nothing is worse than no scanner.
 */

/** Things shaped like live keys. Tight shapes only: a fuzzy pattern that cries wolf
 *  twice is a scanner nobody reads a third time. */
export const SECRET_PATTERNS: { id: string; what: string; regex: RegExp }[] = [
  { id: 'aws-key', what: 'an AWS access key', regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    id: 'github-token',
    what: 'a GitHub token',
    regex: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{22,255}\b/,
  },
  { id: 'gitlab-token', what: 'a GitLab token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', what: 'a Slack token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  {
    id: 'stripe-live-key',
    what: 'a live Stripe key',
    regex: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: 'sendgrid-key',
    what: 'a SendGrid key',
    regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
  },
  { id: 'google-api-key', what: 'a Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'openai-key', what: 'an OpenAI key', regex: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'anthropic-key', what: 'an Anthropic key', regex: /\bsk-ant-[A-Za-z0-9-]{20,}\b/ },
  {
    id: 'digitalocean-token',
    what: 'a DigitalOcean token',
    regex: /\bdop_v1_[a-f0-9]{64}\b/,
  },
  { id: 'npm-token', what: 'an npm token', regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  {
    id: 'telegram-bot-token',
    what: 'a Telegram bot token',
    regex: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/,
  },
  {
    id: 'private-key',
    what: 'a private key',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/,
  },
  {
    id: 'url-password',
    what: 'a database address with its password written in',
    regex:
      /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/'"]+:[^\s@/'"]{4,}@/,
  },
];

/**
 * The word that turns a match into an example. AWS's own documentation keys say
 * EXAMPLE; readme files say placeholder and your-key-here. Suppressing on the line
 * is deliberate: a real key pasted next to the word "example" is rare, and a scanner
 * that flags every documentation snippet trains people to dismiss it.
 */
const EXAMPLE_MARKERS =
  /example|placeholder|your[-_ ]?(?:key|token|secret|password)|xxxx|sample|dummy|redacted|<[a-z-]+>/i;

/** The passwords nobody changed. Lowercased before comparing. */
export const WEAK_SECRETS = new Set([
  'password',
  'passw0rd',
  'password1',
  'password123',
  'changeme',
  'change-me',
  'change_me',
  'changethis',
  'secret',
  'admin',
  'root',
  'letmein',
  '123456',
  '12345678',
  '123456789',
  'qwerty',
  'test',
  'example',
  'default',
]);

/** Env keys that are meant to hold a secret, so a weak value in one is a finding. */
const SECRETY_KEY = /(PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|APIKEY|PRIVATE_KEY)$/i;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'target',
  '__pycache__',
  '.venv',
  'venv',
]);

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_FINDINGS_PER_REPO = 25;

function mask(value: string): string {
  return value.length <= 10 ? `${value.slice(0, 4)}…` : `${value.slice(0, 8)}…`;
}

function findingId(parts: string[]): string {
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** One file's lines, held against every pattern. */
export function scanText(
  text: string,
  where: (line: number) => string,
): { patternId: string; what: string; where: string; match: string }[] {
  const out: { patternId: string; what: string; where: string; match: string }[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.length > 2000) continue;
    if (EXAMPLE_MARKERS.test(line)) continue;
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.regex.exec(line);
      if (!match) continue;
      out.push({
        patternId: pattern.id,
        what: pattern.what,
        where: where(index + 1),
        match: match[0],
      });
    }
  }
  return out;
}

/** Whether a buffer is text enough to scan. A NUL in the first kilobyte says no. */
function looksBinary(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 1024);
  return head.includes(0);
}

async function scanTree(
  root: string,
): Promise<{ patternId: string; what: string; where: string; match: string }[]> {
  const results: { patternId: string; what: string; where: string; match: string }[] = [];
  let seen = 0;

  async function walk(dir: string): Promise<void> {
    if (seen >= MAX_FILES || results.length >= MAX_FINDINGS_PER_REPO) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (seen >= MAX_FILES || results.length >= MAX_FINDINGS_PER_REPO) return;
      const path = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(name)) await walk(path);
        continue;
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      seen++;
      try {
        const bytes = await readFile(path);
        if (looksBinary(bytes)) continue;
        const rel = relative(root, path);
        results.push(...scanText(bytes.toString('utf8'), (line) => `${rel}:${line}`));
      } catch {
        // A file that cannot be read cannot leak through us either.
      }
    }
  }

  await walk(root);
  return results;
}

/**
 * The tip of one app's source, on disk long enough to look at.
 *
 * Repositories are cloned shallow to a throwaway folder because the working copy a
 * deploy used is deliberately not kept. Uploads are already here.
 */
async function withSource<T>(
  service: Service,
  work: (dir: string) => Promise<T>,
): Promise<T | null> {
  if (service.source === 'upload') {
    if (!(await hasUpload(service.id))) return null;
    return work(uploadDir(service.id));
  }
  if (service.source !== 'repo' || !service.repoUrl) return null;
  const dir = await mkdtemp(join(tmpdir(), 'derailed-scan-'));
  try {
    await cloneRepo(service.repoUrl, service.branch, dir, () => undefined, repoToken(service.id));
    return await work(dir);
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Whether Trivy is on this machine, for the image half of the scan. */
const TRIVY_PATHS = [
  '/usr/bin/trivy',
  '/usr/local/bin/trivy',
  '/opt/homebrew/bin/trivy',
  '/snap/bin/trivy',
];

export function trivyBinary(): string | null {
  return TRIVY_PATHS.find((path) => existsSync(path)) ?? null;
}

interface TrivyReport {
  Results?: {
    Vulnerabilities?: { VulnerabilityID: string; Severity: string; FixedVersion?: string }[];
  }[];
}

/** Counts that matter from one image's Trivy report. */
export function summarizeTrivy(report: TrivyReport): {
  critical: number;
  high: number;
  fixable: number;
} {
  let critical = 0;
  let high = 0;
  let fixable = 0;
  for (const result of report.Results ?? []) {
    for (const vuln of result.Vulnerabilities ?? []) {
      if (vuln.Severity === 'CRITICAL') critical++;
      else if (vuln.Severity === 'HIGH') high++;
      if (vuln.FixedVersion) fixable++;
    }
  }
  return { critical, high, fixable };
}

async function runTrivy(image: string): Promise<TrivyReport | null> {
  const binary = trivyBinary();
  if (!binary) return null;
  try {
    const proc = Bun.spawn(
      [binary, 'image', '--severity', 'HIGH,CRITICAL', '--format', 'json', '--quiet', image],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    const timer = setTimeout(() => proc.kill(), 5 * 60_000);
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    clearTimeout(timer);
    if (code !== 0) return null;
    return JSON.parse(out) as TrivyReport;
  } catch {
    return null;
  }
}

/** The whole scan. Slow is fine; it runs on a timer and behind one honest button. */
export async function runScan(): Promise<SecurityScan> {
  const started = Date.now();
  const findings: ScanFinding[] = [];
  const services = listServices();
  const apps = services.filter((service) => service.kind === 'app');

  // Every env value that is itself key-shaped, kept to cross-check against the
  // repos: a live key in a variable is normal, the same key also sitting in a file
  // is the leak.
  const keyShapedEnv: { service: Service; key: string; value: string }[] = [];
  let envVarsChecked = 0;

  for (const service of services) {
    for (const entry of listEnv(service.id)) {
      envVarsChecked++;
      if (entry.source !== 'user') continue;
      const value = entry.value.trim();
      if (!value) continue;

      if (SECRETY_KEY.test(entry.key) && WEAK_SECRETS.has(value.toLowerCase())) {
        findings.push({
          id: findingId(['env-weak', service.id, entry.key]),
          kind: 'env-weak',
          verdict: `${entry.key} on ${service.name} is still "${value}".`,
          action: 'Set it to something real. A default password is the first thing tried.',
          serviceId: service.id,
          serviceName: service.name,
          where: null,
          evidence: value,
          severity: 'warn',
        });
      }
      if (SECRET_PATTERNS.some((pattern) => pattern.regex.test(value))) {
        keyShapedEnv.push({ service, key: entry.key, value });
      }
    }
  }

  let reposChecked = 0;
  for (const service of apps) {
    // One visit to the source per app: the pattern scan and the cross-check share
    // the checkout, because a shallow clone per question would be two.
    const visited = await withSource(service, async (dir) => {
      reposChecked++;
      const results = await scanTree(dir);
      const doubled: { key: string; where: string }[] = [];
      for (const entry of keyShapedEnv.filter((candidate) => candidate.service.id === service.id)) {
        const found = await grepTreeFor(dir, entry.value);
        if (found) doubled.push({ key: entry.key, where: found });
      }
      return { results, doubled };
    });
    if (!visited) continue;

    for (const result of visited.results) {
      findings.push({
        id: findingId(['repo-secret', service.id, result.patternId, result.where]),
        kind: 'repo-secret',
        verdict: `This looks like ${result.what}. It should not be in the ${
          service.source === 'upload' ? 'uploaded files' : 'repository'
        }.`,
        action:
          'Move it to the Variables tab and revoke the exposed one. A key that reached a repository has to be assumed copied.',
        serviceId: service.id,
        serviceName: service.name,
        where: result.where,
        evidence: mask(result.match),
        severity: 'critical',
      });
    }

    // The cross-check: a value that is both an env var here and a string in the
    // files is a secret leading a double life.
    for (const hit of visited.doubled) {
      findings.push({
        id: findingId(['env-in-repo', service.id, hit.key]),
        kind: 'env-in-repo',
        verdict: `The value of ${hit.key} on ${service.name} is also written into its files.`,
        action:
          'Remove it from the files; the variable already reaches the app. Then rotate it, because the copy in the files has been shipped around.',
        serviceId: service.id,
        serviceName: service.name,
        where: hit.where,
        evidence: null,
        severity: 'critical',
      });
    }
  }

  // The image half: known holes in what is actually deployed.
  let imageScanner: SecurityScan['imageScanner'] = trivyBinary() ? 'ok' : 'missing';
  let imagesChecked = 0;
  if (imageScanner === 'ok') {
    const imageApps = apps.filter((service) => service.source === 'image' && service.image);
    const scanned = new Map<string, { critical: number; high: number; fixable: number } | null>();
    for (const service of imageApps) {
      const image = service.image!;
      if (!scanned.has(image)) {
        const report = await runTrivy(image);
        scanned.set(image, report ? summarizeTrivy(report) : null);
        if (report) imagesChecked++;
        else imageScanner = 'failed';
      }
      const counts = scanned.get(image);
      if (!counts || counts.critical + counts.high === 0) continue;

      const availability = await checkAvailability(service).catch(() => null);
      const updateHelps = !!availability?.available;
      const holes =
        counts.critical > 0
          ? `${counts.critical + counts.high} known hole${
              counts.critical + counts.high === 1 ? '' : 's'
            }, ${counts.critical} rated critical`
          : `${counts.high} known hole${counts.high === 1 ? '' : 's'}`;
      findings.push({
        id: findingId(['image-holes', image, String(counts.critical), String(counts.high)]),
        kind: 'image-holes',
        verdict: `The image behind ${service.name} has ${holes}.`,
        action: updateHelps
          ? 'A newer image is published. Updating it is one press, with a backup taken first.'
          : counts.fixable > 0
            ? 'Fixes exist upstream but no newer image is published yet under this tag. Check back, or move to a maintained tag.'
            : 'No fixes are published yet. Nothing to press; worth knowing.',
        serviceId: service.id,
        serviceName: service.name,
        where: image,
        evidence: null,
        updateHelps,
        severity: counts.critical > 0 ? 'critical' : 'warn',
      });
    }
  }

  const critical = findings.filter((finding) => finding.severity === 'critical').length;
  const scan: SecurityScan = {
    at: started,
    tookMs: Date.now() - started,
    findings,
    checked: { repos: reposChecked, envVars: envVarsChecked, images: imagesChecked },
    imageScanner,
    summary:
      findings.length === 0
        ? `Nothing leaking, nothing known-broken. Looked at ${reposChecked} ${
            reposChecked === 1 ? 'app' : 'apps'
          }, ${envVarsChecked} variables${
            imageScanner === 'ok' ? ` and ${imagesChecked} images` : ''
          }.`
        : `${findings.length} thing${findings.length === 1 ? '' : 's'} worth a look${
            critical ? `, ${critical} serious` : ''
          }.`,
  };

  await noteAndAlert(scan);
  return scan;
}

/** One value, looked for verbatim across a tree. Returns where it was first seen. */
async function grepTreeFor(root: string, value: string): Promise<string | null> {
  let found: string | null = null;
  let seen = 0;

  async function walk(dir: string): Promise<void> {
    if (found || seen >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (found || seen >= MAX_FILES) return;
      const path = join(dir, name);
      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        if (!SKIP_DIRS.has(name)) await walk(path);
        continue;
      }
      if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
      seen++;
      try {
        const bytes = await readFile(path);
        if (looksBinary(bytes)) continue;
        const text = bytes.toString('utf8');
        const at = text.indexOf(value);
        if (at >= 0) {
          const line = text.slice(0, at).split('\n').length;
          found = `${relative(root, path)}:${line}`;
        }
      } catch {
        // unreadable is unleakable
      }
    }
  }

  await walk(root);
  return found;
}

/** Remembers the scan and says something when a finding is new since the last one. */
async function noteAndAlert(scan: SecurityScan): Promise<void> {
  let previous: string[] = [];
  try {
    const stored = getSetting(SETTINGS.scanLast);
    if (stored) {
      previous = ((JSON.parse(stored) as SecurityScan).findings ?? []).map((finding) => finding.id);
    }
  } catch {
    previous = [];
  }
  setSetting(SETTINGS.scanLast, JSON.stringify(scan));

  const fresh = scan.findings.filter((finding) => !previous.includes(finding.id));
  if (fresh.length === 0) return;
  const worst = fresh.find((finding) => finding.severity === 'critical') ?? fresh[0]!;
  await raise({
    kind: 'security.finding',
    subject: 'security-scan',
    detail: fresh
      .map((finding) => finding.id)
      .sort()
      .join(','),
    severity: worst.severity === 'critical' ? 'critical' : 'warning',
    title:
      fresh.length === 1
        ? 'The security scan found something'
        : `The security scan found ${fresh.length} things`,
    body: fresh
      .slice(0, 3)
      .map((finding) => finding.verdict)
      .join(' '),
    action: 'The Server page has the list, with what to do about each.',
  }).catch(() => undefined);
}

export function lastScan(): SecurityScan | null {
  try {
    const stored = getSetting(SETTINGS.scanLast);
    return stored ? (JSON.parse(stored) as SecurityScan) : null;
  } catch {
    return null;
  }
}

/** Daily, quietly. Findings arrive as alerts; the page shows the rest. */
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function sweepScan(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runScan();
  } catch {
    // The next sweep will try again; a scan must never take the server down.
  } finally {
    running = false;
  }
}

export function startScans(): void {
  if (timer) return;
  timer = setInterval(() => void sweepScan(), SWEEP_EVERY_MS);
  timer.unref?.();
  // Not at boot: cloning every repository while the apps are still starting is the
  // wrong first impression. Twenty minutes in, the machine is idle again.
  setTimeout(() => void sweepScan(), 20 * 60 * 1000).unref?.();
}

export function stopScans(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
