import type { PayoutMethod, Prisma, PrismaClient } from '@prisma/client';
import { type AuthDeps, verifyCurrentPassword } from '../auth/account-auth.js';
import { enqueue } from '../outbox/enqueue.js';

/**
 * The photographer's payout destination (marketplace-spec.md R4.1, T4.4;
 * marketplace-data-model.md §3.8): MoMo (network, number, account name) or bank
 * (bank, account number, account name).
 *
 * Immutable. A change retires the current row and inserts a new one, in one
 * transaction, so every payout keeps naming the destination it was built for,
 * and `payout_method_one_current` holds at every instant. Redirecting payouts
 * is what an account takeover would aim for, so a change:
 *
 *   - requires the current password (`verifyCurrentPassword`: a wrong one is
 *     403 and counts toward the login lockout);
 *   - emails the photographer `account_security_alert` (`payout_method_changed`),
 *     to their login address, in the same transaction;
 *   - is flagged on the platform's payouts screen for 72 hours
 *     (payouts/payouts.ts, `METHOD_CHANGE_FLAG_HOURS`).
 *
 * The first method a photographer saves goes through exactly the same path:
 * a destination appearing is as worth knowing about as one changing.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export const MOMO_NETWORKS = ['mtn', 'airtel'] as const;
export type MomoNetwork = (typeof MOMO_NETWORKS)[number];
export const PAYOUT_METHOD_KINDS = ['momo', 'bank'] as const;

/**
 * Rwanda's mobile prefixes per network: MTN 078 and 079, Airtel 072 and 073. A
 * number on the other network's prefix is a typo the transfer would fail on.
 */
export const MOMO_PREFIXES: Record<MomoNetwork, readonly string[]> = { mtn: ['+25078', '+25079'], airtel: ['+25072', '+25073'] };

/** E.164 Rwandan mobile: `+2507` then a network digit then 7 digits. CHECK payout_method_momo_number_e164. */
export const RWANDA_MOBILE_E164 = /^\+2507[2389]\d{7}$/;

export type PayoutMethodInput =
  | { kind: 'momo'; momoNetwork: MomoNetwork; momoNumber: string; accountName: string }
  | { kind: 'bank'; bankName: string; bankAccountNumber: string; accountName: string };

/** The method as the studio and the platform show it. */
export type PayoutMethodView = {
  id: string;
  kind: string;
  momoNetwork: string | null;
  momoNumber: string | null;
  bankName: string | null;
  bankAccountNumber: string | null;
  accountName: string;
  createdAt: string;
};

export function payoutMethodView(method: PayoutMethod): PayoutMethodView {
  return {
    id: method.id,
    kind: method.kind,
    momoNetwork: method.momoNetwork,
    momoNumber: method.momoNumber,
    bankName: method.bankName,
    bankAccountNumber: method.bankAccountNumber,
    accountName: method.accountName,
    createdAt: method.createdAt.toISOString(),
  };
}

/**
 * The destination as an email names it: the network or bank, and only the last
 * four digits. A security alert that went to the wrong inbox must not hand over
 * the number.
 */
export function maskedDestination(method: Pick<PayoutMethod, 'kind' | 'momoNetwork' | 'momoNumber' | 'bankName' | 'bankAccountNumber'>): {
  kind: 'momo' | 'bank';
  provider: string;
  last4: string;
} {
  const digits = (method.kind === 'momo' ? method.momoNumber : method.bankAccountNumber) ?? '';
  return {
    kind: method.kind === 'momo' ? 'momo' : 'bank',
    provider: method.kind === 'momo' ? (method.momoNetwork ?? 'mtn') : (method.bankName ?? ''),
    last4: digits.replace(/[^0-9A-Za-z]/g, '').slice(-4),
  };
}

export async function currentPayoutMethod(db: Db, photographerId: string): Promise<PayoutMethod | null> {
  return db.payoutMethod.findFirst({ where: { photographerId, retiredAt: null } });
}

export type ChangePayoutMethodResult =
  | { status: 'ok'; method: PayoutMethod }
  /** The current password was wrong (403). Counted toward the lockout. */
  | { status: 'invalid_password' }
  /** Locked by failed attempts, here or at the login (403). Nothing was checked. */
  | { status: 'password_locked' };

export type ChangePayoutMethodDeps = AuthDeps;

/** The signed-in photographer, from the token: never the request. */
export type PayoutMethodOwner = {
  photographerId: string;
  user: { id: string; email: string; passwordHash: string | null; emailVerifiedAt: Date | null };
};

export async function changePayoutMethod(
  deps: ChangePayoutMethodDeps,
  owner: PayoutMethodOwner,
  input: PayoutMethodInput,
  currentPassword: string,
): Promise<ChangePayoutMethodResult> {
  const check = await verifyCurrentPassword(deps, 'studio', owner.user, currentPassword);
  if (check === 'invalid_password') return { status: 'invalid_password' };
  if (check === 'locked') return { status: 'password_locked' };

  const now = deps.now();
  const method = await deps.prisma.$transaction(async (tx) => {
    // One change at a time per photographer: two saves at once queue here, so
    // the second retires the first's row instead of tripping payout_method_one_current.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('bookly.payout_method:' || ${owner.photographerId}::text))`;
    const retired = await tx.payoutMethod.updateMany({
      where: { photographerId: owner.photographerId, retiredAt: null },
      data: { retiredAt: now },
    });
    const created = await tx.payoutMethod.create({
      data: {
        photographerId: owner.photographerId,
        kind: input.kind,
        momoNetwork: input.kind === 'momo' ? input.momoNetwork : null,
        momoNumber: input.kind === 'momo' ? input.momoNumber : null,
        bankName: input.kind === 'bank' ? input.bankName : null,
        bankAccountNumber: input.kind === 'bank' ? input.bankAccountNumber : null,
        accountName: input.accountName,
        createdAt: now,
      },
    });
    // Account mail (marketplace-data-model.md §2.14): to the login, with no
    // photographer_id. One per change, keyed by the new row.
    await enqueue(tx, {
      kind: 'email',
      template: 'account_security_alert',
      recipient: owner.user.email,
      dedupeKey: `email:account_security_alert:payout_method_changed:${created.id}`,
      payload: {
        variant: 'payout_method_changed',
        area: 'studio',
        replaced: retired.count > 0,
        changedAt: now.toISOString(),
        destination: maskedDestination(created),
      },
    });
    return created;
  });
  return { status: 'ok', method };
}
