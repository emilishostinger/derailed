import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { DetectResult } from '@derailed/shared';
import { detectSite, siteFramework, sitePort, siteSummary } from './site.ts';

/**
 * Works out how to build a repository and says so in plain language.
 * This is the step that has to feel like magic in the new-service wizard, so the
 * summary is written for someone who has never heard the word "Dockerfile".
 */

interface FrameworkRule {
  name: string;
  port: number;
  /** Matched against package.json dependencies (or a marker file). */
  deps?: string[];
  files?: string[];
  note?: string;
}

const NODE_FRAMEWORKS: FrameworkRule[] = [
  { name: 'Next.js', port: 3000, deps: ['next'] },
  { name: 'Nuxt', port: 3000, deps: ['nuxt'] },
  { name: 'Remix', port: 3000, deps: ['@remix-run/node', '@remix-run/serve'] },
  { name: 'SvelteKit', port: 3000, deps: ['@sveltejs/kit'] },
  { name: 'Astro', port: 4321, deps: ['astro'] },
  { name: 'NestJS', port: 3000, deps: ['@nestjs/core'] },
  { name: 'Express', port: 3000, deps: ['express'] },
  { name: 'Fastify', port: 3000, deps: ['fastify'] },
  { name: 'Hono', port: 3000, deps: ['hono'] },
  { name: 'Koa', port: 3000, deps: ['koa'] },
  { name: 'Vite site', port: 4173, deps: ['vite'] },
];

const LANGUAGE_RULES: FrameworkRule[] = [
  { name: 'Django', port: 8000, files: ['manage.py'] },
  { name: 'Python app', port: 8000, files: ['requirements.txt', 'pyproject.toml', 'Pipfile'] },
  { name: 'Go app', port: 8080, files: ['go.mod'] },
  { name: 'Rust app', port: 8080, files: ['Cargo.toml'] },
  { name: 'Ruby on Rails', port: 3000, files: ['config.ru', 'Gemfile'] },
  { name: 'PHP app', port: 8080, files: ['composer.json'] },
  { name: 'Deno app', port: 8000, files: ['deno.json', 'deno.jsonc'] },
  { name: 'Elixir app', port: 4000, files: ['mix.exs'] },
  { name: 'Java app', port: 8080, files: ['pom.xml', 'build.gradle'] },
];

/**
 * Files that mean "this is a project with a build step", whether or not Derailed
 * recognises the framework. Their presence rules out treating the folder as a plain
 * website, because the thing to serve does not exist until after the build.
 */
const MANIFESTS = [
  'package.json',
  'composer.json',
  'requirements.txt',
  'pyproject.toml',
  'Gemfile',
  'go.mod',
  'Cargo.toml',
  'deno.json',
  'deno.jsonc',
  'mix.exs',
  'pom.xml',
  'build.gradle',
  'Makefile',
];

function hasManifest(dir: string): boolean {
  return MANIFESTS.some((name) => existsSync(join(dir, name)));
}

export interface DetectInput {
  /** Absolute path to the checked-out repository. */
  dir: string;
  /** Sub-folder inside the repository, for monorepos. */
  rootDir?: string | null;
  /** Explicit Dockerfile path from the service settings, if the user set one. */
  dockerfilePath?: string | null;
}

export async function detectRepo(input: DetectInput): Promise<DetectResult> {
  const base = safeJoin(input.dir, input.rootDir);
  const warnings: string[] = [];

  const dockerfile = await findDockerfile(base, input.dockerfilePath);
  const pkg = await readJson<PackageJson>(join(base, 'package.json'));
  const framework = await guessFramework(base, pkg);
  const suggestedName = pkg?.name?.split('/').pop() ?? '';

  if (existsSync(join(base, 'docker-compose.yml')) || existsSync(join(base, 'compose.yaml'))) {
    warnings.push(
      "This project has a docker-compose file. Derailed will run the app itself, but won't set up the other services in that file yet.",
    );
  }

  if (dockerfile) {
    const contents = await readFile(join(base, dockerfile), 'utf8').catch(() => '');
    const exposed = parseExposedPort(contents);
    return {
      strategy: 'dockerfile',
      framework: framework?.name ?? null,
      port: exposed ?? framework?.port ?? null,
      dockerfilePath: dockerfile,
      suggestedName,
      summary: exposed
        ? `This project comes with its own build instructions (a Dockerfile). I'll follow them and run it on port ${exposed}.`
        : "This project comes with its own build instructions (a Dockerfile). I'll follow them.",
      warnings,
    };
  }

  if (framework) {
    return {
      strategy: 'nixpacks',
      framework: framework.name,
      port: framework.port,
      dockerfilePath: null,
      suggestedName,
      summary: `This looks like ${article(framework.name)} ${framework.name} project. I'll build it and run it on port ${framework.port}.`,
      warnings,
    };
  }

  // A folder of HTML or PHP with nothing to build is a website, and wants a web
  // server pointed at it. Checked only once nothing else has claimed the folder:
  // half the frameworks in the world also keep an index.html at their root.
  const site = hasManifest(base) ? null : await detectSite(base);
  if (site) {
    return {
      strategy: 'site',
      framework: siteFramework(site),
      port: sitePort(),
      dockerfilePath: null,
      suggestedName,
      summary: siteSummary(site),
      warnings,
    };
  }

  const entries = await readdir(base).catch(() => [] as string[]);
  if (!entries.length) {
    return {
      strategy: 'unknown',
      framework: null,
      port: null,
      dockerfilePath: null,
      suggestedName,
      summary: "That folder is empty. There's nothing to deploy in it.",
      warnings,
    };
  }

  return {
    strategy: 'nixpacks',
    framework: null,
    port: null,
    dockerfilePath: null,
    suggestedName,
    summary:
      "I couldn't tell what kind of project this is, so I'll take my best guess at building it. If it doesn't work, adding a Dockerfile to the repository will.",
    warnings,
  };
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

async function guessFramework(
  base: string,
  pkg: PackageJson | null,
): Promise<FrameworkRule | null> {
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const rule of NODE_FRAMEWORKS) {
      if (rule.deps?.some((dep) => dep in deps)) return rule;
    }
    return { name: 'Node.js app', port: 3000 };
  }
  for (const rule of LANGUAGE_RULES) {
    if (rule.files?.some((file) => existsSync(join(base, file)))) return rule;
  }
  return null;
}

async function findDockerfile(base: string, explicit?: string | null): Promise<string | null> {
  if (explicit) {
    // Through `safeJoin` for the same reason the root folder is: `../../` in a
    // settings box should not reach out of the checkout and read the host, and this
    // one sat right beside the check and did not have it.
    let resolved: string;
    try {
      resolved = safeJoin(base, explicit);
    } catch {
      return null;
    }
    return existsSync(resolved) ? explicit : null;
  }
  for (const candidate of ['Dockerfile', 'dockerfile', 'docker/Dockerfile']) {
    if (existsSync(join(base, candidate))) return candidate;
  }
  return null;
}

/** Reads the last EXPOSE in a Dockerfile. The one that usually matters. */
export function parseExposedPort(dockerfile: string): number | null {
  const matches = [...dockerfile.matchAll(/^\s*EXPOSE\s+(\d{1,5})/gim)];
  const last = matches.at(-1)?.[1];
  if (!last) return null;
  const port = Number(last);
  return port > 0 && port <= 65535 ? port : null;
}

/**
 * Resolves the port to run on: what the user set wins, then what we detected,
 * then 3000 (the convention most frameworks follow when PORT is set).
 */
export function resolvePort(
  userPort: number | null | undefined,
  detectedPort: number | null | undefined,
): number {
  return userPort ?? detectedPort ?? 3000;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** Keeps `rootDir` from escaping the checkout with `../`. */
export function safeJoin(base: string, sub?: string | null): string {
  if (!sub) return base;
  const cleaned = sub.replace(/^[/\\]+/, '');
  const target = resolve(base, cleaned);
  const root = resolve(base);
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new Error('That folder is outside the repository.');
  }
  return target;
}
