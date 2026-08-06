/**
 * The parts of reading a handbook page that are only string work.
 *
 * Kept apart from the renderer so they can be tested without a React tree, and
 * because "which sections does this page have" is a question the page furniture asks
 * as often as the renderer does.
 */

export interface Heading {
  level: number;
  text: string;
  id: string;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Drops a section and everything under it, by heading text.
 *
 * The handbook is written for someone who has not installed Derailed yet, and the
 * reader here plainly has. "Install it, then open the dashboard" is noise at best and
 * confusing at worst when read from inside the dashboard, so those sections are left
 * out rather than reworded into something neither audience wants.
 *
 * A section ends at the next heading of the same level or shallower, which is what
 * makes dropping "## Building" take its `###` subsections with it and stop there.
 */
export function omitSections(markdown: string, headings: string[]): string {
  if (!headings.length) return markdown;
  const wanted = new Set(headings.map((heading) => slugify(heading)));
  const kept: string[] = [];
  let skippingAt = 0;
  let inFence = false;

  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) inFence = !inFence;
    const heading = inFence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      if (skippingAt && level <= skippingAt) skippingAt = 0;
      if (!skippingAt && wanted.has(slugify(heading[2]!))) {
        skippingAt = level;
        continue;
      }
    }
    if (!skippingAt) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Puts a numbered walkthrough back in order after a step has been dropped.
 *
 * Quickstart is written as "1. Install", "2. Put the dashboard behind a domain", and
 * the first step is not one the reader has left to do. Removing it left the page
 * opening at step 2, which reads as though something is missing rather than as
 * though it was never needed. Numbering is counted per level, so a numbered
 * subsection does not disturb the section above it.
 */
export function renumberSections(markdown: string): string {
  const counters = new Map<number, number>();
  let inFence = false;

  return markdown
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const heading = /^(#{2,6})\s+(\d+)\.\s+(.*)$/.exec(line);
      if (!heading) return line;
      const level = heading[1]!.length;
      const at = (counters.get(level) ?? 0) + 1;
      counters.set(level, at);
      // A new run of numbering underneath this one starts over.
      for (const deeper of [...counters.keys()]) if (deeper > level) counters.delete(deeper);
      return `${heading[1]} ${at}. ${heading[3]}`;
    })
    .join('\n');
}

/** Every heading in the document, for the contents rail beside it. */
export function outline(markdown: string): Heading[] {
  const found: Heading[] = [];
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (line.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (match) found.push({ level: match[1]!.length, text: match[2]!, id: slugify(match[2]!) });
  }
  return found;
}

/** The first heading, which is the document's own title rather than the short one. */
export function documentTitle(markdown: string): string | null {
  return /^#\s+(.*)$/m.exec(markdown)?.[1] ?? null;
}
