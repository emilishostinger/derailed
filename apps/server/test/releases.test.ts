import { afterEach, describe, expect, test } from 'bun:test';
import { githubRepo, isUsableTag, latestRelease, RateLimited } from '../src/build/releases.ts';

/**
 * Following GitHub releases.
 *
 * The dangerous failure here is not "it missed a release": it is deploying the wrong
 * thing, or deploying an older tag because GitHub answered in an order nobody
 * expected. Most of these are about that.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function answerWith(body: unknown, status = 200, headers: Record<string, string> = {}): string[] {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    seen.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
  }) as typeof fetch;
  return seen;
}

const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v1.0.0',
  name: 'First',
  html_url: 'https://github.com/o/r/releases/tag/v1.0.0',
  published_at: '2026-01-01T00:00:00Z',
  draft: false,
  prerelease: false,
  ...over,
});

describe('reading a GitHub URL', () => {
  test('the forms people actually paste', () => {
    for (const url of [
      'https://github.com/derailed/derailed',
      'https://github.com/derailed/derailed.git',
      'https://github.com/derailed/derailed/',
      'http://github.com/derailed/derailed',
      'git@github.com:derailed/derailed.git',
      'HTTPS://GitHub.com/derailed/derailed',
      '  https://github.com/derailed/derailed  ',
    ]) {
      expect({ url, repo: githubRepo(url) }).toEqual({
        url,
        repo: { owner: 'derailed', repo: 'derailed' },
      });
    }
  });

  test('anything that is not GitHub is not GitHub', () => {
    for (const url of [
      null,
      '',
      'https://gitlab.com/a/b',
      'https://bitbucket.org/a/b',
      'https://example.com/github.com/a/b',
      // The one that matters: a lookalike host must not be read as GitHub, or a
      // token meant for GitHub would be sent somewhere else entirely.
      'https://github.com.evil.test/a/b',
      'https://notgithub.com/a/b',
      'https://github.com/onlyowner',
    ]) {
      expect({ url, repo: githubRepo(url) }).toEqual({ url, repo: null });
    }
  });
});

describe('picking the newest release', () => {
  test('returns the tag, the name and the link', async () => {
    answerWith([release()]);
    expect(await latestRelease('https://github.com/o/r')).toEqual({
      tag: 'v1.0.0',
      name: 'First',
      url: 'https://github.com/o/r/releases/tag/v1.0.0',
      publishedAt: Date.parse('2026-01-01T00:00:00Z'),
      prerelease: false,
    });
  });

  test('sorts by when it was published, not by the order GitHub returned', async () => {
    answerWith([
      release({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z' }),
      release({ tag_name: 'v2.0.0', published_at: '2026-06-01T00:00:00Z' }),
    ]);
    expect((await latestRelease('https://github.com/o/r'))?.tag).toBe('v2.0.0');
  });

  test('skips drafts, which are not published at all', async () => {
    answerWith([
      release({ tag_name: 'v3.0.0', published_at: '2026-07-01T00:00:00Z', draft: true }),
      release({ tag_name: 'v2.0.0', published_at: '2026-06-01T00:00:00Z' }),
    ]);
    expect((await latestRelease('https://github.com/o/r'))?.tag).toBe('v2.0.0');
  });

  test('skips prereleases unless asked for them', async () => {
    const list = [
      release({ tag_name: 'v3.0.0-rc1', published_at: '2026-07-01T00:00:00Z', prerelease: true }),
      release({ tag_name: 'v2.0.0', published_at: '2026-06-01T00:00:00Z' }),
    ];
    answerWith(list);
    expect((await latestRelease('https://github.com/o/r'))?.tag).toBe('v2.0.0');
    answerWith(list);
    expect(
      (await latestRelease('https://github.com/o/r', null, { includePrereleases: true }))?.tag,
    ).toBe('v3.0.0-rc1');
  });

  test('a repository with only drafts has no release', async () => {
    answerWith([release({ draft: true })]);
    expect(await latestRelease('https://github.com/o/r')).toBeNull();
  });

  test('no releases at all is null, not a throw', async () => {
    answerWith([]);
    expect(await latestRelease('https://github.com/o/r')).toBeNull();
  });

  test('an error from GitHub is null, so the stored tag does not move', async () => {
    for (const status of [403, 404, 500]) {
      answerWith({ message: 'nope' }, status);
      expect(await latestRelease('https://github.com/o/r')).toBeNull();
    }
  });

  test('being rate limited is raised rather than swallowed', async () => {
    // The watcher has to stop the pass: asking about nine more repositories after
    // this only digs the hole deeper.
    answerWith({ message: 'API rate limit exceeded' }, 403, { 'x-ratelimit-remaining': '0' });
    expect(await latestRelease('https://github.com/o/r').catch((e) => e)).toBeInstanceOf(
      RateLimited,
    );

    answerWith({ message: 'Too many requests' }, 429, { 'retry-after': '60' });
    expect(await latestRelease('https://github.com/o/r').catch((e) => e)).toBeInstanceOf(
      RateLimited,
    );
  });

  test('a plain 403 is not mistaken for the rate limit', async () => {
    // A private repository answers 403 to a token that cannot see it. Reading that
    // as "stop, we are rate limited" would stall every other repository behind it.
    answerWith({ message: 'Forbidden' }, 403, { 'x-ratelimit-remaining': '4998' });
    expect(await latestRelease('https://github.com/o/r')).toBeNull();
  });

  test('a body that is not a list does not crash the watcher', async () => {
    answerWith({ message: 'Not Found' });
    expect(await latestRelease('https://github.com/o/r')).toBeNull();
  });

  test('falls back to the tag when a release was never given a name', async () => {
    answerWith([release({ name: null })]);
    expect((await latestRelease('https://github.com/o/r'))?.name).toBe('v1.0.0');
    answerWith([release({ name: '   ' })]);
    expect((await latestRelease('https://github.com/o/r'))?.name).toBe('v1.0.0');
  });

  test('asks GitHub for the repository, and only that repository', async () => {
    const seen = answerWith([release()]);
    await latestRelease('https://github.com/derailed/derailed.git');
    expect(seen[0]).toBe('https://api.github.com/repos/derailed/derailed/releases?per_page=20');
  });

  test('a non-GitHub repository is never asked about at all', async () => {
    const seen = answerWith([release()]);
    expect(await latestRelease('https://gitlab.com/o/r')).toBeNull();
    expect(seen).toEqual([]);
  });

  test('sends the deploy token only when there is one', async () => {
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response('[]', { status: 200 });
    }) as typeof fetch;

    await latestRelease('https://github.com/o/r');
    expect(headers?.has('authorization')).toBe(false);

    await latestRelease('https://github.com/o/r', 'ghp_secret');
    expect(headers?.get('authorization')).toBe('Bearer ghp_secret');
  });
});

describe('a tag worth building', () => {
  test('the ones releases are actually named', () => {
    for (const tag of ['v1.0.0', '1.2.3', 'v1.0.0-rc.1', 'release-2026-08-06', '2026.08', 'v2.0']) {
      expect({ tag, ok: isUsableTag(tag) }).toEqual({ tag, ok: true });
    }
  });

  test('the ones that are a repository doing something strange', () => {
    for (const tag of [
      '',
      '-v1.0.0',
      '--upload-pack=touch /tmp/pwned',
      'v1 0',
      'v1..0',
      'v1.0\n',
      'v1\tx',
      'a/',
      'main.lock',
      'v1^0',
      'v1~2',
      'v1:0',
      'v1?0',
      'v1*',
      'v1[0]',
      'v1]0',
      'back\\slash',
      'x'.repeat(201),
    ]) {
      expect({ tag, ok: isUsableTag(tag) }).toEqual({ tag, ok: false });
    }
  });
});
