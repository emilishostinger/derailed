// The DOM must exist before React and Testing Library load; this import registers it.
import './dom-setup.ts';

/**
 * The two dashboard widgets with real logic of their own.
 *
 * `Select` is a custom listbox, not a native one, so its keyboard and pointer behaviour
 * is code that can break; `FileBrowser` is the one component that draws both an app's
 * storage and a site's source from a small adapter, and its job is to list what the
 * adapter returns and to ask for the next folder when one is opened. Both are rendered
 * for real through happy-dom.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import type { FileEntry } from '@derailed/shared';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { FileBrowser } from '../src/components/FileBrowser.tsx';
import { Select } from '../src/components/ui.tsx';
import { domReady } from './dom-setup.ts';

void domReady;

afterEach(cleanup);

describe('the Select listbox', () => {
  const OPTIONS = [
    { value: 'postgres', label: 'PostgreSQL' },
    { value: 'mysql', label: 'MySQL' },
    { value: 'redis', label: 'Redis' },
  ] as const;

  test('shows the placeholder until something is chosen, then reports the choice', async () => {
    const chosen: string[] = [];
    const { getByRole, getAllByRole } = render(
      <Select
        value=""
        options={[...OPTIONS]}
        onChange={(v) => chosen.push(v)}
        ariaLabel="engine"
        placeholder="Pick an engine"
      />,
    );
    const trigger = getByRole('combobox');
    expect(trigger.textContent).toContain('Pick an engine');

    // Open, then pick MySQL by clicking its option.
    fireEvent.click(trigger);
    await waitFor(() => expect(getAllByRole('option').length).toBe(3));
    const mysql = getAllByRole('option').find((o) => o.textContent?.includes('MySQL'));
    fireEvent.click(mysql!);
    expect(chosen).toEqual(['mysql']);
  });

  test('renders the current label when a value is set', () => {
    const { getByRole } = render(
      <Select value="redis" options={[...OPTIONS]} onChange={() => {}} ariaLabel="engine" />,
    );
    expect(getByRole('combobox').textContent).toContain('Redis');
  });
});

describe('the FileBrowser', () => {
  function entry(name: string, directory: boolean): FileEntry {
    return { name, directory, sizeBytes: directory ? 0 : 10, modifiedAt: 0 };
  }

  function adapterWith(entries: FileEntry[], onList?: (path?: string) => void) {
    return {
      list: mock(async (path?: string) => {
        onList?.(path);
        return { roots: ['/data'], path: path ?? '/data', entries };
      }),
      read: mock(async () => ''),
      write: mock(async () => ({ ok: true as const })),
      makeFolder: mock(async () => ({ ok: true as const })),
      rename: mock(async () => ({ ok: true as const })),
      remove: mock(async () => ({ ok: true as const })),
      upload: mock(async () => ({ ok: true as const })),
      downloadUrl: (p: string) => `/dl${p}`,
    };
  }

  test('lists what the adapter returns', async () => {
    const adapter = adapterWith([entry('uploads', true), entry('config.php', false)]);
    const { findByText } = render(<FileBrowser adapter={adapter} />);
    expect(await findByText('uploads')).toBeDefined();
    expect(await findByText('config.php')).toBeDefined();
  });

  test('opening a folder asks the adapter for that folder', async () => {
    const paths: (string | undefined)[] = [];
    const adapter = adapterWith([entry('uploads', true)], (p) => paths.push(p));
    const { findByText } = render(<FileBrowser adapter={adapter} />);
    const folder = await findByText('uploads');
    fireEvent.click(folder);
    // The first list is the initial load; opening the folder lists its path.
    await waitFor(() => expect(paths.some((p) => p?.includes('uploads'))).toBe(true));
  });

  test('an adapter with nothing shows the empty state, not a broken list', async () => {
    const adapter = adapterWith([]);
    const { findByText } = render(
      <FileBrowser adapter={adapter} emptyState={<div>No files here yet.</div>} />,
    );
    expect(await findByText(/No files here yet\./)).toBeDefined();
  });
});
