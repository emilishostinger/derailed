/**
 * The captured README: found under its common spellings, kept to a sane size,
 * tied to the service's life, and honest when there is nothing to show.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  captureReadme,
  forgetReadme,
  readmeInDir,
  savedReadme,
  saveReadme,
} from '../src/build/readme.ts';

async function folder(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'derailed-readme-'));
  for (const [name, contents] of Object.entries(files)) {
    await Bun.write(join(dir, name), contents);
  }
  return dir;
}

describe('finding a README in a folder', () => {
  test('the common spellings are all recognised', async () => {
    expect(await readmeInDir(await folder({ 'README.md': '# Hello' }))).toBe('# Hello');
    expect(await readmeInDir(await folder({ 'readme.md': 'lower' }))).toBe('lower');
    expect(await readmeInDir(await folder({ README: 'bare' }))).toBe('bare');
  });

  test('a folder without one answers null', async () => {
    expect(await readmeInDir(await folder({ 'index.html': '<h1>site</h1>' }))).toBeNull();
  });

  test('an enormous README is cut, not refused', async () => {
    const dir = await folder({ 'README.md': 'x'.repeat(400_000) });
    const text = await readmeInDir(dir);
    expect(text?.length).toBe(300_000);
  });
});

describe('the captured copy', () => {
  test('capture takes the first folder that has one, and forget removes it', async () => {
    const empty = await folder({});
    const withReadme = await folder({ 'README.md': '# The app' });
    await captureReadme('svc-readme-test', empty, withReadme);
    expect(await savedReadme('svc-readme-test')).toBe('# The app');

    await forgetReadme('svc-readme-test');
    expect(await savedReadme('svc-readme-test')).toBeNull();
  });

  test('a service that never captured one answers null', async () => {
    expect(await savedReadme('svc-never-existed')).toBeNull();
  });

  test('saving directly works, for the Docker Hub cache', async () => {
    await saveReadme('svc-hub-test', 'From the registry');
    expect(await savedReadme('svc-hub-test')).toBe('From the registry');
    await forgetReadme('svc-hub-test');
  });
});
