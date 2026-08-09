import type { HelpTopic } from './manifest.ts';
import { omitSections, renumberSections } from './outline.ts';

/**
 * The handbook files themselves, read from `docs/` at build time.
 *
 * Eager rather than lazy: the whole set is well under a hundred kilobytes of text,
 * and having it all in hand is what lets the search box actually search rather than
 * only matching titles.
 */
// `import.meta.glob` is Vite's, and it is how the handbook markdown is read in at build
// time. Vite replaces the literal call below with the file map, so the call has to stay
// written out verbatim for that to happen. Outside Vite (a `bun test` process reaching
// this module through a component's imports) the function does not exist and the call
// throws, so it is wrapped: there the handbook is simply empty, which is fine, because
// nothing under test reads one.
let FILES: Record<string, string> = {};
try {
  FILES = import.meta.glob('../../../../docs/*.md', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>;
} catch {
  // Not running under Vite; the handbook stays empty.
}

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
