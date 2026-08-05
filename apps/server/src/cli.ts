import { schemas } from '@derailed/shared';
import { ensureDirs, paths, VERSION } from './config.ts';
import { initDb } from './db/index.ts';
import { deleteSessionsForUser } from './db/repo/sessions.ts';
import { SETTINGS, setSetting } from './db/repo/settings.ts';
import { createUser, findUserByEmail, firstUser, updatePassword } from './db/repo/users.ts';
import { runMcpServer } from './mcp/server.ts';
import { serve } from './serve.ts';
import { selfUpdate } from './update.ts';
import { loadSecretKey } from './util/crypto.ts';

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
    derailed reset-password [email]  Set a new password for the admin account
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

    case 'reset-password':
      await resetPassword(argv[1]);
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
