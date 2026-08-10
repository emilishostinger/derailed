/**
 * Working out what a repository is, especially when it carries misleading company.
 *
 * The founding incident: phpbb/phpbb has a package.json at its root (their lint
 * tooling) while the actual forum is PHP in a subfolder. The old detector saw
 * package.json and declared "Node.js app, port 3000" without ever looking at
 * anything else, and the deploy died on the wrong port. A package.json that
 * starts nothing and ships no runtime dependencies must not outvote the language
 * the repository is actually written in.
 */
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRepo } from '../src/build/detect.ts';

async function folder(files: Record<string, string>, dirs: string[] = []): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'derailed-detect-'));
  for (const sub of dirs) await mkdir(join(dir, sub), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await Bun.write(join(dir, name), contents);
  }
  return dir;
}

const TOOLING_PKG = JSON.stringify({
  name: 'repo-tooling',
  scripts: { lint: 'eslint .' },
  devDependencies: { eslint: '^9.0.0' },
});

describe('a package.json that is only tooling', () => {
  test('does not outvote composer.json: the phpbb shape with composer at root', async () => {
    const dir = await folder({
      'package.json': TOOLING_PKG,
      'composer.json': JSON.stringify({ require: { php: '>=8.1' } }),
      'index.php': '<?php echo "forum";',
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('PHP app');
      expect(detected.port).toBe(8080);
      expect(detected.strategy).toBe('nixpacks');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not turn a Laravel app into a Vite site', async () => {
    // Laravel ships vite in devDependencies for its asset pipeline. The app is PHP.
    const dir = await folder({
      'composer.json': JSON.stringify({ require: { 'laravel/framework': '^11.0' } }),
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '^5.0.0', 'laravel-vite-plugin': '^1.0.0' },
      }),
      artisan: '<?php // console',
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('PHP app');
      expect(detected.port).toBe(8080);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('does not turn a Django repo with frontend tooling into a Node app', async () => {
    const dir = await folder({
      'manage.py': 'import django',
      'requirements.txt': 'django==5.0',
      'package.json': JSON.stringify({
        scripts: { build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      }),
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('Django');
      expect(detected.port).toBe(8000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('with no build step, a folder of HTML is still a website', async () => {
    // A docs folder with a prettier config should not lose its site-ness to it.
    const dir = await folder({
      'package.json': TOOLING_PKG,
      'index.html': '<h1>docs</h1>',
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.strategy).toBe('site');
      expect(detected.framework).toBe('Static site');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('real Node apps are still Node apps', () => {
  test('a framework dependency names the framework', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({
        scripts: { start: 'node server.js' },
        dependencies: { express: '^4.0.0' },
      }),
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('Express');
      expect(detected.port).toBe(3000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a start script alone is enough to be a Node app', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('Node.js app');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a Vite SPA with nothing else going on is still a Vite site', async () => {
    const dir = await folder({
      'package.json': JSON.stringify({
        scripts: { dev: 'vite', build: 'vite build' },
        devDependencies: { vite: '^5.0.0' },
      }),
      'index.html': '<div id="app"></div>',
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBe('Vite site');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the app that lives in a subfolder', () => {
  test('the true phpbb shape: tooling at root, the app one folder down', async () => {
    const dir = await folder(
      {
        'package.json': TOOLING_PKG,
        'composer.phar': 'binary',
        'phpBB/composer.json': JSON.stringify({ require: { php: '>=8.1' } }),
        'phpBB/index.php': '<?php',
        'git-tools/hook.sh': '#!/bin/sh',
      },
      ['tests', 'build'],
    );
    try {
      const detected = await detectRepo({ dir });
      expect(detected.suggestedRootDir).toBe('phpBB');
      expect(detected.summary).toContain('phpBB');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('pointing rootDir at the subfolder detects the app inside it', async () => {
    const dir = await folder({
      'package.json': TOOLING_PKG,
      'phpBB/composer.json': JSON.stringify({ require: { php: '>=8.1' } }),
    });
    try {
      const detected = await detectRepo({ dir, rootDir: 'phpBB' });
      expect(detected.framework).toBe('PHP app');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two plausible subfolders is ambiguity, not a guess', async () => {
    const dir = await folder({
      'api/go.mod': 'module api',
      'web/package.json': JSON.stringify({ scripts: { start: 'node .' } }),
    });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.suggestedRootDir ?? null).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('an unrecognisable repo is pointed at the ready-made image path', async () => {
    // Packaged software (a forum, a game server) is not deployed from source. The
    // wizard should say where the working path is instead of only shrugging.
    const dir = await folder({ 'README.md': '# a thing', LICENSE: 'MIT' });
    try {
      const detected = await detectRepo({ dir });
      expect(detected.framework).toBeNull();
      expect(detected.warnings.some((w) => w.includes('Ready-made image'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
