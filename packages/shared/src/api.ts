/**
 * Request/response schemas for the HTTP API.
 * The server validates with these; the web client infers its types from them.
 */
import { z } from 'zod';

export const errorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    hint: z.string().optional(),
  }),
});
export type ErrorBody = z.infer<typeof errorBody>;

/**
 * One number, in one place.
 *
 * Setup asked for eight and changing your password asked for ten, so a password good
 * enough to create the account was refused when it came to changing it, with no way to
 * tell from the screen which rule you had just met.
 */
export const MIN_PASSWORD_LENGTH = 10;

const password = z
  .string()
  .min(
    MIN_PASSWORD_LENGTH,
    `Use at least ${MIN_PASSWORD_LENGTH} characters. This password opens your server.`,
  )
  .max(200);

const email = z.email('That does not look like an email address.');

export const setupRequest = z.object({ email, password });
export type SetupRequest = z.infer<typeof setupRequest>;

export const loginRequest = z.object({ email, password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof loginRequest>;

/** Three, and no more. Every extra one is a matrix somebody has to hold in their head. */
export const userRole = z.enum(['owner', 'member', 'viewer']);

export const addPersonRequest = z.object({ email, password, role: userRole });
export type AddPersonRequest = z.infer<typeof addPersonRequest>;

export const setRoleRequest = z.object({ role: userRole });
export type SetRoleRequest = z.infer<typeof setRoleRequest>;

/** Each part 0-255. The looser `\d{1,3}` accepted 999.999.999.999 and every address
 *  Derailed then handed out under it pointed nowhere. */
const IPV4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

export const patchSystemRequest = z.object({
  serverIp: z
    .string()
    .regex(IPV4, 'Enter an IPv4 address like 203.0.113.7, or leave it blank to auto-detect.')
    .nullable()
    .optional(),
});
export type PatchSystemRequest = z.infer<typeof patchSystemRequest>;

const projectName = z
  .string()
  .trim()
  .min(1, 'Give your project a name.')
  .max(60, 'Keep the name under 60 characters.');

export const createProjectRequest = z.object({ name: projectName });
export type CreateProjectRequest = z.infer<typeof createProjectRequest>;

export const patchProjectRequest = z.object({ name: projectName });
export type PatchProjectRequest = z.infer<typeof patchProjectRequest>;

/**
 * A git branch name, the way `git` itself will accept it.
 *
 * It ends up as an argument to `git clone --branch` and, elsewhere, inside
 * `refs/heads/<branch>`. `--branch <value>` is the option-argument form, so a leading
 * dash is not argument injection today, but "not exploitable at this one call site" is
 * a property of the call site, not of the value, and the value outlives the call site.
 * So it is pinned to what a real ref can hold: letters, numbers, and the four
 * punctuation marks a branch name actually uses, no `..`, and no leading dash.
 */
const gitBranch = z
  .string()
  .trim()
  .max(200)
  .refine(
    (value) =>
      value === '' ||
      (/^[A-Za-z0-9._/-]+$/.test(value) && !value.startsWith('-') && !value.includes('..')),
    { message: 'A branch name can hold letters, numbers, and . _ - / only.' },
  )
  .optional();

export const detectRequest = z.object({
  repoUrl: z.string().trim().min(1, 'Paste a GitHub link.'),
  branch: gitBranch,
  rootDir: z.string().trim().max(400).optional(),
});
export type DetectRequest = z.infer<typeof detectRequest>;

const serviceName = z
  .string()
  .trim()
  .min(1, 'Give this service a name.')
  .max(60, 'Keep the name under 60 characters.');

/**
 * The path Derailed asks for to decide an app has started.
 *
 * It is pasted straight onto `http://127.0.0.1:<port>`, so it has to be a path and
 * nothing else. `@example.com/` on the end of that is not a path: it makes the
 * address point at example.com, and the health check that was meant to poll the
 * container next door would go and knock on somebody else's door instead.
 */
const healthPath = z
  .string()
  .trim()
  .max(400)
  .refine((value) => value === '' || (value.startsWith('/') && !value.startsWith('//')), {
    message: 'That has to be a path inside your app, starting with one slash, like /healthz.',
  });

export const createAppServiceRequest = z
  .object({
    kind: z.literal('app'),
    name: serviceName,
    /** Either a repository to build, or a ready-made image to run. */
    source: z.enum(['repo', 'image', 'upload']).optional(),
    repoUrl: z.string().trim().optional(),
    image: z.string().trim().max(300).optional(),
    branch: gitBranch,
    rootDir: z.string().trim().max(400).optional(),
    buildStrategy: z.enum(['auto', 'dockerfile', 'nixpacks', 'site']).optional(),
    dockerfilePath: z.string().trim().max(400).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: healthPath.optional(),
    deployNow: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
    volumes: z.array(z.string().trim()).optional(),
  })
  .refine(
    (body) =>
      body.source === 'image' ? !!body.image : body.source === 'upload' ? true : !!body.repoUrl,
    { message: 'Paste a GitHub link, or the name of a Docker image to run.' },
  );

export const createDatabaseServiceRequest = z.object({
  kind: z.literal('database'),
  name: serviceName,
  engine: z.string().trim().min(1),
  version: z.string().trim().min(1),
});

export const createServiceRequest = z.discriminatedUnion('kind', [
  createAppServiceRequest,
  createDatabaseServiceRequest,
]);
export type CreateServiceRequest = z.infer<typeof createServiceRequest>;

export const patchServiceRequest = z.object({
  name: serviceName.optional(),
  branch: gitBranch,
  rootDir: z.string().trim().max(400).nullable().optional(),
  buildStrategy: z.enum(['auto', 'dockerfile', 'nixpacks', 'site']).optional(),
  dockerfilePath: z.string().trim().max(400).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  healthPath: healthPath.optional(),
  /** How Derailed decides this app is healthy. One dropdown; see the docs. */
  healthCheck: z.enum(['http', 'started', 'tcp', 'command', 'contains']).optional(),
  /** The text the reply must include, when healthCheck is 'contains'. */
  healthExpect: z.string().trim().max(200).nullable().optional(),
  /** The command whose exit code decides, when healthCheck is 'command'. */
  healthCommand: z.string().trim().max(2000).nullable().optional(),
  memoryLimitMb: z.number().int().min(64).max(65536).nullable().optional(),
  deployOnRelease: z.boolean().optional(),
  deployOnPush: z.boolean().optional(),
});
export type PatchServiceRequest = z.infer<typeof patchServiceRequest>;

export const putEnvRequest = z.object({
  vars: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .regex(
            /^[A-Za-z_][A-Za-z0-9_]*$/,
            'Variable names can use letters, numbers and underscores, and cannot start with a number.',
          ),
        value: z.string(),
      }),
    )
    .max(500),
});
export type PutEnvRequest = z.infer<typeof putEnvRequest>;

export const autoUpdateRequest = z.object({
  enabled: z.boolean(),
});
export type AutoUpdateRequest = z.infer<typeof autoUpdateRequest>;

export const formsToggleRequest = z.object({
  enabled: z.boolean(),
});
export type FormsToggleRequest = z.infer<typeof formsToggleRequest>;

export const botSettingsRequest = z.object({
  mode: z.enum(['off', 'polite', 'strict']).optional(),
  blockAi: z.boolean().optional(),
});
export type BotSettingsRequest = z.infer<typeof botSettingsRequest>;

export const appLoginRequest = z.object({
  enabled: z.boolean(),
  allowedEmails: z.array(email).max(200).optional(),
});
export type AppLoginRequest = z.infer<typeof appLoginRequest>;

/** The name a compose service is written as. Docker's own charset for one. */
const composeName = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/);

export const importSource = z.enum(['compose', 'heroku', 'render', 'railway', 'fly']);

export const importInspectRequest = z.object({
  repoUrl: z.string().trim().min(1).max(500),
  branch: gitBranch,
  rootDir: z.string().trim().max(400).optional(),
  /** Which format to read, when the repository has more than one. */
  format: importSource.optional(),
});
export type ImportInspectRequest = z.infer<typeof importInspectRequest>;

/**
 * The plan, on its way back in. It was shown to a person and may have been
 * edited by anything, so every field is held to the same standard as a request
 * typed from scratch: only known fields, tight charsets, hard caps.
 */
export const importPlanService = z.object({
  name: composeName,
  source: z.enum(['image', 'repo']),
  image: z.string().trim().min(1).max(300).nullable(),
  rootDir: z.string().trim().max(400).nullable(),
  dockerfilePath: z.string().trim().max(400).nullable(),
  command: z.array(z.string().max(2000)).max(100).nullable(),
  port: z.number().int().min(1).max(65535).nullable(),
  healthCheck: z.enum(['http', 'started']),
  healthPath: z
    .string()
    .trim()
    .max(400)
    .refine((value) => value.startsWith('/') && !value.startsWith('//'))
    .nullable(),
  env: z
    .array(
      z.object({
        key: z
          .string()
          .trim()
          .regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/),
        value: z.string().max(10_000),
        generate: z.boolean().optional(),
      }),
    )
    .max(500),
  volumes: z.array(z.string().trim().min(1).max(400)).max(50),
  dependsOn: z.array(composeName).max(50),
  memoryLimitMb: z.number().int().min(64).max(65536).nullable(),
});

export const importPlanDatabase = z.object({
  name: composeName,
  engine: z.string().trim().min(1).max(30),
  version: z.string().trim().min(1).max(20),
  linkTo: z
    .array(
      z.object({
        service: composeName,
        injectAs: z
          .string()
          .trim()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .optional(),
      }),
    )
    .max(40),
});

export const importPlanJob = z.object({
  name: z.string().trim().min(1).max(80),
  command: z.string().trim().min(1).max(2000),
  schedule: z.string().trim().min(1).max(100),
  service: composeName,
});

export const applyImportPlanRequest = z.object({
  plan: z.object({
    source: importSource,
    repoUrl: z.string().trim().min(1).max(500),
    branch: z.string().trim().max(200).nullable(),
    services: z.array(importPlanService).min(1).max(40),
    databases: z.array(importPlanDatabase).max(10),
    jobs: z.array(importPlanJob).max(40),
    warnings: z.array(z.string().max(1000)).max(100),
  }),
});
export type ApplyImportPlanRequest = z.infer<typeof applyImportPlanRequest>;

export const upgradeDatabaseRequest = z.object({
  version: z.string().trim().min(1).max(20),
});
export type UpgradeDatabaseRequest = z.infer<typeof upgradeDatabaseRequest>;

export const pitrToggleRequest = z.object({
  enabled: z.boolean(),
});
export type PitrToggleRequest = z.infer<typeof pitrToggleRequest>;

export const pitrRestoreRequest = z.object({
  /** Milliseconds since the epoch, the moment to land on. */
  at: z.number().int().positive(),
});
export type PitrRestoreRequest = z.infer<typeof pitrRestoreRequest>;

export const createLinkRequest = z.object({
  toServiceId: z.string().min(1),
  injectAs: z
    .string()
    .trim()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
});
export type CreateLinkRequest = z.infer<typeof createLinkRequest>;

export const createDeploymentRequest = z
  .object({
    trigger: z.enum(['manual', 'redeploy']).optional(),
  })
  .optional();

/**
 * A hostname Derailed will accept, in one place.
 *
 * There were three of these, and the loosest of them took `.example.com`,
 * `a..b.com`, `-example.com` and a name six hundred characters long, none of which a
 * certificate authority will ever issue for. Each label is 1-63 characters, cannot
 * start or end with a hyphen, and the last one is letters, because that is what a
 * public domain looks like.
 */
export const HOSTNAME = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*\.[a-z]{2,63}$/;

/** Names longer than this are refused outright by DNS. */
export const MAX_HOSTNAME_LENGTH = 253;

export function isHostname(value: string): boolean {
  return value.length <= MAX_HOSTNAME_LENGTH && HOSTNAME.test(value);
}

export const createDomainRequest = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .max(MAX_HOSTNAME_LENGTH)
    .regex(HOSTNAME, 'Enter a domain like app.example.com (no http:// and no trailing slash).'),
  alsoAddWww: z.boolean().optional(),
});
export type CreateDomainRequest = z.infer<typeof createDomainRequest>;

/**
 * Where update emails come from and go to.
 *
 * The password is write-only: it is accepted here and never sent back, so the
 * dashboard shows whether one is stored rather than what it is.
 */
export const patchMailRequest = z.object({
  delivery: z.enum(['server', 'smtp']).optional(),
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  security: z.enum(['tls', 'starttls', 'none']).optional(),
  username: z.string().trim().max(255).optional(),
  password: z.string().max(500).optional(),
  from: z.string().trim().max(320).optional(),
  fromName: z.string().trim().max(120).optional(),
  notifyUpdates: z.boolean().optional(),
  notifyTo: z.string().trim().max(320).optional(),
  securityOnly: z.boolean().optional(),
});
export type PatchMailRequest = z.infer<typeof patchMailRequest>;

export const testMailRequest = z.object({
  to: z.string().trim().max(320).optional(),
});
export type TestMailRequest = z.infer<typeof testMailRequest>;
