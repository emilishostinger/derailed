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

/**
 * Three, and no more.
 *
 * Every extra role is a permission matrix somebody has to hold in their head, and the
 * questions people actually ask are "can they break it?" and "can they see it?".
 */
export type UserRole = 'owner' | 'member' | 'viewer';

export interface User {
  id: string;
  email: string;
  role: UserRole;
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
  /**
   * Who is allowed to see this app. Enforced by the proxy, so it works for anything
   * without the app itself being changed. The password hash is never included.
   */
  access?: {
    hasPassword: boolean;
    username: string | null;
    allowFrom: string[];
    maintenance: boolean;
  };

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
  /**
   * Whether it appears on the public status page. Null means decide by kind: the
   * ones you bought are shown, the automatic ones are not, because an automatic
   * address has the server's IP written into it.
   */
  onStatusPage?: boolean | null;
  id: string;
  /** Null until the domain is pointed at one of your apps. */
  serviceId: string | null;
  /** Set when this name redirects to the other half of a pair, e.g. www to apex. */
  redirectTo?: string | null;
  hostname: string;
  /**
   * When several apps share this domain, the path this one answers on: `/blog`.
   * Null means the whole domain.
   */
  pathPrefix?: string | null;
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

/**
 * What everything running here would cost on a platform that sends a bill.
 *
 * The point is that the value of your own server is otherwise invisible: nothing
 * arrives monthly to remind you it is worth having. Every figure is a published list
 * price and the estimate is deliberately conservative, because a number that flatters
 * itself is worth nothing.
 */
export interface CostElsewhere {
  name: string;
  monthly: number;
  note: string | null;
}

export interface CostComparison {
  apps: number;
  databases: number;
  projects: number;
  storageGb: number;
  elsewhere: CostElsewhere[];
  cheapestMonthly: number;
  dearestMonthly: number;
  /** When the prices were last checked, so an old figure is obviously old. */
  pricesCheckedAt: string;
  summary: string;
}

/** Where alerts can be sent. One shape for every destination. */
export type AlertChannelKind = 'email' | 'discord' | 'slack' | 'telegram' | 'ntfy' | 'webhook';

export interface AlertChannel {
  id: string;
  kind: AlertChannelKind;
  /** A webhook URL, an ntfy topic address, a Telegram chat id, or an email address. */
  target: string;
  /** Only Telegram needs one. Never sent back to the browser. */
  secret?: string | null;
}

/** The things worth being told about. */
export type AlertEventKind =
  | 'app.crashed'
  | 'app.crashloop'
  | 'deploy.failed'
  | 'deploy.succeeded'
  | 'disk.low'
  | 'memory.low'
  | 'certificate.expiring'
  | 'domain.drifted'
  | 'backup.failed'
  | 'drill.failed'
  | 'job.failed';

export interface AlertSettings {
  channels: AlertChannel[];
  events: AlertEventKind[];
}

/**
 * What went wrong, in two sentences, with something to press.
 *
 * `confident` is false when this came from a model rather than a rule Derailed knows,
 * so the screen can say so. A confident wrong answer is worse than no answer: somebody
 * will follow it and spend an hour on the thing it named instead of the thing that
 * broke.
 */
export interface Diagnosis {
  id: string;
  summary: string;
  action: string;
  /** Something Derailed can do about it, from the failure card. */
  fix?: 'add-swap' | 'reclaim-disk' | null;
  confident: boolean;
}

/**
 * Something that runs on a schedule.
 *
 * With a `serviceId` it runs inside that app's container, so it has the app's
 * environment and its files. Without one it runs on the server, which is the
 * housekeeping that belongs to nobody in particular.
 */
export interface Job {
  id: string;
  serviceId: string | null;
  name: string;
  command: string;
  /** A five-field cron expression. The dashboard's choices compile down to these. */
  schedule: string;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  createdAt: number;
}

export interface JobRun {
  id: string;
  jobId: string;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  output: string | null;
  trigger: 'schedule' | 'manual';
}

/**
 * What an app was doing, an hour at a time.
 *
 * Average and peak both, because an average alone hides the spike somebody is looking
 * for. Deploys come with it: "memory started climbing on Tuesday" is a sentence,
 * "memory started climbing right after that deploy" is a diagnosis.
 */
export interface MetricPoint {
  at: number;
  cpuAverage: number;
  cpuPeak: number;
  memoryAverage: number;
  memoryPeak: number;
  memoryLimit: number | null;
}

export interface MetricsHistory {
  range: '24h' | '7d' | '30d';
  points: MetricPoint[];
  deploys: { id: string; at: number; commitSha: string | null; commitMessage: string | null }[];
  summary: string;
}

/**
 * What changed between two deploys.
 *
 * Debugging is mostly bisecting what changed, and until now Derailed knew and did not
 * say. Variable values are never included, only which ones moved.
 */
export interface DeployDiff {
  from: { id: string; at: number; commitSha: string | null } | null;
  to: { id: string; at: number; commitSha: string | null };
  commits: { sha: string; message: string }[];
  envChanged: { key: string; change: 'added' | 'removed' | 'changed' }[];
  imageChanged: boolean;
  summary: string;
}

/**
 * What sort of thing is inside a database.
 *
 * The Browse tab is one screen for six engines, but three of them keep rows, one
 * keeps documents and two keep keys. Pretending those are the same thing produces a
 * screen that is wrong for all of them, so the shape is named and the screen adapts.
 */
export type BrowseKind = 'sql' | 'documents' | 'keys';

/** One table, collection or key namespace inside a database, for the Browse tab. */
export interface TableSummary {
  name: string;
  /** An estimate, from the engine's own statistics, and said to be one. */
  approximateRows: number;
}

export interface QueryResult {
  columns: string[];
  /** `null` is the database's null, which is not the same as an empty string. */
  rows: (string | null)[][];
  truncated: boolean;
  /** Whether this result can be edited in place. A query's results never can. */
  readOnly: boolean;
  /**
   * The columns that identify a row, so an edit knows which one it means. Empty when
   * the table has no primary key, which is why `readOnlyReason` exists.
   */
  primaryKey?: string[];
  /** Said on the page when editing is off, instead of cells that silently do nothing. */
  readOnlyReason?: string | null;
  /** How many rows there are altogether, when the engine can say without a scan. */
  total?: number | null;
}

/** One key in Redis or Valkey. */
export interface KeyEntry {
  name: string;
  /** `string`, `list`, `hash`, `set`, `zset`, `stream`. */
  type: string;
  /** Seconds until it expires, or null when it does not. */
  expiresIn: number | null;
}

/** A page of keys. `cursor` is where to carry on from, or null at the end. */
export interface KeyPage {
  keys: KeyEntry[];
  cursor: string | null;
}

/** What one key holds, rendered for looking at. */
export interface KeyValue {
  key: string;
  type: string;
  expiresIn: number | null;
  /** Pairs for a hash or a sorted set, single values for everything else. */
  entries: { field: string | null; value: string }[];
  truncated: boolean;
  /** Only a plain string can be edited here; the rest say why not. */
  editable: boolean;
}

/** A query somebody wanted to keep, against one database. */
export interface SavedQuery {
  id: string;
  serviceId: string;
  name: string;
  body: string;
  createdAt: number;
}

/** One thing in an app's storage, for the Files tab. */
export interface FileEntry {
  name: string;
  directory: boolean;
  sizeBytes: number;
  modifiedAt: number;
}

/** Whether a site was up, a day at a time. Ninety days is what a status page shows. */
export interface UptimeDay {
  day: number;
  checks: number;
  uptimePercent: number;
  averageMs: number;
}

export interface UptimeSummary {
  domainId: string;
  /** Null when it has never been checked. */
  up: boolean | null;
  lastCheckedAt: number | null;
  lastReason: string | null;
  days: UptimeDay[];
  uptimePercent: number | null;
}

/** A port an existing container publishes, for the adopt screen. */
export interface AdoptablePort {
  container: number;
  published: number | null;
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
