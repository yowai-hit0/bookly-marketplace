/**
 * What has happened to a booking, for its client's page (docs/prompts/client-access-and-admin-polish.md,
 * item 8): built from what the system already sent them -- the outbox is never
 * pruned, so it is the history -- plus money still owed and the photographer's
 * notes. Newest first.
 *
 * **No payload passes through.** Several hold the plaintext of an access token
 * (the confirmation, a resend, a session-fee request), so each kind copies an
 * explicit list of fields and nothing else, and a field that is not the shape
 * it should be drops the notice rather than guessing.
 */

export type ClientNotice =
  | { id: string; at: string; kind: 'reschedule'; data: { startsAt: string; endsAt: string; previousStartsAt: string; previousEndsAt: string } }
  | { id: string; at: string; kind: 'session_fee_request'; data: { amountRwf: number } }
  | { id: string; at: string; kind: 'payment_receipt'; data: { amountRwf: number } }
  | { id: string; at: string; kind: 'photo_delivery'; data: Record<string, never> }
  | { id: string; at: string; kind: 'cancelled_by_photographer'; data: Record<string, never> }
  | { id: string; at: string; kind: 'balance_due'; data: { amountRwf: number } }
  | { id: string; at: string; kind: 'note'; data: { body: string } };

export type NoticeSources = {
  /** This booking's outbox rows. */
  outbox: readonly { id: string; template: string | null; status: string; payload: unknown; createdAt: Date }[];
  /** Its notes not deleted. */
  notes: readonly { id: string; body: string; createdAt: Date; deletedAt: Date | null }[];
  /** What the booking still owes, and since when it has owed it on its page. */
  balance: { outstandingRwf: number; showing: boolean; since: Date };
};

export function clientNotices(sources: NoticeSources): ClientNotice[] {
  const notices: ClientNotice[] = [];

  for (const row of sources.outbox) {
    // A message withdrawn before it went is not something that happened.
    if (row.status === 'cancelled') continue;
    const notice = fromOutbox(row);
    if (notice !== null) notices.push(notice);
  }

  for (const note of sources.notes) {
    if (note.deletedAt !== null) continue;
    notices.push({ id: `note:${note.id}`, at: note.createdAt.toISOString(), kind: 'note', data: { body: note.body } });
  }

  if (sources.balance.showing && sources.balance.outstandingRwf > 0) {
    notices.push({
      // The amount is in the id: a new balance is a new notice, shown again.
      id: `balance:${sources.balance.outstandingRwf}`,
      at: sources.balance.since.toISOString(),
      kind: 'balance_due',
      data: { amountRwf: sources.balance.outstandingRwf },
    });
  }

  return notices.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

function fromOutbox(row: NoticeSources['outbox'][number]): ClientNotice | null {
  const payload = typeof row.payload === 'object' && row.payload !== null ? (row.payload as Record<string, unknown>) : {};
  const base = { id: `outbox:${row.id}`, at: row.createdAt.toISOString() };
  switch (row.template) {
    case 'reschedule': {
      const [startsAt, endsAt, previousStartsAt, previousEndsAt] = [payload.startsAt, payload.endsAt, payload.previousStartsAt, payload.previousEndsAt];
      if (!isInstant(startsAt) || !isInstant(endsAt) || !isInstant(previousStartsAt) || !isInstant(previousEndsAt)) return null;
      return { ...base, kind: 'reschedule', data: { startsAt, endsAt, previousStartsAt, previousEndsAt } };
    }
    case 'session_fee_request':
      return isAmount(payload.amountRwf) ? { ...base, kind: 'session_fee_request', data: { amountRwf: payload.amountRwf } } : null;
    case 'payment_receipt':
      return isAmount(payload.amountRwf) ? { ...base, kind: 'payment_receipt', data: { amountRwf: payload.amountRwf } } : null;
    case 'photo_delivery':
      return { ...base, kind: 'photo_delivery', data: {} };
    case 'cancellation':
      // The client's own cancellation is something they did, not news to them.
      return payload.cancelledBy === 'admin' ? { ...base, kind: 'cancelled_by_photographer', data: {} } : null;
    default:
      // Everything else is either not about what happened (a link, a confirmation
      // they have just used) or not theirs to see (the photographer's alerts).
      return null;
  }
}

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
