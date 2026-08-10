import type { DetectResult, ImportPlan } from '@derailed/shared';
import { Box, Database, GitBranch, Layers, Sparkles, Upload } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { endpoints } from '../api/endpoints.ts';
import { useProjects } from '../stores/projects.ts';
import { BrandTile, brandByName } from './TechIcon.tsx';
import { cx, ErrorNote, Field, Modal, Select, Spinner } from './ui.tsx';

type Mode = 'choose' | 'apps' | 'github' | 'image' | 'upload' | 'database' | 'compose';

/**
 * The make-or-break moment: paste a link, and Derailed tells you what it found in
 * words a normal person can act on before anything is created.
 */
export function NewServiceWizard({
  projectId,
  onClose,
  onCreated,
}: {
  projectId: string;
  onClose: () => void;
  onCreated?: (serviceId: string) => void;
}) {
  const [mode, setMode] = useState<Mode>('choose');

  // Closing after a create carries the new service's id out, so the caller can
  // open its drawer: the person who just added something should be looking at
  // it going live, not at the canvas wondering which node is theirs.
  const done = (serviceId?: string) => {
    if (serviceId) onCreated?.(serviceId);
    onClose();
  };

  const titles: Record<Mode, string> = {
    choose: 'Add something to this project',
    apps: 'Ready-made apps',
    github: 'Deploy from GitHub',
    image: 'Run a Docker image',
    upload: 'Upload your files',
    database: 'Add a database',
    compose: 'Import an existing setup',
  };

  return (
    <Modal
      title={titles[mode]}
      onClose={onClose}
      onBack={mode !== 'choose' ? () => setMode('choose') : undefined}
      wide={mode === 'choose' || mode === 'apps'}
    >
      {mode === 'choose' && <Choose onPick={setMode} />}
      {mode === 'apps' && <FromTemplates projectId={projectId} onDone={done} />}
      {mode === 'github' && <FromGithub projectId={projectId} onDone={done} />}
      {mode === 'image' && (
        <FromImage projectId={projectId} onDone={done} onPickDatabase={() => setMode('database')} />
      )}
      {mode === 'upload' && <FromUpload projectId={projectId} onDone={done} />}
      {mode === 'database' && <FromCatalog projectId={projectId} onDone={done} />}
      {mode === 'compose' && <FromCompose projectId={projectId} onDone={done} />}
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
      <Choice
        icon={<Layers className="h-5 w-5" />}
        title="Import an existing setup"
        body="Arriving from Heroku, Render, Railway or Fly, or holding a docker-compose file? Derailed reads how it was set up and builds the same thing here."
        onClick={() => onPick('compose')}
      />
    </div>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  compose: 'docker-compose',
  heroku: 'Heroku',
  render: 'Render',
  railway: 'Railway',
  fly: 'Fly',
};

/**
 * Importing as two steps: inspect first, so what is about to happen is on the
 * screen before anything exists; then one press builds it all.
 */
function FromCompose({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
}) {
  const load = useProjects((s) => s.load);
  const [repoUrl, setRepoUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [found, setFound] = useState<string[]>([]);
  const [composeFile, setComposeFile] = useState('');

  async function inspect(event: FormEvent | null, format?: string) {
    event?.preventDefault();
    setInspecting(true);
    setError(null);
    setPlan(null);
    try {
      const answer = await endpoints.inspectImport(repoUrl.trim(), undefined, undefined, format);
      setPlan(answer.plan);
      setFound(answer.found);
      setComposeFile(answer.composeFile);
    } catch (err) {
      setError(err);
    } finally {
      setInspecting(false);
    }
  }

  async function apply() {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      await endpoints.applyImport(projectId, plan);
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setApplying(false);
    }
  }

  return (
    <div className="space-y-3">
      <form onSubmit={inspect} className="space-y-3">
        <Field
          label="Repository with a compose file"
          hint="Derailed reads the file once and turns it into ordinary services. Nothing is created until you say so."
        >
          <div className="flex gap-2">
            <input
              className="input flex-1"
              placeholder="github.com/someone/project"
              value={repoUrl}
              onChange={(event) => setRepoUrl(event.target.value)}
            />
            <button
              type="submit"
              className="btn-secondary"
              disabled={inspecting || !repoUrl.trim()}
            >
              {inspecting && <Spinner />}
              Look inside
            </button>
          </div>
        </Field>
      </form>

      <ErrorNote error={error} />

      {plan && (
        <>
          {found.length > 1 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[12px] text-ink-faint">Read as</span>
              {found.map((source) => (
                <button
                  key={source}
                  type="button"
                  className={cx(
                    'rounded-full border px-2.5 py-0.5 text-[12px]',
                    source === plan.source
                      ? 'border-accent bg-accent-soft text-accent'
                      : 'border-line text-ink-muted hover:border-accent/40',
                  )}
                  onClick={() => void inspect(null, source)}
                >
                  {SOURCE_LABELS[source] ?? source}
                </button>
              ))}
            </div>
          )}
          <p className="text-[13px] text-ink-muted">
            {composeFile} describes {plan.services.length}{' '}
            {plan.services.length === 1 ? 'service' : 'services'}
            {plan.databases.length
              ? ` and ${plan.databases.length} ${plan.databases.length === 1 ? 'database' : 'databases'}`
              : ''}
            :
          </p>
          <ul className="divide-y divide-line rounded-[var(--radius-card)] border border-line">
            {plan.services.map((service) => (
              <li key={service.name} className="px-3 py-2">
                <p className="text-[13px] font-medium text-ink">{service.name}</p>
                <p className="text-[12px] text-ink-muted">
                  {service.source === 'image'
                    ? `Runs ${service.image}`
                    : `Built from the repository${service.rootDir ? `, in ${service.rootDir}` : ''}`}
                  {service.port ? ` · answers on ${service.port}` : ''}
                  {service.volumes.length
                    ? ` · keeps ${service.volumes.length} ${service.volumes.length === 1 ? 'folder' : 'folders'}`
                    : ''}
                  {service.dependsOn.length
                    ? ` · starts after ${service.dependsOn.join(', ')}`
                    : ''}
                </p>
              </li>
            ))}
            {plan.databases.map((database) => (
              <li key={`db-${database.name}`} className="px-3 py-2">
                <p className="text-[13px] font-medium text-ink">{database.name}</p>
                <p className="text-[12px] text-ink-muted">
                  A managed {database.engine} {database.version}
                  {database.linkTo.length
                    ? `, its address wired into ${database.linkTo.map((link) => link.service).join(', ')}`
                    : ''}
                </p>
              </li>
            ))}
            {plan.jobs.map((job) => (
              <li key={`job-${job.name}`} className="px-3 py-2">
                <p className="text-[13px] font-medium text-ink">{job.name}</p>
                <p className="text-[12px] text-ink-muted">
                  Runs "{job.command}" on the schedule {job.schedule}, inside {job.service}
                </p>
              </li>
            ))}
          </ul>

          {plan.warnings.length > 0 && (
            <div className="rounded-[var(--radius-card)] border border-line bg-sunken px-3 py-2">
              <p className="eyebrow mb-1">Worth knowing before you press the button</p>
              <ul className="list-disc space-y-1 pl-4">
                {plan.warnings.map((warning) => (
                  <li key={warning} className="text-[12px] text-ink-muted">
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={applying} onClick={apply}>
              {applying && <Spinner />}
              Import {plan.services.length === 1 ? 'it' : 'them all'}
            </button>
          </div>
        </>
      )}
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

function FromGithub({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
}) {
  const load = useProjects((s) => s.load);
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [rootDir, setRootDir] = useState('');
  const [name, setName] = useState('');
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const [resolvedBranch, setResolvedBranch] = useState('');
  const [commit, setCommit] = useState<{ sha: string; message: string } | null>(null);
  const [strategy, setStrategy] = useState<'auto' | 'dockerfile' | 'nixpacks' | 'site'>('auto');
  const [dockerfileAt, setDockerfileAt] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  async function check(dirOverride?: string) {
    setError(null);
    setBusy(true);
    try {
      const dir = dirOverride ?? rootDir;
      const result = await endpoints.detect(repoUrl, branch || undefined, dir || undefined);
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

  async function onCheck(event: FormEvent) {
    event.preventDefault();
    await check();
  }

  async function onCreate() {
    setError(null);
    setBusy(true);
    try {
      const created = await endpoints.createApp(projectId, {
        name,
        repoUrl,
        branch: resolvedBranch || branch || undefined,
        rootDir: rootDir || undefined,
        port: detected?.port ?? undefined,
        buildStrategy: strategy === 'auto' ? undefined : strategy,
        dockerfilePath: (strategy === 'dockerfile' && dockerfileAt.trim()) || undefined,
        deployNow: true,
      });
      await load();
      onDone(created.id);
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
            {detected.suggestedRootDir && (
              <button
                type="button"
                className="btn-secondary mt-3"
                disabled={busy}
                onClick={() => {
                  const dir = detected.suggestedRootDir;
                  if (!dir) return;
                  setRootDir(dir);
                  void check(dir);
                }}
              >
                {busy && <Spinner />}
                Look in {detected.suggestedRootDir} instead
              </button>
            )}
          </div>

          <Field label="Name it" hint="Used for its web address, so keep it short.">
            <input
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </Field>

          <details className="text-sm">
            <summary className="cursor-pointer text-ink-muted hover:text-ink">
              How it gets built
            </summary>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label="Builder" hint="Automatic follows what was detected above.">
                <select
                  className="input"
                  value={strategy}
                  onChange={(event) => setStrategy(event.target.value as typeof strategy)}
                >
                  <option value="auto">Automatic</option>
                  <option value="dockerfile">Its own Dockerfile</option>
                  <option value="nixpacks">Build from source (Nixpacks)</option>
                  <option value="site">Plain website, no build</option>
                </select>
              </Field>
              {strategy === 'dockerfile' && (
                <Field label="Dockerfile" hint="Path inside the repository.">
                  <input
                    className="input"
                    value={dockerfileAt}
                    onChange={(event) => setDockerfileAt(event.target.value)}
                    placeholder="Dockerfile"
                  />
                </Field>
              )}
            </div>
          </details>

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

interface CatalogEngine {
  engine: string;
  label: string;
  versions: string[];
  blurb: string;
}

/**
 * The engines come from the server rather than from a copy kept here.
 *
 * There were two lists: one the server would actually run and one the dashboard drew
 * buttons from, and they had already drifted, so adding an engine meant editing both
 * and noticing that you had to. Now adding one is a change to `catalog/databases.ts`
 * and nothing else.
 */
function FromCatalog({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
}) {
  const load = useProjects((s) => s.load);
  const [engines, setEngines] = useState<CatalogEngine[] | null>(null);
  const [engine, setEngine] = useState<CatalogEngine | null>(null);
  const [version, setVersion] = useState('');
  const [name, setName] = useState('database');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    endpoints
      .databaseCatalog()
      .then(({ engines: list }) => {
        setEngines(list);
        const first = list[0];
        if (first) {
          setEngine(first);
          setVersion(first.versions[0] ?? '');
          setName(first.engine);
        }
      })
      .catch(setError);
  }, []);

  async function onCreate() {
    if (!engine) return;
    setError(null);
    setBusy(true);
    try {
      const created = await endpoints.createDatabase(projectId, name, engine.engine, version);
      await load();
      onDone(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  if (!engines || !engine) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 py-6 text-[13px] text-ink-muted">
          <Spinner /> Loading the list.
        </div>
        <ErrorNote error={error} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Two to a row rather than three: with a mark and a sentence on each, three
          across squeezed the words into a column two syllables wide. */}
      <div className="grid gap-2 sm:grid-cols-2">
        {engines.map((entry) => {
          const brand = brandByName(entry.engine) ?? brandByName(entry.label);
          return (
            <button
              key={entry.engine}
              type="button"
              onClick={() => {
                setEngine(entry);
                setVersion(entry.versions[0] ?? '');
                setName(entry.engine);
              }}
              className={cx(
                'card flex items-start gap-2.5 p-3 text-left transition-colors',
                engine.engine === entry.engine ? 'border-accent' : 'hover:border-line-strong',
              )}
            >
              {/* The mark does the identifying. "Postgres or MySQL?" is answered by
                  the elephant and the dolphin before either word is read. */}
              {brand ? (
                <BrandTile brand={brand} className="mt-0.5 h-7 w-7" />
              ) : (
                <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] bg-surface-2 text-ink-faint">
                  <Database className="h-4 w-4" />
                </span>
              )}
              <span className="min-w-0">
                <span className="block text-sm font-medium text-ink">{entry.label}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {entry.blurb}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Version">
          <Select
            ariaLabel="Version"
            value={version}
            options={engine.versions.map((entry) => ({ value: entry, label: entry }))}
            onChange={setVersion}
          />
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
function FromTemplates({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
}) {
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
      const installed = await endpoints.installTemplate(projectId, slug);
      await load();
      onDone(installed.service.id);
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

      <FromLink projectId={projectId} onDone={onDone} disabled={installing !== null} />
    </div>
  );
}

/**
 * An app from a link somebody sent you.
 *
 * The server could already fetch and check a template file from a URL, and there was
 * no way to ask it to: no box to paste into, and nothing that would install what came
 * back. So the catalogue was the catalogue, and that was that.
 *
 * It looks before it leaps. Pasting a link tells you what it would create and waits,
 * because "run this file from the internet on my server" is not a thing to do on the
 * strength of a URL nobody has read.
 */
function FromLink({
  projectId,
  onDone,
  disabled,
}: {
  projectId: string;
  onDone: () => void;
  disabled: boolean;
}) {
  const load = useProjects((s) => s.load);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [found, setFound] = useState<{ name: string; blurb: string } | null>(null);
  const [busy, setBusy] = useState<'peek' | 'install' | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function peek() {
    setBusy('peek');
    setError(null);
    setFound(null);
    try {
      const result = await endpoints.peekTemplate(url.trim());
      setFound(result.template);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(null);
    }
  }

  async function install() {
    setBusy('install');
    setError(null);
    try {
      await endpoints.installTemplateFromUrl(projectId, url.trim());
      await load();
      onDone();
    } catch (err) {
      setError(err);
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-line pt-4">
      {!open ? (
        <button
          type="button"
          className="link text-[13px]"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          Have a link to one? Paste it here
        </button>
      ) : (
        <div className="space-y-3">
          <Field
            label="The address of a template file"
            hint="Over https only, and every field Derailed does not understand is dropped rather than passed on."
          >
            <div className="flex gap-2">
              <input
                className="input"
                value={url}
                placeholder="https://example.com/derailed.json"
                onChange={(event) => {
                  setUrl(event.target.value);
                  setFound(null);
                }}
              />
              <button
                type="button"
                className="btn-secondary shrink-0"
                disabled={busy !== null || !url.trim()}
                onClick={() => void peek()}
              >
                {busy === 'peek' && <Spinner />}
                Check it
              </button>
            </div>
          </Field>

          {found && (
            <div className="card p-3.5">
              <p className="text-[13px] font-semibold text-ink">{found.name}</p>
              <p className="mt-1 text-[12px] text-ink-muted">{found.blurb}</p>
              <button
                type="button"
                className="btn-primary mt-3"
                disabled={busy !== null}
                onClick={() => void install()}
              >
                {busy === 'install' && <Spinner />}
                Set this up
              </button>
            </div>
          )}

          <ErrorNote error={error} />
        </div>
      )}
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

/** Engines the image box recognises and steers to the database path instead. */
const DATABASE_IMAGES: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  mongo: 'MongoDB',
  redis: 'Redis',
  valkey: 'Valkey',
};

function FromImage({
  projectId,
  onDone,
  onPickDatabase,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
  onPickDatabase: () => void;
}) {
  const load = useProjects((s) => s.load);
  const [image, setImage] = useState('');
  const [name, setName] = useState('');
  const [port, setPort] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [templates, setTemplates] = useState<Awaited<ReturnType<typeof endpoints.templates>>>([]);

  useEffect(() => {
    endpoints
      .templates()
      .then(setTemplates)
      .catch(() => undefined);
  }, []);

  // `ghcr.io/owner/thing:tag` → `thing`, which is almost always what you'd call it.
  const suggested = image.split('/').pop()?.split(':')[0] ?? '';

  // The typed image, stripped to its bare repository, matched against what the
  // catalogue knows. Someone typing `wordpress` deserves better than a lone
  // container with no database and no storage, and someone typing `postgres`
  // deserves a real database, not an app-shaped one.
  const repo =
    image
      .trim()
      .split('@')[0]
      ?.split(':')[0]
      ?.replace(/^(docker\.io\/)?(library\/)?/, '') ?? '';
  const recognised = repo
    ? (templates.find((t) => t.imageRepo === repo || t.imageRepo.endsWith(`/${repo}`)) ?? null)
    : null;
  const engineName = DATABASE_IMAGES[repo.split('/').pop() ?? ''];

  async function setUpCompletely() {
    if (!recognised) return;
    setBusy(true);
    setError(null);
    try {
      // The tag is the user's choice, the repository is the template's: a bare
      // `wordpress` means "whatever the catalogue pins", not `:latest`.
      const override = image.trim().includes(':') ? image.trim() : undefined;
      const installed = await endpoints.installTemplate(
        projectId,
        recognised.slug,
        name.trim() || suggested,
        override,
      );
      await load();
      onDone(installed.service.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const created = await endpoints.createFromImage(
        projectId,
        name.trim() || suggested,
        image.trim(),
        port ? Number(port) : undefined,
      );
      await load();
      onDone(created.id);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Image" hint="From Docker Hub or any public registry.">
        <input
          className="input text-[12px]"
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

      {recognised && (
        <div className="rounded-lg border border-accent/30 bg-accent-soft/60 p-4">
          <p className="text-sm text-ink">
            That's {recognised.name}. The one-click setup does more than run the image:{' '}
            {recognised.needsDatabase ? 'a database is created and connected, ' : ''}storage is set
            up, and the settings are filled in.
          </p>
          <button
            type="button"
            className="btn-primary mt-3"
            disabled={busy}
            onClick={() => void setUpCompletely()}
          >
            {busy && <Spinner />}
            Set it up completely
          </button>
        </div>
      )}

      {!recognised && engineName && (
        <div className="rounded-lg border border-accent/30 bg-accent-soft/60 p-4">
          <p className="text-sm text-ink">
            That's {engineName}, a database engine. Databases have their own path here, with
            credentials, backups and app connections handled for you.
          </p>
          <button type="button" className="btn-primary mt-3" onClick={onPickDatabase}>
            Add it as a database
          </button>
        </div>
      )}

      <ErrorNote error={error} />

      <button
        type="button"
        className={cx('w-full', recognised || engineName ? 'btn-secondary' : 'btn-primary')}
        disabled={busy || !image.trim()}
        onClick={() => void create()}
      >
        {busy && <Spinner />}
        {recognised || engineName ? 'Run just the image' : 'Run it'}
      </button>
      {recognised?.needsDatabase && (
        <p className="text-[12px] text-warn">
          On its own, this image will look for a database that doesn't exist yet.
        </p>
      )}
    </div>
  );
}

/**
 * Drag a folder in. No git, no repository, no account anywhere, for someone who has
 * a website on their laptop and wants it on the internet.
 */
function FromUpload({
  projectId,
  onDone,
}: {
  projectId: string;
  onDone: (serviceId?: string) => void;
}) {
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
      onDone(service.id);
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
