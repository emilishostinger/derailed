/**
 * Reading a folder somebody dragged in.
 *
 * Browsers hand a dropped directory over as a tree you have to walk yourself, one
 * callback at a time, through an API older than promises. This wraps that up and
 * hands back a flat list of files, each labelled with its path inside the folder.
 *
 * Nothing is zipped on the way. The files go up as they are, which means no zip
 * library in the bundle and no wait while a browser compresses a project it is about
 * to upload anyway.
 */
export interface DroppedFile {
  path: string;
  file: File;
}

/** Skipped here as well as on the server: no point uploading what will be thrown away. */
const SKIP = new Set([
  'node_modules',
  '.git',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.nuxt',
  'dist',
  'build',
  'target',
  '.DS_Store',
  '.pytest_cache',
  '.mypy_cache',
]);

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
  file?: (cb: (file: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => {
    readEntries: (cb: (entries: Entry[]) => void, err: (e: unknown) => void) => void;
  };
}

function fileOf(entry: Entry): Promise<File | null> {
  return new Promise((resolve) => {
    entry.file?.(
      (file) => resolve(file),
      () => resolve(null),
    );
  });
}

/** One `readEntries` call returns at most a hundred, so it has to be asked repeatedly. */
function childrenOf(entry: Entry): Promise<Entry[]> {
  const reader = entry.createReader?.();
  if (!reader) return Promise.resolve([]);

  return new Promise((resolve) => {
    const all: Entry[] = [];
    const step = () => {
      reader.readEntries(
        (batch) => {
          if (!batch.length) return resolve(all);
          all.push(...batch);
          step();
        },
        () => resolve(all),
      );
    };
    step();
  });
}

async function walk(entry: Entry, prefix: string, out: DroppedFile[], budget: { left: number }) {
  if (SKIP.has(entry.name) || budget.left <= 0) return;
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await fileOf(entry);
    if (file) {
      out.push({ path, file });
      budget.left -= 1;
    }
    return;
  }

  if (entry.isDirectory) {
    for (const child of await childrenOf(entry)) {
      await walk(child, path, out, budget);
    }
  }
}

/**
 * Everything in a drop, flattened.
 *
 * Returns null when the browser will not give us a directory tree, which is the cue
 * to fall back to whatever `dataTransfer.files` had in it.
 */
export async function readDroppedFolder(transfer: DataTransfer): Promise<DroppedFile[] | null> {
  const items = Array.from(transfer.items ?? []);
  const roots = items
    .map((item) => (item.webkitGetAsEntry?.() ?? null) as Entry | null)
    .filter((entry): entry is Entry => !!entry);

  if (!roots.length || !roots.some((entry) => entry.isDirectory)) return null;

  const out: DroppedFile[] = [];
  // A ceiling, so dropping a home directory by accident does not lock the tab up
  // walking it. Ten thousand files is far more than any project this hosts.
  const budget = { left: 10_000 };
  for (const root of roots) await walk(root, '', out, budget);

  // The wrapper folder is dropped: somebody dragging `my-site` means its contents.
  const single = roots.length === 1 && roots[0]?.isDirectory ? `${roots[0].name}/` : null;
  return single
    ? out
        .map((entry) => ({ ...entry, path: entry.path.slice(single.length) }))
        .filter((e) => e.path)
    : out;
}
