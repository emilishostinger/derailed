import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb, initDb } from '../src/db/index.ts';
import { listEnv } from '../src/db/repo/env.ts';
import { createProject } from '../src/db/repo/projects.ts';
import { createAppService } from '../src/db/repo/services.ts';
import { appCanSendMail, MAIL_ENV_KEYS, mailEnvFor, setAppMail } from '../src/mail/appmail.ts';
import { saveMailSettings } from '../src/mail/settings.ts';
import { loadSecretKey, resetSecretKeyCache } from '../src/util/crypto.ts';

/**
 * Letting an app send email.
 *
 * The number one "I installed it and it half works" complaint in self-hosting, and
 * the fix is entirely about names: no two apps agree on what to call these, so
 * Derailed sets the common spellings at once. The tests that matter are the ones
 * about not trampling something somebody set by hand.
 */

const dir = mkdtempSync(join(tmpdir(), 'derailed-appmail-'));

beforeEach(() => {
  initDb(':memory:');
  resetSecretKeyCache();
  loadSecretKey(join(dir, 'secret.key'));
});

afterEach(() => {
  closeDb();
});

function anApp() {
  const project = createProject('Shop');
  return createAppService({
    projectId: project.id,
    name: 'Web',
    source: 'image',
    image: 'wordpress:php8.3-apache',
    repoUrl: null,
    branch: null,
  });
}

function setUpMail() {
  saveMailSettings({
    delivery: 'smtp',
    host: 'smtp.example.com',
    port: 587,
    security: 'starttls',
    username: 'postbox@example.com',
    password: 'pa:ss@word',
    from: 'hello@example.com',
    fromName: 'My Site',
  });
}

describe('the variables an app is given', () => {
  test('covers the spellings different apps actually look for', () => {
    const env = mailEnvFor({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'me',
      password: 'secret',
      from: 'hello@example.com',
      fromName: 'My Site',
    });

    // Several at once on purpose: setting six an app ignores costs nothing, setting
    // the wrong one leaves somebody with a password reset that never arrives.
    expect(env.SMTP_HOST).toBe('smtp.example.com');
    expect(env.MAIL_HOST).toBe('smtp.example.com');
    expect(env.SMTP_PORT).toBe('587');
    expect(env.MAIL_FROM_NAME).toBe('My Site');
  });

  test('escapes a password that would otherwise break the URL', () => {
    const env = mailEnvFor({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      username: 'user@example.com',
      // Both of these are legal in a password and both are structural in a URL.
      password: 'pa:ss@word',
      from: 'hello@example.com',
      fromName: 'x',
    });

    const url = new URL(env.SMTP_URL ?? '');
    expect(url.hostname).toBe('smtp.example.com');
    expect(decodeURIComponent(url.password)).toBe('pa:ss@word');
    expect(decodeURIComponent(url.username)).toBe('user@example.com');
  });
});

describe('turning it on', () => {
  test('sets the variables on the app', () => {
    setUpMail();
    const app = anApp();
    setAppMail(app.id, true);

    const env = Object.fromEntries(listEnv(app.id).map((entry) => [entry.key, entry.value]));
    expect(env.SMTP_HOST).toBe('smtp.example.com');
    expect(appCanSendMail(app.id)).toBe(true);
  });

  test('refuses when there is nothing to send with', () => {
    const app = anApp();
    expect(() => setAppMail(app.id, true)).toThrow(/nothing to send email with/i);
  });

  test('refuses when Derailed sends straight from the server', () => {
    // That mode has no credentials at all, so there is nothing an app could be
    // handed: it would have to talk to each recipient's mail server itself.
    saveMailSettings({ delivery: 'server', from: 'hello@example.com' });
    const app = anApp();
    expect(() => setAppMail(app.id, true)).toThrow();
  });

  test('leaves everything else the app was given alone', () => {
    setUpMail();
    const app = anApp();
    const { replaceUserEnv } = require('../src/db/repo/env.ts');
    replaceUserEnv(app.id, [{ key: 'WORDPRESS_DB_NAME', value: 'wp' }]);

    setAppMail(app.id, true);
    const env = Object.fromEntries(listEnv(app.id).map((entry) => [entry.key, entry.value]));
    expect(env.WORDPRESS_DB_NAME).toBe('wp');
    expect(env.SMTP_HOST).toBe('smtp.example.com');
  });
});

describe('turning it off', () => {
  test('takes away exactly what it added', () => {
    setUpMail();
    const app = anApp();
    const { replaceUserEnv } = require('../src/db/repo/env.ts');
    replaceUserEnv(app.id, [{ key: 'KEEP_ME', value: 'yes' }]);

    setAppMail(app.id, true);
    setAppMail(app.id, false);

    const keys = listEnv(app.id).map((entry) => entry.key);
    expect(keys).toContain('KEEP_ME');
    for (const key of MAIL_ENV_KEYS) expect(keys).not.toContain(key);
    expect(appCanSendMail(app.id)).toBe(false);
  });
});
