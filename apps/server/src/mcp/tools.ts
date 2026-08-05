/**
 * The things a coding agent can do to a Derailed server.
 *
 * Everything goes through the ordinary HTTP API with a token, so the agent can be on
 * a laptop while the server is anywhere, and so an agent can never do something the
 * dashboard couldn't. Read tools are plentiful; write tools are the ones a person
 * would actually ask for out loud.
 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
  run: (api: Api, args: Record<string, unknown>) => Promise<unknown>;
}

export interface Api {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body?: unknown): Promise<T>;
  put<T>(path: string, body?: unknown): Promise<T>;
  del<T>(path: string): Promise<T>;
}

const str = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`"${key}" is required.`);
  return value.trim();
};

/** Resolves a project by id, slug or name, because an agent will use whichever it saw. */
async function findProject(api: Api, needle: string) {
  const { projects } = await api.get<{ projects: Project[] }>('/projects');
  const match =
    projects.find((project) => project.id === needle) ??
    projects.find((project) => project.slug === needle) ??
    projects.find((project) => project.name.toLowerCase() === needle.toLowerCase());
  if (!match) {
    throw new Error(
      `No project called "${needle}". Available: ${projects.map((p) => p.name).join(', ') || 'none'}`,
    );
  }
  return match;
}

async function findService(api: Api, needle: string) {
  const { projects } = await api.get<{ projects: Project[] }>('/projects');
  const services = projects.flatMap((project) =>
    (project.services ?? []).map((service) => ({ ...service, projectName: project.name })),
  );
  const match =
    services.find((service) => service.id === needle) ??
    services.find((service) => service.name.toLowerCase() === needle.toLowerCase());
  if (!match) {
    throw new Error(
      `No app or database called "${needle}". Available: ${services.map((s) => s.name).join(', ') || 'none'}`,
    );
  }
  return match;
}

interface Project {
  id: string;
  name: string;
  slug: string;
  services?: Service[];
}

interface Service {
  id: string;
  name: string;
  kind: string;
  status?: string;
  source?: string;
  image?: string | null;
  repoUrl?: string | null;
  domains?: { hostname: string; kind: string; tlsStatus: string }[];
  volumes?: { containerPath: string }[];
  latestDeployment?: { status: string; errorSummary: string | null } | null;
}

export const TOOLS: McpTool[] = [
  {
    name: 'list_projects',
    description:
      'List every project on this Derailed server with its apps, databases, statuses and web addresses.',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      const { projects } = await api.get<{ projects: Project[] }>('/projects');
      return projects.map((project) => ({
        name: project.name,
        slug: project.slug,
        services: (project.services ?? []).map((service) => ({
          name: service.name,
          kind: service.kind,
          status: service.status,
          source: service.source,
          image: service.image ?? undefined,
          repository: service.repoUrl ?? undefined,
          addresses: (service.domains ?? []).map((domain) => domain.hostname),
          storage: (service.volumes ?? []).map((volume) => volume.containerPath),
        })),
      }));
    },
  },
  {
    name: 'server_status',
    description:
      'How the server itself is doing: processor, memory and disk, plus whether Docker and web traffic are healthy.',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      const [{ system }, { stats }] = await Promise.all([
        api.get<{ system: unknown }>('/system'),
        api.get<{ stats: unknown }>('/system/stats'),
      ]);
      return { system, stats };
    },
  },
  {
    name: 'deploy',
    description:
      'Deploy an app, building it again from its repository or re-pulling its image. Returns immediately; use get_logs to follow it.',
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'App name or id' } },
      required: ['service'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      if (service.kind !== 'app') throw new Error(`${service.name} is a database, not an app.`);
      await api.post(`/services/${service.id}/deployments`);
      return { deploying: service.name };
    },
  },
  {
    name: 'get_logs',
    description: 'The build and runtime output of an app, newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'App name or id' },
        lines: { type: 'number', description: 'How many lines to return (default 200)' },
      },
      required: ['service'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const { deployments } = await api.get<{ deployments: { id: string }[] }>(
        `/services/${service.id}/deployments`,
      );
      const latest = deployments[0];
      if (!latest) return { lines: [], note: `${service.name} has never been deployed.` };
      const tail = typeof args.lines === 'number' ? args.lines : 200;
      const { lines } = await api.get<{ lines: { line: string }[] }>(
        `/deployments/${latest.id}/logs?tail=${tail}`,
      );
      return { lines: lines.map((entry) => entry.line) };
    },
  },
  {
    name: 'control_service',
    description: 'Start, stop or restart an app or database.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Name or id' },
        action: { type: 'string', description: 'start, stop or restart' },
      },
      required: ['service', 'action'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const action = str(args, 'action').toLowerCase();
      if (!['start', 'stop', 'restart'].includes(action)) {
        throw new Error('action must be start, stop or restart.');
      }
      await api.post(`/services/${service.id}/${action}`);
      return { [action]: service.name };
    },
  },
  {
    name: 'deploy_from_github',
    description: 'Create a new app in a project from a public GitHub repository and deploy it.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        repository: { type: 'string', description: 'GitHub URL or owner/repo' },
        name: { type: 'string', description: 'What to call it' },
      },
      required: ['project', 'repository'],
    },
    async run(api, args) {
      const project = await findProject(api, str(args, 'project'));
      const repoUrl = str(args, 'repository');
      const detected = await api.post<{ detect: { suggestedName: string; summary: string } }>(
        '/detect',
        { repoUrl },
      );
      const service = await api.post<{ service: Service }>(`/projects/${project.id}/services`, {
        kind: 'app',
        name: (args.name as string) || detected.detect.suggestedName,
        repoUrl,
        deployNow: true,
      });
      return { created: service.service.name, detected: detected.detect.summary };
    },
  },
  {
    name: 'install_app',
    description:
      'Install a ready-made app such as WordPress, Ghost, n8n, Uptime Kuma, Umami or Vaultwarden, with its database and storage set up.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        app: { type: 'string', description: 'Which app, e.g. wordpress' },
        name: { type: 'string', description: 'What to call it' },
      },
      required: ['project', 'app'],
    },
    async run(api, args) {
      const project = await findProject(api, str(args, 'project'));
      const result = await api.post<{ service: Service; afterDeploy: string }>(
        `/projects/${project.id}/templates`,
        { slug: str(args, 'app').toLowerCase(), name: args.name },
      );
      return { installed: result.service.name, next: result.afterDeploy };
    },
  },
  {
    name: 'list_available_apps',
    description: 'The ready-made apps that can be installed in one step.',
    inputSchema: { type: 'object', properties: {} },
    async run(api) {
      return api.get('/templates');
    },
  },
  {
    name: 'create_project',
    description: 'Create an empty project to group apps and databases.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Project name' } },
      required: ['name'],
    },
    async run(api, args) {
      const { project } = await api.post<{ project: Project }>('/projects', {
        name: str(args, 'name'),
      });
      return { created: project.name, slug: project.slug };
    },
  },
  {
    name: 'add_database',
    description: 'Add a PostgreSQL, MySQL or Redis database to a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or slug' },
        engine: { type: 'string', description: 'postgres, mysql or redis' },
        version: { type: 'string', description: 'Engine version, e.g. 17' },
        name: { type: 'string', description: 'What to call it' },
      },
      required: ['project', 'engine'],
    },
    async run(api, args) {
      const project = await findProject(api, str(args, 'project'));
      const engine = str(args, 'engine').toLowerCase();
      const { engines } = await api.get<{ engines: { engine: string; versions: string[] }[] }>(
        '/catalog/databases',
      );
      const known = engines.find((entry) => entry.engine === engine);
      if (!known) {
        throw new Error(`Unknown engine. Available: ${engines.map((e) => e.engine).join(', ')}`);
      }
      const { service } = await api.post<{ service: Service }>(`/projects/${project.id}/services`, {
        kind: 'database',
        name: (args.name as string) || engine,
        engine,
        version: (args.version as string) || known.versions[0],
      });
      return { created: service.name };
    },
  },
  {
    name: 'get_variables',
    description: "An app's environment variables. Values set by a database link are marked.",
    inputSchema: {
      type: 'object',
      properties: { service: { type: 'string', description: 'Name or id' } },
      required: ['service'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const { vars } = await api.get<{ vars: { key: string; value: string; source: string }[] }>(
        `/services/${service.id}/env`,
      );
      return vars.map((entry) => ({
        key: entry.key,
        value: entry.source === 'user' ? entry.value : '(set automatically)',
        source: entry.source,
      }));
    },
  },
  {
    name: 'set_variables',
    description:
      'Replace the environment variables someone set by hand on an app. Redeploy afterwards for them to take effect.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Name or id' },
        variables: { type: 'object', description: 'An object of KEY: value pairs' },
      },
      required: ['service', 'variables'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const variables = args.variables as Record<string, string>;
      if (!variables || typeof variables !== 'object')
        throw new Error('"variables" must be an object.');
      await api.put(`/services/${service.id}/env`, {
        vars: Object.entries(variables).map(([key, value]) => ({ key, value: String(value) })),
      });
      return { set: Object.keys(variables), note: 'Deploy for these to take effect.' };
    },
  },
  {
    name: 'add_domain',
    description:
      'Point a domain at an app. Derailed checks the DNS record first and gets a certificate once it resolves here.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'App name or id' },
        hostname: { type: 'string', description: 'e.g. shop.example.com' },
        includeWww: { type: 'boolean', description: 'Also add the www version' },
      },
      required: ['service', 'hostname'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const { domains } = await api.post<{ domains: { hostname: string; dnsStatus: string }[] }>(
        `/services/${service.id}/domains`,
        { hostname: str(args, 'hostname'), alsoAddWww: args.includeWww === true },
      );
      return domains;
    },
  },
  {
    name: 'add_storage',
    description:
      'Keep a folder inside an app across deploys. Without this, a deploy replaces the container and anything written to disk is lost.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'App name or id' },
        path: { type: 'string', description: 'Absolute path inside the app, e.g. /app/data' },
      },
      required: ['service', 'path'],
    },
    async run(api, args) {
      const service = await findService(api, str(args, 'service'));
      const { volume } = await api.post<{ volume: { containerPath: string } }>(
        `/services/${service.id}/volumes`,
        { containerPath: str(args, 'path') },
      );
      return { keeping: volume.containerPath, note: 'Attached on the next deploy.' };
    },
  },
];
