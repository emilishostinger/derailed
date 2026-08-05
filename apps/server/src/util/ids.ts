import { customAlphabet } from 'nanoid';

/** Lowercase + digits keeps ids safe inside docker object names and hostnames. */
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';

export const newId = customAlphabet(alphabet, 16);
export const shortId = customAlphabet(alphabet, 8);

/**
 * Turns a human name into a DNS/container-safe slug.
 * "My Web App!" → "my-web-app"
 */
export function slugify(input: string, fallback = 'service'): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return slug || fallback;
}

/** Appends -2, -3, … until the slug is free. */
export function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${shortId()}`;
}
