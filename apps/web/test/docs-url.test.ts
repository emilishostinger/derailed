/**
 * The Readme link is derived, never stored, and only offered when the guess is
 * a good one: a wrong link to somebody else's registry is worse than no link.
 */
import { describe, expect, test } from 'bun:test';
import { docsUrlFor } from '../src/components/docsUrl.ts';

describe('where an app documents itself', () => {
  test('a repo app links to its repository', () => {
    expect(docsUrlFor({ repoUrl: 'https://github.com/phpbb/phpbb.git' })).toBe(
      'https://github.com/phpbb/phpbb',
    );
    expect(docsUrlFor({ repoUrl: 'github.com/someone/thing' })).toBe(
      'https://github.com/someone/thing',
    );
  });

  test('official Docker Hub images link to their library page', () => {
    expect(docsUrlFor({ image: 'wordpress:php8.3-apache' })).toBe(
      'https://hub.docker.com/_/wordpress',
    );
    expect(docsUrlFor({ image: 'docker.io/library/nginx:1.27' })).toBe(
      'https://hub.docker.com/_/nginx',
    );
  });

  test('namespaced Docker Hub images link to their repository page', () => {
    expect(docsUrlFor({ image: 'louislam/uptime-kuma:1' })).toBe(
      'https://hub.docker.com/r/louislam/uptime-kuma',
    );
  });

  test('ghcr images link to the GitHub repository behind them', () => {
    expect(docsUrlFor({ image: 'ghcr.io/umami-software/umami:postgresql-latest' })).toBe(
      'https://github.com/umami-software/umami',
    );
  });

  test('an unknown registry gets no link rather than a broken one', () => {
    expect(docsUrlFor({ image: 'quay.io/someone/thing:1' })).toBeNull();
    expect(docsUrlFor({ image: 'registry.example.com/team/app' })).toBeNull();
    expect(docsUrlFor({})).toBeNull();
  });
});
