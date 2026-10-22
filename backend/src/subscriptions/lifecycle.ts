import type { Prisma } from '@prisma/client';
import { addDays } from './plan.js';

/**
 * A photographer's subscription is born at APPROVAL, with its free trial, in the
 * approval's own transaction (marketplace-spec.md R5.1; marketplace-data-model.md
 * §3.7; photographers/moderation.ts). Nothing else creates one, except the
 * Phase 5 migration's backfill for photographers approved before it.
 *
 * At most one subscription per photographer (unique photographer_id) and one
 * trial per subscription (partial unique subscription_period_one_trial): a
 * photographer approved again later -- after a suspension and a return to
 * pending, say -- keeps the subscription they have and never gets a second
 * trial. The insert is `ON CONFLICT DO NOTHING` rather than a read first, so two
 * racing approvals cannot both create one.
 *
 * The trial starts at the approval's instant and lasts `platform_setting.trial_days`
 * as they stand at that moment: editing the trial later changes the trials of
 * later approvals only.
 */

export type TrialSubscription = {
  subscriptionId: string;
  /** False when the photographer already had a subscription: nothing was written. */
  created: boolean;
  /** The end of the subscription's current period: the new trial's end when created. */
  currentPeriodEndsAt: Date;
};

export async function createTrialSubscription(
  tx: Prisma.TransactionClient,
  photographerId: string,
  startsAt: Date,
  trialDays: number,
): Promise<TrialSubscription> {
  // CHECK platform_setting_trial_days_positive keeps this a real period; refuse
  // anything else here too, rather than let subscription_period_range_valid fail the approval.
  if (!Number.isInteger(trialDays) || trialDays < 1) throw new Error(`A trial of ${trialDays} days is not a period`);
  const endsAt = addDays(startsAt, trialDays);

  const created = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO subscription (photographer_id, status, current_period_ends_at, created_at, updated_at)
    VALUES (${photographerId}::uuid, 'trialing', ${endsAt}::timestamptz, ${startsAt}::timestamptz, ${startsAt}::timestamptz)
    ON CONFLICT (photographer_id) DO NOTHING
    RETURNING id::text AS id`;
  const subscriptionId = created[0]?.id;
  if (subscriptionId === undefined) {
    const existing = await tx.subscription.findUniqueOrThrow({ where: { photographerId }, select: { id: true, currentPeriodEndsAt: true } });
    return { subscriptionId: existing.id, created: false, currentPeriodEndsAt: existing.currentPeriodEndsAt };
  }

  await tx.subscriptionPeriod.create({ data: { subscriptionId, kind: 'trial', priceRwf: 0, startsAt, endsAt, createdAt: startsAt } });
  return { subscriptionId, created: true, currentPeriodEndsAt: endsAt };
}
