import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELP, TOPICS } from '../../web/src/help/manifest.ts';
import {
  documentTitle,
  omitSections,
  outline,
  renumberSections,
  slugify,
} from '../../web/src/help/outline.ts';

/**
 * The handbook the dashboard shows is the same `docs/` the repository ships, so the
 * two cannot drift. What can drift is the manifest: a renamed file, or a heading
 * reworded out from under an `omit` entry, both of which fail quietly. A quiet
 * failure here means a page that is empty, or one that still tells the reader to go
 * and install Derailed. These check both.
 */
const DOCS = join(import.meta.dir, '../../../docs');
const read = (slug: string) => readFileSync(join(DOCS, `${slug}.md`), 'utf8');

describe('the handbook manifest', () => {
  test('every topic it lists is a document that exists', () => {
    const available = new Set(
      readdirSync(DOCS)
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.replace(/\.md$/, '')),
    );
    for (const topic of TOPICS) {
      expect({ slug: topic.slug, exists: available.has(topic.slug) }).toEqual({
        slug: topic.slug,
        exists: true,
      });
    }
  });

  test('no topic appears twice', () => {
    const slugs = TOPICS.map((topic) => topic.slug);
    expect(slugs.length).toBe(new Set(slugs).size);
  });

  test('every topic has a title and a one-line blurb', () => {
    for (const topic of TOPICS) {
      expect(topic.title.length).toBeGreaterThan(2);
      expect(topic.blurb.length).toBeGreaterThan(10);
      expect(topic.blurb).not.toInclude('\n');
    }
  });

  test('every section it drops is a heading that is really there', () => {
    for (const topic of TOPICS) {
      if (!topic.omit?.length) continue;
      const headings = new Set(
        read(topic.slug)
          .split('\n')
          .filter((line) => /^#{1,6}\s/.test(line))
          .map((line) => slugify(line.replace(/^#+\s+/, ''))),
      );
      for (const section of topic.omit) {
        expect({ topic: topic.slug, section, present: headings.has(slugify(section)) }).toEqual({
          topic: topic.slug,
          section,
          present: true,
        });
      }
    }
  });

  test('the pages about getting Derailed onto a server are left out', () => {
    // The reader is looking at a running dashboard. These are for somebody else.
    const slugs = TOPICS.map((topic) => topic.slug);
    for (const excluded of ['install', 'contributing', 'release-checklist', 'README']) {
      expect(slugs).not.toContain(excluded);
    }
  });

  test('no page still tells the reader to install anything', () => {
    for (const topic of TOPICS) {
      const body = omitSections(read(topic.slug), topic.omit ?? []);
      // The one command that only makes sense before you have Derailed.
      expect({ topic: topic.slug, installs: body.includes('install.sh | sh') }).toEqual({
        topic: topic.slug,
        installs: false,
      });
    }
  });

  test('every group has topics and every topic is in exactly one group', () => {
    const seen = new Set<string>();
    for (const group of HELP) {
      expect(group.topics.length).toBeGreaterThan(0);
      for (const topic of group.topics) {
        expect(seen.has(topic.slug)).toBe(false);
        seen.add(topic.slug);
      }
    }
    expect(seen.size).toBe(TOPICS.length);
  });
});

describe('dropping a section', () => {
  const doc = [
    '# Title',
    'Opening line.',
    '',
    '## Keep me',
    'Kept.',
    '',
    '## Building',
    'Contributor detail.',
    '',
    '### Under building',
    'Also contributor detail.',
    '',
    '## Keep me too',
    'Also kept.',
  ].join('\n');

  test('takes the heading and its body', () => {
    const out = omitSections(doc, ['Building']);
    expect(out).not.toInclude('Contributor detail.');
    expect(out).toInclude('Kept.');
  });

  test('takes its subsections with it', () => {
    expect(omitSections(doc, ['Building'])).not.toInclude('Also contributor detail.');
  });

  test('stops at the next heading of the same level', () => {
    expect(omitSections(doc, ['Building'])).toInclude('Also kept.');
  });

  test('matches on the words, not the exact punctuation', () => {
    const out = omitSections('# T\n\n## 1. Install\ndropped\n\n## Next\nkept', ['1. Install']);
    expect(out).not.toInclude('dropped');
    expect(out).toInclude('kept');
  });

  test('leaves a document alone when asked for nothing', () => {
    expect(omitSections(doc, [])).toBe(doc);
  });

  test('ignores a heading that only looks like one inside a code fence', () => {
    const fenced = '# T\n\n```\n## Building\n```\n\nAfter.';
    expect(omitSections(fenced, ['Building'])).toInclude('After.');
    expect(omitSections(fenced, ['Building'])).toInclude('## Building');
  });
});

describe('renumbering a walkthrough', () => {
  test('closes the gap left by a dropped step', () => {
    const doc = '# T\n\n## 2. Second\n\n## 3. Third\n';
    expect(renumberSections(doc)).toInclude('## 1. Second');
    expect(renumberSections(doc)).toInclude('## 2. Third');
  });

  test('leaves headings that are not numbered alone', () => {
    expect(renumberSections('## Plain\n\n## 5. Numbered')).toInclude('## Plain');
  });

  test('counts each level on its own', () => {
    const out = renumberSections('## 4. Section\n\n### 9. Sub\n\n## 7. Next');
    expect(out).toInclude('## 1. Section');
    expect(out).toInclude('### 1. Sub');
    expect(out).toInclude('## 2. Next');
  });

  test('does not touch numbering inside a code fence', () => {
    expect(renumberSections('```\n## 9. Not a heading\n```')).toInclude('## 9. Not a heading');
  });

  test('quickstart starts at one after its install step is dropped', () => {
    const body = renumberSections(omitSections(read('quickstart'), ['1. Install']));
    const numbered = body.split('\n').filter((line) => /^##\s+\d+\./.test(line));
    expect(numbered.length).toBeGreaterThan(2);
    expect(numbered[0]).toMatch(/^##\s+1\./);
  });
});

describe('the contents rail', () => {
  test('lists the second and third level headings', () => {
    const found = outline('# One\n## Two\n### Three\n#### Four');
    expect(found.map((h) => h.text)).toEqual(['Two', 'Three']);
    expect(found.map((h) => h.level)).toEqual([2, 3]);
  });

  test('skips headings inside code fences', () => {
    expect(outline('## Real\n\n```sh\n## Not a heading\n```\n')).toHaveLength(1);
  });

  test('gives every heading an anchor that is safe in a selector', () => {
    for (const topic of TOPICS) {
      for (const heading of outline(read(topic.slug))) {
        expect(heading.id).toMatch(/^[a-z0-9-]*$/);
      }
    }
  });

  test('every real document has a title and some sections', () => {
    for (const topic of TOPICS) {
      const body = omitSections(read(topic.slug), topic.omit ?? []);
      expect(documentTitle(body)).toBeTruthy();
      expect(outline(body).length).toBeGreaterThan(0);
      // Dropping sections must not leave a stub behind.
      expect(body.trim().split('\n').length).toBeGreaterThan(10);
    }
  });
});

describe('slugs', () => {
  test('lowercase, hyphenated, no leading or trailing hyphen', () => {
    expect(slugify('What is in one')).toBe('what-is-in-one');
    expect(slugify('"Derailed can\'t reach Docker"')).toBe('derailed-can-t-reach-docker');
    expect(slugify('1. Install')).toBe('1-install');
    expect(slugify('  spaced  ')).toBe('spaced');
  });
});
