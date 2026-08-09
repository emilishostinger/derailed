/**
 * The Files tab against a real container.
 *
 * The unit tests cover the two rules that matter for safety: what counts as inside
 * this app's storage, and what counts as a name. They cannot cover the part that
 * actually broke things in practice, which is bytes. A PNG uploaded and downloaded
 * again has to be the same PNG, and it will not be if anything on the way treats it
 * as text. So this one uses Docker.
 *
 * Skipped automatically when the socket isn't there.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { closeDb, initDb } from '../src/db/index.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { createVolume } from '../src/db/repo/volumes.ts';
import { ping } from '../src/docker/client.ts';
import { createContainer, destroyContainer, startContainer } from '../src/docker/containers.ts';
import { imageExists, pullImage } from '../src/docker/images.ts';
import { managedLabels } from '../src/docker/labels.ts';
import {
  deleteEntry,
  downloadFile,
  listFiles,
  makeFolder,
  readFile,
  renameEntry,
  uploadInto,
} from '../src/runtime/files.ts';

const dockerAvailable = await ping();
const suite = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) console.warn('[test] Docker socket not reachable, skipping files tests.');

const IMAGE = 'alpine:3.20';
const RUN_ID = Math.random().toString(36).slice(2, 8);
const STORAGE = '/data';

let serviceId = '';
let containerId = '';

/** A stream over some bytes, which is the shape an upload arrives in. */
function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk);
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

suite('files in a real container', () => {
  beforeAll(async () => {
    initDb(':memory:');
    const project = createProject('Shop');
    const service = createAppService({
      projectId: project.id,
      name: 'Web',
      source: 'image',
      image: IMAGE,
      repoUrl: null,
      branch: null,
    });
    serviceId = service.id;
    createVolume(serviceId, STORAGE);

    if (!(await imageExists(IMAGE))) await pullImage(IMAGE);
    containerId = await createContainer({
      name: `derailed-test-files-${RUN_ID}`,
      image: IMAGE,
      // The storage folder is owned by an ordinary user, so the ownership-matching
      // on upload has something to prove.
      cmd: ['/bin/sh', '-c', `mkdir -p ${STORAGE} && chown 33:33 ${STORAGE} && sleep 300`],
      labels: managedLabels({ projectId: project.id, serviceId, role: 'app' }),
      restartPolicy: 'no',
    });
    await startContainer(containerId);
    // The command has to have run before anything looks for the folder.
    await Bun.sleep(500);
  }, 180_000);

  afterAll(async () => {
    if (containerId) await destroyContainer(containerId, 1).catch(() => undefined);
    closeDb();
  }, 60_000);

  test('a binary file survives the round trip byte for byte', async () => {
    // Every byte value, including the ones that are not valid UTF-8 on their own.
    // This is exactly what a base64-through-a-shell path gets wrong.
    const original = new Uint8Array(256 * 8);
    for (let i = 0; i < original.length; i++) original[i] = i % 256;

    await uploadInto(serviceId, STORAGE, 'logo.png', original.length, streamOf(original));

    const back = await downloadFile(serviceId, `${STORAGE}/logo.png`);
    expect(back.size).toBe(original.length);
    expect(back.name).toBe('logo.png');
    expect(await collect(back.body)).toEqual(original);
  }, 60_000);

  test('an upload lands owned by whoever owns the folder', async () => {
    await uploadInto(
      serviceId,
      STORAGE,
      'owned.txt',
      5,
      streamOf(new TextEncoder().encode('hello')),
    );

    // Uploaded as root would be 0:0, and a PHP app could not then write to it.
    const { stdout } = Bun.spawnSync([
      'docker',
      'exec',
      containerId,
      'stat',
      '-c',
      '%u:%g',
      `${STORAGE}/owned.txt`,
    ]);
    expect(stdout.toString().trim()).toBe('33:33');
  }, 60_000);

  test('an uploaded file shows up in the listing at its real size', async () => {
    const entries = await listFiles(serviceId, STORAGE);
    const entry = entries.find((e) => e.name === 'logo.png');
    expect(entry).toBeDefined();
    expect(entry?.directory).toBe(false);
    expect(entry?.sizeBytes).toBe(2048);
  }, 30_000);

  test('re-uploading replaces rather than making a second copy', async () => {
    const second = new TextEncoder().encode('replaced');
    await uploadInto(serviceId, STORAGE, 'owned.txt', second.length, streamOf(second));

    const entries = await listFiles(serviceId, STORAGE);
    expect(entries.filter((e) => e.name === 'owned.txt')).toHaveLength(1);
    expect(await readFile(serviceId, `${STORAGE}/owned.txt`)).toBe('replaced');
  }, 60_000);

  test('a new folder is created, and owned like its parent', async () => {
    await makeFolder(serviceId, STORAGE, 'uploads');

    const entries = await listFiles(serviceId, STORAGE);
    expect(entries.find((e) => e.name === 'uploads')?.directory).toBe(true);

    const { stdout } = Bun.spawnSync([
      'docker',
      'exec',
      containerId,
      'stat',
      '-c',
      '%u:%g',
      `${STORAGE}/uploads`,
    ]);
    expect(stdout.toString().trim()).toBe('33:33');
  }, 30_000);

  test('a folder that already exists is refused rather than merged into', async () => {
    await expect(makeFolder(serviceId, STORAGE, 'uploads')).rejects.toThrow(/already something/);
  }, 30_000);

  test('renaming keeps the contents and the folder', async () => {
    await renameEntry(serviceId, `${STORAGE}/owned.txt`, 'notes.txt');

    const entries = await listFiles(serviceId, STORAGE);
    expect(entries.map((e) => e.name)).toContain('notes.txt');
    expect(entries.map((e) => e.name)).not.toContain('owned.txt');
    expect(await readFile(serviceId, `${STORAGE}/notes.txt`)).toBe('replaced');
  }, 30_000);

  test('renaming onto something that already exists is refused', async () => {
    await expect(renameEntry(serviceId, `${STORAGE}/notes.txt`, 'logo.png')).rejects.toThrow(
      /already something/,
    );
  }, 30_000);

  test('deleting takes a folder and everything in it', async () => {
    const inside = new TextEncoder().encode('x');
    await uploadInto(serviceId, `${STORAGE}/uploads`, 'inside.txt', 1, streamOf(inside));

    await deleteEntry(serviceId, `${STORAGE}/uploads`);
    const entries = await listFiles(serviceId, STORAGE);
    expect(entries.map((e) => e.name)).not.toContain('uploads');
  }, 60_000);

  test('the storage folder itself cannot be deleted or renamed here', async () => {
    // Removing the mount point leaves the app pointed at a folder that is not there,
    // which is a broken app with no sign of why. The Storage tab is for that.
    await expect(deleteEntry(serviceId, STORAGE)).rejects.toThrow(/storage itself/);
    await expect(renameEntry(serviceId, STORAGE, 'elsewhere')).rejects.toThrow(/storage itself/);
  }, 30_000);

  test('nothing outside the storage folder can be touched', async () => {
    await expect(deleteEntry(serviceId, '/etc/passwd')).rejects.toThrow(/not part of/);
    await expect(renameEntry(serviceId, '/etc/passwd', 'x')).rejects.toThrow(/not part of/);
    await expect(downloadFile(serviceId, '/etc/shadow')).rejects.toThrow(/not part of/);
    await expect(makeFolder(serviceId, '/etc', 'mine')).rejects.toThrow(/not part of/);
    await expect(
      uploadInto(serviceId, '/etc', 'passwd', 1, streamOf(new Uint8Array(1))),
    ).rejects.toThrow(/not part of/);
  }, 30_000);

  test('a folder is not a download', async () => {
    await makeFolder(serviceId, STORAGE, 'themes');
    await expect(downloadFile(serviceId, `${STORAGE}/themes`)).rejects.toThrow(/folder/);
  }, 30_000);

  test('reading a real file works on a BusyBox image', async () => {
    // The symlink guard resolves the real path with `realpath` before reading. It was
    // written `realpath -- <path>`, and BusyBox (which is what Alpine, and so a large
    // share of real images, ships) treats `--` as a literal path and fails on it, so
    // every read here returned "not part of this app's storage" and the file browser
    // was quietly broken on those images. `owned.txt` above is a real file inside
    // storage on this alpine container; it must read back plainly.
    await uploadInto(
      serviceId,
      STORAGE,
      'plain.txt',
      5,
      streamOf(new TextEncoder().encode('hello')),
    );
    expect(await readFile(serviceId, `${STORAGE}/plain.txt`)).toBe('hello');
  }, 60_000);

  test('a symlink pointing out of storage is still refused, guard intact on BusyBox', async () => {
    // Dropping the `--` must not have reopened the hole the guard exists to close: a
    // link inside storage aimed at a secret outside it. `realpath` follows it to
    // `/etc/hostname`, which is not under a storage root, so the read is refused.
    Bun.spawnSync([
      'docker',
      'exec',
      containerId,
      'ln',
      '-sf',
      '/etc/hostname',
      `${STORAGE}/escape`,
    ]);
    await expect(readFile(serviceId, `${STORAGE}/escape`)).rejects.toThrow(/not part of/);
  }, 30_000);
});
