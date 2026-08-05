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

const password = z
  .string()
  .min(8, 'Use at least 8 characters. This is the only account on your server.')
  .max(200);

const email = z.email('That does not look like an email address.');

export const setupRequest = z.object({ email, password });
export type SetupRequest = z.infer<typeof setupRequest>;

export const loginRequest = z.object({ email, password: z.string().min(1).max(200) });
export type LoginRequest = z.infer<typeof loginRequest>;

export const patchSystemRequest = z.object({
  serverIp: z
    .string()
    .regex(
      /^(\d{1,3}\.){3}\d{1,3}$/,
      'Enter an IPv4 address like 203.0.113.7, or leave it blank to auto-detect.',
    )
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

export const detectRequest = z.object({
  repoUrl: z.string().trim().min(1, 'Paste a GitHub link.'),
  branch: z.string().trim().max(200).optional(),
  rootDir: z.string().trim().max(400).optional(),
});
export type DetectRequest = z.infer<typeof detectRequest>;

const serviceName = z
  .string()
  .trim()
  .min(1, 'Give this service a name.')
  .max(60, 'Keep the name under 60 characters.');

export const createAppServiceRequest = z
  .object({
    kind: z.literal('app'),
    name: serviceName,
    /** Either a repository to build, or a ready-made image to run. */
    source: z.enum(['repo', 'image', 'upload']).optional(),
    repoUrl: z.string().trim().optional(),
    image: z.string().trim().max(300).optional(),
    branch: z.string().trim().max(200).optional(),
    rootDir: z.string().trim().max(400).optional(),
    buildStrategy: z.enum(['auto', 'dockerfile', 'nixpacks']).optional(),
    dockerfilePath: z.string().trim().max(400).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    healthPath: z.string().trim().max(400).optional(),
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
  branch: z.string().trim().max(200).optional(),
  rootDir: z.string().trim().max(400).nullable().optional(),
  buildStrategy: z.enum(['auto', 'dockerfile', 'nixpacks']).optional(),
  dockerfilePath: z.string().trim().max(400).nullable().optional(),
  port: z.number().int().min(1).max(65535).nullable().optional(),
  healthPath: z.string().trim().max(400).optional(),
  memoryLimitMb: z.number().int().min(64).max(65536).nullable().optional(),
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

export const createDomainRequest = z.object({
  hostname: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
      'Enter a domain like app.example.com (no http:// and no trailing slash).',
    ),
  alsoAddWww: z.boolean().optional(),
});
export type CreateDomainRequest = z.infer<typeof createDomainRequest>;
