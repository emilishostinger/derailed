import { existsSync } from 'node:fs';

/**
 * The cupboard computer, reachable.
 *
 * Derailed has always assumed a VPS with a public address. The most-copied
 * feature in home self-hosting says what people actually want: *reachable from
 * anywhere, no port forwarding, no DNS knowledge*. The answer here rides
 * Tailscale rather than running any relay of our own, deliberately: the moment
 * uptime depends on our infrastructure, "it's yours" becomes a lie. Integration,
 * never dependency.
 *
 * - **Private by default**: `tailscale up` puts the box on the person's own
 *   tailnet. The dashboard and every app are then reachable from their devices
 *   anywhere, and the open internet is never involved.
 * - **Public when wanted**: Funnel takes one app the rest of the way, real HTTPS
 *   on a home box behind CGNAT, no ports opened, no relay run by us.
 *
 * Everything here follows the pattern `system/updates.ts` set: detect the
 * binary, refuse to guess when it is missing, and shell out with arguments
 * rather than shell strings.
 */

const BINARY_PATHS = [
  '/usr/bin/tailscale',
  '/usr/sbin/tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
];

export function tailscaleBinary(): string | null {
  return BINARY_PATHS.find((path) => existsSync(path)) ?? null;
}

async function run(
  args: string[],
  timeoutMs = 30_000,
): Promise<{ code: number; out: string; err: string }> {
  const binary = tailscaleBinary();
  if (!binary) return { code: 127, out: '', err: 'tailscale is not installed' };
  try {
    const proc = Bun.spawn([binary, ...args], { stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    return { code, out, err };
  } catch (error) {
    return { code: 1, out: '', err: error instanceof Error ? error.message : String(error) };
  }
}

export interface TailscaleState {
  installed: boolean;
  /** Signed in and connected to a tailnet. */
  connected: boolean;
  /** The box's own name on the tailnet, `box.tail1234.ts.net`, no trailing dot. */
  dnsName: string | null;
  /** The box's tailnet address, `100.x.y.z`. */
  ip: string | null;
  tailnet: string | null;
  /** Whether the funnel to this machine is available on this tailnet. */
  funnelOn: boolean;
}

/** The parts of `tailscale status --json` this feature reads. */
interface StatusJson {
  BackendState?: string;
  Self?: {
    DNSName?: string;
    TailscaleIPs?: string[];
  };
  CurrentTailnet?: { Name?: string };
}

/** Pure, so the shapes can be tested without a tailnet in the building. */
export function parseStatus(text: string): Omit<TailscaleState, 'installed' | 'funnelOn'> {
  let parsed: StatusJson;
  try {
    parsed = JSON.parse(text) as StatusJson;
  } catch {
    return { connected: false, dnsName: null, ip: null, tailnet: null };
  }
  const connected = parsed.BackendState === 'Running';
  const dnsName = parsed.Self?.DNSName?.replace(/\.$/, '') ?? null;
  const ip = parsed.Self?.TailscaleIPs?.find((entry) => entry.includes('.')) ?? null;
  return {
    connected,
    dnsName: connected ? dnsName : null,
    ip: connected ? ip : null,
    tailnet: connected ? (parsed.CurrentTailnet?.Name ?? null) : null,
  };
}

export async function tailscaleState(): Promise<TailscaleState> {
  if (!tailscaleBinary()) {
    return {
      installed: false,
      connected: false,
      dnsName: null,
      ip: null,
      tailnet: null,
      funnelOn: false,
    };
  }
  const status = await run(['status', '--json']);
  const parsed = parseStatus(status.out);
  const funnel = parsed.connected ? await run(['funnel', 'status']) : null;
  return {
    installed: true,
    ...parsed,
    funnelOn: !!funnel && funnel.code === 0 && /https:\/\//.test(funnel.out),
  };
}

/**
 * Joins the person's tailnet.
 *
 * With an auth key, silently. Without one, `tailscale up` prints a sign-in link,
 * which is surfaced rather than swallowed: the person opens it on any device
 * that is already theirs, and the box appears in their tailnet.
 */
export async function tailscaleUp(
  authKey?: string,
): Promise<{ ok: boolean; loginUrl?: string; message?: string }> {
  if (!tailscaleBinary()) {
    return { ok: false, message: 'Tailscale is not installed on this server yet.' };
  }
  if (authKey) {
    if (!/^tskey-[A-Za-z0-9-]+$/.test(authKey)) {
      return { ok: false, message: 'That does not look like a Tailscale auth key.' };
    }
    const result = await run(['up', `--auth-key=${authKey}`], 60_000);
    return result.code === 0
      ? { ok: true }
      : { ok: false, message: result.err.split('\n')[0] || 'Tailscale could not connect.' };
  }

  // No key: ask for the login URL. `tailscale up` blocks until somebody visits
  // it, so it runs with a short timeout and the URL is fished from its output.
  const result = await run(['up', '--timeout=5s'], 15_000);
  const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(`${result.out}\n${result.err}`)?.[0];
  if (result.code === 0) return { ok: true };
  if (url) return { ok: false, loginUrl: url };
  return { ok: false, message: result.err.split('\n')[0] || 'Tailscale could not start.' };
}

/**
 * Shares the proxy's plain-HTTP listener through Funnel.
 *
 * Funnel terminates TLS with a real certificate for the box's ts.net name and
 * hands the traffic to Caddy, which routes by hostname like it does everything
 * else. So "make this app public" is one domain row pointing the ts.net name at
 * the app, plus this switch.
 */
export async function setFunnel(
  on: boolean,
  caddyHttpPort: number,
): Promise<{ ok: boolean; message?: string }> {
  const result = on
    ? await run(['funnel', '--bg', `--https=443`, `http://127.0.0.1:${caddyHttpPort}`], 60_000)
    : await run(['funnel', '--https=443', 'off'], 60_000);
  if (result.code === 0) return { ok: true };
  const line = (result.err || result.out).split('\n').find(Boolean) ?? '';
  return { ok: false, message: line || 'Tailscale refused.' };
}

/** The official installer, the same way install.sh brings Docker. Linux only. */
export async function installTailscale(): Promise<{ ok: boolean; message: string }> {
  if (process.platform !== 'linux') {
    return { ok: false, message: 'Automatic install only works on Linux servers.' };
  }
  if (tailscaleBinary()) return { ok: true, message: 'Tailscale is already installed.' };
  try {
    const proc = Bun.spawn(['sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), 5 * 60_000);
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    if (code === 0 && tailscaleBinary()) return { ok: true, message: 'Installed.' };
    return {
      ok: false,
      message: err.split('\n').filter(Boolean).slice(-1)[0] ?? 'The installer did not finish.',
    };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** Whether a hostname is a tailnet name, which no public DNS check will ever pass. */
export function isTailnetHostname(hostname: string): boolean {
  return hostname.endsWith('.ts.net');
}
