import { describe, expect, test } from 'bun:test';
import { type Api, TOOLS } from '../src/mcp/tools.ts';

/**
 * The tools a coding agent can reach for.
 *
 * Each one is a small translation: a name a person said into a path on the HTTP API.
 * Nothing here checks what the server does with that path, which is covered
 * elsewhere; it checks that the path is the right one and the shape handed back is
 * the shape a model can read. Those are exactly the two things a typo breaks and
 * nothing else notices, because an MCP tool is only ever run by somebody else's
 * language model, in somebody else's editor, a week later.
 */

const PROJECTS = {
  projects: [
    {
      id: 'p1',
      name: 'Shop',
      slug: 'shop',
      services: [
        { id: 's1', name: 'Web', kind: 'app', status: 'running' },
        { id: 's2', name: 'shop-db', kind: 'database', status: 'running' },
      ],
    },
  ],
};

/** Records every call, and answers with whatever the route really returns. */
function recordingApi(responses: Record<string, unknown> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const answer = (path: string): unknown => {
    for (const [pattern, value] of Object.entries(responses)) {
      if (path === pattern || path.startsWith(pattern)) return value;
    }
    return {};
  };
  const api: Api = {
    async get(path) {
      calls.push({ method: 'GET', path });
      return answer(path) as never;
    },
    async post(path, body) {
      calls.push({ method: 'POST', path, body });
      return answer(path) as never;
    },
    async put(path, body) {
      calls.push({ method: 'PUT', path, body });
      return answer(path) as never;
    },
    async patch(path, body) {
      calls.push({ method: 'PATCH', path, body });
      return answer(path) as never;
    },
    async del(path) {
      calls.push({ method: 'DELETE', path });
      return answer(path) as never;
    },
  };
  return { api, calls };
}

const tool = (name: string) => {
  const found = TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool called ${name}`);
  return found;
};

describe('the operational tools', () => {
  test('back_up_now finds the project by name and says where the copy went', async () => {
    const { api, calls } = recordingApi({
      '/projects': PROJECTS,
      '/backups': { backup: { id: 'b1', sizeBytes: 4096 }, offsiteError: null },
    });

    const result = await tool('back_up_now').run(api, { project: 'Shop' });
    expect(calls).toContainEqual({ method: 'POST', path: '/backups', body: { projectId: 'p1' } });
    expect(result).toEqual({
      backedUp: 'Shop',
      sizeBytes: 4096,
      offsite: 'copied off the server',
    });
  });

  test('back_up_now reports a failed off-site copy rather than throwing', async () => {
    // The backup itself worked. Saying otherwise would send an agent off fixing the
    // wrong thing, and would be untrue.
    const { api } = recordingApi({
      '/projects': PROJECTS,
      '/backups': { backup: { id: 'b1', sizeBytes: 10 }, offsiteError: 'the bucket refused' },
    });
    const result = (await tool('back_up_now').run(api, { project: 'shop' })) as {
      offsite: string;
    };
    expect(result.offsite).toBe('the bucket refused');
  });

  test('get_metrics refuses a range the API does not have', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS });
    await tool('get_metrics').run(api, { service: 'Web', range: 'all time' });
    expect(calls.at(-1)?.path).toBe('/services/s1/metrics?range=24h');

    await tool('get_metrics').run(api, { service: 'Web', range: '7d' });
    expect(calls.at(-1)?.path).toBe('/services/s1/metrics?range=7d');
  });

  test('list_domains says which app answers, including when none does', async () => {
    const { api } = recordingApi({
      '/domains': {
        domains: [
          {
            hostname: 'shop.example.com',
            serviceName: 'Web',
            dnsStatus: 'ok',
            tlsStatus: 'active',
            kind: 'custom',
          },
          {
            hostname: 'spare.example.com',
            serviceName: null,
            dnsStatus: 'no_record',
            tlsStatus: 'pending',
            kind: 'custom',
          },
        ],
      },
    });

    const result = (await tool('list_domains').run(api, {})) as { app: string }[];
    expect(result[0]?.app).toBe('Web');
    expect(result[1]?.app).toBe('not pointed at anything yet');
  });

  test('check_domain says what it does know when the name is unknown', async () => {
    const { api } = recordingApi({
      '/domains': { domains: [{ id: 'd1', hostname: 'shop.example.com' }] },
    });
    await expect(tool('check_domain').run(api, { domain: 'nope.example.com' })).rejects.toThrow(
      /shop\.example\.com/,
    );
  });

  test('add_job runs on the server itself when no app is named', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS, '/jobs': { job: { id: 'j1' } } });

    await tool('add_job').run(api, {
      name: 'Nightly tidy',
      command: 'cleanup.sh',
      schedule: '0 3 * * *',
    });
    expect(calls.at(-1)?.body).toEqual({
      serviceId: null,
      name: 'Nightly tidy',
      command: 'cleanup.sh',
      schedule: '0 3 * * *',
    });
  });

  test('add_job attaches to an app when one is named', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS, '/jobs': { job: { id: 'j1' } } });
    await tool('add_job').run(api, {
      name: 'Migrate',
      command: 'npm run migrate',
      schedule: '0 3 * * *',
      service: 'Web',
    });
    expect((calls.at(-1)?.body as { serviceId: string } | undefined)?.serviceId).toBe('s1');
  });

  test('run_job matches a job by its name, which is what a person would say', async () => {
    const { api, calls } = recordingApi({
      '/jobs': { jobs: [{ id: 'j1', name: 'Nightly tidy' }] },
    });
    await tool('run_job').run(api, { job: 'nightly tidy' });
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/jobs/j1/run', body: undefined });
  });
});

/**
 * The one that is not a straight translation.
 *
 * There is no HTTP endpoint for running a single command in a container: the Terminal
 * is an interactive websocket, which has no shape an agent can use. So this borrows a
 * job, which already knows how to run one command inside a container and capture what
 * it printed, and tidies it away afterwards.
 */
describe('running one command in an app', () => {
  test('creates a job, runs it, and deletes it again', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS, '/jobs': { job: { id: 'j9' } } });

    await tool('run_command').run(api, { service: 'Web', command: 'npm run migrate' });

    const paths = calls.map((call) => `${call.method} ${call.path}`);
    expect(paths).toEqual(['GET /projects', 'POST /jobs', 'POST /jobs/j9/run', 'DELETE /jobs/j9']);
  });

  test('on a schedule that can never come round', async () => {
    // Between being created and being deleted the job is visible to the scheduler.
    // The thirty-first of February never arrives, so it cannot fire on its own in
    // that window, and `nextRun` returns null for it rather than a date.
    const { api, calls } = recordingApi({ '/projects': PROJECTS, '/jobs': { job: { id: 'j9' } } });
    await tool('run_command').run(api, { service: 'Web', command: 'ls' });

    const created = calls.find((call) => call.method === 'POST' && call.path === '/jobs');
    const { nextRun } = await import('../src/jobs/schedule.ts');
    const schedule = (created?.body as { schedule: string } | undefined)?.schedule ?? '';
    expect(nextRun(schedule)).toBeNull();
  });

  test('deletes the job even when the command fails', async () => {
    // A command that exits non-zero is an ordinary outcome here, and leaving a job
    // behind for every failed migration would fill the list with debris.
    const { calls } = recordingApi({ '/projects': PROJECTS });
    const api: Api = {
      async get(path) {
        calls.push({ method: 'GET', path });
        return PROJECTS as never;
      },
      async post(path, body) {
        calls.push({ method: 'POST', path, body });
        if (path.endsWith('/run')) throw new Error('the command failed');
        return { job: { id: 'j9' } } as never;
      },
      async put(path) {
        calls.push({ method: 'PUT', path });
        return {} as never;
      },
      async patch(path) {
        calls.push({ method: 'PATCH', path });
        return {} as never;
      },
      async del(path) {
        calls.push({ method: 'DELETE', path });
        return {} as never;
      },
    };

    await expect(
      tool('run_command').run(api, { service: 'Web', command: 'false' }),
    ).rejects.toThrow('the command failed');
    expect(calls.map((call) => `${call.method} ${call.path}`)).toContain('DELETE /jobs/j9');
  });

  test('works on a database too, which is where half the useful commands are', async () => {
    // Deliberately not restricted to apps, unlike `deploy`. `psql`, `mysqldump` and
    // a one-off index rebuild all live inside a database container, and an agent
    // asked to check something in the data has nowhere else to go.
    const { api, calls } = recordingApi({ '/projects': PROJECTS, '/jobs': { job: { id: 'j9' } } });
    await tool('run_command').run(api, { service: 'shop-db', command: 'psql -c "select 1"' });

    const created = calls.find((call) => call.method === 'POST' && call.path === '/jobs');
    expect((created?.body as { serviceId: string } | undefined)?.serviceId).toBe('s2');
  });
});

describe("the tools built for this session's features", () => {
  const WP = {
    projects: [
      { id: 'p1', name: 'Blog', slug: 'blog', services: [{ id: 'w1', name: 'wp', kind: 'app' }] },
    ],
  };

  test('configure_app PATCHes only the settings given', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS });
    await tool('configure_app').run(api, {
      service: 'Web',
      healthCheck: 'contains',
      healthExpect: 'Welcome',
    });
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.path).toBe('/services/s1');
    expect(patch?.body).toEqual({ healthCheck: 'contains', healthExpect: 'Welcome' });
  });

  test('configure_app refuses when nothing to change is given', async () => {
    const { api } = recordingApi({ '/projects': PROJECTS });
    await expect(tool('configure_app').run(api, { service: 'Web' })).rejects.toThrow(/nothing/i);
  });

  test('security_scan runs the scan and hands back its findings', async () => {
    const { api, calls } = recordingApi({ '/system/scan': { scan: { findings: [] } } });
    const result = await tool('security_scan').run(api, {});
    expect(calls.at(-1)).toEqual({ method: 'POST', path: '/system/scan', body: undefined });
    expect(result).toEqual({ findings: [] });
  });

  test('get_traffic passes the range through and returns the traffic block', async () => {
    const { api, calls } = recordingApi({
      '/projects': PROJECTS,
      '/services/s1/traffic': { traffic: { notFound: [] } },
    });
    await tool('get_traffic').run(api, { service: 'Web', range: '7d' });
    expect(calls.at(-1)?.path).toBe('/services/s1/traffic?range=7d');
  });

  test('edit_site_file reads when no contents, writes-and-deploys when given', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS });
    await tool('edit_site_file').run(api, { service: 'Web', path: '404.html' });
    expect(calls.at(-1)).toEqual({
      method: 'GET',
      path: '/services/s1/source/read?path=404.html',
    });
    await tool('edit_site_file').run(api, { service: 'Web', path: '404.html', contents: '<h1>x' });
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/services/s1/source',
      body: { path: '404.html', contents: '<h1>x', deploy: true },
    });
  });

  test('set_image_resizing toggles the app', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS });
    await tool('set_image_resizing').run(api, { service: 'Web', enabled: true });
    expect(calls.at(-1)).toEqual({
      method: 'PUT',
      path: '/services/s1/images',
      body: { enabled: true },
    });
  });

  test('write_dns_records writes to the connected provider', async () => {
    const { api, calls } = recordingApi({});
    await tool('write_dns_records').run(api, { hostname: 'example.com', wildcard: true });
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/system/dns/write',
      body: { hostname: 'example.com', wildcard: true },
    });
  });

  test('pending changes can be listed and applied by project', async () => {
    const { api, calls } = recordingApi({ '/projects': PROJECTS });
    await tool('list_pending_changes').run(api, { project: 'Shop' });
    expect(calls.at(-1)?.path).toBe('/projects/p1/pending');
    await tool('apply_pending_changes').run(api, { project: 'Shop' });
    expect(calls.at(-1)).toEqual({
      method: 'POST',
      path: '/projects/p1/pending/apply',
      body: undefined,
    });
  });

  test('wordpress routes each action to its endpoint', async () => {
    const cases: [string, string, string][] = [
      ['login', 'POST', '/services/w1/wordpress/login'],
      ['updates', 'GET', '/services/w1/wordpress/updates'],
      ['update', 'POST', '/services/w1/wordpress/update'],
      ['staging', 'POST', '/services/w1/wordpress/staging'],
      ['push', 'POST', '/services/w1/wordpress/staging/push'],
    ];
    for (const [action, method, path] of cases) {
      const { api, calls } = recordingApi({ '/projects': WP });
      await tool('wordpress').run(api, { service: 'wp', action });
      expect(calls.at(-1)?.method).toBe(method);
      expect(calls.at(-1)?.path).toBe(path);
    }
  });

  test('wordpress refuses an action it does not know', async () => {
    const { api } = recordingApi({ '/projects': WP });
    await expect(tool('wordpress').run(api, { service: 'wp', action: 'nonsense' })).rejects.toThrow(
      /action must be/i,
    );
  });
});
