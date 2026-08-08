import { readdir, readFile, stat } from 'node:fs/promises';
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

/** The server config Derailed writes when a site brings its own error pages. */
export const SITE_SERVER_CONF = 'derailed-server.conf';

/** Which error pages this folder brings with it. Root only, by convention. */
export async function detectErrorPages(dir: string): Promise<{ has404: boolean; has500: boolean }> {
  const exists = async (name: string) =>
    (await stat(join(dir, name)).catch(() => null))?.isFile() ?? false;
  return { has404: await exists('404.html'), has500: await exists('500.html') };
}

/**
 * Writes the build instructions for a plain website into the folder being built.
 *
 * The generated files delete themselves from the served folder, because anything left
 * in there is reachable from the internet, and a stray Dockerfile at the root of
 * someone's website is a small mess with no upside.
 *
 * A `404.html` or `500.html` at the site's root is wired up as the page visitors
 * actually see for those errors. No setting, no new noun: the file being there is
 * the ask, which is exactly how the platforms people come from treat it.
 */
export async function writeSiteDockerfile(dir: string, kind: SiteKind): Promise<string> {
  const pages = await detectErrorPages(dir);
  const wired = pages.has404 || pages.has500;
  if (wired) {
    await Bun.write(
      join(dir, SITE_SERVER_CONF),
      kind === 'php' ? apacheErrorConf(pages) : nginxConf(pages),
    );
  }
  const contents = kind === 'php' ? phpDockerfile(wired) : staticDockerfile(wired);
  await Bun.write(join(dir, SITE_DOCKERFILE), contents);
  return SITE_DOCKERFILE;
}

/**
 * The whole server block rather than a snippet, because nginx has no "add to the
 * default site" hook: the stock default.conf is replaced with one that serves the
 * same way and also knows the error pages.
 */
function nginxConf(pages: { has404: boolean; has500: boolean }): string {
  return `server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html index.htm;
${pages.has404 ? '    error_page 404 /404.html;\n' : ''}${
  pages.has500 ? '    error_page 500 502 503 504 /500.html;\n' : ''
}    location / { try_files $uri $uri/ =404; }
}
`;
}

function apacheErrorConf(pages: { has404: boolean; has500: boolean }): string {
  return `${pages.has404 ? 'ErrorDocument 404 /404.html\n' : ''}${
    pages.has500 ? 'ErrorDocument 500 /500.html\n' : ''
  }`;
}

/**
 * Makes `<form data-derailed="contact">` mean what it looks like it means.
 *
 * An attribute does not travel with a POST and a form without a method GETs, so
 * the markup alone cannot work. Netlify solved this at build time and so does
 * this: each such form gains `method="post"` when it names none, and a hidden
 * `_derailed` field carrying the form's name, so the submission says which form
 * it came from. The site's own files on disk are never touched; only the copy
 * being built is.
 */
export function injectFormPlumbing(html: string): { html: string; forms: number } {
  let forms = 0;
  const rewritten = html.replace(
    /<form\b([^>]*)\bdata-derailed=["']([A-Za-z0-9 _-]{1,80})["']([^>]*)>/gi,
    (whole, before: string, name: string, after: string) => {
      forms++;
      const hasMethod = /\bmethod\s*=/i.test(before) || /\bmethod\s*=/i.test(after);
      const opening = hasMethod
        ? whole
        : `<form${before} data-derailed="${name}"${after} method="post">`;
      return `${opening}\n<input type="hidden" name="_derailed" value="${name}">`;
    },
  );
  return { html: rewritten, forms };
}

/** Runs the rewrite over every page in the folder being built. */
export async function injectFormsInto(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const name = entry.name.toLowerCase();
    if (!name.endsWith('.html') && !name.endsWith('.htm') && !name.endsWith('.php')) continue;
    const path = join(entry.parentPath ?? dir, entry.name);
    const text = await readFile(path, 'utf8').catch(() => null);
    if (!text?.includes('data-derailed')) continue;
    const { html, forms } = injectFormPlumbing(text);
    if (forms > 0) {
      await Bun.write(path, html);
      total += forms;
    }
  }
  return total;
}

function staticDockerfile(wired: boolean): string {
  return `# Written by Derailed. Edit the site, not this file: it is rewritten on every deploy.
FROM ${STATIC_IMAGE}

COPY . /usr/share/nginx/html
${
  wired
    ? `COPY ${SITE_SERVER_CONF} /etc/nginx/conf.d/default.conf
`
    : ''
}RUN rm -f /usr/share/nginx/html/${SITE_DOCKERFILE} /usr/share/nginx/html/${SITE_SERVER_CONF} /usr/share/nginx/html/.dockerignore

EXPOSE 80
`;
}

function phpDockerfile(wired: boolean): string {
  return `# Written by Derailed. Edit the site, not this file: it is rewritten on every deploy.
FROM ${PHP_IMAGE}

# The two things nearly every PHP site expects: tidy URLs, and a way to reach MySQL.
RUN a2enmod rewrite \\
 && docker-php-ext-install -j"$(nproc)" mysqli pdo_mysql opcache \\
 && rm -rf /var/lib/apt/lists/*

COPY . /var/www/html
${
  wired
    ? `COPY ${SITE_SERVER_CONF} /etc/apache2/conf-enabled/zz-derailed-errors.conf
`
    : ''
}RUN rm -f /var/www/html/${SITE_DOCKERFILE} /var/www/html/${SITE_SERVER_CONF} /var/www/html/.dockerignore \\
 && chown -R www-data:www-data /var/www/html

EXPOSE 80
`;
}
