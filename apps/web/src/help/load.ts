import type { HelpTopic } from './manifest.ts';
import { omitSections, renumberSections } from './outline.ts';

/**
 * The handbook files themselves, read from `docs/` at build time.
 *
 * Eager rather than lazy: the whole set is well under a hundred kilobytes of text,
 * and having it all in hand is what lets the search box actually search rather than
 * only matching titles.
 */
const FILES = import.meta.glob('../../../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const BY_SLUG = new Map<string, string>(
  Object.entries(FILES).map(([path, text]) => [path.replace(/^.*\/|\.md$/g, ''), text]),
);

/** Every slug the manifest could ask for, so a typo in it is caught by a test. */
export function availableSlugs(): string[] {
  return [...BY_SLUG.keys()].sort();
}

export function loadTopic(topic: HelpTopic): string {
  const raw = BY_SLUG.get(topic.slug);
  if (raw === undefined) return `# ${topic.title}\n\nThis page is missing.`;
  return renumberSections(omitSections(raw, topic.omit ?? []));
}
