import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Plain websites.
 *
 * A folder of HTML, or a folder of PHP, is the oldest and most common kind of website
 * there is, and the one most likely to be dragged into a browser by someone who has
 * never heard of a build step. Neither needs building: they need a web server pointed
 * at them. Derailed writes the few lines that do exactly that, rather than sending the
 * folder through a build system that will look for a package manifest and give up.
 */
export type SiteKind = 'static' | 'php';

/** The file Derailed writes. Named so nobody mistakes it for their own. */
export const SITE_DOCKERFILE = 'Dockerfile.derailed-site';

const STATIC_IMAGE = 'nginx:1.27-alpine';
const PHP_IMAGE = 'php:8.3-apache';

/**
 * What kind of website this folder holds, if any.
 *
 * PHP wins when both are present: a PHP site nearly always has HTML next to it, and
 * serving it as static files would hand visitors the source code instead of the page.
 */
export async function detectSite(dir: string): Promise<SiteKind | null> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name.toLowerCase());

  if (names.some((name) => name.endsWith('.php'))) return 'php';
  if (names.includes('index.html') || names.includes('index.htm')) return 'static';
  return null;
}

export function sitePort(): number {
  return 80;
}

export function siteSummary(kind: SiteKind): string {
  return kind === 'php'
    ? "This looks like a PHP website. I'll serve it with PHP and Apache, the usual pairing, and it will be able to reach a database."
    : "This looks like a plain website. I'll serve the files exactly as they are.";
}

export function siteFramework(kind: SiteKind): string {
  return kind === 'php' ? 'PHP site' : 'Static site';
}

/**
 * Writes the build instructions for a plain website into the folder being built.
 *
 * The generated file deletes itself from the served folder, because anything left in
 * there is reachable from the internet, and a stray Dockerfile at the root of
 * someone's website is a small mess with no upside.
 */
export async function writeSiteDockerfile(dir: string, kind: SiteKind): Promise<string> {
  const contents = kind === 'php' ? phpDockerfile() : staticDockerfile();
  await Bun.write(join(dir, SITE_DOCKERFILE), contents);
  return SITE_DOCKERFILE;
}

function staticDockerfile(): string {
  return `# Written by Derailed. Edit the site, not this file: it is rewritten on every deploy.
FROM ${STATIC_IMAGE}

COPY . /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/${SITE_DOCKERFILE} /usr/share/nginx/html/.dockerignore

EXPOSE 80
`;
}

function phpDockerfile(): string {
  return `# Written by Derailed. Edit the site, not this file: it is rewritten on every deploy.
FROM ${PHP_IMAGE}

# The two things nearly every PHP site expects: tidy URLs, and a way to reach MySQL.
RUN a2enmod rewrite \\
 && docker-php-ext-install -j"$(nproc)" mysqli pdo_mysql opcache \\
 && rm -rf /var/lib/apt/lists/*

COPY . /var/www/html
RUN rm -f /var/www/html/${SITE_DOCKERFILE} /var/www/html/.dockerignore \\
 && chown -R www-data:www-data /var/www/html

EXPOSE 80
`;
}
