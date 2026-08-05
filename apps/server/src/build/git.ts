import { rm } from 'node:fs/promises';

/** A failure we can explain to a non-technical person, with a next step. */
export class FriendlyError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
    readonly detail?: string[],
  ) {
    super(message);
    this.name = 'FriendlyError';
  }
}

export interface RepoRef {
  /** Canonical https clone URL. */
  url: string;
  /** `owner/name`, used to suggest a service name. */
  path: string;
  host: string;
}

/**
 * Accepts the shapes people actually paste: a browser URL, a clone URL, an
 * `owner/repo` shorthand, or an SSH remote (which we redirect to https).
 */
export function normalizeRepoUrl(input: string): RepoRef {
  const raw = input.trim().replace(/\s+/g, '');
  if (!raw) throw new FriendlyError('Paste a link to a GitHub repository.');

  if (raw.startsWith('git@') || raw.startsWith('ssh://')) {
    const match = raw.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?$/);
    if (!match) throw new FriendlyError("That doesn't look like a repository link.");
    return { url: `https://${match[1]}/${match[2]}.git`, path: match[2]!, host: match[1]! };
  }

  // Bare owner/repo, assume GitHub, which is what people mean.
  if (/^[\w.-]+\/[\w.-]+$/.test(raw)) {
    return { url: `https://github.com/${raw}.git`, path: raw, host: 'github.com' };
  }

  const withProtocol = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    throw new FriendlyError(
      "That doesn't look like a repository link.",
      'It should look like https://github.com/someone/their-project',
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new FriendlyError('Only https links are supported.');
  }
  if (url.username || url.password) {
    throw new FriendlyError(
      'Please paste the plain repository link, without a username or token in it.',
      'Private repositories are not supported yet.',
    );
  }

  const path = url.pathname
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  if (!path.includes('/')) {
    throw new FriendlyError(
      'That link points at a user or organisation, not a project.',
      'Open the project on GitHub and copy the link from the address bar.',
    );
  }
  // Drop /tree/main and similar browser-only suffixes.
  const [owner, name] = path.split('/');
  return {
    url: `${url.protocol}//${url.host}/${owner}/${name}.git`,
    path: `${owner}/${name}`,
    host: url.host,
  };
}

export function suggestedNameFromRepo(ref: RepoRef): string {
  return ref.path.split('/')[1] ?? 'app';
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(args: string[], options: { cwd?: string; timeoutMs?: number } = {}) {
  const proc = Bun.spawn(['git', ...args], {
    cwd: options.cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      // Never sit waiting for credentials on a private repo, fail fast instead.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      GCM_INTERACTIVE: 'never',
    },
  });

  const timeout = setTimeout(() => proc.kill(), options.timeoutMs ?? 180_000);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timeout);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() } satisfies GitResult;
}

export interface CloneResult {
  commitSha: string;
  commitMessage: string;
  branch: string;
}

/** Shallow-clones into `dir`, then reports what was actually checked out. */
/** `https://x-access-token:TOKEN@github.com/owner/repo.git`, GitHub's documented form. */
function withToken(repoUrl: string, token: string): string {
  try {
    const url = new URL(repoUrl);
    url.username = 'x-access-token';
    url.password = token;
    return url.toString();
  } catch {
    return repoUrl;
  }
}

export async function cloneRepo(
  repoUrl: string,
  branch: string | null,
  dir: string,
  onLine?: (line: string) => void,
  token?: string | null,
): Promise<CloneResult> {
  const args = ['clone', '--depth', '1', '--single-branch'];
  if (branch) args.push('--branch', branch);
  // The token goes in the URL because that is the only thing `git clone` accepts
  // without an interactive prompt. It never reaches the log, which prints the plain
  // URL, and the checkout is deleted when the deploy finishes.
  args.push(token ? withToken(repoUrl, token) : repoUrl, dir);

  onLine?.(`Getting the code from ${repoUrl.replace(/\.git$/, '')}…`);
  const result = await git(args, { timeoutMs: 300_000 });

  if (result.code !== 0) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw explainCloneFailure(result.stderr, branch);
  }

  const [sha, message, head] = await Promise.all([
    git(['rev-parse', 'HEAD'], { cwd: dir }),
    git(['log', '-1', '--pretty=%s'], { cwd: dir }),
    git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir }),
  ]);

  const actualBranch = head.stdout || branch || 'main';
  onLine?.(`Using ${actualBranch} at ${sha.stdout.slice(0, 7)}, "${message.stdout}"`);

  return {
    commitSha: sha.stdout,
    commitMessage: message.stdout,
    branch: actualBranch,
  };
}

function explainCloneFailure(stderr: string, branch: string | null): FriendlyError {
  const text = stderr.toLowerCase();

  if (text.includes('could not resolve host') || text.includes('failed to connect')) {
    return new FriendlyError(
      "Your server couldn't reach the code host.",
      'Check that this server has internet access, then try again.',
      [stderr],
    );
  }
  if (text.includes('remote branch') && text.includes('not found')) {
    return new FriendlyError(
      `There's no branch called "${branch}" in that repository.`,
      'Check the branch name in Settings, most projects use `main` or `master`.',
      [stderr],
    );
  }
  if (
    text.includes('repository not found') ||
    text.includes('could not read username') ||
    text.includes('authentication failed') ||
    text.includes('403')
  ) {
    return new FriendlyError(
      "That repository doesn't exist, or it's private.",
      'Derailed can only deploy public repositories for now. Double-check the link.',
      [stderr],
    );
  }
  if (text.includes('permission denied') || text.includes('publickey')) {
    return new FriendlyError(
      'That repository needs an SSH key, which Derailed does not have.',
      'Use the https link to a public repository instead.',
      [stderr],
    );
  }
  return new FriendlyError(
    "Derailed couldn't download the code.",
    'Check the repository link and branch, then try again.',
    stderr ? stderr.split('\n').slice(-5) : undefined,
  );
}

/** Looks up the default branch without cloning, used by the new-service wizard. */
export async function resolveDefaultBranch(repoUrl: string): Promise<string | null> {
  const result = await git(['ls-remote', '--symref', repoUrl, 'HEAD'], { timeoutMs: 30_000 });
  if (result.code !== 0) return null;
  const match = result.stdout.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
  return match?.[1] ?? null;
}

export async function gitAvailable(): Promise<boolean> {
  const result = await git(['--version'], { timeoutMs: 5000 });
  return result.code === 0;
}
