import { BookOpen, Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cx } from '../components/ui.tsx';
import { loadTopic } from '../help/load.ts';
import { findTopic, HELP, TOPICS } from '../help/manifest.ts';
import { render } from '../help/markdown.tsx';
import { documentTitle, outline } from '../help/outline.ts';
import { PageHeader } from './Layout.tsx';

/**
 * The handbook, in the dashboard.
 *
 * Everything explained here was already written down, and was already sitting in a
 * repository that most people running Derailed will never open. Answering "what
 * happens to my data on a deploy" should not require leaving the thing you are
 * asking about.
 */
export function Help() {
  const { slug } = useParams();
  const topic = findTopic(slug);

  if (!slug) return <HelpIndex />;
  if (!topic) return <HelpIndex missing={slug} />;
  return <HelpArticle key={topic.slug} />;
}

function HelpIndex({ missing }: { missing?: string }) {
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();

  // Titles and blurbs match first, but the body is searched too, because the word
  // someone remembers is usually in the middle of a paragraph.
  const matches = useMemo(() => {
    if (!search) return null;
    return TOPICS.map((topic) => {
      const heading = `${topic.title} ${topic.blurb}`.toLowerCase();
      const body = loadTopic(topic).toLowerCase();
      const where = heading.indexOf(search);
      if (where >= 0) return { topic, rank: 0, excerpt: topic.blurb };
      const at = body.indexOf(search);
      if (at < 0) return null;
      const from = Math.max(0, at - 60);
      return {
        topic,
        rank: 1,
        excerpt: `${from > 0 ? '…' : ''}${body
          .slice(from, at + 100)
          .replace(/\s+/g, ' ')
          .trim()}…`,
      };
    })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.rank - b.rank);
  }, [search]);

  return (
    <>
      <PageHeader title="Handbook" subtitle={`${TOPICS.length} topics`} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-5 py-6">
          {missing && (
            <p className="mb-5 rounded-[var(--radius-card)] border border-line bg-sunken px-3.5 py-2.5 text-[13px] text-ink-muted">
              There is no page called <span className="text-ink">{missing}</span>. Everything there
              is, is below.
            </p>
          )}

          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3 h-3.5 w-3.5 -translate-y-1/2 text-ink-faint" />
            <input
              className="input pl-8.5"
              placeholder="Search the handbook"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear"
                className="absolute top-1/2 right-2.5 -translate-y-1/2 text-ink-faint hover:text-ink"
                onClick={() => setQuery('')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {matches ? (
            <div className="mt-5">
              {matches.length === 0 ? (
                <p className="py-10 text-center text-[13px] text-ink-faint">
                  Nothing in the handbook mentions that.
                </p>
              ) : (
                <ul className="space-y-2">
                  {matches.map(({ topic, excerpt }) => (
                    <li key={topic.slug}>
                      <Link
                        to={`/help/${topic.slug}`}
                        className="card block p-3.5 transition-colors hover:border-line-strong hover:bg-surface-2/40"
                      >
                        <p className="text-[13px] font-semibold text-ink">{topic.title}</p>
                        <p className="mt-1 line-clamp-2 text-[12.5px] text-ink-muted">{excerpt}</p>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            HELP.map((group) => (
              <section key={group.title} className="mt-7">
                <h2 className="eyebrow text-ink-faint">{group.title}</h2>
                <ul className="mt-2.5 grid gap-2 sm:grid-cols-2">
                  {group.topics.map((topic) => (
                    <li key={topic.slug}>
                      <Link
                        to={`/help/${topic.slug}`}
                        className="card flex h-full flex-col gap-1 p-3.5 transition-colors hover:border-line-strong hover:bg-surface-2/40"
                      >
                        <p className="text-[13px] font-semibold text-ink">{topic.title}</p>
                        <p className="text-[12.5px] leading-relaxed text-ink-muted">
                          {topic.blurb}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function HelpArticle() {
  const { slug } = useParams();
  const topic = findTopic(slug)!;
  const markdown = useMemo(() => loadTopic(topic), [topic]);
  const headings = useMemo(() => outline(markdown), [markdown]);
  const body = useMemo(() => render(markdown), [markdown]);
  const scroller = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<string | null>(null);

  // A different page starts at the top of itself, not wherever the last one was left.
  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
    setActive(null);
  }, []);

  // Which section is being read, for the rail. Measured against the scrolling box
  // rather than the window, since the page does not scroll, the panel inside it does.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onScroll = () => {
      let current: string | null = null;
      for (const heading of headings) {
        const element = box.querySelector(`#${CSS.escape(heading.id)}`);
        if (element && element.getBoundingClientRect().top - box.getBoundingClientRect().top < 80) {
          current = heading.id;
        }
      }
      setActive(current);
    };
    onScroll();
    box.addEventListener('scroll', onScroll, { passive: true });
    return () => box.removeEventListener('scroll', onScroll);
  }, [headings]);

  const index = TOPICS.findIndex((entry) => entry.slug === topic.slug);
  const previous = TOPICS[index - 1];
  const next = TOPICS[index + 1];

  return (
    <>
      <PageHeader
        title={
          <Link to="/help" className="text-ink-muted transition-colors hover:text-ink">
            Handbook
          </Link>
        }
        subtitle={topic.title}
      />

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl gap-10 px-5 py-6">
          <article className="min-w-0 flex-1">
            <h1 className="text-[22px] font-semibold text-ink">
              {documentTitle(markdown) ?? topic.title}
            </h1>
            <p className="mt-1 text-[13px] text-ink-faint">{topic.blurb}</p>
            <div className="mt-5">{body}</div>

            <nav className="mt-12 flex gap-3 border-t border-line pt-5">
              {previous && (
                <Link
                  to={`/help/${previous.slug}`}
                  className="card flex-1 p-3 transition-colors hover:border-line-strong"
                >
                  <p className="text-[11px] text-ink-faint">Before this</p>
                  <p className="mt-0.5 text-[13px] font-medium text-ink">{previous.title}</p>
                </Link>
              )}
              {next && (
                <Link
                  to={`/help/${next.slug}`}
                  className="card flex-1 p-3 text-right transition-colors hover:border-line-strong"
                >
                  <p className="text-[11px] text-ink-faint">After this</p>
                  <p className="mt-0.5 text-[13px] font-medium text-ink">{next.title}</p>
                </Link>
              )}
            </nav>
          </article>

          {headings.length > 2 && (
            <nav className="sticky top-0 hidden w-52 shrink-0 self-start pt-1 lg:block">
              <p className="eyebrow text-ink-faint">On this page</p>
              <ul className="mt-2 space-y-1.5">
                {headings.map((heading) => (
                  <li key={heading.id}>
                    <a
                      href={`#${heading.id}`}
                      onClick={(event) => {
                        event.preventDefault();
                        scroller.current
                          ?.querySelector(`#${CSS.escape(heading.id)}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      }}
                      className={cx(
                        'block truncate text-[12.5px] transition-colors',
                        heading.level === 3 && 'pl-3',
                        active === heading.id
                          ? 'text-accent'
                          : 'text-ink-faint hover:text-ink-muted',
                      )}
                    >
                      {heading.text}
                    </a>
                  </li>
                ))}
              </ul>
            </nav>
          )}
        </div>
      </div>
    </>
  );
}

/** The icon the sidebar uses, kept here so the page owns its own identity. */
export const HelpIcon = BookOpen;
