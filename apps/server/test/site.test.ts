/**
 * Plain websites: a folder of HTML, or a folder of PHP.
 *
 * This is the path someone takes who has never used a build tool, so it has to work
 * without one. Detection is pure filesystem work and always runs; actually building
 * the image is covered by the deploy tests.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepo } from '../src/build/detect.ts';
import {
  detectSite,
  SITE_DOCKERFILE,
  SITE_SERVER_CONF,
  writeSiteDockerfile,
} from '../src/build/site.ts';

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'derailed-site-'));
  for (const [name, contents] of Object.entries(files)) {
    await Bun.write(join(dir, name), contents);
  }
  return dir;
}

describe('recognising a plain website', () => {
  test('a folder with an index.html is a static site', async () => {
    const dir = await folder({ 'index.html': '<h1>hello</h1>', 'style.css': 'body{}' });
    try {
      expect(await detectSite(dir)).toBe('static');
      const detected = await detectRepo({ dir });
      expect(detected.strategy).toBe('site');
      expect(detected.framework).toBe('Static site');
      expect(detected.port).toBe(80);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a folder with PHP in it is a PHP site', async () => {
    const dir = await folder({ 'index.php': '<?php echo "hi";', 'about.html': '<p>hi</p>' });
    try {
      // PHP wins over the HTML beside it: serving that as static files would hand
      // visitors the source code instead of the page.
      expect(await detectSite(dir)).toBe('php');
      const detected = await detectRepo({ dir });
      expect(detected.strategy).toBe('site');
      expect(detected.framework).toBe('PHP site');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a project with a package.json is left to the build system', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({ name: 'x', dependencies: { next: '14' } }),
      'index.html': '<h1>hello</h1>',
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.strategy).toBe('nixpacks');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a PHP project with composer is left to the build system', async () => {
    const dir = await folder({ 'composer.json': '{}', 'index.php': '<?php' });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.strategy).toBe('nixpacks');
      expect(detected.framework).toBe('PHP app');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an empty folder is not a website', async () => {
    const dir = await folder({});
    try {
      expect(await detectSite(dir)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the generated build instructions', () => {
  test('a static site is served by nginx and does not serve the Dockerfile', async () => {
    const dir = await folder({ 'index.html': 'hi' });
    try {
      const name = await writeSiteDockerfile(dir, 'static');
      expect(name).toBe(SITE_DOCKERFILE);
      const contents = await Bun.file(join(dir, name)).text();
      expect(contents).toContain('nginx');
      expect(contents).toContain(`rm -f /usr/share/nginx/html/${SITE_DOCKERFILE}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a PHP site gets Apache, rewrites and the MySQL drivers', async () => {
    const dir = await folder({ 'index.php': '<?php' });
    try {
      const contents = await Bun.file(join(dir, await writeSiteDockerfile(dir, 'php'))).text();
      expect(contents).toContain('php:8.3-apache');
      expect(contents).toContain('a2enmod rewrite');
      expect(contents).toContain('pdo_mysql');
      expect(contents).toContain(`rm -f /var/www/html/${SITE_DOCKERFILE}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('pages for when things go wrong', () => {
  test('a 404.html at the root is wired into nginx, and cleaned off the site', async () => {
    const dir = await folder({ 'index.html': 'hi', '404.html': '<h1>lost</h1>' });
    try {
      await writeSiteDockerfile(dir, 'static');
      const dockerfile = await Bun.file(join(dir, SITE_DOCKERFILE)).text();
      expect(dockerfile).toContain(`COPY ${SITE_SERVER_CONF} /etc/nginx/conf.d/default.conf`);
      expect(dockerfile).toContain(`rm -f /usr/share/nginx/html/${SITE_DOCKERFILE}`);
      expect(dockerfile).toContain(SITE_SERVER_CONF);

      const conf = await Bun.file(join(dir, SITE_SERVER_CONF)).text();
      expect(conf).toContain('error_page 404 /404.html;');
      // Only the page that exists is wired: a 500 directive pointing at nothing
      // would replace nginx's plain error with a second 404.
      expect(conf).not.toContain('error_page 500');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a 500.html is wired for the whole family of server errors', async () => {
    const dir = await folder({ 'index.html': 'hi', '500.html': '<h1>oops</h1>' });
    try {
      await writeSiteDockerfile(dir, 'static');
      const conf = await Bun.file(join(dir, SITE_SERVER_CONF)).text();
      expect(conf).toContain('error_page 500 502 503 504 /500.html;');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a PHP site uses ErrorDocument instead', async () => {
    const dir = await folder({ 'index.php': '<?php', '404.html': 'lost' });
    try {
      await writeSiteDockerfile(dir, 'php');
      const dockerfile = await Bun.file(join(dir, SITE_DOCKERFILE)).text();
      expect(dockerfile).toContain('/etc/apache2/conf-enabled/zz-derailed-errors.conf');
      const conf = await Bun.file(join(dir, SITE_SERVER_CONF)).text();
      expect(conf).toBe('ErrorDocument 404 /404.html\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a site with neither page keeps the stock server untouched', async () => {
    const dir = await folder({ 'index.html': 'hi' });
    try {
      await writeSiteDockerfile(dir, 'static');
      const dockerfile = await Bun.file(join(dir, SITE_DOCKERFILE)).text();
      expect(dockerfile).not.toContain('COPY derailed-server.conf');
      expect(await Bun.file(join(dir, SITE_SERVER_CONF)).exists()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
