import { describe, expect, it } from 'vitest';
import { type NoticeSources, clientNotices } from './notices.js';

/**
 * The notices on a client's booking page (docs/prompts/client-access-and-admin-polish.md,
 * item 8). No database: the sources are what the view hands over.
 *
 * What is proven: each client-facing email becomes its notice with only its
 * allowlisted fields, so a token in any payload never comes through; withdrawn
 * messages, the photographer's own alerts, link emails and the client's own
 * cancellation make none; a payload of the wrong shape drops its notice; a
 * balance shows once the shoot is done, keyed by its amount; deleted notes do
 * not show; and everything is newest first.
 */

const TOKEN = 'Zx9Q2mT7vL4pR8sK1nB6yH3cF5dG0wJe';
const at = (iso: string) => new Date(iso);

function sources(extra: Partial<NoticeSources> = {}): NoticeSources {
  return { outbox: [], notes: [], balance: { outstandingRwf: 0, showing: false, since: at('2027-01-06T09:00:00Z') }, ...extra };
}

function row(id: string, template: string, payload: Record<string, unknown>, createdAt: string, status = 'done') {
  return { id, template, status, payload: { ...payload, accessToken: TOKEN, reference: 'BKY-2701-00042' }, createdAt: at(createdAt) };
}

describe('clientNotices', () => {
  it('turns each client-facing email into its notice, copying only its allowlisted fields', () => {
    const notices = clientNotices(
      sources({
        outbox: [
          row(
            'o1',
            'reschedule',
            { startsAt: '2027-01-08T07:00:00Z', endsAt: '2027-01-08T08:30:00Z', previousStartsAt: '2027-01-06T07:00:00Z', previousEndsAt: '2027-01-06T08:30:00Z', locationText: 'secret place' },
            '2027-01-02T10:00:00Z',
          ),
          row('o2', 'session_fee_request', { amountRwf: 30_000, clientName: 'Aline' }, '2027-01-03T10:00:00Z'),
          row('o3', 'payment_receipt', { amountRwf: 30_000, paymentReference: 'MOMO-1', kind: 'session_fee' }, '2027-01-04T10:00:00Z'),
          row('o4', 'photo_delivery', { deliveryUrl: 'https://photos.example/x', expiresOn: '2027-04-01' }, '2027-01-05T10:00:00Z'),
          row('o5', 'cancellation', { cancelledBy: 'admin', reason: 'unwell' }, '2027-01-06T10:00:00Z'),
        ],
      }),
    );

    expect(notices).toEqual([
      { id: 'outbox:o5', at: '2027-01-06T10:00:00.000Z', kind: 'cancelled_by_photographer', data: {} },
      { id: 'outbox:o4', at: '2027-01-05T10:00:00.000Z', kind: 'photo_delivery', data: {} },
      { id: 'outbox:o3', at: '2027-01-04T10:00:00.000Z', kind: 'payment_receipt', data: { amountRwf: 30_000 } },
      { id: 'outbox:o2', at: '2027-01-03T10:00:00.000Z', kind: 'session_fee_request', data: { amountRwf: 30_000 } },
      {
        id: 'outbox:o1',
        at: '2027-01-02T10:00:00.000Z',
        kind: 'reschedule',
        data: { startsAt: '2027-01-08T07:00:00Z', endsAt: '2027-01-08T08:30:00Z', previousStartsAt: '2027-01-06T07:00:00Z', previousEndsAt: '2027-01-06T08:30:00Z' },
      },
    ]);
    const serialised = JSON.stringify(notices);
    for (const leak of [TOKEN, 'secret place', 'MOMO-1', 'photos.example', 'unwell', 'Aline', 'BKY-2701-00042']) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('makes none from withdrawn messages, the photographer’s alerts, link emails or the client’s own cancellation', () => {
    const notices = clientNotices(
      sources({
        outbox: [
          row('c1', 'session_fee_request', { amountRwf: 1 }, '2027-01-01T10:00:00Z', 'cancelled'),
          row('a1', 'admin_alert', { variant: 'payment_received' }, '2027-01-01T10:00:00Z'),
          row('a2', 'admin_new_booking', {}, '2027-01-01T10:00:00Z'),
          row('l1', 'booking_confirmation', {}, '2027-01-01T10:00:00Z'),
          row('l2', 'access_link_resend', {}, '2027-01-01T10:00:00Z'),
          row('l3', 'booking_links', {}, '2027-01-01T10:00:00Z'),
          row('e1', 'email_change_confirm', {}, '2027-01-01T10:00:00Z'),
          row('x1', 'cancellation', { cancelledBy: 'client' }, '2027-01-01T10:00:00Z'),
          { id: 'g1', template: null, status: 'done', payload: {}, createdAt: at('2027-01-01T10:00:00Z') },
        ],
      }),
    );

    expect(notices).toEqual([]);
  });

  it('keeps a message still sending or one that failed: it happened either way', () => {
    const notices = clientNotices(
      sources({
        outbox: [
          row('p1', 'photo_delivery', {}, '2027-01-01T10:00:00Z', 'pending'),
          row('f1', 'photo_delivery', {}, '2027-01-02T10:00:00Z', 'failed'),
        ],
      }),
    );

    expect(notices.map((notice) => notice.id)).toEqual(['outbox:f1', 'outbox:p1']);
  });

  it('drops a notice whose payload is not the shape it should be', () => {
    const notices = clientNotices(
      sources({
        outbox: [
          row('b1', 'session_fee_request', { amountRwf: '30000' }, '2027-01-01T10:00:00Z'),
          row('b2', 'reschedule', { startsAt: 'soon' }, '2027-01-01T10:00:00Z'),
          { id: 'b3', template: 'payment_receipt', status: 'done', payload: null, createdAt: at('2027-01-01T10:00:00Z') },
        ],
      }),
    );

    expect(notices).toEqual([]);
  });

  it('shows money still owed once the shoot is done, keyed by its amount', () => {
    const owed = clientNotices(sources({ balance: { outstandingRwf: 33_000, showing: true, since: at('2027-01-06T09:00:00Z') } }));
    expect(owed).toEqual([{ id: 'balance:33000', at: '2027-01-06T09:00:00.000Z', kind: 'balance_due', data: { amountRwf: 33_000 } }]);

    expect(clientNotices(sources({ balance: { outstandingRwf: 33_000, showing: false, since: at('2027-01-06T09:00:00Z') } }))).toEqual([]);
    expect(clientNotices(sources({ balance: { outstandingRwf: 0, showing: true, since: at('2027-01-06T09:00:00Z') } }))).toEqual([]);
  });

  it('shows the photographer’s notes, never a deleted one', () => {
    const notices = clientNotices(
      sources({
        notes: [
          { id: 'n1', body: 'Bring a jacket.', createdAt: at('2027-01-05T10:00:00Z'), deletedAt: null },
          { id: 'n2', body: 'Withdrawn.', createdAt: at('2027-01-05T11:00:00Z'), deletedAt: at('2027-01-05T12:00:00Z') },
        ],
      }),
    );

    expect(notices).toEqual([{ id: 'note:n1', at: '2027-01-05T10:00:00.000Z', kind: 'note', data: { body: 'Bring a jacket.' } }]);
  });
});
