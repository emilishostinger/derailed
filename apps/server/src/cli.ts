import { schemas } from '@derailed/shared';
import { queueDeployment } from './build/pipeline.ts';
import { dev, login, tunnel } from './cli/laptop.ts';
import { uninstall } from './cli/uninstall.ts';
import { ensureDirs, paths, VERSION } from './config.ts';
import { initDb } from './db/index.ts';
import { listDomains } from './db/repo/domains.ts';
import { listProjects } from './db/repo/projects.ts';
import { listServices } from './db/repo/services.ts';
import { deleteSessionsForUser } from './db/repo/sessions.ts';
import { SETTINGS, setSetting } from './db/repo/settings.ts';
import {
  createUser,
  findUserByEmail,
  firstUser,
  listUsers,
  updatePassword,
} from './db/repo/users.ts';
import { listContainers } from './docker/containers.ts';
import { LABELS, labelFilter } from './docker/labels.ts';
import { streamContainerLogs } from './docker/logs.ts';
import { runMcpServer } from './mcp/server.ts';
import { serve } from './serve.ts';
import { runDoctor } from './system/doctor.ts';
import { selfUpdate } from './update.ts';
import { loadSecretKey } from './util/crypto.ts';

/**
 * The same checks the dashboard runs, on the command line.
 *
 * This exists for the case where the dashboard is the thing that is broken, which is
 * exactly when a health check is worth having and exactly when a web page cannot
 * deliver one. Exits non-zero when something needs attention, so it can be used in a
 * cron job or a monitoring check without parsing anything.
 */
async function doctor(): Promise<void> {
  ensureDirs();
  initDb();
  loadSecretKey();

  const report = await runDoctor();
  const mark = { ok: '  ok  ', warn: ' warn ', bad: ' FAIL ' };

  console.log(`\n  Derailed ${VERSION}\n`);
  for (const check of report.checks) {
    console.log(`  [${mark[check.status]}] ${check.title}`);
    console.log(`            ${check.detail}`);
    if (check.fix) console.log(`            Fix: ${check.fix.label} (in the dashboard)`);
  }
  console.log(`\n  ${report.summary}\n`);

  if (report.level === 'bad') process.exit(1);
}

/**
 * Finding an app by whatever somebody typed.
 *
 * A name, a slug, or `project/app` when two projects both have a `web`. Ambiguity is
 * reported rather than guessed at: deploying the wrong app because two were called
 * the same thing is not a mistake worth making on somebody's behalf.
 */
function findApp(needle: string): { id: string; label: string } | null {
  const wanted = needle.trim().toLowerCase();
  const matches: { id: string; label: string }[] = [];

  for (const project of listProjects()) {
    for (const service of listServices(project.id)) {
      const label = `${project.slug}/${service.slug}`;
      if (
        wanted === label ||
        wanted === service.slug.toLowerCase() ||
        wanted === service.name.toLowerCase()
      ) {
        matches.push({ id: service.id, label });
      }
    }
  }

  if (matches.length === 0) {
    console.error(`Nothing here is called "${needle}".`);
    console.error('Run `derailed status` to see what there is.');
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`More than one thing is called "${needle}":`);
    for (const match of matches) console.error(`  ${match.label}`);
    console.error('Use the longer name to say which.');
    process.exit(1);
  }
  return matches[0] ?? null;
}

/** What is on this machine, in one screen. */
async function status(): Promise<void> {
  ensureDirs();
  initDb();
  loadSecretKey();

  const projects = listProjects();
  if (!projects.length) {
    console.log('\n  Nothing set up yet. Open the dashboard to add something.\n');
    return;
  }

  console.log('');
  for (const project of projects) {
    console.log(`  ${project.name}`);
    for (const service of listServices(project.id)) {
      // Asked of Docker rather than taken from the dashboard's own idea of status.
      // That is kept in memory by the running server's monitor, and this is a
      // one-shot process with no monitor, so everything would read as failed.
      const containers = await listContainers(
        labelFilter({ [LABELS.service]: service.id }),
        true,
      ).catch(() => []);

      const mark = !containers.length
        ? '  - '
        : containers.some((container) => container.State === 'running')
          ? ' up '
          : 'off ';
      const address = listDomains(service.id)[0]?.hostname ?? '';
      console.log(`    [${mark}] ${service.slug.padEnd(20)} ${address}`);
    }
    console.log('');
  }
  console.log('  [  - ] means nothing has been built for it yet.\n');
}

async function deployFromCli(name?: string): Promise<void> {
  if (!name) {
    console.error('Usage: derailed deploy <app>');
    process.exit(1);
  }
  ensureDirs();
  initDb();
  loadSecretKey();

  const app = findApp(name)!;
  queueDeployment(app.id, 'manual');
  console.log(`Deploying ${app.label}. Watch it in the dashboard, or with derailed logs.`);
}

async function logsFromCli(name?: string): Promise<void> {
  if (!name) {
    console.error('Usage: derailed logs <app>');
    process.exit(1);
  }
  ensureDirs();
  initDb();
  loadSecretKey();

  const app = findApp(name)!;
  const containers = await listContainers(labelFilter({ [LABELS.service]: app.id })).catch(
    () => [],
  );
  const running = containers.find((container) => container.State === 'running') ?? containers[0];
  if (!running) {
    console.error(`${app.label} has no container yet. Deploy it first.`);
    process.exit(1);
  }

  for await (const line of streamContainerLogs(running.Id, { tail: 200 })) {
    console.log(line.line);
  }
}

/**
 * Non-interactive first-run setup, used by the installer so someone can be handed a
 * working HTTPS dashboard they are already able to sign in to, instead of a plain-HTTP
 * page asking them to invent a password.
 */
async function firstRunSetup(args: string[]): Promise<void> {
  const value = (flag: string): string | undefined => {
    const withEquals = args.find((arg) => arg.startsWith(`--${flag}=`));
    if (withEquals) return withEquals.split('=').slice(1).join('=');
    const index = args.indexOf(`--${flag}`);
    return index >= 0 ? args[index + 1] : undefined;
  };

  ensureDirs();
  initDb();
  loadSecretKey();

  const email = value('email');
  // The environment first: an argument is visible in `ps` to every user on the
  // machine for as long as the command runs, and this one is the admin password.
  const password = process.env.DERAILED_SETUP_PASSWORD || value('password');
  const domain = value('domain');

  if (firstUser()) {
    console.log('An account already exists. Nothing to do.');
  } else {
    if (!email || !password) {
      console.error(
        'Usage: derailed setup --email you@example.com --password ... [--domain panel.example.com]',
      );
      process.exit(1);
    }
    if (password.length < schemas.MIN_PASSWORD_LENGTH) {
      console.error(`The password must be at least ${schemas.MIN_PASSWORD_LENGTH} characters.`);
      process.exit(1);
    }
    createUser(email.trim().toLowerCase(), await Bun.password.hash(password));
    setSetting(SETTINGS.setupComplete, 'true');
    console.log(`Created the account for ${email}.`);
  }

  // Recorded now; the running server picks it up and asks for a certificate as soon
  // as it starts, so the dashboard is on HTTPS before anyone signs in.
  if (domain) {
    setSetting(SETTINGS.panelDomain, domain.trim().toLowerCase());
    console.log(`The dashboard will be served at https://${domain}.`);
  }
}

const HELP = `
  Derailed ${VERSION}, self-hosted deploys on your own server.

  Usage
    derailed serve                 Run the server (this is what systemd does)
    derailed mcp                   Run as an MCP server for coding agents
    derailed setup                 Create the admin account from the command line
                                   (pass the password in DERAILED_SETUP_PASSWORD, so
                                    it is not visible in ps)
    derailed update                Download and install the latest version
    derailed doctor                Check everything and say what is wrong
    derailed status                What is running, and whether it is up
    derailed deploy <app>          Deploy an app now
    derailed logs <app>            What an app last printed
    derailed reset-password [email]  Set a new password for an account
    derailed uninstall             Remove Derailed and everything it made,
                                   as if it was never here (asks first)

  From your laptop (after: derailed login <https://your-server>)
    derailed login <url>           Save a server address and API token
    derailed dev [--port N]        Share the current folder (or a local dev
                                   server on --port) on a temporary subdomain
    derailed tunnel <db> [--port N]  Reach a database at 127.0.0.1, no port opened
    derailed version               Print the version
    derailed help                  Show this message

  Environment
    DERAILED_DATA   Where state lives (default ${paths.dataDir})
    DERAILED_PORT   Dashboard port (default 8422)
    DERAILED_URL    Which server derailed mcp talks to
    DERAILED_TOKEN  An API token, created in Settings
`;

export async function runCli(argv: string[]): Promise<void> {
  const command = argv[0] ?? 'serve';

  switch (command) {
    case 'serve':
      await serve();
      return;

    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION);
      return;

    case 'update': {
      const updated = await selfUpdate();
      process.exit(updated ? 0 : 1);
      break;
    }

    case 'mcp':
      // Speaks JSON-RPC on stdout, so nothing else may be printed.
      await runMcpServer();
      return;

    case 'setup':
      await firstRunSetup(argv.slice(1));
      return;

    case 'doctor':
      await doctor();
      return;

    case 'status':
      await status();
      return;

    case 'deploy':
      await deployFromCli(argv[1]);
      return;

    case 'logs':
      await logsFromCli(argv[1]);
      return;

    case 'reset-password':
      await resetPassword(argv[1]);
      return;

    case 'uninstall':
      await uninstall(argv.slice(1));
      return;

    case 'login':
      await login(argv[1]);
      return;

    case 'dev':
      await dev(argv.slice(1));
      return;

    case 'tunnel':
      await tunnel(argv.slice(1));
      return;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

async function resetPassword(email?: string): Promise<void> {
  ensureDirs();
  initDb();

  // With more than one account here, guessing which one was meant is the wrong kind of
  // helpful: it would silently sign somebody else out of their own account and hand
  // whoever ran this a password to it.
  const everyone = listUsers();
  if (!email && everyone.length > 1) {
    console.error('There is more than one account on this server. Say which one:\n');
    for (const person of everyone) console.error(`  derailed reset-password ${person.email}`);
    process.exit(1);
  }

  const user = email ? findUserByEmail(email) : firstUser();
  if (!user) {
    console.error(
      email
        ? `No account with the email ${email}.`
        : 'There is no account yet, open the dashboard to create one.',
    );
    process.exit(1);
  }

  const password = prompt(`New password for ${user.email}:`);
  if (!password || password.length < schemas.MIN_PASSWORD_LENGTH) {
    console.error(
      `Password must be at least ${schemas.MIN_PASSWORD_LENGTH} characters. Nothing was changed.`,
    );
    process.exit(1);
  }
  const confirm = prompt('Type it once more:');
  if (password !== confirm) {
    console.error('Those did not match. Nothing was changed.');
    process.exit(1);
  }

  updatePassword(user.id, await Bun.password.hash(password));
  deleteSessionsForUser(user.id);
  console.log(
    `\nDone. ${user.email} can sign in with the new password (other sessions were ended).`,
  );
}
