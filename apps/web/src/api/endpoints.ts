import type {
  Deployment,
  DetectResult,
  Domain,
  EnvVar,
  LogLine,
  Project,
  Service,
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
  deleteProject: (id: string) => api.delete<{ ok: true }>(`/projects/${id}`),

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
  deleteService: (id: string) => api.delete<{ ok: true }>(`/services/${id}`),
  startService: (id: string) => api.post<{ service: Service }>(`/services/${id}/start`),
  stopService: (id: string) => api.post<{ service: Service }>(`/services/${id}/stop`),
  restartService: (id: string) => api.post<{ service: Service }>(`/services/${id}/restart`),

  env: (serviceId: string) =>
    api.get<{ vars: EnvVar[] }>(`/services/${serviceId}/env`).then((r) => r.vars),
  saveEnv: (serviceId: string, vars: { key: string; value: string }[]) =>
    api.put<{ vars: EnvVar[] }>(`/services/${serviceId}/env`, { vars }).then((r) => r.vars),

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
  addOwnDomain: (hostname: string, alsoAddWww = false, primary: 'apex' | 'www' = 'apex') =>
    api.post<{ domains: import('../pages/Domains.tsx').DomainRow[] }>('/domains', {
      hostname,
      alsoAddWww,
      primary,
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
        }[];
      }>('/templates')
      .then((r) => r.templates),
  installTemplate: (projectId: string, slug: string, name?: string) =>
    api.post<{ service: Service; afterDeploy: string }>(`/projects/${projectId}/templates`, {
      slug,
      name,
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
    api.patch<{ user: { id: string; email: string; createdAt: number } }>('/auth/me/email', {
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
