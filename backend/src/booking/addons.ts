import type { Prisma, PrismaClient } from '@prisma/client';
import { type AdminBooking, findAdminBooking } from './admin-view.js';
import { bookingTotals } from './totals.js';

/**
 * Post-shoot add-ons (plan.md Task 20; spec §3.5 step 2, §6.15): the extra
 * photos, prints and hours agreed at the shoot itself, added to the booking
 * once it is `completed`.
 *
 * They are snapshots, exactly as the at-booking add-ons are (spec §6.13): the
 * name and unit price are copied from the catalogue as they stand when the
 * photographer adds them, so editing or deactivating that add-on later never
 * rewrites a booking's history or its total. `amount_rwf` is the product the
 * database CHECK insists on, so `bookingTotals()` can sum one column.
 *
 * Adding one raises `grandTotalRwf`, and with it what is outstanding -- there
 * is no stored total to fall out of step (data-model_v2.md §6.1), which is the
 * v1 under-reporting bug made impossible rather than fixed.
 *
 * Removing one is for the mistake just made, not for unwinding money: an
 * add-on the client has already paid for cannot be dropped, because that would
 * silently turn their payment into an overpayment nobody was told about. The
 * booking row is locked while the totals are read, so two edits at once cannot
 * each see the other's money as unspent.
 */

export type AddonEditDeps = { prisma: PrismaClient; now: () => Date };

/** Enough for "20 extra prints"; a typo of 10,000 is not an add-on. */
export const ADDON_MAX_QUANTITY = 99;

/**
 * The largest amount the money columns hold: `booking_addon.amount_rwf` and
 * `payment.amount_rwf` are both `integer`.
 *
 * The catalogue accepts a price up to this on its own, and a quantity up to 99
 * is legal, so the product of two legal values is not. Refused here, where it
 * can be answered, rather than reaching PostgreSQL as a 22003 and surfacing as
 * a 500 (routes/validation.ts).
 */
const MAX_AMOUNT_RWF = 2_147_483_647;

export type AddonEditResult =
  | { status: 'ok'; booking: AdminBooking }
  | { status: 'not_found' }
  /** Not a completed booking, not a post-shoot line, or not an add-on he sells. */
  | { status: 'not_allowed' }
  /** The line, or the booking it would make, is worth more than the money columns hold. */
  | { status: 'too_large' }
  /** Removing it would leave the client having paid more than the booking is worth. */
  | { status: 'already_paid' };

type Outcome = Exclude<AddonEditResult, { status: 'ok' }>['status'] | 'ok';

type LockedBooking = { id: string; status: string; serviceId: string; packagePriceRwf: number; startsAt: Date };

/**
 * Adds one catalogue add-on to a booking whose shoot has begun, at the price
 * it is sold for now and the quantity agreed. Since 2026-09-27 that is while
 * it is `confirmed` -- add-ons come before completion, which needs everything
 * paid -- and never once it is `completed`.
 */
export async function addPostShootAddon(
  deps: AddonEditDeps,
  bookingId: string,
  request: { addonId: string; quantity: number },
): Promise<AddonEditResult> {
  const outcome = await deps.prisma.$transaction(async (tx): Promise<Outcome> => {
    const booking = await lockBooking(tx, bookingId);
    if (booking === null) return 'not_found';
    if (!editable(booking, deps.now())) return 'not_allowed';

    const addon = await tx.addon.findUnique({ where: { id: request.addonId } });
    if (addon === null) return 'not_found';
    // Only something he sells today, and only where this service can sell it.
    if (!addon.isActive) return 'not_allowed';
    if (addon.serviceId !== null && addon.serviceId !== booking.serviceId) return 'not_allowed';
    if (request.quantity < 1 || request.quantity > ADDON_MAX_QUANTITY) return 'not_allowed';

    const amountRwf = addon.priceRwf * request.quantity;
    const lines = await tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { amountRwf: true } });
    const total = lines.reduce((sum, line) => sum + line.amountRwf, booking.packagePriceRwf);
    // Neither the line nor the booking it makes may outgrow the columns that
    // have to hold them -- including the payment that would collect it.
    if (amountRwf > MAX_AMOUNT_RWF || total + amountRwf > MAX_AMOUNT_RWF) return 'too_large';

    await tx.bookingAddon.create({
      data: {
        bookingId: booking.id,
        addonId: addon.id,
        // The catalogue as it reads now; the catalogue may change tomorrow.
        nameSnapshot: addon.nameEn,
        unitPriceRwf: addon.priceRwf,
        quantity: request.quantity,
        amountRwf,
        stage: 'post_shoot',
      },
    });
    return 'ok';
  });

  return finish(deps, bookingId, outcome);
}

/** Takes one post-shoot line off again, while nobody has paid for it. */
export async function removePostShootAddon(deps: AddonEditDeps, bookingId: string, bookingAddonId: string): Promise<AddonEditResult> {
  const outcome = await deps.prisma.$transaction(async (tx): Promise<Outcome> => {
    const booking = await lockBooking(tx, bookingId);
    if (booking === null) return 'not_found';
    if (!editable(booking, deps.now())) return 'not_allowed';

    const line = await tx.bookingAddon.findUnique({ where: { id: bookingAddonId } });
    if (line === null || line.bookingId !== booking.id) return 'not_found';
    // What the client chose and paid a booking fee on is not his to delete.
    if (line.stage !== 'post_shoot') return 'not_allowed';

    const [addons, payments] = await Promise.all([
      tx.bookingAddon.findMany({ where: { bookingId: booking.id }, select: { stage: true, amountRwf: true } }),
      tx.payment.findMany({ where: { bookingId: booking.id }, select: { status: true, amountRwf: true } }),
    ]);
    const totals = bookingTotals(booking, addons, payments);
    // Money already in hand for it: dropping the line would make a payment the
    // client made into an overpayment, and only a refund can undo that (§6.16).
    if (totals.grandTotalRwf - line.amountRwf < totals.collectedRwf) return 'already_paid';

    await tx.bookingAddon.delete({ where: { id: line.id } });
    return 'ok';
  });

  return finish(deps, bookingId, outcome);
}

/** Open once the shoot has begun, while the booking is still `confirmed` (2026-09-27). */
function editable(booking: LockedBooking, now: Date): boolean {
  return booking.status === 'confirmed' && booking.startsAt <= now;
}

/** The booking row, held for the length of the edit so its totals cannot move. */
async function lockBooking(tx: Prisma.TransactionClient, bookingId: string): Promise<LockedBooking | null> {
  const rows = await tx.$queryRaw<{ id: string; status: string; service_id: string; package_price_rwf: number; starts_at: Date }[]>`
    SELECT id::text AS id, status, service_id::text AS service_id, package_price_rwf, starts_at
      FROM booking
     WHERE id = ${bookingId}::uuid
       FOR UPDATE`;
  const row = rows[0];
  if (row === undefined) return null;
  return { id: row.id, status: row.status, serviceId: row.service_id, packagePriceRwf: row.package_price_rwf, startsAt: row.starts_at };
}

/** Every edit answers with the booking as it now stands, refusals included. */
async function finish(deps: AddonEditDeps, bookingId: string, outcome: Outcome): Promise<AddonEditResult> {
  if (outcome !== 'ok') return { status: outcome };
  const booking = await findAdminBooking(deps.prisma, bookingId);
  return booking === null ? { status: 'not_found' } : { status: 'ok', booking };
}
