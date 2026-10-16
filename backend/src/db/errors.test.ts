import { describe, expect, it } from 'vitest';
import { SQLSTATE, isSlotTaken, isTransactionConflict, sqlstateOf } from './errors.js';

/**
 * The SQLSTATE seam, tested without a database (data-model_v2.md §9.2).
 *
 * The shapes below are the real ones Prisma 7 + @prisma/adapter-pg produce: a
 * model method wraps the driver error as `P2039`, `$queryRaw` wraps it as
 * `P2010`, and the SQLSTATE is buried identically under both.
 */

/** What `booking_no_overlap` looks like by the time Prisma has wrapped it. */
const EXCLUSION_CAUSE = { originalCode: '23P01', code: '23P01' };

function prismaError(code: string, cause?: Record<string, unknown>): Record<string, unknown> {
  return {
    name: 'PrismaClientKnownRequestError',
    code,
    clientVersion: '7.10.0',
    meta: {
      modelName: 'Booking',
      ...(cause === undefined ? {} : { driverAdapterError: { cause } }),
    },
  };
}

describe('sqlstateOf', () => {
  it('digs the SQLSTATE out of a Prisma model-method error (P2039)', () => {
    expect(sqlstateOf(prismaError('P2039', EXCLUSION_CAUSE))).toBe('23P01');
  });

  it('digs the same SQLSTATE out of a raw-query error (P2010)', () => {
    expect(sqlstateOf(prismaError('P2010', EXCLUSION_CAUSE))).toBe('23P01');
  });

  it('never mistakes a Prisma code for a SQLSTATE when no driver error is nested', () => {
    // P2039 matches ^[0-9A-Z]{5}$ exactly as a real SQLSTATE does, so a shape
    // test cannot separate them. Returning 'P2039' here is the bug this pins.
    expect(sqlstateOf(prismaError('P2039'))).toBeUndefined();
    expect(sqlstateOf(prismaError('P2010'))).toBeUndefined();
    expect(sqlstateOf(prismaError('P2002'))).toBeUndefined();
  });

  it('ignores a Prisma error whose meta carries no driverAdapterError at all', () => {
    const error = {
      name: 'PrismaClientKnownRequestError',
      code: 'P2002',
      clientVersion: '7.10.0',
      meta: { target: ['reference'] },
    };
    expect(sqlstateOf(error)).toBeUndefined();
  });

  it('reads the code off a raw pg error, which carries no clientVersion', () => {
    expect(sqlstateOf({ code: '23505', severity: 'ERROR' })).toBe('23505');
    expect(sqlstateOf({ code: '23P01', severity: 'ERROR' })).toBe('23P01');
  });

  it('falls back to the nested `code` when `originalCode` is absent', () => {
    expect(sqlstateOf(prismaError('P2010', { code: '23503' }))).toBe('23503');
  });

  it('prefers the driver code over the outer Prisma code', () => {
    expect(sqlstateOf(prismaError('P2010', { originalCode: '23514' }))).toBe('23514');
  });

  it('returns undefined when the nested code is not a string', () => {
    expect(sqlstateOf(prismaError('P2010', { originalCode: 23_505 }))).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a plain Error', new Error('connection terminated')],
    ['a string', '23P01'],
    ['a number', 23],
    ['an empty object', {}],
  ])('returns undefined for %s', (_label, value) => {
    expect(sqlstateOf(value)).toBeUndefined();
  });
});

describe('isSlotTaken', () => {
  it('is true only for an exclusion violation', () => {
    expect(isSlotTaken(prismaError('P2039', EXCLUSION_CAUSE))).toBe(true);
    expect(isSlotTaken(prismaError('P2010', EXCLUSION_CAUSE))).toBe(true);
    expect(isSlotTaken({ code: SQLSTATE.EXCLUSION_VIOLATION })).toBe(true);
  });

  it.each([
    SQLSTATE.UNIQUE_VIOLATION,
    SQLSTATE.FOREIGN_KEY_VIOLATION,
    SQLSTATE.CHECK_VIOLATION,
    '23502',
  ])('is false for %s, which must keep throwing', (code) => {
    expect(isSlotTaken(prismaError('P2010', { originalCode: code }))).toBe(false);
    expect(isSlotTaken({ code })).toBe(false);
  });

  it.each([
    ['a bare Prisma code', prismaError('P2039')],
    ['undefined', undefined],
    ['null', null],
    ['a plain Error', new Error('boom')],
  ])('is false for %s', (_label, value) => {
    expect(isSlotTaken(value)).toBe(false);
  });
});

describe('isTransactionConflict', () => {
  it('is true for a deadlock or a serialization failure, in either error shape', () => {
    expect(isTransactionConflict(prismaError('P2010', { originalCode: '40P01', code: '40P01' }))).toBe(true);
    expect(isTransactionConflict(prismaError('P2039', { originalCode: '40001', code: '40001' }))).toBe(true);
    expect(isTransactionConflict({ code: SQLSTATE.DEADLOCK_DETECTED, severity: 'ERROR' })).toBe(true);
    expect(isTransactionConflict({ code: SQLSTATE.SERIALIZATION_FAILURE, severity: 'ERROR' })).toBe(true);
  });

  it('is true for Prisma’s own write-conflict-or-deadlock error, which can carry no SQLSTATE', () => {
    expect(isTransactionConflict(prismaError('P2034'))).toBe(true);
  });

  it('is false for a P2034-looking code that did not come from Prisma', () => {
    // Only Prisma's errors carry clientVersion; a raw driver `code` is a SQLSTATE.
    expect(isTransactionConflict({ code: 'P2034', severity: 'ERROR' })).toBe(false);
  });

  it('is false for the violations that are answers, not contention', () => {
    expect(isTransactionConflict(prismaError('P2039', EXCLUSION_CAUSE))).toBe(false);
    expect(isTransactionConflict({ code: SQLSTATE.UNIQUE_VIOLATION, severity: 'ERROR' })).toBe(false);
    expect(isTransactionConflict(prismaError('P2028'))).toBe(false);
  });

  it('is false for anything that is not an error record', () => {
    for (const value of [undefined, null, 'P2034', 40, new Error('deadlock detected')]) {
      expect(isTransactionConflict(value)).toBe(false);
    }
  });
});
