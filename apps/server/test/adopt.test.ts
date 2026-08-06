import { describe, expect, test } from 'bun:test';
import { suggestPort } from '../src/catalog/adopt.ts';

/**
 * Taking over something already on the machine.
 *
 * The only judgement here is which port to point a web address at, and the cost of
 * getting it wrong is an address that answers with binary nonsense. So it guesses
 * conservatively and is happy to guess nothing.
 */
const ports = (...list: number[]) => list.map((container) => ({ container, published: container }));

describe('choosing a port', () => {
  test('prefers the familiar web ports', () => {
    expect(suggestPort(ports(9999, 80))).toBe(80);
    expect(suggestPort(ports(5432, 3000))).toBe(3000);
    expect(suggestPort(ports(7000, 8080))).toBe(8080);
  });

  test('takes something plausible when there is no obvious web port', () => {
    expect(suggestPort(ports(9000))).toBe(9000);
    expect(suggestPort(ports(19530, 9091))).toBe(19530);
  });

  test('suggests nothing for a container that is plainly a database', () => {
    // An address pointed at Postgres answers with binary nonsense, which is a worse
    // first impression than an empty field.
    expect(suggestPort(ports(5432))).toBeNull();
    expect(suggestPort(ports(6379))).toBeNull();
    expect(suggestPort(ports(3306))).toBeNull();
    expect(suggestPort(ports(27017))).toBeNull();
  });

  test('suggests nothing when there is nothing to suggest', () => {
    expect(suggestPort([])).toBeNull();
  });
});
