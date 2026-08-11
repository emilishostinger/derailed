import { useSession } from '../stores/session.ts';

/**
 * The clickable address for a domain row.
 *
 * Secured domains are plain https. HTTP-only ones carry the proxy's real port
 * when it isn't 80, which is the difference between a dev link that loads and
 * one that points at a router's closed port 80. On a real server the port is
 * 80 and the suffix never appears.
 */
export function appUrl(
  domain: { hostname: string; tlsStatus: string },
  proxyHttpPort?: number,
): string {
  if (domain.tlsStatus === 'active') return `https://${domain.hostname}`;
  const port = proxyHttpPort && proxyHttpPort !== 80 ? `:${proxyHttpPort}` : '';
  return `http://${domain.hostname}${port}`;
}

/** The same, reading the proxy port from the session for components. */
export function useAppUrl(): (domain: { hostname: string; tlsStatus: string }) => string {
  const proxyHttpPort = useSession((s) => s.system?.proxyHttpPort);
  return (domain) => appUrl(domain, proxyHttpPort);
}
