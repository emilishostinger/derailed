import { describe, expect, test } from 'bun:test';
import { diagnose, interestingLines, RULES } from '../src/build/diagnose.ts';

/**
 * Reading a failure and saying what to do about it.
 *
 * Every case below is real output, copied from the thing that actually prints it,
 * because a rule written against imagined output is a rule that matches imagined
 * failures. The last group matters as much as the rest: saying nothing when nothing
 * is recognised, since a confident wrong answer sends somebody off for an hour on the
 * wrong thing.
 */

function lines(text: string): string[] {
  return text.trim().split('\n');
}

describe('memory', () => {
  test('recognises a build that ran out of it', () => {
    const result = diagnose(
      lines(`
        <--- Last few GCs --->
        FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory
      `),
    );
    expect(result?.id).toBe('oom-build');
    // The one thing a 1 GB server can actually do about it.
    expect(result?.fix).toBe('add-swap');
  });

  test('recognises an app killed for it', () => {
    const result = diagnose(lines('container exited with exit code 137'));
    expect(result?.id).toBe('oom-run');
    expect(result?.summary).toContain('ran out of memory');
    // Worth saying plainly: this app did not crash, it was chosen and killed.
    expect(result?.action).toContain('did not crash');
  });
});

describe('ports', () => {
  test('recognises a port already taken', () => {
    const result = diagnose(lines('Error: listen EADDRINUSE: address already in use 0.0.0.0:3000'));
    expect(result?.id).toBe('port-in-use');
  });

  test('recognises an app bound to localhost, which nothing outside can reach', () => {
    const result = diagnose(lines('Server running at http://127.0.0.1:3000'));
    expect(result?.id).toBe('listening-on-localhost');
    expect(result?.action).toContain('0.0.0.0');
  });
});

describe('dependencies', () => {
  test('recognises a missing lockfile', () => {
    const result = diagnose(
      lines(`
        npm error \`npm ci\` can only install packages when your package.json and
        npm error package-lock.json are in sync.
      `),
    );
    expect(result?.id).toBe('missing-lockfile');
  });

  test('recognises a native module with no compiler', () => {
    const result = diagnose(
      lines(`
        gyp ERR! find Python Python is not set from command line or npm configuration
        gyp ERR! stack Error: Could not find any Python installation to use
      `),
    );
    expect(result?.id).toBe('python-missing');
  });

  test('recognises something asked for and never installed', () => {
    const result = diagnose(lines("Error: Cannot find module 'express'"));
    expect(result?.id).toBe('module-not-found');
  });
});

describe('databases', () => {
  test('recognises a database that is not reachable', () => {
    const result = diagnose(lines('Error: connect ECONNREFUSED 172.18.0.3:5432'));
    expect(result?.id).toBe('db-refused');
    // The fix is a tab, not a config file, and that is worth naming.
    expect(result?.action).toContain('Connections tab');
  });

  test('recognises wrong credentials', () => {
    const result = diagnose(lines('FATAL: password authentication failed for user "app"'));
    expect(result?.id).toBe('db-auth');
  });

  test('recognises migrations that never ran', () => {
    const result = diagnose(lines('error: relation "users" does not exist'));
    expect(result?.id).toBe('migrations');
    expect(result?.action).toContain('Terminal tab');
  });
});

describe('storage and disk', () => {
  test('recognises a full disk', () => {
    const result = diagnose(lines('write /app/.next/cache: no space left on device'));
    expect(result?.id).toBe('disk-full');
    expect(result?.fix).toBe('reclaim-disk');
  });

  test('recognises writing somewhere it may not', () => {
    const result = diagnose(lines("Error: EACCES: permission denied, open '/app/uploads/x.png'"));
    expect(result?.id).toBe('permission-denied');
    expect(result?.action).toContain('Storage tab');
  });
});

describe('the repository', () => {
  test('recognises a private repository with no token', () => {
    const result = diagnose(
      lines(`
        Cloning into '/builds/abc'...
        remote: Repository not found.
        fatal: repository 'https://github.com/someone/private/' not found
      `),
    );
    expect(result?.id).toBe('repo-auth');
  });
});

describe('saying nothing', () => {
  test('says nothing when nothing is recognised', () => {
    // The important behaviour. Somebody will follow whatever this says, so an
    // invented answer costs them an hour on the wrong thing.
    expect(diagnose(lines('Something went wrong in a way nobody has seen before'))).toBeNull();
  });

  test('says nothing about empty output', () => {
    expect(diagnose([])).toBeNull();
    expect(diagnose(['', '   '])).toBeNull();
  });

  test('reads the recorded summary as well as the log', () => {
    // A failure whose log tail is only stack frames often has the useful sentence in
    // the summary instead, and it should be searched too.
    const result = diagnose(['    at Object.<anonymous> (/app/index.js:1:1)'], 'exit code 137');
    expect(result?.id).toBe('oom-run');
  });
});

describe('the rules themselves', () => {
  test('every rule says what to do, not only what happened', () => {
    for (const rule of RULES) {
      expect(rule.summary.length).toBeGreaterThan(20);
      expect(rule.action.length).toBeGreaterThan(20);
      // A "diagnosis" that restates the error is not one.
      expect(rule.action).not.toBe(rule.summary);
    }
  });

  test('every rule has a distinct id', () => {
    const ids = RULES.map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('choosing which lines to show', () => {
  test('drops stack frames and noise, keeps what was said', () => {
    const kept = interestingLines([
      'npm warn deprecated something@1.0.0',
      "Error: Cannot find module 'express'",
      '    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)',
      '    at Module._load (node:internal/modules/cjs/loader:986:27)',
    ]);
    expect(kept).toContain("Error: Cannot find module 'express'");
    expect(kept.some((line) => line.includes('_resolveFilename'))).toBe(false);
    expect(kept.some((line) => line.includes('npm warn'))).toBe(false);
  });

  test('falls back to the raw lines rather than showing nothing', () => {
    // An output that is entirely stack frames is still better than a blank box.
    const onlyNoise = ['    at one (a.js:1:1)', '    at two (b.js:2:2)'];
    expect(interestingLines(onlyNoise)).toHaveLength(2);
  });
});
