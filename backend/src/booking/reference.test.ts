import { describe, expect, it, vi } from 'vitest';
import { CROCKFORD_BASE32, REFERENCE_PATTERN, generateReference } from './reference.js';

/**
 * Booking references, `BKY-YYMM-XXXXX` (plan.md Task 13; data-model_v2.md
 * §5.9). Pure: the randomness is injected, so every character is pinned.
 *
 * `YYMM` is the Kigali month the booking was made. Kigali is UTC+2 with no
 * DST, so 22:00Z on the last day of a month is already the next month there.
 */

/** A `randomIndex` answering the given indexes in turn. */
function indexes(...values: number[]) {
  const queue = [...values];
  return vi.fn((size: number) => {
    const next = queue.shift();
    if (next === undefined) throw new Error(`randomIndex(${size}) called more often than scripted`);
    return next;
  });
}

const ZEROS = () => 0;

describe('the Crockford base32 alphabet', () => {
  it('has 32 distinct characters: the ten digits, then 22 capital letters in order', () => {
    expect(CROCKFORD_BASE32).toHaveLength(32);
    expect(new Set(CROCKFORD_BASE32).size).toBe(32);
    expect(CROCKFORD_BASE32.slice(0, 10)).toBe('0123456789');
    expect([...CROCKFORD_BASE32].every((char) => /^[0-9A-Z]$/.test(char))).toBe(true);
    expect([...CROCKFORD_BASE32].sort().join('')).toBe(CROCKFORD_BASE32);
  });

  it.each(['I', 'L', 'O', 'U'])('leaves out %s, which could be misheard over the phone', (letter) => {
    expect(CROCKFORD_BASE32).not.toContain(letter);
  });

  it('has every other capital letter', () => {
    const expected = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.replace(/[ILOU]/g, '');
    expect(CROCKFORD_BASE32.slice(10)).toBe(expected);
  });
});

describe('generateReference', () => {
  const OCTOBER = new Date('2026-10-07T07:00:00Z');

  it('builds BKY-YYMM-XXXXX from five injected indexes into the alphabet', () => {
    const randomIndex = indexes(0, 31, 10, 17, 26);

    expect(generateReference(OCTOBER, randomIndex)).toBe('BKY-2610-0ZAHT');
    expect(randomIndex).toHaveBeenCalledTimes(5);
    for (const [size] of randomIndex.mock.calls) expect(size).toBe(32);
  });

  it('is deterministic for the same clock and indexes', () => {
    const first = generateReference(OCTOBER, indexes(1, 2, 3, 4, 5));
    const second = generateReference(OCTOBER, indexes(1, 2, 3, 4, 5));

    expect(first).toBe('BKY-2610-12345');
    expect(second).toBe(first);
  });

  it('can produce every character of the alphabet, each matching the pattern', () => {
    const produced = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const reference = generateReference(OCTOBER, () => i);
      expect(reference).toMatch(REFERENCE_PATTERN);
      produced.add(reference.slice(-1));
    }
    expect([...produced].join('')).toBe(CROCKFORD_BASE32);
  });

  it.each([
    ['2026-10-31T21:59:59.999Z', '2610', 'the last millisecond of October in Kigali'],
    ['2026-10-31T22:00:00.000Z', '2611', 'midnight on 1 November in Kigali, still 31 October in UTC'],
    ['2026-10-31T22:30:00.000Z', '2611', 'half past midnight on 1 November in Kigali'],
    ['2026-09-30T22:00:00.000Z', '2610', 'October 1 in Kigali'],
    ['2026-12-31T21:59:59.999Z', '2612', 'the last millisecond of 2026 in Kigali'],
    ['2026-12-31T22:00:00.000Z', '2701', 'new year in Kigali, still 2026 in UTC'],
    ['2026-02-28T22:00:00.000Z', '2603', 'March 1 in Kigali'],
    ['2028-02-28T22:00:00.000Z', '2802', 'the leap day in Kigali'],
    ['2099-12-31T22:00:00.000Z', '0001', 'a century rollover keeps two digits'],
    ['2030-06-15T10:00:00.000Z', '3006', 'mid-month'],
  ])('reads %s as YYMM %s (%s)', (instant, yymm) => {
    expect(generateReference(new Date(instant), ZEROS)).toBe(`BKY-${yymm}-00000`);
  });

  it('uses crypto randomness by default, always within the alphabet and never repeating in practice', () => {
    const references = Array.from({ length: 500 }, () => generateReference(OCTOBER));

    for (const reference of references) {
      expect(reference).toMatch(REFERENCE_PATTERN);
      expect(reference.startsWith('BKY-2610-')).toBe(true);
    }
    // 32^5 is ~33 million; 500 draws colliding more than once is vanishingly unlikely.
    expect(new Set(references).size).toBeGreaterThanOrEqual(499);
  });
});

describe('REFERENCE_PATTERN', () => {
  it.each(['BKY-2610-00000', 'BKY-2610-ZZZZZ', 'BKY-0001-ABCDE', 'BKY-9912-H3K7V'])('accepts %s', (reference) => {
    expect(reference).toMatch(REFERENCE_PATTERN);
  });

  it.each([
    'BKY-2610-0000',
    'BKY-2610-000000',
    'bky-2610-00000',
    'BKY-2610-abcde',
    'BKY-2610-0000I',
    'BKY-2610-0000L',
    'BKY-2610-0000O',
    'BKY-2610-0000U',
    'BKY-261-00000',
    'BKY-26100-00000',
    'BKX-2610-00000',
    'BKY2610-00000',
    ' BKY-2610-00000',
    'BKY-2610-00000 ',
    '',
  ])('refuses %j', (reference) => {
    expect(reference).not.toMatch(REFERENCE_PATTERN);
  });

  it('is the pattern the plan names', () => {
    expect(REFERENCE_PATTERN.source).toBe(/^BKY-\d{4}-[0-9A-HJKMNP-TV-Z]{5}$/.source);
  });
});
