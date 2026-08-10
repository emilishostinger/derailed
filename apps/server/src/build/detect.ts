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

/**
 * Whether something here needs building before it can be served. A tooling-only
 * package.json with no build script doesn't: a docs folder does not stop being a
 * website because a prettier config moved in.
 */
function blocksSiteDetection(dir: string, pkg: PackageJson | null): boolean {
  const others = MANIFESTS.filter((name) => name !== 'package.json');
  if (others.some((name) => existsSync(join(dir, name)))) return true;
  if (pkg) return looksLikeNodeApp(pkg) || Boolean(pkg.scripts?.build);
  // The file exists but didn't parse: keep the old caution and assume a build.
  return existsSync(join(dir, 'package.json'));
}

/**
 * Folders that conventionally hold a repository's supporting cast, not the app.
 * Skipped when looking for the app in a subfolder, so phpbb's build/ scripts do
 * not tie with phpBB/ and turn a clear answer into an ambiguous one.
 */
const SUPPORTING_DIRS = new Set([
  'node_modules',
  'vendor',
  'test',
  'tests',
  'doc',
  'docs',
  'examples',
  'example',
  'scripts',
  'tools',
  'build',
  'dist',
  'out',
  'assets',
  'static',
  'vagrant',
  'infra',
  'deploy',
]);

/**
 * When the root of a repository is not the app, one subfolder often is. Each
 * candidate is scored by how many app-shaped things it holds, and the answer is
 * the clear winner or nothing: phpbb's phpBB/ (composer.json and an index.php)
 * must beat its vagrant/ (a composer.json for the dev box), while a genuine tie
 * between two apps is ambiguity worth asking about rather than guessing at.
 */
async function findNestedApp(base: string): Promise<string | null> {
  const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
  const scored: { name: string; marks: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (SUPPORTING_DIRS.has(entry.name.toLowerCase())) continue;
    const inside = join(base, entry.name);
    const marks = [
      MANIFESTS.some((name) => existsSync(join(inside, name))),
      existsSync(join(inside, 'Dockerfile')),
      existsSync(join(inside, 'index.php')),
      existsSync(join(inside, 'index.html')),
    ].filter(Boolean).length;
    if (marks > 0) scored.push({ name: entry.name, marks });
  }
  scored.sort((a, b) => b.marks - a.marks);
  const [top, second] = [scored[0], scored[1]];
  if (!top) return null;
  if (second && second.marks >= top.marks) return null;
  return top.name;
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
      'This project has a docker-compose file. Importing it instead sets up everything in that file as linked services.',
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
  const site = blocksSiteDetection(base, pkg) ? null : await detectSite(base);
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

  const nested = await findNestedApp(base);
  if (!nested) {
    warnings.push(
      'If this is packaged software (a forum, a CMS, a game server), its official Docker image is usually the intended way to run it. The "Ready-made image" option deploys one.',
    );
  }
  return {
    strategy: 'nixpacks',
    framework: null,
    port: null,
    dockerfilePath: null,
    suggestedName,
    suggestedRootDir: nested,
    summary: nested
      ? `The top of this repository doesn't look like a runnable app, but the ${nested} folder does. Set the app folder to ${nested} and I'll look again.`
      : "I couldn't tell what kind of project this is, so I'll take my best guess at building it. If it doesn't work, adding a Dockerfile to the repository will.",
    warnings,
  };
}

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

/**
 * A package.json that starts nothing and ships no runtime dependencies is an
 * asset pipeline or a linter riding along in someone else's repository, not the
 * application. phpbb's root package.json is eslint config; Laravel's is Vite.
 */
function looksLikeNodeApp(pkg: PackageJson): boolean {
  if (pkg.scripts?.start) return true;
  return Object.keys(pkg.dependencies ?? {}).length > 0;
}

async function guessFramework(
  base: string,
  pkg: PackageJson | null,
): Promise<FrameworkRule | null> {
  const language =
    LANGUAGE_RULES.find((rule) => rule.files?.some((file) => existsSync(join(base, file)))) ?? null;
  if (!pkg) return language;

  // A language marker beside a tooling-only package.json names the real app, and
  // that holds even when the tooling would match a Node framework rule: Laravel's
  // vite devDependency must not make a PHP app a "Vite site".
  if (language && !looksLikeNodeApp(pkg)) return language;

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const rule of NODE_FRAMEWORKS) {
    if (rule.deps?.some((dep) => dep in deps)) return rule;
  }
  if (looksLikeNodeApp(pkg)) return { name: 'Node.js app', port: 3000 };
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
