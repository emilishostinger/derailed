import type { Diagnosis } from '@derailed/shared';

/**
 * Why did this break?
 *
 * Derailed's whole personality is plain language when things go wrong. This is that
 * personality as a feature: read what the build or the container actually printed,
 * recognise it, and answer in two sentences with something to press.
 *
 * Every rule below is a failure that has happened to somebody, phrased as what to do
 * rather than what went wrong. They are ordered, and the first match wins, so the
 * specific ones come before the general ones: "port already in use" must be found
 * before "the container exited", because both are true and only one is useful.
 *
 * This runs entirely offline and always has. An optional model can be pointed at the
 * leftovers, but the rules are the product: they are instant, they work on a server
 * with no internet, and they send nothing anywhere.
 */

export interface Rule {
  id: string;
  /** All of these must appear for the rule to match. Lower-cased before testing. */
  match: RegExp[];
  /** Any of these disqualifies it, for the cases that look alike. */
  unless?: RegExp[];
  summary: string;
  action: string;
  /** Something Derailed can do about it from the failure card. */
  fix?: Diagnosis['fix'];
}

export const RULES: Rule[] = [
  // ---- Ports and addresses -------------------------------------------------
  {
    id: 'port-in-use',
    match: [/eaddrinuse|address already in use/],
    summary: 'The app tried to listen on a port that something else is already using.',
    action:
      'Almost always the app hard-codes a port that another app here already has. Set a PORT variable on its Variables tab and make the app read it.',
  },
  {
    // The detect step wrote its subfolder advice into this same log; a failure
    // after that sentence nearly always means the advice was the answer.
    id: 'app-in-subfolder',
    match: [/set the app folder to .* and i'll look again/],
    summary: "The app doesn't live at the top of this repository.",
    action:
      'The build log names the folder that looks like the real app. Put it in the Folder box on the Settings tab and deploy again.',
  },
  {
    id: 'wrong-port',
    match: [/didn't answer|never answered|health check failed|not responding on port/],
    summary: 'The app started but never answered on the port Derailed was watching.',
    action:
      'Check the port on its Settings tab matches the one the app actually listens on. If the app picks its own, make it read the PORT variable Derailed sets. And if the whole stack looks wrong (a PHP forum built as a Node app), the Settings tab has a "Build it with" control to say what it really is.',
  },
  {
    id: 'listening-on-localhost',
    match: [/127\.0\.0\.1|localhost/, /listening|server (started|running)/],
    summary:
      'The app is listening on localhost, which means only itself. Nothing outside the container can reach it.',
    action:
      'Bind to 0.0.0.0 instead of 127.0.0.1. In most frameworks that is a host option next to the port.',
  },

  // ---- Memory --------------------------------------------------------------
  {
    id: 'oom-build',
    match: [/javascript heap out of memory|killed.*(webpack|vite|tsc|next build)|signal 9/],
    summary: 'The build ran out of memory and was killed part way through.',
    action:
      'Give the server some swap on the Server page, which is usually enough. Failing that, build fewer things at once.',
    fix: 'add-swap',
  },
  {
    id: 'oom-run',
    match: [/out of memory|oomkilled|exit code 137/],
    summary: 'The app ran out of memory and the system stopped it.',
    action:
      'Raise its memory limit on the Settings tab, or add swap on the Server page. An app killed this way did not crash: it was chosen and killed because the machine had nothing left.',
    fix: 'add-swap',
  },

  // ---- Disk ----------------------------------------------------------------
  {
    id: 'disk-full',
    match: [/no space left on device|enospc/],
    summary: 'The server ran out of disk space during the build.',
    action: 'Free up space on the Server page, which shows what is using it.',
    fix: 'reclaim-disk',
  },

  // ---- Dependencies and builds ---------------------------------------------
  {
    id: 'missing-lockfile',
    // Split rather than one expression: npm wraps this across two lines, and `.` does
    // not cross a newline. Each pattern is tested against the whole text separately.
    match: [/can only install packages|lockfile.*not found|no lockfile/],
    summary: 'The build wants a lockfile that is not in the repository.',
    action:
      'Commit your package-lock.json, yarn.lock or pnpm-lock.yaml. Without it the build cannot know which versions to install.',
  },
  {
    id: 'lockfile-mismatch',
    match: [/lock file.*out of (sync|date)|does not match|frozen-lockfile/],
    summary: 'The lockfile and package.json disagree about what should be installed.',
    action:
      "Run your package manager's install locally, commit the updated lockfile, and deploy again.",
  },
  {
    id: 'python-missing',
    match: [/gyp err|node-gyp|python.*not found|distutils/],
    summary:
      'Something in the dependency tree has to be compiled, and the build image has no compiler.',
    action:
      'Switch this app to build from a Dockerfile and install python3 and build-essential in it, or find a dependency that ships prebuilt.',
  },
  {
    id: 'node-version',
    match: [/(unsupported engine|requires node|node version).*(\d+)/],
    summary: 'A dependency wants a different version of Node than the build used.',
    action:
      'Add an "engines" field to package.json, or a .nvmrc, naming the version you want. The builder reads both.',
  },
  {
    id: 'module-not-found',
    match: [/cannot find module|module not found|importerror|modulenotfounderror/],
    summary: 'The app asked for something that was not installed.',
    action:
      'Usually a dependency listed as a devDependency that is needed at runtime, or one not listed at all. Check it is in the right section of package.json.',
  },
  {
    id: 'no-start-script',
    match: [/missing script.*start|no start command|could not determine how to start/],
    summary: 'Nothing tells Derailed how to start this app.',
    action:
      'Add a "start" script to package.json, or a Procfile, or a Dockerfile with a CMD. Any of the three is enough.',
  },
  {
    id: 'typescript-error',
    match: [/error ts\d{4}|type error:/],
    summary: 'The build failed on a TypeScript error.',
    action:
      'The line above names the file. It will fail the same way locally, which is the quicker place to fix it.',
  },

  // ---- Docker --------------------------------------------------------------
  {
    id: 'dockerfile-missing',
    match: [/dockerfile.*(not found|no such file)/],
    summary: 'Derailed was told to build from a Dockerfile that is not there.',
    action:
      'Check the Dockerfile path on the Settings tab. If the repository has no Dockerfile, set the build to Automatic instead.',
  },
  {
    id: 'base-image-missing',
    match: [/pull access denied|manifest.*not found|repository does not exist/],
    summary: 'The image this build starts from could not be downloaded.',
    action:
      'Check the name and tag in the FROM line. A tag that has been removed upstream is the usual cause.',
  },
  {
    id: 'buildkit-mount',
    match: [/--mount|the --mount option requires buildkit/],
    summary: 'The Dockerfile uses a BuildKit feature that Derailed cannot build with.',
    action: 'Remove the RUN --mount lines. They only make builds faster, so nothing is lost.',
  },

  // ---- Databases -----------------------------------------------------------
  {
    id: 'db-refused',
    match: [/econnrefused|connection refused/, /5432|3306|27017|6379|postgres|mysql|mongo|redis/],
    summary: 'The app could not reach its database.',
    action:
      'Check the database is running, and that it is connected to this app on the Connections tab. Connecting them sets the credentials for you.',
  },
  {
    id: 'db-auth',
    match: [/password authentication failed|access denied for user|authentication failed/],
    summary: 'The database refused the username and password the app used.',
    action:
      'If you set these by hand, they have drifted from the real ones. Connect the database to the app on the Connections tab and let Derailed fill them in.',
  },
  {
    id: 'db-missing',
    match: [/database .* does not exist|unknown database/],
    summary: 'The app is asking for a database that has not been created inside the server.',
    action:
      "Either create it, or point the app at the one that exists. Its name is on the database's Connection tab.",
  },
  {
    id: 'migrations',
    match: [/relation .* does not exist|no such table|table .* doesn't exist/],
    summary: 'The app is querying tables that are not there, so its migrations have not run.',
    action:
      "Run the migrations. The app's Terminal tab is the quickest way, with whatever command your framework uses.",
  },

  // ---- Permissions and storage ---------------------------------------------
  {
    id: 'permission-denied',
    match: [/eacces|permission denied/],
    summary: 'The app was not allowed to write where it tried to write.',
    action:
      'If it writes to a folder, add that folder as storage on its Storage tab. Otherwise the image is running as a user without access to it.',
  },
  {
    id: 'read-only',
    match: [/read-only file system|erofs/],
    summary: 'The app tried to write somewhere that is not writable.',
    action:
      'Add that path as storage on its Storage tab, which also means it survives the next deploy.',
  },

  // ---- Repository ----------------------------------------------------------
  {
    id: 'repo-auth',
    match: [/authentication failed|could not read username|repository not found|403/, /git|clone/],
    summary: 'Derailed could not read the repository.',
    action:
      'If it is private, add a token on the Settings tab. If it is public, check the address is right.',
  },
  {
    id: 'branch-missing',
    match: [/(couldn't find|not found).*(branch|ref)|pathspec.*did not match/],
    summary: 'The branch Derailed was told to deploy does not exist.',
    action: 'Check the branch name on the Settings tab against the one in the repository.',
  },

  // ---- Networking ----------------------------------------------------------
  {
    id: 'dns-failure',
    match: [/enotfound|getaddrinfo|temporary failure in name resolution/],
    summary: 'Something the build or the app needed could not be found on the network.',
    action:
      'Usually a hostname in a variable that is wrong, or a service that is not running. If it is a database, connect it on the Connections tab instead of typing the address.',
  },
  {
    id: 'timeout',
    match: [/etimedout|timed out|timeout/],
    summary: 'Something took longer than it was allowed to.',
    action:
      'If it happened while fetching dependencies, trying again usually works. If it happened while starting, the app may simply need longer than the health check allows.',
  },
];

/** Everything the app and the build printed, made comparable. */
function haystack(lines: string[]): string {
  return lines.join('\n').toLowerCase();
}

/**
 * Reads the output and says what went wrong.
 *
 * Returns null rather than guessing when nothing matches. A confident wrong answer is
 * worse than no answer at all: somebody will follow it, and spend an hour on the
 * thing it named instead of the thing that broke.
 */
export function diagnose(lines: string[], errorSummary?: string | null): Diagnosis | null {
  // The recorded summary is part of what is searched: it often carries the sentence
  // that names the failure when the tail of the log is only stack frames.
  const text = haystack([...(errorSummary ? [errorSummary] : []), ...lines]);
  if (!text.trim()) return null;

  for (const rule of RULES) {
    if (!rule.match.every((pattern) => pattern.test(text))) continue;
    if (rule.unless?.some((pattern) => pattern.test(text))) continue;

    return {
      id: rule.id,
      summary: rule.summary,
      action: rule.action,
      fix: rule.fix ?? null,
      confident: true,
    };
  }

  return null;
}

/** The lines worth showing beside a diagnosis, or worth sending to a model. */
export function interestingLines(lines: string[], limit = 40): string[] {
  const noisy = /^\s*(at |\s+at |npm warn|warning:|info\b|debug\b)/i;
  const kept = lines.filter((line) => line.trim() && !noisy.test(line));
  return (kept.length ? kept : lines).slice(-limit);
}
