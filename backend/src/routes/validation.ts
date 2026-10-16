import type { Response } from 'express';
import { z } from 'zod';
import { assertKigaliDate } from '../availability/engine.js';

/**
 * One rule for every admin write (plan.md Task 8):
 *
 * - **400 `invalid_request`** -- not the shape of a request: a wrong type, an
 *   unknown or missing key, a malformed date, or both or neither of two
 *   mutually exclusive keys.
 * - **422 `validation_failed`** -- the right shape carrying a value outside its
 *   rules: a fee rate above 1, a minute past 1440, a window that closes before
 *   it opens. Answered here, so the database's CHECK never surfaces as a 500.
 *
 * The split is read off zod's issue codes, so each schema states its rules once
 * instead of in a shape schema and a rules schema that could drift apart.
 * Mutual exclusion is therefore expressed as a union of strict objects, never
 * as a refinement: a refinement's issue is `custom`, which would read as 422.
 */
const RULE_ISSUE_CODES: ReadonlySet<string> = new Set(['too_small', 'too_big', 'custom']);

/**
 * The parsed body, or `undefined` once the rejection has been sent. The 422
 * names the offending fields so a form can mark them; it never echoes values.
 */
export function parseOrReject<T>(schema: z.ZodType<T>, input: unknown, res: Response): T | undefined {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  const { issues } = result.error;
  if (issues.every((issue) => RULE_ISSUE_CODES.has(issue.code))) {
    const fields = [...new Set(issues.map((issue) => issue.path.join('.')))];
    res.status(422).json({ error: 'validation_failed', fields });
  } else {
    res.status(400).json({ error: 'invalid_request' });
  }
  return undefined;
}

/**
 * A `YYYY-MM-DD` the engine can compute with. Past the format, this is the
 * engine's own check, which refuses years 0000-0099: `Date.UTC` reads those as
 * 1900-1999, so `0050-01-01` was silently stored as a block in 1949.
 */
export const kigaliDate = z.iso.date().refine((value) => {
  try {
    assertKigaliDate(value);
    return true;
  } catch {
    return false;
  }
}, 'Unsupported date');

/** The largest `integer` PostgreSQL stores; past it, a write raises 22003. */
export const INT4_MAX = 2_147_483_647;

/** A developer default, not a spec value: far above any real basket. */
export const MAX_ADDONS = 50;

/**
 * A basket's add-on ids, as the quote and a booking both take them (plan.md
 * Tasks 11 and 13): at most `MAX_ADDONS`, each once, absent meaning none.
 */
export const addonIds = z
  // Lowercased first: a uuid is case-insensitive, so `[id, ID]` is a repeat.
  .array(z.guid().transform((id) => id.toLowerCase()))
  .max(MAX_ADDONS)
  .refine((ids) => new Set(ids).size === ids.length, 'Each add-on at most once')
  .default([]);

/** numeric(4,3) would silently round a fourth decimal place; refuse it instead. */
function hasAtMostThreeDecimals(value: number): boolean {
  const thousandths = value * 1000;
  return Math.abs(thousandths - Math.round(thousandths)) < 1e-9;
}

/** A booking-fee rate as `numeric(4,3)` stores it: 0 to 1, three decimal places. */
export const feeRate = z
  .number()
  .min(0)
  .max(1)
  .refine(hasAtMostThreeDecimals, 'At most three decimal places');
