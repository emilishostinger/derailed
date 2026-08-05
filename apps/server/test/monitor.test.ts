import { beforeEach, describe, expect, test } from 'bun:test';
import type { ContainerEvent } from '../src/docker/events.ts';
import { clearIntents, markIntentionalStop } from '../src/runtime/intent.ts';
import { statusFromEvent } from '../src/runtime/monitor.ts';

const event = (over: Partial<ContainerEvent> = {}): ContainerEvent => ({
  action: 'die',
  containerId: 'abc123',
  serviceId: 'svc1',
  projectId: 'proj1',
  deploymentId: null,
  exitCode: 0,
  name: 'd_demo_web',
  at: Date.now(),
  ...over,
});

describe('container status mapping', () => {
  beforeEach(() => clearIntents());

  test('a start means running', () => {
    expect(statusFromEvent(event({ action: 'start' }))).toBe('running');
  });

  test('an exit code of zero means stopped', () => {
    expect(statusFromEvent(event({ exitCode: 0 }))).toBe('stopped');
  });

  test('a non-zero exit we did not ask for is a crash', () => {
    expect(statusFromEvent(event({ exitCode: 1 }))).toBe('crashed');
  });

  test('a stop we asked for is not a crash, even though it exits 143', () => {
    markIntentionalStop('abc123');
    expect(statusFromEvent(event({ exitCode: 143 }))).toBe('stopped');
  });

  test('the intent is consumed, so a later crash still reports', () => {
    markIntentionalStop('abc123');
    expect(statusFromEvent(event({ exitCode: 137 }))).toBe('stopped');
    expect(statusFromEvent(event({ exitCode: 137 }))).toBe('crashed');
  });

  test('intent for one container does not cover another', () => {
    markIntentionalStop('abc123');
    expect(statusFromEvent(event({ containerId: 'other', exitCode: 137 }))).toBe('crashed');
  });

  test('an out-of-memory kill is always a crash', () => {
    markIntentionalStop('abc123');
    expect(statusFromEvent(event({ action: 'oom' }))).toBe('crashed');
  });

  test('uninteresting actions are ignored', () => {
    expect(statusFromEvent(event({ action: 'exec_create' }))).toBeNull();
  });
});
