import { describe, expect, it } from 'vitest';
import { normalizePhone } from './phone.js';

/**
 * Phone numbers as a booking stores them (plan.md Task 13; data-model_v2.md
 * §5.8): E.164 where the number can be read as one, the bare digits otherwise,
 * and null when the input cannot be a phone number at all.
 */

describe('normalizePhone: Rwandan numbers', () => {
  it.each([
    ['078 812 3456', '+250788123456'],
    ['0788123456', '+250788123456'],
    ['0788 123 456', '+250788123456'],
    ['078-812-3456', '+250788123456'],
    ['078.812.3456', '+250788123456'],
    ['(078) 812 3456', '+250788123456'],
    ['0722123456', '+250722123456'],
    ['0738123456', '+250738123456'],
    ['250788123456', '+250788123456'],
    ['250 788 123 456', '+250788123456'],
    ['+250 788 123 456', '+250788123456'],
    ['+250788123456', '+250788123456'],
    ['+250-788-123-456', '+250788123456'],
    ['  0788123456  ', '+250788123456'],
    ['\t+250 788 123 456\n', '+250788123456'],
  ])('reads %j as %s', (typed, expected) => {
    expect(normalizePhone(typed)).toBe(expected);
  });
});

describe('normalizePhone: other numbers', () => {
  it.each([
    ['+1 (415) 555-0100', '+14155550100'],
    ['+44 20 7946 0958', '+442079460958'],
    ['+33 1 23 45 67 89', '+33123456789'],
    // Without a `+`, a foreign number cannot be told from a local one: its digits are kept.
    ['(415) 555-0100', '4155550100'],
    ['1 415 555 0100', '14155550100'],
    // A 07 prefix of the wrong length is not a Rwandan mobile number.
    ['078812345', '078812345'],
    ['07881234567', '07881234567'],
    // 250 then 07 is not the Rwandan pattern (2507 + 8 digits); nor is 250 + 13 digits.
    ['2507881234567', '2507881234567'],
    ['0252123456', '0252123456'],
  ])('reads %j as %s', (typed, expected) => {
    expect(normalizePhone(typed)).toBe(expected);
  });
});

describe('normalizePhone: digit count', () => {
  it('accepts 7 digits, the fewest', () => {
    expect(normalizePhone('1234567')).toBe('1234567');
    expect(normalizePhone('+1234567')).toBe('+1234567');
    expect(normalizePhone('123 45 67')).toBe('1234567');
  });

  it('refuses 6 digits, however they are dressed up', () => {
    expect(normalizePhone('123456')).toBeNull();
    expect(normalizePhone('+123456')).toBeNull();
    expect(normalizePhone('(12) 34-56......')).toBeNull();
  });

  it('accepts 15 digits, E.164’s most', () => {
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345');
    expect(normalizePhone('123456789012345')).toBe('123456789012345');
  });

  it('refuses 16 digits', () => {
    expect(normalizePhone('+1234567890123456')).toBeNull();
    expect(normalizePhone('1234567890123456')).toBeNull();
  });
});

describe('normalizePhone: not a phone number', () => {
  it.each([
    [''],
    ['   '],
    ['+'],
    ['+ - ( ) .'],
    ['0788abc456'],
    ['call me on 0788123456'],
    ['0788123456 ext 12'],
    ['0788123456#'],
    ['+250+788123456'],
    ['250+788123456'],
    ['++250788123456'],
    ['0788/123/456'],
    ['0788_123_456'],
    ['aline@example.com'],
    // Not ASCII digits: `\d` without the `u` flag is [0-9] only.
    ['٠٧٨٨١٢٣٤٥٦'],
    ['０７８８１２３４５６'],
  ])('refuses %j', (typed) => {
    expect(normalizePhone(typed)).toBeNull();
  });
});

describe('normalizePhone: output', () => {
  it('is idempotent: a normalised number normalises to itself', () => {
    for (const typed of ['078 812 3456', '+1 (415) 555-0100', '(415) 555-0100', '250 788 123 456']) {
      const once = normalizePhone(typed);
      expect(once).not.toBeNull();
      expect(normalizePhone(once ?? '')).toBe(once);
    }
  });

  it('only ever returns a `+` then digits, or digits', () => {
    for (const typed of ['078 812 3456', '+44 (0) 20 7946 0958', '1-800-555-0100', '+250.788.123.456']) {
      expect(normalizePhone(typed)).toMatch(/^\+?\d{7,15}$/);
    }
  });
});
