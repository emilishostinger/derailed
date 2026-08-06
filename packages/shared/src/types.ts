/**
 * Core domain types, shared by the server and the web UI.
 * These mirror the SQLite tables one-to-one (minus secrets, which never leave the server).
 */

export type ServiceKind = 'app' | 'database';

export type BuildStrategy = 'auto' | 'dockerfile' | 'nixpacks' | 'site';

/** Where an app comes from: a repository we build, or an image we just run. */
export type ServiceSource = 'repo' | 'image' | 'upload';

export const DEPLOYMENT_STATUSES = [
  'queued',
  'cloning',
  'detecting',
  'building',
  'starting',
  'checking',
  'routing',
  'running',
  'failed',
  'canceled',
  'superseded',
] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/** Statuses where the deployment is still moving. */
export const ACTIVE_DEPLOYMENT_STATUSES: readonly DeploymentStatus[] = [
  'queued',
  'cloning',
  'detecting',
  'building',
  'starting',
  'checking',
  'routing',
];

/** What the UI shows on a service node, derived, never stored. */
export type ServiceStatus = 'running' | 'deploying' | 'stopped' | 'failed' | 'crashed' | 'creating';

export type DeploymentTrigger = 'manual' | 'redeploy' | 'rollback' | 'webhook' | 'release' | 'push';

export type EnvSource = 'user' | 'link' | 'system';

export type DomainKind = 'generated' | 'custom';
export type DnsStatus = 'unchecked' | 'ok' | 'wrong_ip' | 'no_record';
export type TlsStatus = 'pending' | 'active' | 'error' | 'disabled';

export type LogStream = 'system' | 'build' | 'runtime';

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

export type BackupSchedule = 'off' | 'daily' | 'weekly';

export interface Project {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  /** How often this project is backed up on its own. */
  backupSchedule: BackupSchedule;
  /** When it was deleted, if it was. Deleted things are kept for a week. */
  deletedAt?: number | null;
  services?: Service[];
  /** Attached by the API. The app→database edges the topology view draws. */
  links?: Link[];
}

export interface Service {
  id: string;
  projectId: string;
  kind: ServiceKind;
  name: string;
  slug: string;

  // app fields
  source: ServiceSource;
  /** Set when source is 'image', e.g. `wordpress:php8.3-apache`. */
  image: string | null;
  /** Whatever detection worked out ('Next.js', 'Django', …) for the UI's icon. */
  framework: string | null;
  /** Overrides the image's own default, for images that have none worth running. */
  command: string[] | null;
  /** Whether a deploy token is stored. The token itself is never sent. */
  hasRepoToken?: boolean;
  repoUrl: string | null;
  branch: string | null;
  rootDir: string | null;
  buildStrategy: BuildStrategy;
  dockerfilePath: string | null;
  port: number | null;
  healthPath: string;
  instancesDesired: 0 | 1;
  memoryLimitMb: number | null;
  /** Deploy by itself when a new release is published on GitHub. */
  deployOnRelease: boolean;
  /** The newest commit seen on the branch, deployed or not. See the push watcher. */
  deployOnPush: boolean;
  lastPushedSha: string | null;
  /** The newest release tag Derailed has seen, deployed or merely noted. */
  lastReleaseTag: string | null;

  // database fields
  dbEngine: string | null;
  dbVersion: string | null;
  dbName: string | null;
  dbUser: string | null;
  exposedPort: number | null;

  createdAt: number;
  updatedAt: number;
  /** When it was deleted, if it was. Deleted things are kept for a week. */
  deletedAt?: number | null;

  /** Derived, attached by the API for convenience. */
  status?: ServiceStatus;
  latestDeployment?: DeploymentSummary | null;
  domains?: Domain[];
  volumes?: Volume[];
  /**
   * Set when this app almost certainly writes data it would lose on the next deploy,
   * and no storage is attached yet.
   */
  storageWarning?: { paths: string[]; what: string } | null;
  /**
   * What the running site looks like: its own title and icon, and a screenshot when
   * those are switched on. Decoration, and always optional.
   */
  preview?: {
    title: string | null;
    /** Name to fetch from `/api/services/previews/`, or null. */
    iconPath: string | null;
    shotPath: string | null;
    at: number;
  };
}

export interface DeploymentSummary {
  id: string;
  serviceId: string;
  status: DeploymentStatus;
  commitSha: string | null;
  commitMessage: string | null;
  trigger: DeploymentTrigger;
  errorSummary: string | null;
  errorHint: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface Deployment extends DeploymentSummary {
  imageTag: string | null;
  containerId: string | null;
}

export interface EnvVar {
  id: string;
  serviceId: string;
  key: string;
  value: string;
  source: EnvSource;
}

export interface Link {
  id: string;
  projectId: string;
  fromServiceId: string;
  toServiceId: string;
  injectAs: string | null;
}

export interface Domain {
  id: string;
  /** Null until the domain is pointed at one of your apps. */
  serviceId: string | null;
  /** Set when this name redirects to the other half of a pair, e.g. www to apex. */
  redirectTo?: string | null;
  hostname: string;
  kind: DomainKind;
  dnsStatus: DnsStatus;
  tlsStatus: TlsStatus;
  lastCheckedAt: number | null;
  createdAt: number;
}

/** Storage that survives a redeploy. Without one, an app's files reset every time. */
export interface Volume {
  id: string;
  serviceId: string;
  name: string;
  containerPath: string;
  createdAt: number;
}

export interface LogLine {
  ts: number;
  stream: LogStream;
  line: string;
}

export interface SystemInfo {
  version: string;
  serverIp: string | null;
  serverIpSource: 'detected' | 'manual' | 'unknown';
  dockerOk: boolean;
  dockerVersion: string | null;
  dockerError: string | null;
  caddyOk: boolean;
  disk: { totalBytes: number; freeBytes: number } | null;
  setupComplete: boolean;
  dev: boolean;
}

/**
 * The free secured address, if one has been claimed.
 *
 * Derailed hands out `myapp.<name>.duckdns.org` and holds one wildcard certificate
 * covering all of them. It works where the ready-made sslip.io addresses cannot be
 * secured at all, because duckdns.org is on the public suffix list and so a name
 * under it has a certificate allowance of its own.
 */
export interface FreeDomain {
  /** The bare label, e.g. `emilis-box`. Null when nothing has been claimed. */
  name: string | null;
  hostname: string | null;
  /** Whether a usable certificate is on disk right now. */
  secured: boolean;
  expiresAt: number | null;
  /** Set when the last attempt failed, phrased for a person. */
  error: string | null;
}

/**
 * Something deleted, and still recoverable.
 *
 * Deleting stops an app and frees its addresses, but keeps everything that holds
 * data, for a week. `whatIsKept` says what is actually still there, in plain words,
 * because "restore" is only worth pressing if you know what comes back.
 */
export interface TrashItem {
  kind: 'project' | 'service';
  id: string;
  name: string;
  /** For a service, the project it was in, so the list reads sensibly. */
  parentName: string | null;
  deletedAt: number;
  /** When it will be thrown away for good. */
  purgeAt: number;
  whatIsKept: string[];
}

/**
 * What is using the disk, and what could go.
 *
 * A full disk breaks everything at once and silently, and Docker is almost always the
 * reason. Every figure here is paired with words, because "12.4 GB of images" means
 * nothing without "these are old copies of your apps and nothing is running them".
 */
export interface DiskCategory {
  kind: 'images' | 'build-cache' | 'containers' | 'backups' | 'logs' | 'data';
  label: string;
  bytes: number;
  /** How much could be freed without losing anything you would miss. */
  reclaimableBytes: number;
  detail: string;
}

export interface DiskReport {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  percentUsed: number;
  level: 'ok' | 'filling' | 'full';
  summary: string;
  categories: DiskCategory[];
  reclaimableBytes: number;
}

/** Swap, which most cheap servers ship without and most cheap servers need. */
export interface SwapState {
  bytes: number;
  totalMemoryBytes: number;
  recommended: boolean;
  suggestedBytes: number;
  reason: string | null;
  canAdd: boolean;
}

/**
 * One check the doctor ran.
 *
 * Everything either says "fine" or says what to do about it, and where Derailed can
 * do that itself there is a `fix` naming the button.
 */
export interface DoctorCheck {
  id: string;
  title: string;
  status: 'ok' | 'warn' | 'bad';
  detail: string;
  fix?: { action: DoctorFix; label: string };
}

/** The things the doctor can put right without leaving the page. */
export type DoctorFix = 'restart-proxy' | 'reclaim-disk' | 'add-swap';

export interface DoctorReport {
  at: number;
  checks: DoctorCheck[];
  summary: string;
  level: 'ok' | 'warn' | 'bad';
}

/**
 * Where backups are copied to, so losing the server does not lose them too.
 *
 * S3-compatible only, on purpose: one implementation reaches Backblaze B2, Cloudflare
 * R2, Wasabi, Storj, MinIO, Hetzner and AWS.
 */
export interface OffsiteSettings {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  prefix: string;
  /** `endpoint/bucket/key` rather than `bucket.endpoint/key`. Most providers want it. */
  pathStyle: boolean;
  /** Whether a secret is stored. The secret itself never leaves the server. */
  hasSecret: boolean;
}

export interface OffsiteStatus {
  configured: boolean;
  copies: number;
  newestAt: number | null;
  totalBytes: number;
  error: string | null;
}

/**
 * The result of checking that a backup can actually be read back.
 *
 * Every backup tool says a backup was made. This is the claim people care about and
 * almost nobody makes.
 */
export interface DrillResult {
  backupId: string;
  at: number;
  tookMs: number;
  ok: boolean;
  /** How many databases and stored folders were inspected. */
  checked: number;
  problems: string[];
  summary: string;
}

/** Detection result for a repo, phrased for humans, not machines. */
export interface DetectResult {
  strategy: 'dockerfile' | 'nixpacks' | 'site' | 'unknown';
  framework: string | null;
  port: number | null;
  dockerfilePath: string | null;
  suggestedName: string;
  /** One or two sentences the wizard shows verbatim. */
  summary: string;
  warnings: string[];
}
