/**
 * Searching a deploy's log.
 *
 * The live tail, the changes view and the "why did it fail" view all check the deploy
 * is real first and answer 404 when it is not. The search route skipped that and handed
 * back a cheerful empty result for a deploy id that was never here, so the one screen
 * that would tell you the id was wrong instead told you the log was empty. This makes it
 * answer the same 404 as its siblings.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { createSession } from '../src/db/repo/sessions.ts';
import { createUser } from '../src/db/repo/users.ts';
import { createApp } from '../src/http/app.ts';
import { loadSecretKey } from '../src/util/crypto.ts';

const dir = mkdtempSync(join(tmpdir(), 'derailed-deploysearch-'));
let app: ReturnType<typeof createApp>;
let cookie = '';

beforeAll(async () => {
  initDb(join(dir, 'test.db'));
  loadSecretKey(join(dir, 'secret.key'));
  app = createApp();
  const user = createUser('owner@example.com', await Bun.password.hash('correct-horse'), 'owner');
  cookie = `derailed_session=${createSession(user.id).id}`;
});

afterAll(async () => {
  closeDb();
  await rm(dir, { recursive: true, force: true });
});

describe('searching a deploy that is not there', () => {
  test('is a 404, the same as asking for its log or its changes', async () => {
    const response = await app.request('/api/deployments/no-such-deploy/search?q=error', {
      headers: { cookie },
    });
    expect(response.status).toBe(404);
  });
});
