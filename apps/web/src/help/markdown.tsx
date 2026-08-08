import type { ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { slugify } from './outline.ts';

/**
 * A deliberately small markdown renderer.
 *
 * It handles exactly what the handbook is written in: headings, paragraphs, lists,
 * fenced code, blockquotes, tables and the four inline forms. Anything it does not
 * recognise is shown as the plain text it is, which is the right failure: a page with
 * a stray asterisk on it still tells you how backups work.
 *
 * It builds React elements rather than a string of HTML. Nothing here is ever handed
 * to `dangerouslySetInnerHTML`, so a document cannot inject markup into the dashboard
 * however it is written, and none of the usual sanitiser questions arise.
 */

/** Inline: `code`, **strong**, *emphasis*, [links](to). */
export function inline(text: string, keyPrefix = ''): ReactNode[] {
  const out: ReactNode[] = [];
  // Code first and separately: backticks win over everything, so `**not bold**`
  // inside them stays literal, the way it does everywhere else markdown is read.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let match: RegExpExecArray | null = pattern.exec(text);
  let n = 0;

  while (match) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}i${n++}`;

    if (token.startsWith('`')) {
      out.push(
        <code key={key} className="rounded-[4px] bg-sunken px-1 py-0.5 text-[0.9em] text-ink">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      out.push(
        <strong key={key} className="font-semibold text-ink">
          {token.slice(2, -2)}
        </strong>,
      );
    } else if (token.startsWith('*')) {
      out.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const split = token.indexOf('](');
      const label = token.slice(1, split);
      const href = token.slice(split + 2, -1);
      out.push(
        <Link key={key} href={href}>
          {label}
        </Link>,
      );
    }
    last = match.index + token.length;
    match = pattern.exec(text);
  }

  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Links between handbook pages are written as `storage.md` so the same files read
 * correctly on GitHub. In here they have to become dashboard routes. Anything that
 * leaves the dashboard opens in a new tab and carries `noreferrer`, since the
 * handbook links out to registrars and to GitHub.
 */
function Link({ href, children }: { href: string; children: ReactNode }) {
  const doc = /^([a-z0-9-]+)\.md(#.*)?$/.exec(href);
  if (doc) {
    return (
      <RouterLink to={`/help/${doc[1]}${doc[2] ?? ''}`} className="text-accent hover:underline">
        {children}
      </RouterLink>
    );
  }
  if (href.startsWith('/')) {
    return (
      <RouterLink to={href} className="text-accent hover:underline">
        {children}
      </RouterLink>
    );
  }
  // Anything else leaves the dashboard, but only over http(s). The handbook is bundled
  // from the repo at build time, so a `javascript:` href cannot reach here today; the
  // guard is so that stays true if this renderer is ever pointed at text from anywhere
  // else. An href we will not vouch for renders as plain words, not a link.
  if (!/^https?:\/\//i.test(href)) return <>{children}</>;
  // `noopener` matters even on links we trust, since the handbook points at registrars
  // and at GitHub.
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="text-accent hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * The `| --- | --- |` line under a table's first row.
 *
 * This is what makes a table a table. Testing for it loosely (a line starting with a
 * pipe) matched the table's own body rows and the first version of this rendered
 * every table as literal pipes on the page.
 */
export function isSeparator(line: string | undefined): boolean {
  return line !== undefined && /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

export function render(markdown: string): ReactNode[] {
  const lines = markdown.split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  const next = () => `b${key++}`;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code. Unterminated fences run to the end rather than throwing.
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      out.push(
        <pre
          key={next()}
          className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-sunken p-3.5 text-[12.5px] leading-relaxed text-ink-muted"
        >
          <code>{body.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]!.length;
      const text = heading[2]!;
      const id = slugify(text);
      i++;
      // The document's own title is rendered by the page, not here.
      if (level === 1) continue;
      const size =
        level === 2
          ? 'mt-9 text-[17px] font-semibold'
          : level === 3
            ? 'mt-7 text-[14px] font-semibold'
            : 'mt-5 text-[13px] font-semibold';
      out.push(
        <h2 key={next()} id={id} className={`scroll-mt-6 text-ink ${size}`}>
          {inline(text, id)}
        </h2>,
      );
      continue;
    }

    if (line.startsWith('> ')) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>'))
        body.push(lines[i++]!.replace(/^>\s?/, ''));
      out.push(
        <blockquote
          key={next()}
          className="mt-4 border-l-2 border-line-strong pl-3.5 text-[13px] text-ink-muted italic"
        >
          {inline(body.join(' '), next())}
        </blockquote>,
      );
      continue;
    }

    // A table needs its separator row to be a table at all, otherwise a line that
    // merely starts with a pipe would swallow the paragraph after it.
    if (line.trim().startsWith('|') && isSeparator(lines[i + 1])) {
      const cells = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((cell) => cell.trim());
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.trim().startsWith('|')) rows.push(cells(lines[i++]!));
      // Several of these tables are written headerless, as `| | |`. Drawing an empty
      // header row above them puts a rule and a gap where nothing is being said.
      const titled = head.some((cell) => cell.length > 0);
      out.push(
        <div key={next()} className="mt-4 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            {titled && (
              <thead>
                <tr>
                  {head.map((cell) => (
                    <th
                      key={cell}
                      className="border-b border-line py-2 pr-4 text-left font-semibold text-ink"
                    >
                      {inline(cell, cell)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity of their own.
                <tr key={r}>
                  {row.map((cell, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: same.
                    <td key={c} className="border-b border-line py-2 pr-4 align-top text-ink-muted">
                      {inline(cell, `${r}-${c}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    const bullet = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /\d/.test(bullet[2]!);
      const items: ReactNode[] = [];
      let n = 0;
      while (i < lines.length) {
        const entry = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(lines[i]!);
        if (!entry) {
          // A wrapped continuation line belongs to the item above it.
          if (items.length && lines[i]!.startsWith('  ') && lines[i]!.trim()) {
            i++;
            continue;
          }
          break;
        }
        if (/\d/.test(entry[2]!) !== ordered) break;
        // Gather the item plus any lines wrapped underneath it.
        const parts = [entry[3]!];
        i++;
        while (
          i < lines.length &&
          /^\s{2,}\S/.test(lines[i]!) &&
          !/^(\s*)([-*]|\d+\.)\s/.test(lines[i]!)
        ) {
          parts.push(lines[i++]!.trim());
        }
        items.push(
          <li key={`li${n}`} className="pl-1">
            {inline(parts.join(' '), `l${n}`)}
          </li>,
        );
        n++;
      }
      const List = ordered ? 'ol' : 'ul';
      out.push(
        <List
          key={next()}
          className={`mt-3 space-y-1.5 pl-5 text-[13.5px] leading-relaxed text-ink-muted ${
            ordered ? 'list-decimal' : 'list-disc'
          }`}
        >
          {items}
        </List>,
      );
      continue;
    }

    // Anything else is a paragraph, running until a blank line or a block starts.
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]!.trim() &&
      !/^(#{1,4}\s|```|>\s|\s*([-*]|\d+\.)\s)/.test(lines[i]!) &&
      !(lines[i]!.trim().startsWith('|') && isSeparator(lines[i + 1]))
    ) {
      paragraph.push(lines[i++]!);
    }
    // A line that matched nothing and started no block: take it literally and move on,
    // rather than looping forever on it.
    if (!paragraph.length) {
      paragraph.push(lines[i++]!);
    }
    const id = next();
    out.push(
      <p key={id} className="mt-3.5 text-[13.5px] leading-relaxed text-ink-muted">
        {inline(paragraph.join(' '), id)}
      </p>,
    );
  }

  return out;
}
