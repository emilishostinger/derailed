import type {
  AlertChannel,
  AlertEventKind,
  AlertSettings,
  BrowseKind,
  CostComparison,
  DeployDiff,
  Deployment,
  DetectResult,
  Diagnosis,
  DiskReport,
  DoctorFix,
  DoctorReport,
  Domain,
  DrillResult,
  EnvHistoryEntry,
  EnvVar,
  FileEntry,
  FreeDomain,
  Job,
  JobRun,
  KeyPage,
  KeyValue,
  LogLine,
  MetricsHistory,
  OffsiteSettings,
  OffsiteStatus,
  PendingChange,
  Project,
  QueryResult,
  SavedQuery,
  SecurityScan,
  ServerSshKey,
  Service,
  SshState,
  SwapState,
  TableSummary,
  TrashItem,
  UptimeSummary,
  User,
  UserRole,
  Volume,
} from '@derailed/shared';
import { api } from './client.ts';

export interface DirectCheck {
  usable: boolean;
  port25: boolean;
  reverseDns: string | null;
  ip: string | null;
  reason: string | null;
}

export interface MailSettings {
  delivery: 'server' | 'smtp';
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  /** Whether a password is stored. Never the password itself. */
  hasPassword: boolean;
  from: string;
  fromName: string;
  notifyUpdates: boolean;
  notifyTo: string;
  securityOnly: boolean;
  lastSentAt: number | null;
}

export interface DetectResponse {
  detect: DetectResult;
  repo: { url: string; path: string; branch: string };
  commit: { sha: string; message: string };
}

export interface CreateAppInput {
  name: string;
  repoUrl: string;
  branch?: string;
  rootDir?: string;
  port?: number;
  buildStrategy?: 'auto' | 'dockerfile' | 'nixpacks' | 'site';
  dockerfilePath?: string;
  deployNow?: boolean;
}

export interface OtherSoftware {
  derailed: { version: string; address: string | null; dataDir: string };
  containers: {
    id: string;
    name: string;
    image: string;
    state: string;
    status: string;
    ports: string[];
  }[];
}

export const endpoints = {
  projects: () => api.get<{ projects: Project[] }>('/projects').then((r) => r.projects),
  project: (id: string) => api.get<{ project: Project }>(`/projects/${id}`).then((r) => r.project),
  createProject: (name: string) =>
    api.post<{ project: Project }>('/projects', { name }).then((r) => r.project),
  renameProject: (id: string, name: string) =>
    api.patch<{ project: Project }>(`/projects/${id}`, { name }).then((r) => r.project),
  deleteProject: (id: string) => api.delete<{ ok: true; undoable?: boolean }>(`/projects/${id}`),

  detect: (repoUrl: string, branch?: string, rootDir?: string) =>
    api.post<DetectResponse>('/detect', { repoUrl, branch, rootDir }),

  createApp: (projectId: string, input: CreateAppInput) =>
    api
      .post<{ service: Service }>(`/projects/${projectId}/services`, { kind: 'app', ...input })
      .then((r) => r.service),
  createDatabase: (projectId: string, name: string, engine: string, version: string) =>
    api
      .post<{ service: Service }>(`/projects/${projectId}/services`, {
        kind: 'database',
        name,
        engine,
        version,
      })
      .then((r) => r.service),

  service: (id: string) => api.get<{ service: Service }>(`/services/${id}`).then((r) => r.service),
  mail: () => api.get<{ mail: MailSettings }>('/mail').then((r) => r.mail),
  mailDirectCheck: () => api.get<{ direct: DirectCheck }>('/mail/direct').then((r) => r.direct),
  saveMail: (patch: Record<string, unknown>) =>
    api.patch<{ mail: MailSettings }>('/mail', patch).then((r) => r.mail),
  testMail: (to?: string) => api.post<{ ok: true; to: string }>('/mail/test', { to }),

  patchService: (id: string, patch: Record<string, unknown>) =>
    api.patch<{ service: Service }>(`/services/${id}`, patch).then((r) => r.service),
  deleteService: (id: string) => api.delete<{ ok: true; undoable?: boolean }>(`/services/${id}`),
  startService: (id: string) => api.post<{ service: Service }>(`/services/${id}/start`),
  stopService: (id: string) => api.post<{ service: Service }>(`/services/${id}/stop`),
  restartService: (id: string) => api.post<{ service: Service }>(`/services/${id}/restart`),

  setProjectLimits: (
    projectId: string,
    limits: { memoryLimitMb: number | null; cpuLimitMillis: number | null },
  ) => api.put<{ project: Project }>(`/projects/${projectId}/limits`, limits),

  projectEnv: (projectId: string) =>
    api
      .get<{ vars: { key: string; value: string }[] }>(`/projects/${projectId}/env`)
      .then((r) => r.vars),
  saveProjectEnv: (projectId: string, vars: { key: string; value: string }[]) =>
    api.put<{ vars?: { key: string; value: string }[]; staged?: boolean; pending?: number }>(
      `/projects/${projectId}/env`,
      { vars },
    ),

  env: (serviceId: string) =>
    api.get<{ vars: EnvVar[] }>(`/services/${serviceId}/env`).then((r) => r.vars),
  saveEnv: (serviceId: string, vars: { key: string; value: string }[]) =>
    api.put<{ vars?: EnvVar[]; staged?: boolean; pending?: number }>(`/services/${serviceId}/env`, {
      vars,
    }),
  dnsState: () =>
    api.get<{ configured: boolean; zones: { id: string; name: string }[]; problem?: string }>(
      '/system/dns',
    ),
  setDnsToken: (token: string | null) =>
    api.put<{ configured: boolean; zones: { id: string; name: string }[] }>('/system/dns', {
      token,
    }),
  writeDns: (hostname: string, wildcard: boolean) =>
    api.post<{
      zone: string;
      records: { name: string; type: string; content: string; outcome: string }[];
    }>('/system/dns/write', { hostname, wildcard }),
  wordPressState: (serviceId: string) =>
    api.get<{ isWordPress: boolean; staging: { id: string; name: string } | null }>(
      `/services/${serviceId}/wordpress`,
    ),
  wordPressLogin: (serviceId: string) =>
    api.post<{ url: string }>(`/services/${serviceId}/wordpress/login`),
  wordPressUpdates: (serviceId: string) =>
    api.get<{
      updates: {
        core: { current: string; available: string | null };
        plugins: { name: string; version: string; available: string }[];
        themes: { name: string; version: string; available: string }[];
      };
    }>(`/services/${serviceId}/wordpress/updates`),
  wordPressUpdate: (serviceId: string, what: 'plugins' | 'themes' | 'core' | 'all') =>
    api.post<{ backupId: string; report: string }>(`/services/${serviceId}/wordpress/update`, {
      what,
    }),
  wordPressStaging: (serviceId: string) =>
    api.post<{ staging: Service }>(`/services/${serviceId}/wordpress/staging`),
  wordPressPush: (serviceId: string) =>
    api.post<{ backupId: string }>(`/services/${serviceId}/wordpress/staging/push`),
  imagesEnabled: (serviceId: string) =>
    api.get<{ enabled: boolean }>(`/services/${serviceId}/images`).then((r) => r.enabled),
  setImages: (serviceId: string, enabled: boolean) =>
    api
      .put<{ enabled: boolean }>(`/services/${serviceId}/images`, { enabled })
      .then((r) => r.enabled),
  // The site source, presented with the same shapes as storage files, so one
  // browser component draws both.
  source: (serviceId: string, path?: string) =>
    api.get<{ roots: string[]; path: string | null; entries: FileEntry[] }>(
      `/services/${serviceId}/source${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  readSource: (serviceId: string, path: string) =>
    api
      .get<{ contents: string }>(
        `/services/${serviceId}/source/read?path=${encodeURIComponent(path)}`,
      )
      .then((r) => r.contents),
  writeSource: (serviceId: string, path: string, contents: string, deploy = true) =>
    api.put<{ ok: boolean; deployment: Deployment | null }>(`/services/${serviceId}/source`, {
      path,
      contents,
      deploy,
    }),
  newSourceFolder: (serviceId: string, path: string, name: string) =>
    api.post<{ ok: true }>(`/services/${serviceId}/source/folder`, { path, name }),
  renameSource: (serviceId: string, path: string, name: string) =>
    api.post<{ ok: true }>(`/services/${serviceId}/source/rename`, { path, name }),
  deleteSource: (serviceId: string, path: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/source?path=${encodeURIComponent(path)}`),
  uploadSource: (serviceId: string, path: string, file: File) =>
    api.putFile<{ ok: true }>(
      `/services/${serviceId}/source/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
      file,
    ),
  downloadSourceUrl: (serviceId: string, path: string) =>
    `/api/services/${serviceId}/source/download?path=${encodeURIComponent(path)}`,
  errorPageTemplate: (serviceId: string, kind: '404' | '500') =>
    api.get<{ contents: string }>(`/services/${serviceId}/source/error-page/${kind}`),
  envHistory: (serviceId: string) =>
    api
      .get<{ history: EnvHistoryEntry[] }>(`/services/${serviceId}/env/history`)
      .then((r) => r.history),
  projectEnvHistory: (projectId: string) =>
    api
      .get<{ history: EnvHistoryEntry[] }>(`/projects/${projectId}/env/history`)
      .then((r) => r.history),

  pendingChanges: (projectId: string) =>
    api.get<{ reviewChanges: boolean; changes: PendingChange[] }>(`/projects/${projectId}/pending`),
  applyPendingChanges: (projectId: string) =>
    api.post<{
      results: { id: string; summary: string; ok: boolean; note: string | null }[];
      pending: number;
      redeployNeeded: boolean;
    }>(`/projects/${projectId}/pending/apply`),
  discardPendingChange: (projectId: string, changeId?: string) =>
    api.delete<{ pending: number }>(
      changeId ? `/projects/${projectId}/pending/${changeId}` : `/projects/${projectId}/pending`,
    ),
  setReviewChanges: (projectId: string, enabled: boolean) =>
    api.put<{ reviewChanges: boolean; pending: number }>(`/projects/${projectId}/review`, {
      enabled,
    }),

  deployments: (serviceId: string) =>
    api
      .get<{ deployments: Deployment[] }>(`/services/${serviceId}/deployments`)
      .then((r) => r.deployments),
  deploy: (serviceId: string) =>
    api
      .post<{ deployment: Deployment }>(`/services/${serviceId}/deployments`)
      .then((r) => r.deployment),
  deploymentLogs: (deploymentId: string, tail = 1000) =>
    api
      .get<{ lines: LogLine[] }>(`/deployments/${deploymentId}/logs?tail=${tail}`)
      .then((r) => r.lines),
  cancelDeployment: (deploymentId: string) =>
    api.post<{ ok: true }>(`/deployments/${deploymentId}/cancel`),
  rollback: (deploymentId: string) =>
    api
      .post<{ deployment: Deployment }>(`/deployments/${deploymentId}/rollback`)
      .then((r) => r.deployment),

  domains: (serviceId: string) =>
    api.get<{ domains: Domain[] }>(`/services/${serviceId}/domains`).then((r) => r.domains),
  addDomain: (serviceId: string, hostname: string, alsoAddWww = false) =>
    api
      .post<{ domains: Domain[] }>(`/services/${serviceId}/domains`, { hostname, alsoAddWww })
      .then((r) => r.domains),
  allDomains: () =>
    api
      .get<{ domains: import('../pages/Domains.tsx').DomainRow[] }>('/domains')
      .then((r) => r.domains),
  addOwnDomain: (
    hostname: string,
    alsoAddWww = false,
    primary: 'apex' | 'www' = 'apex',
    /** Set on the second press, after "that points at somebody else's server". */
    force = false,
  ) =>
    api.post<{ domains: import('../pages/Domains.tsx').DomainRow[] }>('/domains', {
      hostname,
      alsoAddWww,
      primary,
      force,
    }),
  /** Adds the other half of a pair (usually www) and points it at an existing one. */
  addPairedDomain: (hostname: string, redirectTo: string) =>
    api.post<{ domains: import('../pages/Domains.tsx').DomainRow[] }>('/domains', {
      hostname,
      redirectTo,
    }),
  makePrimary: (domainId: string) =>
    api.put<{ domain: Domain }>(`/domains/${domainId}/primary`, {}),
  setDomainService: (domainId: string, serviceId: string | null) =>
    api.put<{ domain: Domain }>(`/domains/${domainId}/service`, { serviceId }),
  deleteDomain: (domainId: string) => api.delete<{ ok: true }>(`/domains/${domainId}`),
  checkDomain: (domainId: string) =>
    api.post<{ domain: Domain }>(`/domains/${domainId}/check`).then((r) => r.domain),

  checkUpdate: () =>
    api
      .get<{
        update: {
          version: string;
          current: string;
          newer: boolean;
          url: string;
          notes: string | null;
        } | null;
      }>('/system/update')
      .then((r) => r.update),

  templates: () =>
    api
      .get<{
        templates: {
          slug: string;
          name: string;
          blurb: string;
          category: string;
          needsDatabase: boolean;
          afterDeploy: string;
          imageRepo: string;
        }[];
      }>('/templates')
      .then((r) => r.templates),
  /** Checks a link and says what it would create, without creating anything. */
  peekTemplate: (url: string) =>
    api.post<{ template: { name: string; blurb: string; needsDatabase?: boolean } }>(
      '/templates/from-url',
      { url },
    ),
  installTemplateFromUrl: (projectId: string, url: string) =>
    api.post<{ ok: true }>(`/projects/${projectId}/templates`, { url }),

  installTemplate: (projectId: string, slug: string, name?: string, image?: string) =>
    api.post<{ service: Service; afterDeploy: string }>(`/projects/${projectId}/templates`, {
      slug,
      name,
      image,
    }),
  createFromImage: (projectId: string, name: string, image: string, port?: number) =>
    api
      .post<{ service: Service }>(`/projects/${projectId}/services`, {
        kind: 'app',
        source: 'image',
        name,
        image,
        port,
        deployNow: true,
      })
      .then((r) => r.service),

  volumes: (serviceId: string) =>
    api.get<{ volumes: Volume[] }>(`/services/${serviceId}/volumes`).then((r) => r.volumes),
  addVolume: (serviceId: string, containerPath: string) =>
    api
      .post<{ volume: Volume }>(`/services/${serviceId}/volumes`, { containerPath })
      .then((r) => r.volume),
  deleteVolume: (volumeId: string) => api.delete<{ ok: true }>(`/volumes/${volumeId}`),

  setRepoToken: (serviceId: string, token: string | null) =>
    api.put<{ service: Service }>(`/services/${serviceId}/repo-token`, { token }),

  createUploadApp: (projectId: string, name: string) =>
    api
      .post<{ service: Service }>(`/projects/${projectId}/services`, {
        kind: 'app',
        source: 'upload',
        name,
        deployNow: false,
      })
      .then((r) => r.service),
  /** A folder, each file labelled with its path inside it. Nothing is zipped first. */
  serviceLogs: (serviceId: string) => api.get<{ lines: LogLine[] }>(`/services/${serviceId}/logs`),

  uploadFolder: (serviceId: string, files: { path: string; file: File }[]) => {
    const form = new FormData();
    for (const entry of files) form.append('files', entry.file, entry.path);
    return api.upload<{ files: number }>(`/services/${serviceId}/upload`, form);
  },

  uploadFiles: (serviceId: string, file: File) => {
    const form = new FormData();
    form.append('file', file);
    return api.upload<{ files: number }>(`/services/${serviceId}/upload`, form);
  },

  backups: () => api.get<import('../pages/Backups.tsx').BackupsResponse>('/backups'),
  createBackup: (projectId: string) => api.post<{ backup: unknown }>('/backups', { projectId }),
  setRetention: (keep: number, keepDays: number) =>
    api.put<{ retention: { keep: number; keepDays: number }; removed: number }>(
      '/backups/retention',
      { keep, keepDays },
    ),
  setBackupSchedule: (projectId: string, schedule: 'off' | 'daily' | 'weekly') =>
    api.put<{ schedule: string }>('/backups/schedule', { projectId, schedule }),
  restoreBackup: (id: string, projectId: string) =>
    api.post<{ report: { databases: number; volumes: number; warnings: string[] } }>(
      `/backups/${id}/restore`,
      { projectId },
    ),
  deleteBackup: (id: string) => api.delete<{ ok: true }>(`/backups/${id}`),

  updates: (refresh = false) =>
    api.get<import('../pages/Updates.tsx').UpdateReport>(
      `/updates${refresh ? '?refresh=true' : ''}`,
    ),
  applyUpdate: (id: string) => api.post<{ message: string }>(`/updates/${id}/apply`),

  appUpdateState: (serviceId: string) =>
    api.get<{
      availability: import('@derailed/shared').AppUpdateAvailability;
      autoUpdate: boolean;
      history: import('@derailed/shared').AppUpdate[];
      canRevert: boolean;
    }>(`/services/${serviceId}/update`),
  startAppUpdate: (serviceId: string) =>
    api.post<{ update: import('@derailed/shared').AppUpdate }>(`/services/${serviceId}/update`),
  revertAppUpdate: (serviceId: string) =>
    api.post<{ update: import('@derailed/shared').AppUpdate }>(
      `/services/${serviceId}/update/revert`,
    ),
  setAppAutoUpdate: (serviceId: string, enabled: boolean) =>
    api.put<{ autoUpdate: boolean }>(`/services/${serviceId}/auto-update`, { enabled }),

  dbUpgradeState: (serviceId: string) =>
    api.get<{
      engine: string | null;
      current: string | null;
      targets: string[];
      history: import('@derailed/shared').DbUpgrade[];
    }>(`/services/${serviceId}/upgrade`),
  startDbUpgrade: (serviceId: string, version: string) =>
    api.post<{ upgrade: import('@derailed/shared').DbUpgrade }>(`/services/${serviceId}/upgrade`, {
      version,
    }),
  pitrState: (serviceId: string) =>
    api.get<import('@derailed/shared').PitrState>(`/services/${serviceId}/pitr`),
  setPitr: (serviceId: string, enabled: boolean) =>
    api.put<import('@derailed/shared').PitrState>(`/services/${serviceId}/pitr`, { enabled }),
  pitrRestore: (serviceId: string, at: number) =>
    api.post<{ started: true }>(`/services/${serviceId}/pitr/restore`, { at }),

  tailscale: () =>
    api.get<{
      installed: boolean;
      connected: boolean;
      dnsName: string | null;
      ip: string | null;
      tailnet: string | null;
      funnelOn: boolean;
      funnelServiceId: string | null;
    }>('/system/tailscale'),
  installTailscale: () => api.post<{ ok: boolean; message: string }>('/system/tailscale/install'),
  connectTailscale: (authKey?: string) =>
    api.post<{ ok: boolean; loginUrl?: string }>('/system/tailscale/connect', { authKey }),
  setFunnel: (serviceId: string | null) =>
    api.put<{ funnelServiceId: string | null; hostname?: string }>('/system/tailscale/funnel', {
      serviceId,
    }),

  appLogin: (serviceId: string) =>
    api.get<{
      loginRequired: boolean;
      allowedEmails: string[];
      sessions: {
        id: string;
        email: string;
        createdAt: number;
        lastSeenAt: number | null;
        ip: string | null;
        userAgent: string | null;
      }[];
    }>(`/services/${serviceId}/login`),
  setAppLogin: (serviceId: string, patch: { enabled: boolean; allowedEmails?: string[] }) =>
    api.put<{ loginRequired: boolean; allowedEmails: string[] }>(
      `/services/${serviceId}/login`,
      patch,
    ),
  endAppSession: (serviceId: string, sessionId: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/login/sessions/${sessionId}`),

  botSettings: (serviceId: string) =>
    api.get<{
      mode: 'off' | 'polite' | 'strict';
      blockAi: boolean;
      challenged: number;
      banned: number;
    }>(`/services/${serviceId}/bots`),
  setBotSettings: (
    serviceId: string,
    patch: { mode?: 'off' | 'polite' | 'strict'; blockAi?: boolean },
  ) =>
    api.put<{ mode: 'off' | 'polite' | 'strict'; blockAi: boolean }>(
      `/services/${serviceId}/bots`,
      patch,
    ),

  messages: (serviceId: string) =>
    api.get<{
      enabled: boolean;
      total: number;
      submissions: {
        id: string;
        form: string;
        fields: Record<string, string>;
        createdAt: number;
      }[];
    }>(`/services/${serviceId}/messages`),
  setFormsEnabled: (serviceId: string, enabled: boolean) =>
    api.put<{ enabled: boolean }>(`/services/${serviceId}/messages/settings`, { enabled }),
  deleteMessage: (serviceId: string, messageId: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/messages/${messageId}`),

  inspectImport: (repoUrl: string, branch?: string, rootDir?: string, format?: string) =>
    api.post<{
      plan: import('@derailed/shared').ImportPlan;
      found: string[];
      format: string;
      composeFile: string;
      suggestedName: string;
    }>('/import/inspect', { repoUrl, branch, rootDir, format }),
  applyImport: (projectId: string, plan: import('@derailed/shared').ImportPlan) =>
    api.post<{
      services: import('@derailed/shared').Service[];
      databases: import('@derailed/shared').Service[];
      warnings: string[];
    }>(`/projects/${projectId}/import`, { plan }),

  tokens: () =>
    api
      .get<{
        tokens: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[];
      }>('/tokens')
      .then((r) => r.tokens),
  createToken: (name: string) => api.post<{ secret: string }>('/tokens', { name }),
  deleteToken: (id: string) => api.delete<{ ok: true }>(`/tokens/${id}`),

  serverStats: () =>
    api
      .get<{
        stats: {
          at: number;
          uptimeSeconds: number;
          cpu: { cores: number; percent: number; load1: number };
          memory: { totalBytes: number; usedBytes: number; percent: number };
          swap: { totalBytes: number; usedBytes: number } | null;
          summary: string;
          level: 'ok' | 'busy' | 'strained';
        };
      }>('/system/stats')
      .then((r) => r.stats),

  panelDomain: () =>
    api.get<{ panelDomain: string | null }>('/system/panel-domain').then((r) => r.panelDomain),
  changeEmail: (email: string, password: string) =>
    api.patch<{ user: User }>('/auth/me/email', {
      email,
      password,
    }),
  changePassword: (current: string, password: string) =>
    api.patch<{ ok: true }>('/auth/me/password', { current, password }),

  traffic: (serviceId: string, range: '24h' | '7d' | '30d') =>
    api
      .get<{ traffic: import('../components/TrafficTab.tsx').TrafficReport }>(
        `/services/${serviceId}/traffic?range=${range}`,
      )
      .then((r) => r.traffic),

  others: () => api.get<{ others: OtherSoftware }>('/system/others').then((r) => r.others),

  appDomain: () =>
    api.get<{ appDomain: string | null }>('/system/app-domain').then((r) => r.appDomain),
  setAppDomain: (domain: string | null) =>
    api.put<{ appDomain: string | null; added?: number }>('/system/app-domain', { domain }),

  offsite: () => api.get<{ settings: OffsiteSettings; status: OffsiteStatus }>('/backups/offsite'),
  saveOffsite: (input: Record<string, unknown>) =>
    api.put<{ settings: OffsiteSettings; status: OffsiteStatus }>('/backups/offsite', input),
  forgetOffsite: () =>
    api.delete<{ settings: OffsiteSettings; status: OffsiteStatus }>('/backups/offsite'),
  testOffsite: () =>
    api.post<{ result: { roundTripMs: number } }>('/backups/offsite/test').then((r) => r.result),

  drill: () => api.get<{ drill: DrillResult | null }>('/backups/drill').then((r) => r.drill),
  runDrill: () => api.post<{ drill: DrillResult }>('/backups/drill').then((r) => r.drill),

  previews: (serviceId: string) =>
    api.get<{
      enabled: boolean;
      mode: 'shared' | 'clone';
      scrub: string | null;
      previews: Service[];
    }>(`/services/${serviceId}/previews`),
  setPreviewData: (serviceId: string, data: 'shared' | 'clone', scrub?: string | null) =>
    api.put<{ enabled: boolean; mode: 'shared' | 'clone' }>(`/services/${serviceId}/previews`, {
      enabled: true,
      data,
      scrub,
    }),
  setPreviews: (serviceId: string, enabled: boolean) =>
    api.put<{ enabled: boolean }>(`/services/${serviceId}/previews`, { enabled }),

  people: () => api.get<{ people: User[]; you: string }>('/people'),
  addPerson: (email: string, password: string, role: UserRole) =>
    api.post<{ person: User }>('/people', { email, password, role }),
  setPersonRole: (id: string, role: UserRole) =>
    api.put<{ person: User }>(`/people/${id}/role`, { role }),
  removePerson: (id: string) => api.delete<{ ok: true }>(`/people/${id}`),

  setDomainOnStatusPage: (domainId: string, show: boolean | null) =>
    api.put<{ domain: Domain }>(`/uptime/${domainId}/status-page`, { show }),

  adoptable: () =>
    api
      .get<{
        containers: {
          id: string;
          name: string;
          image: string;
          state: string;
          ports: { container: number; published: number | null }[];
          suggestedPort: number | null;
          blocked: string | null;
        }[];
      }>('/system/adoptable')
      .then((r) => r.containers),
  adopt: (input: { containerId: string; projectName?: string; appName?: string; port?: number }) =>
    api.post<{ projectId: string; serviceId: string }>('/system/adopt', input),

  movePlan: () => api.get<{ plan: unknown }>('/backups/move/plan').then((r) => r.plan),
  exportInstall: () => api.post<{ file: string; sizeBytes: number }>('/backups/move/export'),
  importInstall: (plan: unknown) =>
    api
      .post<{
        result: {
          projects: number;
          services: number;
          domains: number;
          afterwards: string[];
          warnings: string[];
        };
      }>('/backups/move/import', { plan })
      .then((r) => r.result),

  me: () => api.get<{ totpEnabled?: boolean; recoveryCodesLeft?: number }>('/auth/me'),
  startTotp: () => api.post<{ secret: string; url: string }>('/auth/totp/start'),
  confirmTotp: (code: string) =>
    api.post<{ enabled: boolean; recoveryCodes: string[] }>('/auth/totp/confirm', { code }),
  disableTotp: (password: string) => api.delete<{ enabled: boolean }>('/auth/totp', { password }),
  sessions: () =>
    api
      .get<{
        sessions: {
          id: string;
          createdAt: number;
          lastSeenAt: number | null;
          userAgent: string | null;
          ip: string | null;
          current: boolean;
        }[];
      }>('/auth/sessions')
      .then((r) => r.sessions),
  endSession: (id: string) => api.delete<{ ok: true }>(`/auth/sessions/${id}`),
  audit: () =>
    api
      .get<{
        entries: {
          id: string;
          at: number;
          email: string | null;
          action: string;
          ip: string | null;
        }[];
      }>('/audit')
      .then((r) => r.entries),

  uptime: () =>
    api.get<{
      sites: { domain: Domain; service: string | null; uptime: UptimeSummary }[];
      statusPage: { enabled: boolean; title: string };
    }>('/uptime'),
  checkUptime: (domainId: string) => api.post<unknown>(`/uptime/${domainId}/check`),
  setStatusPage: (input: { enabled: boolean; title: string }) =>
    api.put<{ enabled: boolean; title: string }>('/uptime/status-page', input),

  files: (serviceId: string, path?: string) =>
    api.get<{ roots: string[]; path: string | null; entries: FileEntry[] }>(
      `/services/${serviceId}/files${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  readFile: (serviceId: string, path: string) =>
    api
      .get<{ contents: string }>(
        `/services/${serviceId}/files/read?path=${encodeURIComponent(path)}`,
      )
      .then((r) => r.contents),
  writeFile: (serviceId: string, path: string, contents: string) =>
    api.put<{ ok: true }>(`/services/${serviceId}/files`, { path, contents }),
  newFolder: (serviceId: string, path: string, name: string) =>
    api.post<{ ok: true }>(`/services/${serviceId}/files/folder`, { path, name }),
  renameFile: (serviceId: string, path: string, name: string) =>
    api.post<{ ok: true }>(`/services/${serviceId}/files/rename`, { path, name }),
  deleteFile: (serviceId: string, path: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/files?path=${encodeURIComponent(path)}`),
  uploadFile: (serviceId: string, path: string, file: File) =>
    api.putFile<{ ok: true }>(
      `/services/${serviceId}/files/upload?path=${encodeURIComponent(path)}&name=${encodeURIComponent(file.name)}`,
      file,
    ),
  downloadFileUrl: (serviceId: string, path: string) =>
    `/api/services/${serviceId}/files/download?path=${encodeURIComponent(path)}`,

  appMail: (serviceId: string) =>
    api.get<{ enabled: boolean; available: boolean }>(`/services/${serviceId}/mail`),
  setAppMail: (serviceId: string, enabled: boolean) =>
    api.put<{ enabled: boolean }>(`/services/${serviceId}/mail`, { enabled }),

  setDomainPath: (domainId: string, pathPrefix: string | null) =>
    api.put<{ domain: Domain }>(`/domains/${domainId}/path`, { pathPrefix }),

  tables: (serviceId: string) =>
    api.get<{ kind: BrowseKind; tables: TableSummary[] }>(`/services/${serviceId}/tables`),
  readTable: (serviceId: string, table: string, limit = 100, offset = 0) =>
    api
      .get<{ result: QueryResult }>(
        `/services/${serviceId}/tables/${encodeURIComponent(table)}?limit=${limit}&offset=${offset}`,
      )
      .then((r) => r.result),
  updateCell: (
    serviceId: string,
    table: string,
    key: Record<string, string | null>,
    column: string,
    value: string | null,
  ) =>
    api.put<{ ok: true }>(`/services/${serviceId}/tables/${encodeURIComponent(table)}/cell`, {
      key,
      column,
      value,
    }),
  runQuery: (serviceId: string, body: string) =>
    api
      .post<{ result: QueryResult }>(`/services/${serviceId}/query`, { body })
      .then((r) => r.result),

  readDocument: (serviceId: string, collection: string, documentId: string) =>
    api
      .get<{ document: string }>(
        `/services/${serviceId}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(documentId)}`,
      )
      .then((r) => r.document),
  saveDocument: (serviceId: string, collection: string, documentId: string, document: string) =>
    api.put<{ ok: true }>(
      `/services/${serviceId}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(documentId)}`,
      { document },
    ),
  deleteDocument: (serviceId: string, collection: string, documentId: string) =>
    api.delete<{ ok: true }>(
      `/services/${serviceId}/collections/${encodeURIComponent(collection)}/${encodeURIComponent(documentId)}`,
    ),

  browseKeys: (serviceId: string, pattern: string, cursor: string) =>
    api
      .get<{ page: KeyPage }>(
        `/services/${serviceId}/keys?pattern=${encodeURIComponent(pattern)}&cursor=${encodeURIComponent(cursor)}`,
      )
      .then((r) => r.page),
  readKey: (serviceId: string, key: string) =>
    api
      .get<{ value: KeyValue }>(`/services/${serviceId}/keys/value?key=${encodeURIComponent(key)}`)
      .then((r) => r.value),
  saveKey: (serviceId: string, key: string, value: string) =>
    api.put<{ ok: true }>(`/services/${serviceId}/keys/value`, { key, value }),
  deleteKey: (serviceId: string, key: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/keys?key=${encodeURIComponent(key)}`),

  snapshots: (serviceId: string) =>
    api.get<{
      snapshots: { id: string; at: number; sizeBytes: number }[];
      everyHours: number | null;
      intervals: number[];
    }>(`/services/${serviceId}/snapshots`),
  setSnapshotInterval: (serviceId: string, everyHours: number | null) =>
    api.put<{ everyHours: number | null }>(`/services/${serviceId}/snapshots`, { everyHours }),
  takeSnapshot: (serviceId: string) =>
    api.post<{ snapshot: unknown }>(`/services/${serviceId}/snapshots`),
  restoreSnapshot: (serviceId: string, snapshotId: string) =>
    api.post<{ ok: true }>(`/services/${serviceId}/snapshots/${snapshotId}/restore`),

  savedQueries: (serviceId: string) =>
    api.get<{ queries: SavedQuery[] }>(`/services/${serviceId}/queries`).then((r) => r.queries),
  saveNamedQuery: (serviceId: string, name: string, body: string) =>
    api
      .post<{ query: SavedQuery }>(`/services/${serviceId}/queries`, { name, body })
      .then((r) => r.query),
  deleteSavedQuery: (serviceId: string, queryId: string) =>
    api.delete<{ ok: true }>(`/services/${serviceId}/queries/${queryId}`),

  metrics: (serviceId: string, range: '24h' | '7d' | '30d') =>
    api
      .get<{ metrics: MetricsHistory }>(`/services/${serviceId}/metrics?range=${range}`)
      .then((r) => r.metrics),
  deployChanges: (deploymentId: string) =>
    api.get<{ diff: DeployDiff }>(`/deployments/${deploymentId}/changes`).then((r) => r.diff),
  searchLog: (deploymentId: string, options: { q?: string; errors?: boolean }) =>
    api.get<{ lines: LogLine[]; matched: number; scanned: number }>(
      `/deployments/${deploymentId}/search?${new URLSearchParams({
        ...(options.q ? { q: options.q } : {}),
        ...(options.errors ? { errors: 'true' } : {}),
      })}`,
    ),

  jobs: (serviceId: string) =>
    api
      .get<{ jobs: (Job & { scheduleInWords?: string })[] }>(`/services/${serviceId}/jobs`)
      .then((r) => r.jobs),
  createJob: (input: {
    serviceId: string | null;
    name: string;
    command: string;
    schedule: string;
  }) => api.post<{ job: Job }>('/jobs', input),
  updateJob: (id: string, patch: Record<string, unknown>) =>
    api.patch<{ job: Job }>(`/jobs/${id}`, patch),
  deleteJob: (id: string) => api.delete<{ ok: true }>(`/jobs/${id}`),
  runJob: (id: string) => api.post<{ result: { ok: boolean; run: JobRun } }>(`/jobs/${id}/run`),
  runsFor: (id: string) => api.get<{ runs: JobRun[] }>(`/jobs/${id}/runs`).then((r) => r.runs),

  setAccess: (
    serviceId: string,
    patch: {
      username?: string | null;
      password?: string | null;
      allowFrom?: string[] | null;
      blockFrom?: string[] | null;
      maintenance?: boolean;
      /** Set on the second press, after the "that would block you" refusal. */
      force?: boolean;
    },
  ) => api.put<{ service: Service }>(`/services/${serviceId}/access`, patch),
  /** The address this browser is reaching the server from, for the "add mine" button. */
  myAddress: () => api.get<{ address: string }>('/system/my-address').then((r) => r.address),

  whyBroken: (deploymentId: string) =>
    api.get<{ diagnosis: Diagnosis | null; lines: string[] }>(`/deployments/${deploymentId}/why`),

  serverTraffic: (range: '24h' | '7d' | '30d', scope?: { project?: string; service?: string }) =>
    api
      .get<{
        traffic: {
          range: string;
          totals: {
            requests: number;
            visitors: number;
            bots: number;
            bytes: number;
            avgMs: number;
          };
          live: number;
          byService: { serviceId: string; name: string; requests: number; visitors: number }[];
        };
      }>(
        `/system/traffic?range=${range}${scope?.project ? `&project=${scope.project}` : ''}${
          scope?.service ? `&service=${scope.service}` : ''
        }`,
      )
      .then((r) => r.traffic),

  serverLogs: () =>
    api
      .get<{ lines: (LogLine & { serviceId: string; serviceName: string })[] }>('/system/logs')
      .then((r) => r.lines),

  openPorts: () =>
    api
      .get<{
        ports: {
          ports: {
            port: number;
            what: string;
            needed: boolean;
            action: string | null;
            serviceId?: string;
          }[];
          readable: boolean;
        };
      }>('/system/ports')
      .then((r) => r.ports),

  automaticUpdates: () =>
    api
      .get<{
        automatic: {
          enabled: boolean;
          supported: boolean;
          manager: string | null;
          lastRunAt: number | null;
          lastResult: string | null;
          rebootRequired: boolean;
          rebootReason: string | null;
        };
      }>('/updates/automatic')
      .then((r) => r.automatic),
  setAutomaticUpdates: (enabled: boolean) =>
    api.put<{ automatic: unknown }>('/updates/automatic', { enabled }),
  runSecurityUpdates: () => api.post<{ result: string }>('/updates/automatic/run'),

  webhooks: () =>
    api.get<{
      webhooks: {
        id: string;
        url: string;
        hasSecret: boolean;
        events: AlertEventKind[] | null;
        enabled: boolean;
        lastAt: number | null;
        lastStatus: number | null;
        lastError: string | null;
      }[];
      kinds: { kind: AlertEventKind; label: string }[];
    }>('/webhooks'),
  addWebhook: (url: string, secret: string, events: AlertEventKind[] | null) =>
    api.post<{ webhook: unknown }>('/webhooks', { url, secret, events }),
  setWebhookEnabled: (id: string, enabled: boolean) =>
    api.patch<{ webhook: unknown }>(`/webhooks/${id}`, { enabled }),
  deleteWebhook: (id: string) => api.delete<{ ok: true }>(`/webhooks/${id}`),
  testWebhook: (id: string) => api.post<{ sent: true }>(`/webhooks/${id}/test`),

  alerts: () =>
    api.get<{ settings: AlertSettings; kinds: { kind: AlertEventKind; label: string }[] }>(
      '/alerts',
    ),
  saveAlertChannels: (channels: AlertChannel[]) =>
    api.put<{ settings: AlertSettings }>('/alerts/channels', { channels }).then((r) => r.settings),
  saveAlertEvents: (events: AlertEventKind[]) =>
    api.put<{ settings: AlertSettings }>('/alerts/events', { events }).then((r) => r.settings),
  testAlertChannel: (id: string) => api.post<{ ok: true }>(`/alerts/channels/${id}/test`),

  cost: () => api.get<{ cost: CostComparison }>('/system/cost').then((r) => r.cost),

  previewSettings: () =>
    api.get<{ screenshots: boolean }>('/system/previews').then((r) => r.screenshots),
  setPreviewSettings: (screenshots: boolean) =>
    api
      .put<{ screenshots: boolean }>('/system/previews', { screenshots })
      .then((r) => r.screenshots),
  refreshPreview: (serviceId: string) => api.post<unknown>(`/services/${serviceId}/preview`),

  doctor: () => api.get<{ report: DoctorReport }>('/system/doctor').then((r) => r.report),
  lastScan: () => api.get<{ scan: SecurityScan | null }>('/system/scan').then((r) => r.scan),
  runScan: () => api.post<{ scan: SecurityScan }>('/system/scan').then((r) => r.scan),
  ssh: () => api.get<SshState>('/system/ssh'),
  addSshKey: (key: string) =>
    api.post<{ key: ServerSshKey; keys: ServerSshKey[] }>('/system/ssh/keys', { key }),
  removeSshKey: (fingerprint: string) =>
    api.delete<{ keys: ServerSshKey[] }>(
      `/system/ssh/keys?fingerprint=${encodeURIComponent(fingerprint)}`,
    ),
  setPasswordLogin: (enabled: boolean) =>
    api.put<{ passwordLogin: SshState['passwordLogin'] }>('/system/ssh/password-login', {
      enabled,
    }),
  doctorFix: (action: DoctorFix) =>
    api.post<{ report: DoctorReport }>(`/system/doctor/fix/${action}`).then((r) => r.report),

  disk: () => api.get<{ disk: DiskReport }>('/system/disk').then((r) => r.disk),
  reclaimDisk: () =>
    api
      .post<{ result: { freedBytes: number; what: string[] } }>('/system/disk/reclaim')
      .then((r) => r.result),
  swap: () => api.get<{ swap: SwapState }>('/system/swap').then((r) => r.swap),
  addSwap: () => api.post<{ swap: SwapState; added: number }>('/system/swap'),

  trash: () => api.get<{ items: TrashItem[] }>('/trash').then((r) => r.items),
  restoreFromTrash: (kind: 'project' | 'service', id: string) =>
    api.post<{ items: TrashItem[] }>(`/trash/${kind}/${id}/restore`).then((r) => r.items),
  purgeFromTrash: (kind: 'project' | 'service', id: string) =>
    api.delete<{ items: TrashItem[] }>(`/trash/${kind}/${id}`).then((r) => r.items),

  freeDomain: () =>
    api.get<{ freeDomain: FreeDomain }>('/system/free-domain').then((r) => r.freeDomain),
  claimFreeDomain: (name: string, token: string) =>
    api.put<{ freeDomain: FreeDomain; added: number }>('/system/free-domain', { name, token }),
  releaseFreeDomain: () =>
    api.delete<{ freeDomain: FreeDomain }>('/system/free-domain').then((r) => r.freeDomain),

  setPanelDomain: (hostname: string | null) =>
    api
      .put<{ panelDomain: string | null }>('/system/panel-domain', { hostname })
      .then((r) => r.panelDomain),

  databaseCatalog: () =>
    api.get<{ engines: { engine: string; label: string; versions: string[]; blurb: string }[] }>(
      '/catalog/databases',
    ),
  connection: (serviceId: string) =>
    api.get<{
      connection: {
        host: string;
        port: number;
        user: string;
        password: string;
        dbName: string;
        url: string;
        exposedPort: number | null;
      };
    }>(`/services/${serviceId}/connection`),
  setExposed: (serviceId: string, exposed: boolean) =>
    api.post<{ service: Service }>(`/services/${serviceId}/expose`, { exposed }),

  createLink: (fromServiceId: string, toServiceId: string, injectAs?: string, discrete?: boolean) =>
    api.post<{ ok: true }>(`/services/${fromServiceId}/links`, {
      toServiceId,
      injectAs,
      discrete,
    }),
  deleteLink: (linkId: string) => api.delete<{ ok: true }>(`/links/${linkId}`),
};
