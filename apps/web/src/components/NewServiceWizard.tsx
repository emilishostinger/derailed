import type { DetectResult } from '@derailed/shared';
import { Box, ChevronLeft, Database, GitBranch, Sparkles, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { BrandTile, brandByName } from './TechIcon.tsx';
import { cx, ErrorNote, Field, Modal, Spinner } from './ui.tsx';

type Mode = 'choose' | 'apps' | 'github' | 'image' | 'upload' | 'database';

/**
 * The make-or-break moment: paste a link, and Derailed tells you what it found in
 * words a normal person can act on before anything is created.
 */
export function NewServiceWizard({
  projectId,
  onClose,
}: {
  projectId: string;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>('choose');

  const titles: Record<Mode, string> = {
    choose: 'Add something to this project',
    apps: 'Ready-made apps',
    github: 'Deploy from GitHub',
    image: 'Run a Docker image',
    upload: 'Upload your files',
    database: 'Add a database',
  };

  return (
    <Modal title={titles[mode]} onClose={onClose} wide={mode === 'choose' || mode === 'apps'}>
      {mode !== 'choose' && (
        <button
          type="button"
          className="btn-ghost -mt-1 mb-3 -ml-1.5 px-1.5"
          onClick={() => setMode('choose')}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          Back
        </button>
      )}
      {mode === 'choose' && <Choose onPick={setMode} />}
      {mode === 'apps' && <FromTemplates projectId={projectId} onDone={onClose} />}
      {mode === 'github' && <FromGithub projectId={projectId} onDone={onClose} />}
      {mode === 'image' && <FromImage projectId={projectId} onDone={onClose} />}
      {mode === 'upload' && <FromUpload projectId={projectId} onDone={onClose} />}
      {mode === 'database' && <FromCatalog projectId={projectId} onDone={onClose} />}
    </Modal>
  );
}

function Choose({ onPick }: { onPick: (mode: Mode) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {/* First, because most people want a known app rather than a repository. */}
      <Choice
        icon={<Sparkles className="h-5 w-5" />}
        title="Install a ready-made app"
        body="WordPress, Ghost, n8n and others. Set up completely, in one click."
        onClick={() => onPick('apps')}
        featured
      />
      <Choice
        icon={<GitBranch className="h-5 w-5" />}
        title="Deploy from GitHub"
        body="Paste a link to a public repository. Derailed works out how to build it."
        onClick={() => onPick('github')}
      />
      <Choice
        icon={<Box className="h-5 w-5" />}
        title="Run a Docker image"
        body="Already know the image you want? Give its name and Derailed runs it."
        onClick={() => onPick('image')}
      />
      <Choice
        icon={<Upload className="h-5 w-5" />}
        title="Upload a website"
        body="Drag in a zip of a folder on your computer. Plain HTML or PHP works as it is, with nothing to set up."
        onClick={() => onPick('upload')}
      />
      <Choice
        icon={<Database className="h-5 w-5" />}
        title="Add a database"
        body="PostgreSQL, MySQL or Redis, ready in a few seconds and private by default."
        onClick={() => onPick('database')}
      />
    </div>
  );
}

function Choice({
  icon,
  title,
  body,
  onClick,
  featured,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  onClick: () => void;
  featured?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cx(
        'card group flex flex-col items-start p-4 text-left transition-[border-color,background-color] duration-150 hover:border-accent hover:bg-surface-2/50',
        featured && 'border-accent/40 bg-accent-soft/40',
      )}
    >
      <span
        className={cx(
          'mb-3 flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] border transition-colors',
          featured
            ? 'border-accent/40 bg-accent-soft text-accent'
            : 'border-line bg-surface-2 text-ink-muted group-hover:border-accent/40 group-hover:text-accent',
        )}
      >
        {icon}
      </span>
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      <p className="mt-1 text-[12px] leading-relaxed text-ink-muted">{body}</p>
    </button>
  );
}

function FromGithub({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const load = useProjects((s) => s.load);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [name, setName] = useState('');
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [resolvedBranch, setResolvedBranch] = useState('');
  const [commit, setCommit] = useState<{ sha: string; message: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onCheck(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result = await endpoints.detect(repoUrl, branch || undefined, rootDir || undefined);
      setDetected(result.detect);
      setResolvedBranch(result.repo.branch);
      setCommit(result.commit);
      setName((current) => current || result.detect.suggestedName);
    } catch (err) {
      setError(err);
      setDetected(null);
    } finally {
      setBusy(false);
    }
  }

  async function onCreate() {
    setError(null);
    setBusy(true);
    try {
      await endpoints.createApp(projectId, {
        name,
        repoUrl,
        branch: resolvedBranch || branch || undefined,
        rootDir: rootDir || undefined,
        port: detected?.port ?? undefined,
        deployNow: true,
      });
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onCheck} className="space-y-4">
      <Field label="Repository link" hint="Any public GitHub repository.">
        <input
          className="input"
          value={repoUrl}
          onChange={(event) => {
            setRepoUrl(event.target.value);
            setDetected(null);
          }}
          placeholder="https://github.com/someone/their-project"
          autoFocus
          required
        />
      </Field>

      <details className="text-sm">
        <summary className="cursor-pointer text-ink-muted hover:text-ink">
          Branch or sub-folder
        </summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Branch" hint="Leave blank for the default.">
            <input
              className="input"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="main"
            />
          </Field>
          <Field label="Folder" hint="If the app lives in a sub-folder.">
            <input
              className="input"
              value={rootDir}
              onChange={(event) => setRootDir(event.target.value)}
              placeholder="apps/web"
            />
          </Field>
        </div>
      </details>

      <ErrorNote error={error} />

      {!detected && (
        <button type="submit" className="btn-primary w-full" disabled={busy || !repoUrl.trim()}>
          {busy && <Spinner />}
          {busy ? 'Taking a look…' : 'Check this repository'}
        </button>
      )}

      {detected && (
        <>
          <div className="rounded-lg border border-accent/30 bg-accent-soft/60 p-4">
            <p className="text-sm text-ink">{detected.summary}</p>
            {commit && (
              <p className="mt-2 text-xs text-ink-muted">
                {resolvedBranch} · {commit.sha.slice(0, 7)} · {commit.message}
              </p>
            )}
            {detected.warnings.map((warning) => (
              <p key={warning} className="mt-2 text-xs text-warn">
                {warning}
              </p>
            ))}
          </div>

          <Field label="Name it" hint="Used for its web address, so keep it short.">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>

          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary flex-1"
              disabled={busy || !name.trim()}
              onClick={() => void onCreate()}
            >
              {busy && <Spinner />}
              Deploy it
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setDetected(null)}
              disabled={busy}
            >
              Back
            </button>
          </div>
        </>
      )}
    </form>
  );
}

const ENGINES = [
  {
    engine: 'postgres',
    label: 'PostgreSQL',
    versions: ['17', '16', '15'],
    blurb: 'The usual choice. Great for almost anything.',
  },
  {
    engine: 'mysql',
    label: 'MySQL',
    versions: ['8.4', '8.0'],
    blurb: 'Widely supported, especially by PHP apps.',
  },
  {
    engine: 'redis',
    label: 'Redis',
    versions: ['7'],
    blurb: 'In-memory store for caching, queues and sessions.',
  },
];

function FromCatalog({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const load = useProjects((s) => s.load);
  const [engine, setEngine] = useState(ENGINES[0]!);
  const [version, setVersion] = useState(ENGINES[0]!.versions[0]!);
  const [name, setName] = useState('database');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function onCreate() {
    setError(null);
    setBusy(true);
    try {
      await endpoints.createDatabase(projectId, name, engine.engine, version);
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-3">
        {ENGINES.map((entry) => (
          <button
            key={entry.engine}
            type="button"
            onClick={() => {
              setEngine(entry);
              setVersion(entry.versions[0]!);
              setName(entry.engine);
            }}
            className={cx(
              'card p-3 text-left transition-colors',
              engine.engine === entry.engine ? 'border-accent' : 'hover:border-line-strong',
            )}
          >
            <p className="text-sm font-medium text-ink">{entry.label}</p>
            <p className="mt-1 text-xs text-ink-muted">{entry.blurb}</p>
          </button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Version">
          <select
            className="input"
            value={version}
            onChange={(event) => setVersion(event.target.value)}
          >
            {engine.versions.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name it">
          <input
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
            required
          />
        </Field>
      </div>

      <p className="hint">
        Only apps in this project will be able to reach it. Nothing is exposed to the internet.
      </p>

      <ErrorNote error={error} />

      <button
        type="button"
        className="btn-primary w-full"
        disabled={busy || !name.trim()}
        onClick={() => void onCreate()}
      >
        {busy && <Spinner />}
        Create {engine.label}
      </button>
    </div>
  );
}

/**
 * The gallery. For someone who wants a website rather than a deployment pipeline,
 * this is the only screen in the product that matters.
 */
function FromTemplates({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const load = useProjects((s) => s.load);
  const [templates, setTemplates] = useState<
    { slug: string; name: string; blurb: string; category: string; needsDatabase: boolean }[]
  >([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    endpoints
      .templates()
      .then(setTemplates)
      .catch(setError)
      .finally(() => setLoading(false));
  }, []);

  async function install(slug: string) {
    setInstalling(slug);
    setError(null);
    try {
      await endpoints.installTemplate(projectId, slug);
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setInstalling(null);
    }
  }

  if (loading) return <p className="hint">Loading…</p>;

  const categories = [...new Set(templates.map((template) => template.category))];

  return (
    <div className="space-y-5">
      {categories.map((category) => (
        <section key={category}>
          <p className="eyebrow mb-2">{category}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {templates
              .filter((template) => template.category === category)
              .map((template) => (
                <button
                  key={template.slug}
                  type="button"
                  disabled={installing !== null}
                  onClick={() => void install(template.slug)}
                  className={cx(
                    'card flex flex-col items-start p-3.5 text-left transition-[border-color,background-color] duration-150',
                    'hover:border-accent hover:bg-surface-2/50 disabled:opacity-50',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <TemplateGlyph slug={template.slug} name={template.name} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">
                      {template.name}
                    </span>
                    {installing === template.slug && <Spinner />}
                  </span>
                  <span className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">
                    {template.blurb}
                  </span>
                  {template.needsDatabase && (
                    <span className="mt-2 flex items-center gap-1 text-[11px] text-ink-faint">
                      <Database className="h-3 w-3" />A database is set up for you
                    </span>
                  )}
                </button>
              ))}
          </div>
        </section>
      ))}

      {installing && (
        <p className="hint">
          Setting everything up. The database, the app and its storage. This takes a minute.
        </p>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

/** A coloured initial. Cheap, recognisable, and no third-party logo assets to ship. */
function TemplateGlyph({ slug, name }: { slug: string; name: string }) {
  const brand = brandByName(name) ?? brandByName(slug);
  if (brand) return <BrandTile brand={brand} className="h-6 w-6" />;

  return (
    <span
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] bg-ink-faint text-[12px] font-bold text-white"
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function FromImage({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const load = useProjects((s) => s.load);
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // `ghcr.io/owner/thing:tag` → `thing`, which is almost always what you'd call it.
  const suggested = image.split('/').pop()?.split(':')[0] ?? '';

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await endpoints.createFromImage(
        projectId,
        name.trim() || suggested,
        image.trim(),
        port ? Number(port) : undefined,
      );
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Image" hint="From Docker Hub or any public registry.">
        <input
          className="input font-mono text-[12px]"
          value={image}
          placeholder="wordpress:php8.3-apache"
          autoFocus
          onChange={(event) => setImage(event.target.value)}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name it">
          <input
            className="input"
            value={name}
            placeholder={suggested || 'my-app'}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="Port" hint="The port the app listens on inside.">
          <input
            className="input"
            value={port}
            placeholder="3000"
            onChange={(event) => setPort(event.target.value.replace(/\D/g, ''))}
          />
        </Field>
      </div>

      <ErrorNote error={error} />

      <button
        type="button"
        className="btn-primary w-full"
        disabled={busy || !image.trim()}
        onClick={() => void create()}
      >
        {busy && <Spinner />}
        Run it
      </button>
    </div>
  );
}

/**
 * Drag a folder in. No git, no repository, no account anywhere, for someone who has
 * a website on their laptop and wants it on the internet.
 */
function FromUpload({ projectId, onDone }: { projectId: string; onDone: () => void }) {
  const load = useProjects((s) => s.load);
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function take(chosen: File | undefined) {
    if (!chosen) return;
    if (!chosen.name.toLowerCase().endsWith('.zip')) {
      setError(new Error('That needs to be a .zip file.'));
      return;
    }
    setError(null);
    setFile(chosen);
    setName((current) => current || chosen.name.replace(/\.zip$/i, ''));
  }

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const service = await endpoints.createUploadApp(projectId, name.trim() || 'app');
      await endpoints.uploadFiles(service.id, file);
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the visible control is the button inside; this only adds drag-and-drop on top of it. */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setOver(false);
          take(event.dataTransfer.files[0]);
        }}
        className={cx(
          'flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed px-6 py-10 text-center transition-colors',
          over ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface-2/40',
        )}
      >
        <Upload className={cx('h-6 w-6', over ? 'text-accent' : 'text-ink-faint')} />
        <p className="mt-3 text-[13px] font-medium text-ink">
          {file ? file.name : 'Drop a .zip of your project here'}
        </p>
        <p className="mt-1 text-[12px] text-ink-muted">
          {file
            ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
            : 'Zip the folder your site lives in. Leave out node_modules.'}
        </p>
        <p className="mt-2 max-w-xs text-[11px] text-ink-faint">
          A folder of HTML is served as it is. A folder of PHP is served with PHP and Apache.
          Anything else is built the same way a repository would be.
        </p>

        <label className="btn-secondary mt-4 cursor-pointer">
          <input
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(event) => take(event.target.files?.[0])}
          />
          Choose a file
        </label>
      </div>

      <Field label="Name it">
        <input
          className="input"
          value={name}
          placeholder="my-site"
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <ErrorNote error={error} />

      <button
        type="button"
        className="btn-primary w-full"
        disabled={busy || !file}
        onClick={() => void upload()}
      >
        {busy && <Spinner />}
        {busy ? 'Uploading and deploying…' : 'Upload and deploy'}
      </button>
    </div>
  );
}
