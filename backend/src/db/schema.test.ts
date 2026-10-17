import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APPLICATION_TABLES, REFERENCE_TABLES, connect, firstRow, sqlstateOf, truncateAll } from '../test/database.js';
import { BOOKING_STATUSES, OCCUPYING_STATUSES } from './statuses.js';

/**
 * The schema tests. Prisma cannot report that a constraint went missing; a
 * query against pg_constraint can, and that is what this file is for
 * (data-model_v2.md 2.1, rule 3; marketplace-data-model.md §7, T1.1).
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

/**
 * The 14 single-photographer tables, less `admin_user` and `setting`, plus the
 * nine Phase 1 adds (marketplace-spec.md brief decision 1), plus Phase 2's
 * `oauth_flow` (decision 6). Subscriptions and payouts take it to 27 in later
 * phases.
 */
const APPLICATION_TABLE_COUNT = 22;

/** Tables a later phase adds; Phase 1's baseline must not. */
const LATER_PHASE_TABLES = ['subscription', 'subscription_period', 'payout_method', 'payout', 'payout_item'];

type Ids = { photographerId: string; serviceId: string; packageId: string; clientId: string };

/** An approved photographer with their login and settings row, as approval leaves them. */
async function insertPhotographer(handle = 'studio-a'): Promise<string> {
  const user = await db.query<{ id: string }>(
    `INSERT INTO app_user (email, role, password_hash) VALUES ($1, 'photographer', 'x') RETURNING id`,
    [`${handle}@example.com`],
  );
  const photographer = await db.query<{ id: string }>(
    `INSERT INTO photographer (user_id, handle, display_name, status, approved_at)
     VALUES ($1, $2, $2, 'approved', now()) RETURNING id`,
    [firstRow(user).id, handle],
  );
  const photographerId = firstRow(photographer).id;
  await db.query(`INSERT INTO photographer_setting (photographer_id) VALUES ($1)`, [photographerId]);
  return photographerId;
}

/** One service and one package, both the photographer's. */
async function insertCatalogue(photographerId: string) {
  const service = await db.query<{ id: string }>(
    `INSERT INTO service (photographer_id, slug, name_en) VALUES ($1, 'portrait', 'Portrait') RETURNING id`,
    [photographerId],
  );
  const pkg = await db.query<{ id: string }>(
    `INSERT INTO package (photographer_id, service_id, name_en, price_rwf, photo_count, duration_minutes)
     VALUES ($1, $2, 'Standard', 40000, 20, 60) RETURNING id`,
    [photographerId, firstRow(service).id],
  );
  return { photographerId, serviceId: firstRow(service).id, packageId: firstRow(pkg).id };
}

/** Platform-global: one per email whichever photographer is booked. */
async function insertClient(): Promise<string> {
  const client = await db.query<{ id: string }>(
    `INSERT INTO client (full_name, email, phone)
     VALUES ('Aline Uwase', 'aline@example.com', '+250788000000') RETURNING id`,
  );
  return firstRow(client).id;
}

/** A photographer, their catalogue and a client: the single-photographer world. */
async function insertWorld(handle = 'studio-a'): Promise<Ids> {
  const catalogue = await insertCatalogue(await insertPhotographer(handle));
  return { ...catalogue, clientId: await insertClient() };
}

/** A second photographer with a catalogue of their own, booking the same client. */
async function insertSecondWorld(first: Ids, handle = 'studio-b'): Promise<Ids> {
  const catalogue = await insertCatalogue(await insertPhotographer(handle));
  return { ...catalogue, clientId: first.clientId };
}

type BookingOverrides = {
  status?: string;
  startsAt: string;
  endsAt: string;
  bufferEndsAt: string;
};

async function insertBooking(
  ids: Ids,
  reference: string,
  { status = 'confirmed', startsAt, endsAt, bufferEndsAt }: BookingOverrides,
) {
  const result = await db.query<{ id: string }>(
    `INSERT INTO booking (
       reference, client_id, photographer_id, service_id, package_id,
       contact_name, contact_email, contact_phone,
       service_name_snapshot, package_name_snapshot,
       package_price_rwf, package_duration_minutes, package_photo_count,
       status, starts_at, ends_at, buffer_ends_at,
       location_text, consent_at, booking_fee_rate, booking_fee_rwf,
       client_cancel_cutoff_hours, booking_fee_refundable_on_client_cancel
     ) VALUES (
       $1, $2, $3, $4, $5,
       'Aline Uwase', 'aline@example.com', '+250788000000',
       'Portrait', 'Standard',
       40000, 60, 20,
       $6, $7, $8, $9,
       'Kigali Heights', now(), 0.400, 16000,
       0, false
     ) RETURNING id`,
    [reference, ids.clientId, ids.photographerId, ids.serviceId, ids.packageId, status, startsAt, endsAt, bufferEndsAt],
  );
  return firstRow(result).id;
}

async function countOf(table: string): Promise<number> {
  const result = await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
  return Number(firstRow(result).n);
}

/** 09:00-10:00 Kigali on a Wednesday, buffer to 10:30. */
const NINE = '2026-10-07T07:00:00Z';
const TEN = '2026-10-07T08:00:00Z';
const TEN_THIRTY = '2026-10-07T08:30:00Z';
const ELEVEN = '2026-10-07T09:00:00Z';
const ELEVEN_THIRTY = '2026-10-07T09:30:00Z';
const NOON = '2026-10-07T10:00:00Z';
const SLOT = { startsAt: NINE, endsAt: TEN, bufferEndsAt: TEN_THIRTY };

// --- Shape ------------------------------------------------------------------

describe('the schema', () => {
  it('has 22 application tables (Phase 1 of the marketplace, and Phase 2 oauth_flow) plus Prisma migration history, and no view', async () => {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
    );
    expect(tables.rowCount).toBe(APPLICATION_TABLE_COUNT + 1);
    // Exactly the tables the test helpers know about, so truncateAll misses none.
    expect(tables.rows.map((r) => r.tablename).sort()).toEqual(
      [...APPLICATION_TABLES, ...REFERENCE_TABLES, '_prisma_migrations'].sort(),
    );

    // There is no booking_totals view. Totals are one function (6.1), because a
    // view could not express "nothing is owed on a no-show".
    const views = await db.query(`SELECT viewname FROM pg_views WHERE schemaname = 'public'`);
    expect(views.rowCount).toBe(0);
  });

  it('leaves subscriptions and payouts to their own phases, and admin_user and setting behind', async () => {
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [[...LATER_PHASE_TABLES, 'admin_user', 'setting']],
    );
    expect(tables.rows).toEqual([]);
  });

  it('has btree_gist, which the per-photographer exclusion needs', async () => {
    const result = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`);
    expect(result.rowCount).toBe(1);
  });
});

// --- Constraint existence ---------------------------------------------------

describe('the constraints Prisma cannot see', () => {
  it('still has booking_no_overlap, by name, and it is per photographer', async () => {
    const result = await db.query<{ contype: string; def: string }>(
      `SELECT contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'booking_no_overlap'`,
    );
    expect(result.rowCount).toBe(1);
    // 'x' is an exclusion constraint. A unique or check constraint by this name
    // would pass a naive existence test while preventing nothing.
    expect(firstRow(result).contype).toBe('x');
    expect(firstRow(result).def).toMatch(/photographer_id WITH =/);
    expect(firstRow(result).def).toMatch(/tstzrange\(starts_at, buffer_ends_at, '\[\)'::text\) WITH &&/);
  });

  it.each([
    'payment_provider_ref_unique',
    'payment_one_succeeded_booking_fee',
    'working_hours_weekday_unique',
    'working_hours_effective_date_unique',
    'booking_pending_email_token_hash_unique',
    'app_user_google_sub_unique',
    'app_user_password_reset_token_hash_unique',
    'app_user_email_verify_token_hash_unique',
  ])('still has partial unique index %s, by name', async (indexName) => {
    const result = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [indexName],
    );
    expect(result.rowCount).toBe(1);
    expect(firstRow(result).indexdef).toMatch(/CREATE UNIQUE INDEX/);
    expect(firstRow(result).indexdef).toMatch(/WHERE/);
  });

  it('leads both working-hours uniques and the block range index with photographer_id', async () => {
    const result = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('working_hours_weekday_unique', 'working_hours_effective_date_unique', 'availability_block_range_idx')
       ORDER BY indexname`,
    );
    expect(result.rows.map((row) => row.indexname)).toEqual([
      'availability_block_range_idx',
      'working_hours_effective_date_unique',
      'working_hours_weekday_unique',
    ]);
    for (const row of result.rows) expect(row.indexdef).toMatch(/\(photographer_id, /);
    expect(result.rows[0]?.indexdef).toMatch(/USING gist/);
  });

  it('has the functional unique indexes that make email case-insensitive', async () => {
    const result = await db.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('app_user_lower_email_unique', 'client_lower_email_unique')`,
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

  it('renamed the single-photographer admin cancellation: the database refuses the old status now', async () => {
    const ids = await insertWorld();
    // Spelled in pieces so the retired name appears nowhere in the source tree.
    const retired = ['cancelled', 'by', 'admin'].join('_');
    expect(await sqlstateOf(db, () => insertBooking(ids, 'BKY-2610-AAAAA', { ...SLOT, status: retired }))).toBe('23514');
  });
});

// --- Overlap ----------------------------------------------------------------

describe('booking_no_overlap', () => {
  it('refuses a booking that starts inside the previous one buffer', async () => {
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

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
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    await insertBooking(ids, 'BKY-2610-CCCCC', {
      startsAt: TEN_THIRTY,
      endsAt: ELEVEN_THIRTY,
      bufferEndsAt: NOON,
    });

    expect(await countOf('booking')).toBe(2);
  });

  it('releases the slot and its buffer the instant a booking is cancelled', async () => {
    const ids = await insertWorld();
    const first = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

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
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', { ...SLOT, status });

    const code = await sqlstateOf(db, () => insertBooking(ids, 'BKY-2610-BBBBB', { ...SLOT, status: 'confirmed' }));

    expect(code).toBe('23P01');
  });

  it.each(BOOKING_STATUSES.filter((status) => !(OCCUPYING_STATUSES as readonly string[]).includes(status)))(
    'frees the slot while status is %s',
    async (status) => {
      const ids = await insertWorld();
      await insertBooking(ids, 'BKY-2610-AAAAA', { ...SLOT, status });

      await insertBooking(ids, 'BKY-2610-BBBBB', { ...SLOT, status: 'confirmed' });

      expect(await countOf('booking')).toBe(2);
    },
  );

  it('lets two photographers book the same range, and still refuses the same photographer twice (R1.2)', async () => {
    const a = await insertWorld('studio-a');
    const b = await insertSecondWorld(a, 'studio-b');

    await insertBooking(a, 'BKY-2610-AAAAA', SLOT);
    await insertBooking(b, 'BKY-2610-BBBBB', SLOT);
    expect(await countOf('booking')).toBe(2);

    expect(await sqlstateOf(db, () => insertBooking(a, 'BKY-2610-CCCCC', SLOT))).toBe('23P01');
    expect(await sqlstateOf(db, () => insertBooking(b, 'BKY-2610-DDDDD', SLOT))).toBe('23P01');
  });
});

// --- Tenancy: composite foreign keys and per-photographer uniqueness -------------

describe('one photographer per row (composite foreign keys)', () => {
  it("refuses a package on another photographer's service", async () => {
    const a = await insertWorld('studio-a');
    const b = await insertSecondWorld(a, 'studio-b');

    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO package (photographer_id, service_id, name_en, price_rwf, photo_count, duration_minutes)
           VALUES ($1, $2, 'Stolen', 1000, 1, 60)`,
          [b.photographerId, a.serviceId],
        ),
      ),
    ).toBe('23503');
  });

  it("refuses a booking of another photographer's package", async () => {
    const a = await insertWorld('studio-a');
    const b = await insertSecondWorld(a, 'studio-b');

    expect(await sqlstateOf(db, () => insertBooking({ ...b, packageId: a.packageId }, 'BKY-2610-AAAAA', SLOT))).toBe('23503');
  });

  it("refuses a booking of another photographer's service", async () => {
    const a = await insertWorld('studio-a');
    const b = await insertSecondWorld(a, 'studio-b');

    expect(await sqlstateOf(db, () => insertBooking({ ...b, serviceId: a.serviceId }, 'BKY-2610-AAAAA', SLOT))).toBe('23503');
  });

  it('accepts the same booking when everything is the one photographer', async () => {
    const a = await insertWorld('studio-a');
    await insertSecondWorld(a, 'studio-b');

    await insertBooking(a, 'BKY-2610-AAAAA', SLOT);
    expect(await countOf('booking')).toBe(1);
  });
});

describe('uniqueness per photographer', () => {
  it('allows one service slug under two photographers, and refuses it twice under one', async () => {
    const a = await insertWorld('studio-a');
    // insertSecondWorld's catalogue reuses the slug 'portrait'.
    const b = await insertSecondWorld(a, 'studio-b');
    expect(await countOf('service')).toBe(2);

    expect(
      await sqlstateOf(db, () =>
        db.query(`INSERT INTO service (photographer_id, slug, name_en) VALUES ($1, 'portrait', 'Again')`, [b.photographerId]),
      ),
    ).toBe('23505');
  });

  it('refuses a service slug that is not URL-safe: it is part of /p/<handle>/<slug>', async () => {
    const photographerId = await insertPhotographer();
    for (const slug of ['Portraits', 'portraits!', '-portraits', 'portraits-', 'two--hyphens']) {
      expect(
        await sqlstateOf(db, () => db.query(`INSERT INTO service (photographer_id, slug, name_en) VALUES ($1, $2, 'X')`, [photographerId, slug])),
      ).toBe('23514');
    }
  });

  it('allows one weekday rule per photographer, each', async () => {
    const a = await insertPhotographer('studio-a');
    const b = await insertPhotographer('studio-b');
    const insertRule = (photographerId: string) =>
      db.query(
        `INSERT INTO working_hours (photographer_id, weekday, opens_minute, closes_minute) VALUES ($1, 3, 540, 1020)`,
        [photographerId],
      );

    await insertRule(a);
    await insertRule(b);
    expect(await sqlstateOf(db, () => insertRule(a))).toBe('23505');
  });

  it('allows one dated override per photographer, each', async () => {
    const a = await insertPhotographer('studio-a');
    const b = await insertPhotographer('studio-b');
    const insertOverride = (photographerId: string) =>
      db.query(`INSERT INTO working_hours (photographer_id, effective_date, is_open) VALUES ($1, '2026-12-25', false)`, [photographerId]);

    await insertOverride(a);
    await insertOverride(b);
    expect(await sqlstateOf(db, () => insertOverride(a))).toBe('23505');
  });
});

// --- Money --------------------------------------------------------------------

describe('payment_one_succeeded_booking_fee', () => {
  it('refuses a second succeeded booking fee on one booking', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

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
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

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
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    for (const status of ['failed', 'succeeded']) {
      await db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status)
         VALUES ($1, 'booking_fee', 'mtn_momo_direct', 16000, $2)`,
        [bookingId, status],
      );
    }

    expect(await countOf('payment')).toBe(2);
  });
});

describe('payment_provider_ref_unique', () => {
  it('refuses a duplicate provider_ref but tolerates many nulls', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

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

describe('payment CHECKs', () => {
  it('takes cash as a session fee only (marketplace-data-model.md §2.11)', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const insertCash = (kind: string) =>
      db.query(
        `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status, note) VALUES ($1, $2, 'cash', 5000, 'succeeded', 'At the shoot')`,
        [bookingId, kind],
      );

    await insertCash('session_fee');
    expect(await sqlstateOf(db, () => insertCash('booking_fee'))).toBe('23514');
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
    expect(await countOf('webhook_event')).toBe(2);
  });
});

// --- Nullability the erasure routine depends on -------------------------------

describe('the columns erasure nulls', () => {
  it('accepts null in client.phone, webhook_event.payload and outbox.payload', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    await db.query(
      `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid, payload)
       VALUES ('mtn_momo_direct', 'evt_1', 'payment.succeeded', true, '{"a":1}'::jsonb)`,
    );
    await db.query(
      `INSERT INTO outbox (kind, booking_id, photographer_id, dedupe_key, template, recipient, payload)
       VALUES ('email', $1, $2, 'email:booking_confirmation:1', 'booking_confirmation',
               'aline@example.com', '{"b":2}'::jsonb)`,
      [bookingId, ids.photographerId],
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
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(await sqlstateOf(db, () => db.query(`UPDATE booking SET consent_at = NULL`))).toBe(
      '23502',
    );
  });
});

// --- Configuration -------------------------------------------------------------

describe('settings', () => {
  it('allows exactly one platform_setting row', async () => {
    await db.query(`INSERT INTO platform_setting (id) VALUES (1)`);
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO platform_setting (id) VALUES (2)`)),
    ).toBe('23514');
  });

  it('defaults the platform hold to 30 minutes and the trial to 30 days, and refuses a zero hold', async () => {
    const row = await db.query<{ hold_minutes: number; trial_days: number }>(`INSERT INTO platform_setting (id) VALUES (1) RETURNING hold_minutes, trial_days`);
    expect(firstRow(row)).toEqual({ hold_minutes: 30, trial_days: 30 });
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET hold_minutes = 0`))).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET trial_days = -1`))).toBe('23514');
  });

  it('gives a photographer the single-photographer defaults and the R1.8 cancellation policy', async () => {
    const photographerId = await insertPhotographer();
    const row = await db.query(`SELECT * FROM photographer_setting WHERE photographer_id = $1`, [photographerId]);
    expect(firstRow(row)).toMatchObject({
      booking_fee_rate: '0.400',
      min_lead_time_minutes: 120,
      buffer_minutes: 30,
      delivery_expiry_days: 90,
      client_cancel_cutoff_hours: 0,
      booking_fee_refundable_on_client_cancel: false,
    });
  });

  it.each([
    ['booking_fee_rate', '1.5'],
    ['booking_fee_rate', '-0.1'],
    ['min_lead_time_minutes', '-1'],
    ['buffer_minutes', '-1'],
    ['delivery_expiry_days', '0'],
    ['client_cancel_cutoff_hours', '-1'],
  ])('refuses photographer_setting.%s = %s', async (column, value) => {
    const photographerId = await insertPhotographer();
    expect(
      await sqlstateOf(db, () => db.query(`UPDATE photographer_setting SET ${column} = $1 WHERE photographer_id = $2`, [value, photographerId])),
    ).toBe('23514');
  });

  it('allows one settings row per photographer', async () => {
    const photographerId = await insertPhotographer();
    expect(await sqlstateOf(db, () => db.query(`INSERT INTO photographer_setting (photographer_id) VALUES ($1)`, [photographerId]))).toBe('23505');
  });
});

// --- Photographers and logins ----------------------------------------------------

describe('photographer CHECKs', () => {
  async function insertUser(email: string): Promise<string> {
    const user = await db.query<{ id: string }>(`INSERT INTO app_user (email, role, password_hash) VALUES ($1, 'photographer', 'x') RETURNING id`, [email]);
    return firstRow(user).id;
  }

  async function tryPhotographer(columns: Record<string, unknown>) {
    const userId = await insertUser(`p${Math.random().toString(36).slice(2)}@example.com`);
    const values = { user_id: userId, handle: 'good-handle', display_name: 'Good Name', ...columns };
    const names = Object.keys(values);
    return sqlstateOf(db, () =>
      db.query(`INSERT INTO photographer (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values)),
    );
  }

  it('accepts a well-formed pending photographer', async () => {
    expect(await tryPhotographer({})).toBeUndefined();
  });

  it.each(['ab', 'Aline', 'aline_studio', '-aline', 'aline-', 'a'.repeat(31), 'kigali lens'])('refuses the handle %s', async (handle) => {
    expect(await tryPhotographer({ handle })).toBe('23514');
  });

  it.each(['abc', 'kigali-lens', 'a1b', 'a'.repeat(30)])('accepts the handle %s', async (handle) => {
    expect(await tryPhotographer({ handle })).toBeUndefined();
  });

  it('keeps handles unique', async () => {
    expect(await tryPhotographer({ handle: 'kigali-lens' })).toBeUndefined();
    expect(await tryPhotographer({ handle: 'kigali-lens' })).toBe('23505');
  });

  it('refuses a status outside the vocabulary', async () => {
    expect(await tryPhotographer({ status: 'banned' })).toBe('23514');
  });

  it('refuses approved without an approval date, and suspended without a suspension date', async () => {
    expect(await tryPhotographer({ status: 'approved' })).toBe('23514');
    expect(await tryPhotographer({ status: 'suspended' })).toBe('23514');
    expect(await tryPhotographer({ status: 'approved', approved_at: new Date() })).toBeUndefined();
    expect(await tryPhotographer({ handle: 'other-one', status: 'suspended', suspended_at: new Date() })).toBeUndefined();
  });

  it('refuses a cover image that is not https, and an empty display name', async () => {
    expect(await tryPhotographer({ cover_image_url: 'http://img.example/x.jpg' })).toBe('23514');
    expect(await tryPhotographer({ display_name: '' })).toBe('23514');
    expect(await tryPhotographer({ cover_image_url: 'https://img.example/x.jpg' })).toBeUndefined();
  });

  it('gives each login at most one photographer', async () => {
    const userId = await insertUser('one@example.com');
    await db.query(`INSERT INTO photographer (user_id, handle, display_name) VALUES ($1, 'first-one', 'First')`, [userId]);
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO photographer (user_id, handle, display_name) VALUES ($1, 'second-one', 'Second')`, [userId])),
    ).toBe('23505');
  });

  it('refuses a portfolio image that is not https', async () => {
    const photographerId = await insertPhotographer();
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO portfolio_image (photographer_id, url) VALUES ($1, 'http://img.example/1.jpg')`, [photographerId])),
    ).toBe('23514');
    await db.query(`INSERT INTO portfolio_image (photographer_id, url) VALUES ($1, 'https://img.example/1.jpg')`, [photographerId]);
  });
});

describe('app_user CHECKs', () => {
  const insertUser = (columns: Record<string, unknown>) => {
    const values = { email: `u${Math.random().toString(36).slice(2)}@example.com`, ...columns };
    const names = Object.keys(values);
    return sqlstateOf(db, () =>
      db.query(`INSERT INTO app_user (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values)),
    );
  };

  it.each(['platform_admin', 'photographer', 'client'])('accepts the role %s with a password', async (role) => {
    expect(await insertUser({ role, password_hash: 'x' })).toBeUndefined();
  });

  it('refuses a role outside the vocabulary', async () => {
    expect(await insertUser({ role: 'admin', password_hash: 'x' })).toBe('23514');
  });

  it('accepts a Google-only client, with no password (R2.4)', async () => {
    expect(await insertUser({ role: 'client', google_sub: 'google-123' })).toBeUndefined();
  });

  it.each(['photographer', 'platform_admin'])('refuses Google sign-in for a %s: it is for clients only', async (role) => {
    expect(await insertUser({ role, password_hash: 'x', google_sub: 'google-123' })).toBe('23514');
  });

  it('refuses a login with no credential at all', async () => {
    expect(await insertUser({ role: 'client' })).toBe('23514');
  });

  it('keeps one account per Google identity', async () => {
    expect(await insertUser({ role: 'client', google_sub: 'google-123' })).toBeUndefined();
    expect(await insertUser({ role: 'client', google_sub: 'google-123' })).toBe('23505');
  });

  it('matches email case-insensitively across every role', async () => {
    expect(await insertUser({ email: 'Aline@Example.com', role: 'client', password_hash: 'x' })).toBeUndefined();
    expect(await insertUser({ email: 'aline@example.com', role: 'photographer', password_hash: 'x' })).toBe('23505');
  });

  it('refuses a token hash without its expiry, for both tokens', async () => {
    expect(await insertUser({ role: 'client', password_hash: 'x', password_reset_token_hash: 'h1' })).toBe('23514');
    expect(await insertUser({ role: 'client', password_hash: 'x', email_verify_token_hash: 'h2' })).toBe('23514');
    expect(await insertUser({ role: 'client', password_hash: 'x', email_verify_token_hash: 'h3', email_verify_expires_at: new Date() })).toBeUndefined();
  });

  it('starts token_version at 0 and refuses a negative one (Phase 2 decision 2)', async () => {
    expect(await insertUser({ role: 'client', password_hash: 'x', token_version: -1 })).toBe('23514');
    const email = `v${Math.random().toString(36).slice(2)}@example.com`;
    expect(await insertUser({ email, role: 'client', google_sub: `google-${email}` })).toBeUndefined();
    const row = await db.query<{ token_version: number }>('SELECT token_version FROM app_user WHERE email = $1', [email]);
    expect(row.rows).toEqual([{ token_version: 0 }]);
  });

  it('lets a token hash address one login only', async () => {
    const expires = new Date();
    expect(await insertUser({ role: 'client', password_hash: 'x', password_reset_token_hash: 'same', password_reset_expires_at: expires })).toBeUndefined();
    expect(await insertUser({ role: 'client', password_hash: 'x', password_reset_token_hash: 'same', password_reset_expires_at: expires })).toBe('23505');
  });
});

// --- oauth_flow (Phase 2 decision 6) -----------------------------------------------

describe('oauth_flow', () => {
  const HASH = 'a'.repeat(64);
  const VERIFIER = 'v'.repeat(43);
  const NONCE = 'n'.repeat(43);

  function insertFlow(row: { state_hash?: string; code_verifier?: string; nonce?: string }) {
    return sqlstateOf(db, () =>
      db.query(`INSERT INTO oauth_flow (state_hash, code_verifier, nonce, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`, [
        row.state_hash ?? `${Math.random().toString(16).slice(2).padEnd(16, '0')}${'b'.repeat(48)}`.slice(0, 64),
        row.code_verifier ?? VERIFIER,
        row.nonce ?? NONCE,
      ]),
    );
  }

  it('stores a state only as a SHA-256 hex digest, once', async () => {
    expect(await insertFlow({ state_hash: HASH })).toBeUndefined();
    expect(await insertFlow({ state_hash: HASH })).toBe('23505');
    expect(await insertFlow({ state_hash: 'the-state-itself-in-plaintext' })).toBe('23514');
    expect(await insertFlow({ state_hash: 'A'.repeat(64) })).toBe('23514');
  });

  it('holds the code verifier to RFC 7636 and the nonce to a sane length', async () => {
    expect(await insertFlow({ code_verifier: 'v'.repeat(42) })).toBe('23514');
    expect(await insertFlow({ code_verifier: 'v'.repeat(129) })).toBe('23514');
    expect(await insertFlow({ code_verifier: `${'v'.repeat(42)}+` })).toBe('23514');
    expect(await insertFlow({ code_verifier: 'A-z0.9_~'.repeat(6) })).toBeUndefined();
    expect(await insertFlow({ nonce: 'short' })).toBe('23514');
  });
});

// --- Districts and categories ------------------------------------------------------

describe('districts', () => {
  it("has Rwanda's 30, inserted by the migration and kept by truncateAll", async () => {
    const result = await db.query<{ province: string; n: string }>(
      `SELECT province, count(*) AS n FROM district GROUP BY province ORDER BY province`,
    );
    expect(result.rows.map((row) => [row.province, Number(row.n)])).toEqual([
      ['eastern', 7],
      ['kigali', 3],
      ['northern', 5],
      ['southern', 8],
      ['western', 7],
    ]);
    expect(await countOf('district')).toBe(30);
  });

  it('refuses a district that does not exist', async () => {
    const photographerId = await insertPhotographer();
    await db.query(`INSERT INTO photographer_district (photographer_id, district_code) VALUES ($1, 'gasabo')`, [photographerId]);
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO photographer_district (photographer_id, district_code) VALUES ($1, 'atlantis')`, [photographerId])),
    ).toBe('23503');
  });

  it('refuses a district in use being deleted, and a province outside the five', async () => {
    const photographerId = await insertPhotographer();
    await db.query(`INSERT INTO photographer_district (photographer_id, district_code) VALUES ($1, 'huye')`, [photographerId]);
    expect(await sqlstateOf(db, () => db.query(`DELETE FROM district WHERE code = 'huye'`))).toBe('23503');
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO district (code, name, province) VALUES ('x', 'X', 'central')`)),
    ).toBe('23514');
  });
});

describe('categories', () => {
  it('refuses a slug that is not URL-safe', async () => {
    expect(await sqlstateOf(db, () => db.query(`INSERT INTO category (slug, name_en) VALUES ('Real Estate', 'Real estate')`))).toBe('23514');
    await db.query(`INSERT INTO category (slug, name_en) VALUES ('real-estate', 'Real estate')`);
  });
});

// --- Outbox ---------------------------------------------------------------------

describe('outbox', () => {
  const insertRow = (columns: Record<string, unknown>) => {
    const values = { kind: 'email', dedupe_key: `k${Math.random().toString(36).slice(2)}`, recipient: 'x@example.com', ...columns };
    const names = Object.keys(values);
    return sqlstateOf(db, () =>
      db.query(`INSERT INTO outbox (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values)),
    );
  };

  it("refuses a row about a booking that names no photographer: it would escape the studio's scope", async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(await insertRow({ booking_id: bookingId, template: 'booking_confirmation' })).toBe('23514');
    expect(await insertRow({ booking_id: bookingId, photographer_id: ids.photographerId, template: 'booking_confirmation' })).toBeUndefined();
  });

  it('accepts a row about no booking, with or without a photographer', async () => {
    const photographerId = await insertPhotographer();
    expect(await insertRow({ template: 'platform_alert' })).toBeUndefined();
    expect(await insertRow({ photographer_id: photographerId, template: 'photographer_alert' })).toBeUndefined();
  });

  it.each([
    'photographer_new_booking',
    'photographer_alert',
    'platform_alert',
    'account_verify_email',
    'account_password_reset',
    'account_security_alert',
    'photographer_application_received',
    'photographer_approved',
    'photographer_suspended',
    'subscription_reminder',
    'subscription_receipt',
    'subscription_expired',
    'payout_sent',
  ])('accepts the marketplace template %s', async (template) => {
    expect(await insertRow({ template })).toBeUndefined();
  });

  it.each(['admin_alert', 'admin_new_booking', 'booking_invite'])('refuses the template %s', async (template) => {
    expect(await insertRow({ template })).toBe('23514');
  });
});

// --- A sample of the carried-over CHECK constraints ---------------------------------

describe('CHECK constraints', () => {
  it('refuses a working_hours row carrying both a weekday and a date', async () => {
    const photographerId = await insertPhotographer();
    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO working_hours (photographer_id, weekday, effective_date, opens_minute, closes_minute)
           VALUES ($1, 3, '2026-10-10', 540, 1020)`,
          [photographerId],
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a working_hours row that closes before it opens', async () => {
    const photographerId = await insertPhotographer();
    expect(
      await sqlstateOf(db, () =>
        db.query(
          `INSERT INTO working_hours (photographer_id, weekday, opens_minute, closes_minute)
           VALUES ($1, 3, 1020, 540)`,
          [photographerId],
        ),
      ),
    ).toBe('23514');
  });

  it('refuses a booking_addon whose amount is not unit price times quantity', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const addon = await db.query<{ id: string }>(
      `INSERT INTO addon (photographer_id, service_id, name_en, price_rwf) VALUES ($1, $2, 'Extra prints', 5000) RETURNING id`,
      [ids.photographerId, ids.serviceId],
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
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(
      await sqlstateOf(db, () =>
        db.query(`UPDATE booking SET delivery_url = 'http://drive.example/x'`),
      ),
    ).toBe('23514');

    await db.query(`UPDATE booking SET delivery_url = 'https://drive.example/x'`);
  });

  it('refuses a pending contact-email change missing a part', async () => {
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(await sqlstateOf(db, () => db.query(`UPDATE booking SET pending_contact_email = 'new@example.com'`))).toBe('23514');
  });

  it('refuses a booking note that is empty', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(await sqlstateOf(db, () => db.query(`INSERT INTO booking_note (booking_id, body) VALUES ($1, '')`, [bookingId]))).toBe('23514');
  });

  it('refuses a booking status outside the vocabulary', async () => {
    const ids = await insertWorld();
    expect(await sqlstateOf(db, () => insertBooking(ids, 'BKY-2610-AAAAA', { ...SLOT, status: 'declined' }))).toBe('23514');
  });

  it('refuses a negative cancellation cut-off snapshotted on a booking (R1.8)', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(
      await sqlstateOf(db, () => db.query('UPDATE booking SET client_cancel_cutoff_hours = -1 WHERE id = $1', [bookingId])),
    ).toBe('23514');
  });

  it('gives the cancellation-policy snapshot no default: a booking insert that skips it is refused (R1.8)', async () => {
    const columns = await db.query<{ column_name: string; is_nullable: string; column_default: string | null }>(
      `SELECT column_name, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'booking'
          AND column_name IN ('client_cancel_cutoff_hours', 'booking_fee_refundable_on_client_cancel')
        ORDER BY column_name`,
    );

    expect(columns.rows).toEqual([
      { column_name: 'booking_fee_refundable_on_client_cancel', is_nullable: 'NO', column_default: null },
      { column_name: 'client_cancel_cutoff_hours', is_nullable: 'NO', column_default: null },
    ]);
  });
});

// --- Referential behaviour ----------------------------------------------------

describe('referential behaviour', () => {
  it('refuses to hard-delete a package a booking references', async () => {
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(
      await sqlstateOf(db, () => db.query('DELETE FROM package WHERE id = $1', [ids.packageId])),
    ).toBe('23503');
  });

  it('refuses to delete a photographer who has bookings, or the login of any photographer', async () => {
    const ids = await insertWorld();
    await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);

    expect(await sqlstateOf(db, () => db.query('DELETE FROM photographer WHERE id = $1', [ids.photographerId]))).toBe('23503');
    expect(
      await sqlstateOf(db, () => db.query('DELETE FROM app_user WHERE id = (SELECT user_id FROM photographer WHERE id = $1)', [ids.photographerId])),
    ).toBe('23503');
  });

  it("cascades a photographer's configuration -- settings, hours, blocks, districts, categories, portfolio -- with them", async () => {
    const photographerId = await insertPhotographer();
    const category = await db.query<{ id: string }>(`INSERT INTO category (slug, name_en) VALUES ('portrait', 'Portrait') RETURNING id`);
    await db.query(`INSERT INTO working_hours (photographer_id, weekday, opens_minute, closes_minute) VALUES ($1, 1, 540, 1020)`, [photographerId]);
    await db.query(`INSERT INTO availability_block (photographer_id, starts_at, ends_at) VALUES ($1, $2, $3)`, [photographerId, NINE, TEN]);
    await db.query(`INSERT INTO photographer_district (photographer_id, district_code) VALUES ($1, 'gasabo')`, [photographerId]);
    await db.query(`INSERT INTO photographer_category (photographer_id, category_id) VALUES ($1, $2)`, [photographerId, firstRow(category).id]);
    await db.query(`INSERT INTO portfolio_image (photographer_id, url) VALUES ($1, 'https://img.example/1.jpg')`, [photographerId]);

    await db.query('DELETE FROM photographer WHERE id = $1', [photographerId]);

    for (const table of ['photographer_setting', 'working_hours', 'availability_block', 'photographer_district', 'photographer_category', 'portfolio_image']) {
      expect(await countOf(table)).toBe(0);
    }
    // What was only referenced stays.
    expect(await countOf('category')).toBe(1);
    expect(await countOf('district')).toBe(30);
  });

  it('refuses to delete a photographer who still has a catalogue', async () => {
    const { photographerId } = await insertCatalogue(await insertPhotographer());
    expect(await sqlstateOf(db, () => db.query('DELETE FROM photographer WHERE id = $1', [photographerId]))).toBe('23503');
  });

  it('refuses to delete a category in use', async () => {
    const photographerId = await insertPhotographer();
    const category = await db.query<{ id: string }>(`INSERT INTO category (slug, name_en) VALUES ('portrait', 'Portrait') RETURNING id`);
    await db.query(`INSERT INTO photographer_category (photographer_id, category_id) VALUES ($1, $2)`, [photographerId, firstRow(category).id]);

    expect(await sqlstateOf(db, () => db.query('DELETE FROM category WHERE id = $1', [firstRow(category).id]))).toBe('23503');
  });

  it("unlinks a client record when its account is deleted, and keeps the record (§2.8)", async () => {
    const user = await db.query<{ id: string }>(`INSERT INTO app_user (email, role, password_hash) VALUES ('aline@example.com', 'client', 'x') RETURNING id`);
    const clientId = await insertClient();
    await db.query(`UPDATE client SET user_id = $1 WHERE id = $2`, [firstRow(user).id, clientId]);

    await db.query('DELETE FROM app_user WHERE id = $1', [firstRow(user).id]);

    const client = await db.query<{ user_id: string | null }>(`SELECT user_id FROM client WHERE id = $1`, [clientId]);
    expect(firstRow(client).user_id).toBeNull();
  });

  it('matches an email case-insensitively when deduplicating clients, across photographers', async () => {
    await db.query(`INSERT INTO client (full_name, email) VALUES ('Aline', 'Aline@Example.com')`);
    expect(
      await sqlstateOf(db, () =>
        db.query(`INSERT INTO client (full_name, email) VALUES ('Aline again', 'aline@example.com')`),
      ),
    ).toBe('23505');
  });
});
