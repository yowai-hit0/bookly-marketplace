import type { Response } from 'express';
import { z } from 'zod';
import { normalizePhone } from '../booking/phone.js';
import type { PaymentMethod } from '../payments/provider.js';
import type { PaymentRouting } from '../payments/routing.js';
import { parseOrReject } from './validation.js';

/**
 * The body of every pay route (the checkout, the guest booking page, the
 * account dashboard, the studio subscription): `{ method, phone }`, with what
 * else the route takes. Shared so the four cannot drift apart.
 *
 *  - `method` must be on offer (R3.1): one not enabled, or whose provider is
 *    unconfigured, is a 422 on `method`.
 *  - `phone` is the MoMo number to prompt, required for MoMo (absent: 400, as
 *    before cards) and normalised; a number no Rwandan format reads is a 422.
 *  - `method: 'card'` needs no phone (2026-10-30): the payer types the card
 *    into Flutterwave's modal. A phone sent along is stripped unread, as are
 *    unknown keys -- an amount, a status, a provider -- on every route.
 */

const PHONE_MAX_LENGTH = 40;

const phone = z
  .string()
  .max(PHONE_MAX_LENGTH)
  .refine((value) => normalizePhone(value) !== null, 'Invalid phone number')
  .transform((value) => normalizePhone(value) ?? value);

export type PaymentBody<Extra> = Extra & { method: PaymentMethod; phone: string };

/** A parser for a pay route's body: the body, or `undefined` once the 400 or 422 has been sent. */
export function paymentBodyParser<Shape extends z.ZodRawShape>(
  routing: PaymentRouting,
  extra: Shape,
): (input: unknown, res: Response) => PaymentBody<z.infer<z.ZodObject<Shape>>> | undefined {
  const method = z.string().refine((value) => routing.providerFor(value) !== undefined, 'Method not available');
  const withPhone = z.object({ ...extra, method, phone });
  const card = z.object({ ...extra, method });
  return (input, res) => {
    // A card not on offer is read as any other method, so its answer is exactly
    // what it was before cards: a 422 on `method` (and on `phone` if that is wrong too).
    const isCard =
      typeof input === 'object' && input !== null && (input as { method?: unknown }).method === 'card' && routing.providerFor('card') !== undefined;
    if (isCard) {
      const body = parseOrReject(card, input, res);
      return body === undefined ? undefined : ({ ...body, method: 'card', phone: '' } as PaymentBody<z.infer<z.ZodObject<Shape>>>);
    }
    // The method was refined against the routing above, so it is one on offer.
    const body = parseOrReject(withPhone, input, res);
    return body === undefined ? undefined : (body as unknown as PaymentBody<z.infer<z.ZodObject<Shape>>>);
  };
}
