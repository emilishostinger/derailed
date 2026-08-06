import type { Service } from '@derailed/shared';
import { Box, Container, Database, Globe } from 'lucide-react';
import { BRANDS, type BrandMark } from './brands.ts';
import { cx } from './ui.tsx';

/**
 * A small tile for whatever a service turned out to be.
 *
 * The marks are the real ones, embedded rather than fetched, so a server with no way
 * out to the internet still shows them and nothing is loaded from a third party. Each
 * sits on its brand's own colour, which is enough for the eye to find "the Postgres
 * one" without reading a word.
 */

/**
 * What a detected framework, image or engine is called, mapped to its mark.
 *
 * Keyed by a lowercase fragment that appears in the name, the image or the framework.
 * Longest key wins, so "next.js" beats "node" for a Next.js app and "mariadb" beats
 * "maria".
 */
const ALIASES: Record<string, string> = {
  // agents
  'claude code': 'claude',
  claude: 'claude',
  cursor: 'cursor',
  codex: 'openai',
  openclaw: 'openclaw',
  'hermes agent': 'hermesagent',
  hermes: 'hermesagent',

  // databases
  postgres: 'postgresql',
  postgresql: 'postgresql',
  mysql: 'mysql',
  mariadb: 'mariadb',
  redis: 'redis',
  mongo: 'mongodb',

  // languages and runtimes
  'node.js': 'nodedotjs',
  node: 'nodedotjs',
  deno: 'deno',
  bun: 'bun',
  python: 'python',
  ruby: 'ruby',
  php: 'php',
  go: 'go',
  rust: 'rust',
  java: 'openjdk',
  elixir: 'elixir',

  // frameworks
  'next.js': 'nextdotjs',
  nuxt: 'nuxt',
  remix: 'remix',
  sveltekit: 'svelte',
  svelte: 'svelte',
  astro: 'astro',
  nest: 'nestjs',
  express: 'express',
  vite: 'vite',
  react: 'react',
  django: 'django',
  flask: 'flask',
  rails: 'rubyonrails',
  laravel: 'laravel',

  // what a plain website is built from
  'static site': 'html5',
  html: 'html5',
  'php site': 'php',

  // the things Derailed runs for you
  nginx: 'nginx',
  apache: 'apache',
  docker: 'docker',

  // catalogue apps, matched on their names
  wordpress: 'wordpress',
  ghost: 'ghost',
  n8n: 'n8n',
  'uptime kuma': 'uptimekuma',
  umami: 'umami',
  vaultwarden: 'vaultwarden',
  nextcloud: 'nextcloud',
  gitea: 'gitea',
  forgejo: 'forgejo',
  jellyfin: 'jellyfin',
  grafana: 'grafana',
  metabase: 'metabase',
  freshrss: 'freshrss',
  vikunja: 'vikunja',
  mealie: 'mealie',
  'actual budget': 'actualbudget',
  actual: 'actualbudget',
  listmonk: 'listmonk',
  matomo: 'matomo',
  syncthing: 'syncthing',
  directus: 'directus',
  baserow: 'baserow',
  'wiki.js': 'wikidotjs',
  excalidraw: 'excalidraw',
  'home assistant': 'homeassistant',
  immich: 'immich',
  plausible: 'plausibleanalytics',
  paperless: 'paperlessngx',
};

/** Longest key first, so the more specific name wins. */
const KEYS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

export function brandFor(service: Service): BrandMark | null {
  const haystack = (
    service.kind === 'database'
      ? (service.dbEngine ?? '')
      : // The name is included because an app built from a repository has neither an
        // image name nor, necessarily, a recognisable framework.
        `${service.framework ?? ''} ${service.image ?? ''} ${service.name}`
  ).toLowerCase();
  if (!haystack.trim()) return null;

  const key = KEYS.find((candidate) => haystack.includes(candidate));
  return key ? (BRANDS[ALIASES[key]!] ?? null) : null;
}

/** Look one up directly, for the catalogue where there is no service yet. */
export function brandByName(name: string): BrandMark | null {
  const lower = name.toLowerCase();
  const key = KEYS.find((candidate) => lower.includes(candidate));
  return key ? (BRANDS[ALIASES[key]!] ?? null) : null;
}

/**
 * White or near-black, whichever can be read on the brand's colour.
 *
 * Half these marks are drawn for a white page and half for a dark one, and a few
 * brands are almost black or almost white themselves, so picking by hand would be
 * forty judgement calls that go stale.
 */
export function readableOn(hex: string): string {
  const value = hex.replace('#', '');
  const rgb = [0, 2, 4].map((at) => Number.parseInt(value.slice(at, at + 2), 16) / 255);
  const linear = rgb.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  const luminance = 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  return luminance > 0.45 ? '#12141a' : '#ffffff';
}

export function BrandTile({
  brand,
  className = 'h-6 w-6',
}: {
  brand: BrandMark;
  className?: string;
}) {
  return (
    <span
      title={brand.title}
      className={cx('flex shrink-0 items-center justify-center rounded-[6px]', className)}
      style={{ backgroundColor: brand.hex }}
    >
      {brand.art ? (
        // A picture, not a silhouette: framed rather than recoloured, and given a
        // little more of the tile because it has its own internal margins.
        <svg
          viewBox={brand.art.viewBox}
          className="h-[78%] w-[78%]"
          aria-hidden="true"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: authored in this file, never from input.
          dangerouslySetInnerHTML={{ __html: brand.art.svg }}
        />
      ) : (
        <svg
          viewBox="0 0 24 24"
          className="h-[62%] w-[62%]"
          fill={readableOn(brand.hex)}
          fillRule={brand.evenOdd ? 'evenodd' : undefined}
          aria-hidden="true"
        >
          <title>{brand.title}</title>
          <path d={brand.path} />
        </svg>
      )}
    </span>
  );
}

export function TechIcon({
  service,
  className = 'h-6 w-6 text-[11px]',
}: {
  service: Service;
  className?: string;
}) {
  const brand = brandFor(service);
  if (brand)
    return <BrandTile brand={brand} className={className.replace(/text-\[[^\]]+\]/, '')} />;

  // Nothing recognised, so say what kind of thing it is rather than guessing.
  const Fallback =
    service.kind === 'database' ? Database : service.source === 'image' ? Container : Globe;
  return (
    <span
      title={service.kind === 'database' ? 'Database' : 'App'}
      className={cx(
        'flex shrink-0 items-center justify-center rounded-[6px] border border-line bg-surface-2 text-ink-faint',
        className,
      )}
    >
      <Fallback className="h-3.5 w-3.5" />
    </span>
  );
}

export { Box };
