import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connect, firstRow, sqlstateOf, truncateAll } from '../test/database.js';
import { BOOKING_STATUSES, OCCUPYING_STATUSES } from './statuses.js';

/**
 * The schema tests. Prisma cannot report that a constraint went missing; a
 * query against pg_constraint can, and that is what this file is for
 * (data-model_v2.md 2.1, rule 3).
 */

let db: pg.Client;

beforeAll(async () => {
  db = connect();
  await db.connect();
});

afterAll(async () => {
  await db.end();
});

beforeEach(async () => {
  await truncateAll(db);
});

// --- Fixtures ---------------------------------------------------------------

const APPLICATION_TABLE_COUNT = 14;

async function insertCatalogue() {
  const service = await db.query<{ id: string }>(
    `INSERT INTO service (slug, name_en) VALUES ('portrait', 'Portrait') RETURNING id`,
  );
  const pkg = await db.query<{ id: string }>(
    `INSERT INTO package (service_id, name_en, price_rwf, photo_count, duration_minutes)
     VALUES ($1, 'Standard', 40000, 20, 60) RETURNING id`,
    [firstRow(service).id],
  );
  const client = await db.query<{ id: string }>(
    `INSERT INTO client (full_name, email, phone)
     VALUES ('Aline Uwase', 'aline@example.com', '+250788000000') RETURNING id`,
  );
  return { serviceId: firstRow(service).id, packageId: firstRow(pkg).id, clientId: firstRow(client).id };
}

type BookingOverrides = {
  status?: string;
  startsAt: string;
  endsAt: string;
  bufferEndsAt: string;
};

async function insertBooking(
  ids: { serviceId: string; packageId: string; clientId: string },
  reference: string,
  { status = 'confirmed', startsAt, endsAt, bufferEndsAt }: BookingOverrides,
) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO booking (
       reference, client_id, service_id, package_id,
       contact_name, contact_email, contact_phone,
       service_name_snapshot, package_name_snapshot,
       package_price_rwf, package_duration_minutes, package_photo_count,
       status, starts_at, ends_at, buffer_ends_at,
       location_text, consent_at, booking_fee_rate, booking_fee_rwf
     ) VALUES (
       $1, $2, $3, $4,
       'Aline Uwase', 'aline@example.com', '+250788000000',
       'Portrait', 'Standard',
       40000, 60, 20,
       $5, $6, $7, $8,
       'Kigali Heights', now(), 0.400, 16000
     ) RETURNING id`,
    [reference, ids.clientId, ids.serviceId, ids.packageId, status, startsAt, endsAt, bufferEndsAt],
  );
  return firstRow(result).id;
}

/** 09:00-10:00 Kigali on a Wednesday, buffer to 10:30. */
const NINE = '2026-10-07T07:00:00Z';
const TEN = '2026-10-07T08:00:00Z';
const TEN_THIRTY = '2026-10-07T08:30:00Z';
const ELEVEN = '2026-10-07T09:00:00Z';
const ELEVEN_THIRTY = '2026-10-07T09:30:00Z';
const NOON = '2026-10-07T10:00:00Z';

// --- Shape ------------------------------------------------------------------

describe('the schema', () => {
  it('has 14 application tables (booking_note since 2026-09-25) plus Prisma migration history, and no view', async () => {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables.rowCount).toBe(APPLICATION_TABLE_COUNT + 1);
    expect(tables.rows.map((r) => r.tablename)).toContain('_prisma_migrations');

    // There is no booking_totals view. Totals are one function (6.1), because a
    // view could not express "nothing is owed on a no-show".
    const views = await db.query(`SELECT viewname FROM pg_views WHERE schemaname = 'public'`);
    expect(views.rowCount).toBe(0);
  });
});

// --- Constraint existence ---------------------------------------------------

describe('the constraints Prisma cannot see', () => {
  it('still has booking_no_overlap, by name', async () => {
    const result = await db.query<{ contype: string }>(
      `SELECT contype FROM pg_constraint WHERE conname = 'booking_no_overlap'`,
    );
    expect(result.rowCount).toBe(1);
    // 'x' is an exclusion constraint. A unique or check constraint by this name
    // would pass a naive existence test while preventing nothing.
    expect(firstRow(result).contype).toBe('x');
  });

  it.each([
    'payment_provider_ref_unique',
    'payment_one_succeeded_booking_fee',
    'working_hours_weekday_unique',
    'working_hours_effective_date_unique',
  ])('still has partial unique index %s, by name', async (indexName) => {
    const result = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [indexName],
    );
    expect(result.rowCount).toBe(1);
    expect(firstRow(result).indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(firstRow(result).indexdef).toMatch(/WHERE/);
  });

  it('has the functional unique indexes that make email case-insensitive', async () => {
    const result = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('admin_user_lower_email_unique', 'client_lower_email_unique')`,
    );
    expect(result.rowCount).toBe(2);
  });
});

// --- The status list agreement ---------------------------------------------

describe('the exclusion predicate and the code vocabulary', () => {
  it('list exactly the same occupying statuses', async () => {
    const result = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'booking_no_overlap'`,
    );
    const predicate = firstRow(result).def.split('WHERE')[1] ?? '';
    const inPredicate = [...predicate.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();

    expect(inPredicate).toEqual([...OCCUPYING_STATUSES].sort());
  });

  it('draw every occupying status from the status CHECK, so neither can drift alone', async () => {
    const result = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'booking_status_allowed'`,
    );
    const inCheck = [...firstRow(result).def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();

    expect(inCheck).toEqual([...BOOKING_STATUSES].sort());
    for (const status of OCCUPYING_STATUSES) {
      expect(inCheck).toContain(status);
    }
  });
});

// --- Overlap ----------------------------------------------------------------

describe('booking_no_overlap', () => {
  it('refuses a booking that starts inside the previous one buffer', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    const code = await sqlstateOf(db, () =>
      insertBooking(ids, 'BKY-2610-BBBBB', {
        startsAt: TEN,
        endsAt: ELEVEN,
        bufferEndsAt: ELEVEN_THIRTY,
      }),
    );

    expect(code).toBe('23P01');
  });

  it('accepts a booking that starts exactly at the buffer end', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    await insertBooking(ids, 'BKY-2610-CCCCC', {
      startsAt: TEN_THIRTY,
      endsAt: ELEVEN_THIRTY,
      bufferEndsAt: NOON,
    });

    const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM booking');
    expect(firstRow(count).n).toBe('2');
  });

  it('releases the slot and its buffer the instant a booking is cancelled', async () => {
    const ids = await insertCatalogue();
    const first = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    await db.query(`UPDATE booking SET status = 'cancelled_by_client' WHERE id = $1`, [first]);

    await insertBooking(ids, 'BKY-2610-BBBBB', {
      startsAt: TEN,
      endsAt: ELEVEN,
      bufferEndsAt: ELEVEN_THIRTY,
    });

    const live = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM booking WHERE status = 'confirmed'`,
    );
    expect(firstRow(live).n).toBe('1');
  });

  it.each(OCCUPYING_STATUSES)('occupies the slot while status is %s', async (status) => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      status,
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    const code = await sqlstateOf(db, () =>
      insertBooking(ids, 'BKY-2610-BBBBB', {
        status: 'confirmed',
        startsAt: NINE,
        endsAt: TEN,
        bufferEndsAt: TEN_THIRTY,
      }),
    );

    expect(code).toBe('23P01');
  });

  it.each(['expired', 'cancelled_by_client', 'cancelled_by_admin'])(
    'frees the slot while status is %s',
    async (status) => {
      const ids = await insertCatalogue();
      await insertBooking(ids, 'BKY-2610-AAAAA', {
        status,
        startsAt: NINE,
        endsAt: TEN,
        bufferEndsAt: TEN_THIRTY,
      });

      await insertBooking(ids, 'BKY-2610-BBBBB', {
        status: 'confirmed',
        startsAt: NINE,
        endsAt: TEN,
        bufferEndsAt: TEN_THIRTY,
      });

      const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM booking');
      expect(firstRow(count).n).toBe('2');
    },
  );
});

// --- Money --------------------------------------------------------------------

describe('payment_one_succeeded_booking_fee', () => {
  it('refuses a second succeeded booking fee on one booking', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    const insertFee = () =>
      db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status)
         VALUES ($1, 'booking_fee', 'mtn_momo_direct', 16000, 'succeeded')`,
        [bookingId],
      );

    await insertFee();
    expect(await sqlstateOf(db, insertFee)).toBe('23505');
  });

  it('allows many succeeded session fees, which spec 6.15 requires', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    for (const amount of [24000, 15000]) {
      await db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status)
         VALUES ($1, 'session_fee', 'mtn_momo_direct', $2, 'succeeded')`,
        [bookingId, amount],
      );
    }

    const count = await db.query<{ n: string }>(
      `SELECT count(*) AS n FROM payment WHERE kind = 'session_fee'`,
    );
    expect(firstRow(count).n).toBe('2');
  });

  it('allows a failed attempt alongside a succeeded one', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    for (const status of ['failed', 'succeeded']) {
      await db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status)
         VALUES ($1, 'booking_fee', 'mtn_momo_direct', 16000, $2)`,
        [bookingId, status],
      );
    }

    const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM payment');
    expect(firstRow(count).n).toBe('2');
  });
});

describe('payment_provider_ref_unique', () => {
  it('refuses a duplicate provider_ref but tolerates many nulls', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    const insertWithRef = (ref: string | null) =>
      db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, provider_ref)
         VALUES ($1, 'session_fee', 'mtn_momo_direct', 1000, $2)`,
        [bookingId, ref],
      );

    await insertWithRef(null);
    await insertWithRef(null);
    await insertWithRef('MTN-123');
    expect(await sqlstateOf(db, () => insertWithRef('MTN-123'))).toBe('23505');
  });
});

// --- Webhook idempotency ------------------------------------------------------

describe('webhook_event', () => {
  it('refuses a duplicate delivery of one provider event', async () => {
    const insertEvent = () =>
      db.query(
        `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid)
         VALUES ('mtn_momo_direct', 'evt_1', 'payment.succeeded', true)`,
      );

    await insertEvent();
    expect(await sqlstateOf(db, insertEvent)).toBe('23505');
  });

  it('accepts the same event id from a different provider', async () => {
    await db.query(
      `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid)
       VALUES ('mtn_momo_direct', 'evt_1', 'payment.succeeded', true),
              ('flutterwave', 'evt_1', 'charge.completed', true)`,
    );
    const count = await db.query<{ n: string }>('SELECT count(*) AS n FROM webhook_event');
    expect(firstRow(count).n).toBe('2');
  });
});

// --- Nullability the erasure routine depends on -------------------------------

describe('the columns erasure nulls', () => {
  it('accepts null in client.phone, webhook_event.payload and outbox.payload', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    await db.query(
      `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid, payload)
       VALUES ('mtn_momo_direct', 'evt_1', 'payment.succeeded', true, '{"a":1}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO outbox (kind, booking_id, dedupe_key, template, recipient, payload)
       VALUES ('email', $1, 'email:booking_confirmation:1', 'booking_confirmation',
               'aline@example.com', '{"b":2}'::jsonb)`,
      [bookingId],
    );

    // This is the erasure routine's write path (data-model_v2.md 10.2). As NOT
    // NULL, every one of these raised 23502.
    await db.query(`UPDATE client SET phone = NULL`);
    await db.query(`UPDATE webhook_event SET payload = NULL`);
    await db.query(`UPDATE outbox SET payload = NULL, recipient = '[erased]'`);

    const nulls = await db.query<{ phone: string | null }>(
      `SELECT c.phone FROM client c
       WHERE c.phone IS NULL
         AND EXISTS (SELECT 1 FROM webhook_event WHERE payload IS NULL)
         AND EXISTS (SELECT 1 FROM outbox WHERE payload IS NULL)`,
    );
    expect(nulls.rowCount).toBe(1);
  });

  it('keeps consent_at NOT NULL, because it is the evidence erasure must not destroy', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    expect(await sqlstateOf(db, () => db.query(`UPDATE booking SET consent_at = NULL`))).toBe(
      '23502',
    );
  });
});

// --- A sample of the CHECK constraints ---------------------------------------

describe('CHECK constraints', () => {
  it('allows exactly one setting row', async () => {
    await db.query(`INSERT INTO setting (id) VALUES (1)`);
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO setting (id) VALUES (2)`)),
    ).toBe('23514');
  });

  it('refuses a working_hours row carrying both a weekday and a date', async () => {
    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO working_hours (weekday, effective_date, opens_minute, closes_minute)
           VALUES (3, '2026-10-10', 540, 1020)`,
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a working_hours row that closes before it opens', async () => {
    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO working_hours (weekday, opens_minute, closes_minute)
           VALUES (3, 1020, 540)`,
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a booking_addon whose amount is not unit price times quantity', async () => {
    const ids = await insertCatalogue();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });
    const addon = await db.query<{ id: string }>(
      `INSERT INTO addon (service_id, name_en, price_rwf) VALUES ($1, 'Extra prints', 5000) RETURNING id`,
      [ids.serviceId],
    );

    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO booking_addon (booking_id, addon_id, name_snapshot, unit_price_rwf, quantity, amount_rwf, stage)
           VALUES ($1, $2, 'Extra prints', 5000, 2, 5000, 'at_booking')`,
          [bookingId, firstRow(addon).id],
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a non-https delivery link', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    expect(
      await sqlstateOf(db, () =>
        db.query(`UPDATE booking SET delivery_url = 'http://drive.example/x'`),
      ),
    ).toBe('23514');

    await db.query(`UPDATE booking SET delivery_url = 'https://drive.example/x'`);
  });

  it('refuses an outbox template that no email will ever render', async () => {
    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO outbox (kind, dedupe_key, template, recipient)
           VALUES ('email', 'email:booking_invite:1', 'booking_invite', 'x@example.com')`,
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a booking status outside the vocabulary', async () => {
    const ids = await insertCatalogue();
    expect(
      await sqlstateOf(db, () =>
        insertBooking(ids, 'BKY-2610-AAAAA', {
          status: 'declined',
          startsAt: NINE,
          endsAt: TEN,
          bufferEndsAt: TEN_THIRTY,
        }),
      ),
    ).toBe('23514');
  });
});

// --- Referential behaviour ----------------------------------------------------

describe('referential behaviour', () => {
  it('refuses to hard-delete a package a booking references', async () => {
    const ids = await insertCatalogue();
    await insertBooking(ids, 'BKY-2610-AAAAA', {
      startsAt: NINE,
      endsAt: TEN,
      bufferEndsAt: TEN_THIRTY,
    });

    expect(
      await sqlstateOf(db, () => db.query('DELETE FROM package WHERE id = $1', [ids.packageId])),
    ).toBe('23503');
  });

  it('matches an email case-insensitively when deduplicating clients', async () => {
    await db.query(`INSERT INTO client (full_name, email) VALUES ('Aline', 'Aline@Example.com')`);
    expect(
      await sqlstateOf(db, () =>
        db.query(`INSERT INTO client (full_name, email) VALUES ('Aline again', 'aline@example.com')`),
      ),
    ).toBe('23505');
  });
});
