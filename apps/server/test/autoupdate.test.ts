import { describe, expect, test } from 'bun:test';
import { isDue } from '../src/system/autoupdate.ts';
import {
  type PackageManager,
  securityUpgradeCommand,
  upgradeCommand,
} from '../src/system/updates.ts';

/**
 * Updating somebody's server without being asked.
 *
 * Everything here is about staying narrow. A switch labelled "automatic updates" that
 * quietly upgrades a whole machine is the difference between a feature and somebody's
 * afternoon, and the only thing standing between the two is which command runs.
 */

const MANAGERS: PackageManager[] = ['apt', 'dnf', 'yum', 'pacman', 'apk', 'zypper'];

describe('which command runs unattended', () => {
  test('only the ones that can tell a security update from any other', () => {
    // Three of six can. The rest ship one stream, and "just the security ones" there
    // means everything.
    expect(securityUpgradeCommand('apt')).not.toBeNull();
    expect(securityUpgradeCommand('dnf')).not.toBeNull();
    expect(securityUpgradeCommand('yum')).not.toBeNull();
    expect(securityUpgradeCommand('zypper')).not.toBeNull();
  });

  test('and nothing at all on Arch or Alpine, rather than everything', () => {
    // Refusing is the feature. Upgrading the whole machine on a timer under a heading
    // that says security is the failure this is written to avoid.
    expect(securityUpgradeCommand('pacman')).toBeNull();
    expect(securityUpgradeCommand('apk')).toBeNull();
  });

  test('the security command is never the full upgrade command', () => {
    for (const manager of MANAGERS) {
      const security = securityUpgradeCommand(manager);
      if (!security) continue;
      expect(security.join(' ')).not.toBe(upgradeCommand(manager).join(' '));
    }
  });

  test('each one names its own manager and asks no questions', () => {
    // A prompt in an unattended command is a machine waiting for somebody who is
    // asleep, holding a package lock the next run needs.
    for (const manager of MANAGERS) {
      const cmd = securityUpgradeCommand(manager);
      if (!cmd) continue;
      const line = cmd.join(' ');
      expect(line).toContain(manager === 'apt' ? 'apt' : manager);
      expect(line).toMatch(/-y|--non-interactive|noninteractive|unattended/);
    }
  });

  test('says security somewhere, which is the whole claim', () => {
    for (const manager of ['dnf', 'yum', 'zypper'] as PackageManager[]) {
      expect(securityUpgradeCommand(manager)?.join(' ')).toMatch(/securit/i);
    }
    expect(securityUpgradeCommand('apt')?.join(' ')).toMatch(/unattended|securi/i);
  });

  test('never restarts the machine', () => {
    // The right moment to reboot is a decision about somebody's visitors, not about
    // packages. Derailed says one is needed and leaves the timing alone.
    for (const manager of MANAGERS) {
      const line = securityUpgradeCommand(manager)?.join(' ') ?? '';
      expect(line).not.toMatch(/\breboot\b|\bshutdown\b|systemctl/);
    }
  });
});

describe('when it runs', () => {
  const DAY = 24 * 60 * 60 * 1000;

  test('straight away when it has never run', () => {
    expect(isDue(null)).toBe(true);
  });

  test('once a day, and not twice', () => {
    const now = Date.now();
    expect(isDue(now - DAY - 1000, now)).toBe(true);
    expect(isDue(now - DAY / 2, now)).toBe(false);
    expect(isDue(now, now)).toBe(false);
  });

  test('catches up on a server that was switched off for a week', () => {
    // Checked hourly against the last run rather than fired by a daily timer, so a
    // machine that was off overnight does not simply miss its turn.
    expect(isDue(Date.now() - 7 * DAY)).toBe(true);
  });
});
