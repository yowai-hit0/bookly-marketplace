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
 * `oauth_flow` (decision 6), plus Phase 4's `payout_method`, `payout` and
 * `payout_item`, plus Phase 5's `subscription` and `subscription_period`, plus
 * Phase 9's `platform_audit`: 28, the marketplace's full count
 * (marketplace-data-model.md, amendments).
 */
const APPLICATION_TABLE_COUNT = 28;

/** Phase 5's tables (marketplace-data-model.md §3.7). */
const SUBSCRIPTION_TABLES = ['subscription', 'subscription_period'];

/** The platform settings row, with the prices that have no column default (§3.2). */
const PLATFORM_SETTING_INSERT = `INSERT INTO platform_setting (id, subscription_monthly_price_rwf, subscription_yearly_price_rwf) VALUES ($1, 10000, 100000)`;

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
  it('has 28 application tables (Phase 1 of the marketplace, Phase 2 oauth_flow, Phase 4 payouts, Phase 5 subscriptions, Phase 9 platform_audit) plus Prisma migration history, and no view', async () => {
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

  it('has the Phase 5 subscription tables, and leaves admin_user and setting behind', async () => {
    const present = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY tablename`,
      [SUBSCRIPTION_TABLES],
    );
    expect(present.rows.map((row) => row.tablename)).toEqual(SUBSCRIPTION_TABLES);
    const retired = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`, [['admin_user', 'setting']]);
    expect(retired.rows).toEqual([]);
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
    // Phase 8: an account's address change (migration 20261027120000_account_dashboard).
    'app_user_pending_email_token_hash_unique',
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
  /** A subscription for the world's photographer, as approval leaves it. */
  async function insertSubscription(photographerId: string): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO subscription (photographer_id, current_period_ends_at) VALUES ($1, now() + interval '30 days') RETURNING id`,
      [photographerId],
    );
    return firstRow(result).id;
  }

  const insertPayment = (values: { booking_id: string | null; subscription_id: string | null; kind: string; plan_interval: string | null; provider?: string }) =>
    db.query(
      `INSERT INTO payment (booking_id, subscription_id, kind, plan_interval, provider, amount_rwf) VALUES ($1, $2, $3, $4, $5, 10000) RETURNING id`,
      [values.booking_id, values.subscription_id, values.kind, values.plan_interval, values.provider ?? 'mtn_momo_direct'],
    );

  it('takes a subscription payment with its subscription and plan, and no booking (§2.11)', async () => {
    const ids = await insertWorld();
    const subscriptionId = await insertSubscription(ids.photographerId);
    for (const plan of ['monthly', 'yearly']) {
      expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: subscriptionId, kind: 'subscription', plan_interval: plan }))).toBeUndefined();
    }
  });

  it('holds a payment to exactly one subject: a booking or a subscription, never both, never neither (payment_subject_exactly_one)', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const subscriptionId = await insertSubscription(ids.photographerId);

    expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: null, kind: 'booking_fee', plan_interval: null }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: null, kind: 'subscription', plan_interval: 'monthly' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: subscriptionId, kind: 'subscription', plan_interval: 'monthly' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: subscriptionId, kind: 'booking_fee', plan_interval: null }))).toBe('23514');
  });

  it('matches the subject to the kind: a fee has a booking, a subscription payment a subscription (payment_subject_matches_kind)', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const subscriptionId = await insertSubscription(ids.photographerId);

    expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: null, kind: 'subscription', plan_interval: 'monthly' }))).toBe('23514');
    for (const kind of ['booking_fee', 'session_fee']) {
      expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: subscriptionId, kind, plan_interval: null })), kind).toBe('23514');
      expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: null, kind, plan_interval: null })), kind).toBeUndefined();
    }
  });

  it('freezes a plan on a subscription payment and only there, from the two intervals (payment_plan_interval_*)', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const subscriptionId = await insertSubscription(ids.photographerId);

    expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: subscriptionId, kind: 'subscription', plan_interval: null }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: subscriptionId, kind: 'subscription', plan_interval: 'weekly' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: null, kind: 'session_fee', plan_interval: 'monthly' }))).toBe('23514');
  });

  it('keeps the kind vocabulary closed, and cash a session fee only: never a subscription', async () => {
    const ids = await insertWorld();
    const bookingId = await insertBooking(ids, 'BKY-2610-AAAAA', SLOT);
    const subscriptionId = await insertSubscription(ids.photographerId);

    expect(await sqlstateOf(db, () => insertPayment({ booking_id: bookingId, subscription_id: null, kind: 'tip', plan_interval: null }))).toBe('23514');
    expect(
      await sqlstateOf(db, () => insertPayment({ booking_id: null, subscription_id: subscriptionId, kind: 'subscription', plan_interval: 'monthly', provider: 'cash' })),
    ).toBe('23514');
  });

  it('indexes a subscription payment by (subscription_id, status) for the one-in-progress check', async () => {
    const result = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE indexname = 'payment_subscription_id_status_idx'`);
    expect(firstRow(result).indexdef).toMatch(/\(subscription_id, status\)/);
  });

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

// --- Payouts (Phase 4; marketplace-data-model.md §3.8-§3.11, §7) ------------------

describe('payouts', () => {
  type PayoutWorld = Ids & { bookingId: string; paymentId: string; adminId: string; methodId: string };

  /** A world, its booking, a succeeded payment, a platform admin and a current MoMo method. */
  async function payoutWorld(handle = 'studio-a', reference = 'BKY-2610-AAAAA', first?: Ids): Promise<PayoutWorld> {
    const ids = first === undefined ? await insertWorld(handle) : await insertSecondWorld(first, handle);
    const bookingId = await insertBooking(ids, reference, SLOT);
    const payment = await db.query<{ id: string }>(
      `INSERT INTO payment (booking_id, kind, provider, amount_rwf, status) VALUES ($1, 'booking_fee', 'mtn_momo_direct', 16000, 'succeeded') RETURNING id`,
      [bookingId],
    );
    const admin = await db.query<{ id: string }>(`INSERT INTO app_user (email, role, password_hash) VALUES ($1, 'platform_admin', 'x') RETURNING id`, [
      `admin-${handle}@example.com`,
    ]);
    const methodId = await insertMethod(ids.photographerId);
    return { ...ids, bookingId, paymentId: firstRow(payment).id, adminId: firstRow(admin).id, methodId };
  }

  async function insertMethod(photographerId: string, overrides: Record<string, string | null> = {}): Promise<string> {
    const row = { kind: 'momo', momo_network: 'mtn', momo_number: '+250788123456', bank_name: null, bank_account_number: null, account_name: 'Studio A', ...overrides };
    const result = await db.query<{ id: string }>(
      `INSERT INTO payout_method (photographer_id, kind, momo_network, momo_number, bank_name, bank_account_number, account_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [photographerId, row.kind, row.momo_network, row.momo_number, row.bank_name, row.bank_account_number, row.account_name],
    );
    return firstRow(result).id;
  }

  async function insertPayout(w: { photographerId: string; methodId: string; adminId: string }): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO payout (photographer_id, amount_rwf, payout_method_id, created_by_user_id) VALUES ($1, 16000, $2, $3) RETURNING id`,
      [w.photographerId, w.methodId, w.adminId],
    );
    return firstRow(result).id;
  }

  const markPaid = (payoutId: string, adminId: string, reference = 'MTN-1') =>
    db.query(`UPDATE payout SET status = 'paid', transfer_reference = $3, paid_at = now(), paid_by_user_id = $2 WHERE id = $1`, [payoutId, adminId, reference]);

  const insertItem = (w: { photographerId: string; paymentId: string }, kind: string, amount: number, payoutId: string | null = null, voided = false) =>
    db.query(
      `INSERT INTO payout_item (photographer_id, payment_id, kind, amount_rwf, payout_id, voided_at)
       VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::boolean THEN now() END)`,
      [w.photographerId, w.paymentId, kind, amount, payoutId, voided],
    );

  it('has every partial unique and the unpaid-items index, by name and predicate', async () => {
    const result = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1)`, [
      ['payout_method_one_current', 'payout_one_draft', 'payout_transfer_reference_unique', 'payout_item_unpaid_idx'],
    ]);
    const defs = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(defs.payout_method_one_current).toMatch(/UNIQUE.*\(photographer_id\) WHERE \(retired_at IS NULL\)/);
    expect(defs.payout_one_draft).toMatch(/UNIQUE.*\(photographer_id\) WHERE \(status = 'draft'::text\)/);
    expect(defs.payout_transfer_reference_unique).toMatch(/UNIQUE.*\(transfer_reference\) WHERE \(transfer_reference IS NOT NULL\)/);
    expect(defs.payout_item_unpaid_idx).toMatch(/\(photographer_id\) WHERE \(\(payout_id IS NULL\) AND \(voided_at IS NULL\)\)/);
    expect(defs.payout_item_unpaid_idx).not.toMatch(/UNIQUE/);
  });

  it('holds the sign to the kind: an earning positive, a reversal negative, nothing at nought', async () => {
    const w = await payoutWorld();
    expect(await sqlstateOf(db, () => insertItem(w, 'earning', -16000))).toBe('23514');
    expect(await sqlstateOf(db, () => insertItem(w, 'reversal', 16000))).toBe('23514');
    expect(await sqlstateOf(db, () => insertItem(w, 'earning', 0))).toBe('23514');
    expect(await sqlstateOf(db, () => insertItem(w, 'commission', 100))).toBe('23514');
    await insertItem(w, 'earning', 16000);
    await insertItem(w, 'reversal', -16000);
  });

  it('allows one earning and one reversal per payment (@@unique([paymentId, kind]))', async () => {
    const w = await payoutWorld();
    await insertItem(w, 'earning', 16000);
    expect(await sqlstateOf(db, () => insertItem(w, 'earning', 16000))).toBe('23505');
    await insertItem(w, 'reversal', -16000);
    expect(await sqlstateOf(db, () => insertItem(w, 'reversal', -16000))).toBe('23505');
  });

  it('refuses an item both voided and in a payout', async () => {
    const w = await payoutWorld();
    const payoutId = await insertPayout(w);
    expect(await sqlstateOf(db, () => insertItem(w, 'earning', 16000, payoutId, true))).toBe('23514');
    await insertItem(w, 'earning', 16000, payoutId, false);
  });

  it('refuses a paid payout without a reference, a paid time or who paid it, and a reference on an unpaid one', async () => {
    const w = await payoutWorld();
    const payoutId = await insertPayout(w);
    const pay = (set: string, params: unknown[]) => sqlstateOf(db, () => db.query(`UPDATE payout SET status = 'paid', ${set} WHERE id = $1`, [payoutId, ...params]));

    expect(await pay('paid_at = now(), paid_by_user_id = $2', [w.adminId])).toBe('23514');
    expect(await pay(`transfer_reference = 'MTN-1', paid_by_user_id = $2`, [w.adminId])).toBe('23514');
    expect(await pay(`transfer_reference = 'MTN-1', paid_at = now()`, [])).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE payout SET transfer_reference = 'MTN-1' WHERE id = $1`, [payoutId]))).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE payout SET transfer_reference = '' WHERE id = $1`, [payoutId]))).toBe('23514');
    expect(await pay(`transfer_reference = 'MTN-1', paid_at = now(), paid_by_user_id = $2`, [w.adminId])).toBeUndefined();
  });

  it('refuses a cancelled payout without its date or who cancelled it', async () => {
    const w = await payoutWorld();
    const payoutId = await insertPayout(w);
    const cancel = (set: string, params: unknown[]) =>
      sqlstateOf(db, () => db.query(`UPDATE payout SET status = 'cancelled', ${set} WHERE id = $1`, [payoutId, ...params]));

    expect(await cancel('cancelled_by_user_id = $2', [w.adminId])).toBe('23514');
    expect(await cancel('cancelled_at = now()', [])).toBe('23514');
    expect(await cancel('cancelled_at = now(), cancelled_by_user_id = $2', [w.adminId])).toBeUndefined();
  });

  it('refuses a payout of nought or less, and a status outside the vocabulary', async () => {
    const w = await payoutWorld();
    const payoutId = await insertPayout(w);
    expect(await sqlstateOf(db, () => db.query('UPDATE payout SET amount_rwf = 0 WHERE id = $1', [payoutId]))).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE payout SET status = 'sent' WHERE id = $1`, [payoutId]))).toBe('23514');
  });

  it('allows one draft per photographer, and another once it is paid', async () => {
    const w = await payoutWorld();
    const first = await insertPayout(w);
    expect(await sqlstateOf(db, () => insertPayout(w))).toBe('23505');
    await markPaid(first, w.adminId);
    await insertPayout(w);
  });

  it('uses a transfer reference once, across photographers', async () => {
    const a = await payoutWorld();
    const b = await payoutWorld('studio-b', 'BKY-2610-BBBBB', a);
    await markPaid(await insertPayout(a), a.adminId, 'MTN-SAME');
    const other = await insertPayout(b);
    expect(await sqlstateOf(db, () => markPaid(other, b.adminId, 'MTN-SAME'))).toBe('23505');
  });

  it('allows one current method per photographer; retiring it frees the slot', async () => {
    const w = await payoutWorld();
    expect(await sqlstateOf(db, () => insertMethod(w.photographerId))).toBe('23505');
    await db.query('UPDATE payout_method SET retired_at = now() WHERE id = $1', [w.methodId]);
    await insertMethod(w.photographerId, { kind: 'bank', momo_network: null, momo_number: null, bank_name: 'Bank of Kigali', bank_account_number: '00040-1' });
  });

  it('holds a method to its shape per kind, its network, its number format and its name length', async () => {
    const w = await payoutWorld();
    await db.query('UPDATE payout_method SET retired_at = now() WHERE id = $1', [w.methodId]);
    const refused: Record<string, string | null>[] = [
      { momo_number: null },
      { bank_name: 'Bank of Kigali' },
      { kind: 'bank', momo_network: null, momo_number: null, bank_name: 'BK', bank_account_number: null },
      { kind: 'bank', bank_name: 'BK', bank_account_number: '12345' },
      { kind: 'paypal' },
      { momo_network: 'tigo' },
      { momo_number: '0788123456' },
      { momo_number: '+254712345678' },
      { account_name: '' },
      { account_name: 'x'.repeat(121) },
    ];
    for (const overrides of refused) {
      expect(await sqlstateOf(db, () => insertMethod(w.photographerId, overrides)), JSON.stringify(overrides)).toBe('23514');
    }
  });

  it("refuses a payout to another photographer's method (composite foreign key)", async () => {
    const a = await payoutWorld();
    const b = await payoutWorld('studio-b', 'BKY-2610-BBBBB', a);
    expect(await sqlstateOf(db, () => insertPayout({ photographerId: a.photographerId, methodId: b.methodId, adminId: a.adminId }))).toBe('23503');
  });

  it('records who refunded only on a refunded payment', async () => {
    const w = await payoutWorld();
    expect(await sqlstateOf(db, () => db.query('UPDATE payment SET refunded_by_user_id = $2 WHERE id = $1', [w.paymentId, w.adminId]))).toBe('23514');
    await db.query(`UPDATE payment SET status = 'refunded', refunded_at = now(), refunded_by_user_id = $2 WHERE id = $1`, [w.paymentId, w.adminId]);
  });

  // --- Overpayments (Phase 4 overpayment decision) ---

  /** A succeeded payment on the world's booking; a session fee paid online unless told otherwise. */
  async function insertPaid(w: PayoutWorld, seed: { kind?: string; provider?: string; amount?: number; overpaid?: number; status?: string } = {}): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO payment (booking_id, kind, provider, amount_rwf, overpaid_rwf, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [w.bookingId, seed.kind ?? 'session_fee', seed.provider ?? 'mtn_momo_direct', seed.amount ?? 40000, seed.overpaid ?? 0, seed.status ?? 'succeeded'],
    );
    return firstRow(result).id;
  }

  const recordOverpaymentRefund = (paymentId: string, adminId: string, reference = 'MTN-OVER-1') =>
    db.query(
      `UPDATE payment SET overpayment_refunded_at = now(), overpayment_refund_reference = $3, overpayment_refunded_by_user_id = $2 WHERE id = $1`,
      [paymentId, adminId, reference],
    );

  it('takes flutterwave_checkout as a payment provider, and refuses one it does not know (cards, 2026-10-30)', async () => {
    const w = await payoutWorld();
    await insertPaid(w, { provider: 'flutterwave_checkout' });
    await insertPaid(w, { kind: 'booking_fee', provider: 'flutterwave_checkout', amount: 20000, status: 'pending' });
    for (const provider of ['stripe', 'flutterwave_card', 'FLUTTERWAVE_CHECKOUT']) {
      expect(await sqlstateOf(db, () => insertPaid(w, { provider })), provider).toBe('23514');
    }
  });

  it('has both refund-reference partial uniques, by name and predicate', async () => {
    const result = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1)`, [
      ['payment_refund_reference_online_unique', 'payment_overpayment_refund_reference_unique'],
    ]);
    const defs = Object.fromEntries(result.rows.map((row) => [row.indexname, row.indexdef]));
    expect(defs.payment_refund_reference_online_unique).toMatch(
      /UNIQUE.*\(refund_reference\) WHERE \(\(refund_reference IS NOT NULL\) AND \(provider <> 'cash'::text\)\)/,
    );
    expect(defs.payment_overpayment_refund_reference_unique).toMatch(/UNIQUE.*\(overpayment_refund_reference\) WHERE \(overpayment_refund_reference IS NOT NULL\)/);
  });

  it('defaults overpaid_rwf to nought, and holds it at or above nought and below the amount', async () => {
    const w = await payoutWorld();
    expect((await db.query<{ overpaid_rwf: number }>('SELECT overpaid_rwf FROM payment WHERE id = $1', [w.paymentId])).rows[0]?.overpaid_rwf).toBe(0);
    expect(await sqlstateOf(db, () => insertPaid(w, { overpaid: -1 }))).toBe('23514');
    // Wholly extra is refund_due, never an overpayment of the whole amount.
    expect(await sqlstateOf(db, () => insertPaid(w, { amount: 40000, overpaid: 40000 }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPaid(w, { amount: 40000, overpaid: 39999 }))).toBeUndefined();
  });

  it('lets only an online session fee be overpaid', async () => {
    const w = await payoutWorld();
    expect(await sqlstateOf(db, () => insertPaid(w, { provider: 'cash', overpaid: 1000 }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPaid(w, { kind: 'booking_fee', status: 'failed', overpaid: 1000 }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPaid(w, { provider: 'flutterwave', overpaid: 1000 }))).toBeUndefined();
  });

  it('records an overpayment refund whole -- when, the reference and who -- and only on an overpaid payment', async () => {
    const w = await payoutWorld();
    const overpaid = await insertPaid(w, { overpaid: 10000 });
    const exact = await insertPaid(w);
    const partly = (set: string, params: unknown[]) => sqlstateOf(db, () => db.query(`UPDATE payment SET ${set} WHERE id = $1`, [overpaid, ...params]));

    expect(await partly('overpayment_refund_reference = $2', ['MTN-OVER-1'])).toBe('23514');
    expect(await partly('overpayment_refunded_at = now(), overpayment_refund_reference = $2', ['MTN-OVER-1'])).toBe('23514');
    expect(await partly('overpayment_refunded_at = now(), overpayment_refunded_by_user_id = $2', [w.adminId])).toBe('23514');
    expect(await sqlstateOf(db, () => recordOverpaymentRefund(exact, w.adminId))).toBe('23514');
    expect(await sqlstateOf(db, () => recordOverpaymentRefund(overpaid, w.adminId, ''))).toBe('23514');
    expect(await sqlstateOf(db, () => recordOverpaymentRefund(overpaid, w.adminId))).toBeUndefined();
  });

  it('uses an online refund reference once in each column, and leaves cash references free', async () => {
    const w = await payoutWorld();
    const refund = (paymentId: string, reference: string) =>
      db.query(`UPDATE payment SET status = 'refunded', refunded_at = now(), refund_reference = $2 WHERE id = $1`, [paymentId, reference]);
    const online = [await insertPaid(w, { status: 'refund_due' }), await insertPaid(w, { status: 'refund_due', provider: 'flutterwave' })];
    const cash = [await insertPaid(w, { status: 'refund_due', provider: 'cash' }), await insertPaid(w, { status: 'refund_due', provider: 'cash' })];

    await refund(online[0] ?? '', 'REF-1');
    expect(await sqlstateOf(db, () => refund(online[1] ?? '', 'REF-1'))).toBe('23505');
    // Cash is the photographer's own words: the same twice, and the same as an online refund's.
    expect(await sqlstateOf(db, () => refund(cash[0] ?? '', 'REF-1'))).toBeUndefined();
    expect(await sqlstateOf(db, () => refund(cash[1] ?? '', 'REF-1'))).toBeUndefined();

    const overpaid = [await insertPaid(w, { overpaid: 10000 }), await insertPaid(w, { overpaid: 5000 })];
    await recordOverpaymentRefund(overpaid[0] ?? '', w.adminId, 'OVER-1');
    expect(await sqlstateOf(db, () => recordOverpaymentRefund(overpaid[1] ?? '', w.adminId, 'OVER-1'))).toBe('23505');
  });

  it('restricts deleting the admin who recorded an overpayment refund', async () => {
    const w = await payoutWorld();
    const overpaid = await insertPaid(w, { overpaid: 10000 });
    await recordOverpaymentRefund(overpaid, w.adminId);
    // The payout world's own rows name no admin; this one does.
    expect(await sqlstateOf(db, () => db.query('DELETE FROM app_user WHERE id = $1', [w.adminId]))).toBe('23503');
  });

  it('restricts deletes of a payment, payout, method, admin or photographer that money-out rows name', async () => {
    const w = await payoutWorld();
    const payoutId = await insertPayout(w);
    await insertItem(w, 'earning', 16000, payoutId);

    expect(await sqlstateOf(db, () => db.query('DELETE FROM payment WHERE id = $1', [w.paymentId]))).toBe('23503');
    expect(await sqlstateOf(db, () => db.query('DELETE FROM payout WHERE id = $1', [payoutId]))).toBe('23503');
    expect(await sqlstateOf(db, () => db.query('DELETE FROM payout_method WHERE id = $1', [w.methodId]))).toBe('23503');
    expect(await sqlstateOf(db, () => db.query('DELETE FROM app_user WHERE id = $1', [w.adminId]))).toBe('23503');

    // With everything else of theirs gone, the payout method alone still holds the photographer.
    for (const table of ['payout_item', 'payout', 'payment', 'booking', 'package', 'service']) await db.query(`DELETE FROM ${table}`);
    expect(await sqlstateOf(db, () => db.query('DELETE FROM photographer WHERE id = $1', [w.photographerId]))).toBe('23503');
    await db.query('DELETE FROM payout_method');
    expect(await sqlstateOf(db, () => db.query('DELETE FROM photographer WHERE id = $1', [w.photographerId]))).toBeUndefined();
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

  it('takes flutterwave_checkout as a provider, and refuses one it does not know (cards, 2026-10-30)', async () => {
    await db.query(
      `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid)
       VALUES ('flutterwave_checkout', '285959875:SUCCESSFUL', 'verify.SUCCESSFUL', true)`,
    );
    const unknown = () =>
      db.query(
        `INSERT INTO webhook_event (provider, event_id, event_type, signature_valid)
         VALUES ('stripe', 'evt_1', 'charge.completed', true)`,
      );
    expect(await sqlstateOf(db, unknown)).toBe('23514');
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

// --- Subscriptions (Phase 5; marketplace-data-model.md §3.7, §3.11, §7) ----------

describe('subscriptions', () => {
  type SubscriptionWorld = Ids & { subscriptionId: string };

  async function subscriptionWorld(handle = 'studio-a'): Promise<SubscriptionWorld> {
    const ids = await insertWorld(handle);
    const result = await db.query<{ id: string }>(
      `INSERT INTO subscription (photographer_id, current_period_ends_at) VALUES ($1, '2026-11-01T00:00:00Z') RETURNING id`,
      [ids.photographerId],
    );
    return { ...ids, subscriptionId: firstRow(result).id };
  }

  async function subscriptionPayment(w: SubscriptionWorld, plan = 'monthly'): Promise<string> {
    const result = await db.query<{ id: string }>(
      `INSERT INTO payment (subscription_id, kind, plan_interval, provider, amount_rwf, status) VALUES ($1, 'subscription', $2, 'mtn_momo_direct', 10000, 'succeeded') RETURNING id`,
      [w.subscriptionId, plan],
    );
    return firstRow(result).id;
  }

  type PeriodValues = { kind?: string; plan_interval?: string | null; price_rwf?: number; starts_at: string; ends_at: string; payment_id?: string | null; voided_at?: string | null };

  const insertPeriod = (w: SubscriptionWorld, v: PeriodValues) =>
    db.query(
      `INSERT INTO subscription_period (subscription_id, kind, plan_interval, price_rwf, starts_at, ends_at, payment_id, voided_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [w.subscriptionId, v.kind ?? 'trial', v.plan_interval ?? null, v.price_rwf ?? 0, v.starts_at, v.ends_at, v.payment_id ?? null, v.voided_at ?? null],
    );

  const OCT = { starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-10-31T00:00:00Z' };
  const NOV = { starts_at: '2026-10-31T00:00:00Z', ends_at: '2026-11-30T00:00:00Z' };

  it('has the overlap exclusion, the one-trial unique and the indexes, by name and definition', async () => {
    const exclusion = await db.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'subscription_period_no_overlap' AND contype = 'x'`,
    );
    expect(firstRow(exclusion).def).toMatch(/EXCLUDE USING gist \(subscription_id WITH =, tstzrange\(starts_at, ends_at, '\[\)'::text\) WITH &&\) WHERE \(\(voided_at IS NULL\)\)/);

    const indexes = await db.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1)`, [
      [
        'subscription_period_one_trial',
        'subscription_period_payment_id_key',
        'subscription_photographer_id_key',
        'subscription_status_current_period_ends_at_idx',
        'subscription_period_subscription_id_ends_at_idx',
      ],
    ]);
    const defs = Object.fromEntries(indexes.rows.map((row) => [row.indexname, row.indexdef]));
    expect(defs.subscription_period_one_trial).toMatch(/UNIQUE.*\(subscription_id\) WHERE \(kind = 'trial'::text\)/);
    expect(defs.subscription_period_payment_id_key).toMatch(/UNIQUE.*\(payment_id\)/);
    expect(defs.subscription_photographer_id_key).toMatch(/UNIQUE.*\(photographer_id\)/);
    expect(defs.subscription_status_current_period_ends_at_idx).toMatch(/\(status, current_period_ends_at\)/);
    expect(defs.subscription_period_subscription_id_ends_at_idx).toMatch(/\(subscription_id, ends_at\)/);
  });

  it('gives a photographer one subscription, born trialing', async () => {
    const w = await subscriptionWorld();
    await expect(db.query(`SELECT status FROM subscription WHERE id = $1`, [w.subscriptionId]).then(firstRow)).resolves.toEqual({ status: 'trialing' });
    expect(
      await sqlstateOf(db, () => db.query(`INSERT INTO subscription (photographer_id, current_period_ends_at) VALUES ($1, now())`, [w.photographerId])),
    ).toBe('23505');
  });

  it('holds the status to its vocabulary', async () => {
    const w = await subscriptionWorld();
    for (const status of ['trialing', 'active', 'past_due', 'expired']) {
      expect(await sqlstateOf(db, () => db.query(`UPDATE subscription SET status = $1 WHERE id = $2`, [status, w.subscriptionId])), status).toBeUndefined();
    }
    expect(await sqlstateOf(db, () => db.query(`UPDATE subscription SET status = 'cancelled' WHERE id = $1`, [w.subscriptionId]))).toBe('23514');
  });

  it('refuses two periods of one subscription that overlap, and allows them end to start (23P01)', async () => {
    const w = await subscriptionWorld();
    await insertPeriod(w, OCT);
    const paymentId = await subscriptionPayment(w);

    expect(
      await sqlstateOf(db, () =>
        insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, starts_at: '2026-10-30T00:00:00Z', ends_at: '2026-11-30T00:00:00Z' }),
      ),
    ).toBe('23P01');
    expect(await sqlstateOf(db, () => insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, ...NOV }))).toBeUndefined();
  });

  it('lets two subscriptions cover the same time: the exclusion is per subscription', async () => {
    const a = await subscriptionWorld('studio-a');
    const b = await db.query<{ id: string }>(
      `INSERT INTO subscription (photographer_id, current_period_ends_at) VALUES ($1, now()) RETURNING id`,
      [await insertPhotographer('studio-b')],
    );
    await insertPeriod(a, OCT);
    expect(await sqlstateOf(db, () => insertPeriod({ ...a, subscriptionId: firstRow(b).id }, OCT))).toBeUndefined();
  });

  it('frees the range of a voided period', async () => {
    const w = await subscriptionWorld();
    const paymentId = await subscriptionPayment(w);
    await insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, voided_at: '2026-10-02T00:00:00Z', ...OCT });
    expect(await sqlstateOf(db, () => insertPeriod(w, OCT))).toBeUndefined();
  });

  it('allows one trial per subscription, even one that does not overlap (subscription_period_one_trial)', async () => {
    const w = await subscriptionWorld();
    await insertPeriod(w, OCT);
    expect(await sqlstateOf(db, () => insertPeriod(w, NOV))).toBe('23505');
  });

  it('holds a period to its shape: a free trial with no plan or payment, a paid one with both and a price (subscription_period_shape)', async () => {
    const w = await subscriptionWorld();
    const paymentId = await subscriptionPayment(w);
    const paid = { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, ...NOV };

    expect(await sqlstateOf(db, () => insertPeriod(w, { ...OCT, price_rwf: 5000 }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...OCT, plan_interval: 'monthly' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...OCT, payment_id: paymentId }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...paid, payment_id: null }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...paid, plan_interval: null }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...paid, price_rwf: 0 }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...paid, plan_interval: 'weekly' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { ...paid, kind: 'bonus' }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, paid))).toBeUndefined();
  });

  it('refuses a period that ends at or before it starts (subscription_period_range_valid)', async () => {
    const w = await subscriptionWorld();
    expect(await sqlstateOf(db, () => insertPeriod(w, { starts_at: OCT.starts_at, ends_at: OCT.starts_at }))).toBe('23514');
    expect(await sqlstateOf(db, () => insertPeriod(w, { starts_at: OCT.ends_at, ends_at: OCT.starts_at }))).toBe('23514');
  });

  it('lets one payment buy one period only (unique payment_id)', async () => {
    const w = await subscriptionWorld();
    const paymentId = await subscriptionPayment(w);
    await insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, ...OCT });
    expect(await sqlstateOf(db, () => insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, ...NOV }))).toBe('23505');
  });

  it('restricts deleting a photographer, a subscription or a payment that subscription rows name', async () => {
    const w = await subscriptionWorld();
    const paymentId = await subscriptionPayment(w);
    await insertPeriod(w, { kind: 'paid', plan_interval: 'monthly', price_rwf: 10000, payment_id: paymentId, ...OCT });

    expect(await sqlstateOf(db, () => db.query('DELETE FROM payment WHERE id = $1', [paymentId]))).toBe('23503');
    expect(await sqlstateOf(db, () => db.query('DELETE FROM subscription WHERE id = $1', [w.subscriptionId]))).toBe('23503');
    for (const table of ['package', 'service']) await db.query(`DELETE FROM ${table}`);
    expect(await sqlstateOf(db, () => db.query('DELETE FROM photographer WHERE id = $1', [w.photographerId]))).toBe('23503');
  });
});

// --- Configuration -------------------------------------------------------------

describe('settings', () => {
  it('allows exactly one platform_setting row', async () => {
    await db.query(PLATFORM_SETTING_INSERT, [1]);
    expect(await sqlstateOf(db, () => db.query(PLATFORM_SETTING_INSERT, [2]))).toBe('23514');
  });

  it('defaults the platform hold to 30 minutes and the trial to 30 days, and refuses a zero hold', async () => {
    const row = await db.query<{ hold_minutes: number; trial_days: number }>(`${PLATFORM_SETTING_INSERT} RETURNING hold_minutes, trial_days`, [1]);
    expect(firstRow(row)).toEqual({ hold_minutes: 30, trial_days: 30 });
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET hold_minutes = 0`))).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET trial_days = -1`))).toBe('23514');
  });

  it('refuses a trial of no days: a trial is a period, and a period has a length (Phase 5)', async () => {
    await db.query(PLATFORM_SETTING_INSERT, [1]);
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET trial_days = 0`))).toBe('23514');
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET trial_days = 1`))).toBeUndefined();
  });

  it('gives the prices no default: a row without them is refused (§3.2)', async () => {
    expect(await sqlstateOf(db, () => db.query(`INSERT INTO platform_setting (id) VALUES (1)`))).toBe('23502');
    expect(await sqlstateOf(db, () => db.query(`INSERT INTO platform_setting (id, subscription_monthly_price_rwf) VALUES (1, 10000)`))).toBe('23502');
  });

  it('defaults the grace to 7 days and the reminders to 7, 3 and 1 days (R5.4)', async () => {
    const row = await db.query(`${PLATFORM_SETTING_INSERT} RETURNING subscription_grace_days, subscription_reminder_days`, [1]);
    expect(firstRow(row)).toEqual({ subscription_grace_days: 7, subscription_reminder_days: [7, 3, 1] });
  });

  it.each([
    ['subscription_monthly_price_rwf = 0'],
    ['subscription_yearly_price_rwf = 0'],
    ['subscription_monthly_price_rwf = -1'],
    ['subscription_grace_days = -1'],
    ['subscription_reminder_days = NULL'],
    ["subscription_reminder_days = '{7,0}'"],
    ["subscription_reminder_days = '{-1}'"],
    ["subscription_reminder_days = '{7,NULL,1}'"],
    ["subscription_reminder_days = '{1,2,3,4,5,6,7,8,9,10,11}'"],
  ])('refuses platform_setting SET %s', async (assignment) => {
    await db.query(PLATFORM_SETTING_INSERT, [1]);
    expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET ${assignment}`))).toBe('23514');
  });

  it.each([["subscription_reminder_days = '{}'"], ["subscription_reminder_days = '{1,2,3,4,5,6,7,8,9,10}'"], ['subscription_grace_days = 0']])(
    'accepts platform_setting SET %s',
    async (assignment) => {
      await db.query(PLATFORM_SETTING_INSERT, [1]);
      expect(await sqlstateOf(db, () => db.query(`UPDATE platform_setting SET ${assignment}`))).toBeUndefined();
    },
  );

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

  // --- Phase 8 (migration 20261027120000_account_dashboard) ---------------------------

  it.each(['+250788123456', '+12025550123', '+4930123456'])('accepts the E.164 phone %s (decision 1)', async (phone) => {
    expect(await insertUser({ role: 'client', password_hash: 'x', phone })).toBeUndefined();
  });

  it.each(['0788123456', '250788123456', '+0788123456', '+25078812345678901', '+25', '+250 788 123 456', ''])(
    'refuses the phone %j: only E.164 is stored',
    async (phone) => {
      expect(await insertUser({ role: 'client', password_hash: 'x', phone })).toBe('23514');
    },
  );

  it('refuses a pending address change without all three of its address, hash and expiry', async () => {
    const at = new Date();
    for (const partial of [
      { pending_email: 'new@example.com' },
      { pending_email_token_hash: 'p1' },
      { pending_email_expires_at: at },
      { pending_email: 'new@example.com', pending_email_token_hash: 'p2' },
      { pending_email: 'new@example.com', pending_email_expires_at: at },
      { pending_email_token_hash: 'p3', pending_email_expires_at: at },
    ]) {
      expect(await insertUser({ role: 'client', password_hash: 'x', ...partial }), JSON.stringify(Object.keys(partial))).toBe('23514');
    }
    expect(await insertUser({ role: 'client', password_hash: 'x', pending_email: 'new@example.com', pending_email_token_hash: 'p4', pending_email_expires_at: at })).toBeUndefined();
  });

  it('lets a pending address change token address one login only', async () => {
    const pending = { pending_email: 'new@example.com', pending_email_token_hash: 'same-pending', pending_email_expires_at: new Date() };
    expect(await insertUser({ role: 'client', password_hash: 'x', ...pending })).toBeUndefined();
    expect(await insertUser({ role: 'client', password_hash: 'x', ...pending, pending_email: 'other@example.com' })).toBe('23505');
  });

  it('admits an ERASED login with no credential, and still refuses a live one (R8.3)', async () => {
    expect(await insertUser({ role: 'client', anonymized_at: new Date() })).toBeUndefined();
    expect(await insertUser({ role: 'client' })).toBe('23514');
    expect(await insertUser({ role: 'client', disabled_at: new Date() })).toBe('23514');
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

// --- The platform's audit trail (Phase 9) ------------------------------------------

describe('platform_audit (Phase 9, R9.4)', () => {
  async function insertAdmin(email = 'admin@example.com'): Promise<string> {
    const user = await db.query<{ id: string }>(
      `INSERT INTO app_user (email, role, password_hash) VALUES ($1, 'platform_admin', 'x') RETURNING id`,
      [email],
    );
    return firstRow(user).id;
  }
  const insertAudit = (columns: Record<string, unknown>) => {
    const keys = Object.keys(columns);
    return db.query(
      `INSERT INTO platform_audit (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(columns),
    );
  };

  it('holds the vocabulary of platform/audit.ts, exactly', async () => {
    const { PLATFORM_AUDIT_ACTIONS, PLATFORM_AUDIT_TARGET_TYPES } = await import('../platform/audit.js');
    const defOf = async (name: string) =>
      firstRow(await db.query<{ def: string }>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [name])).def;
    const values = (def: string) => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]).sort();

    expect(values(await defOf('platform_audit_action_allowed'))).toEqual([...PLATFORM_AUDIT_ACTIONS].sort());
    expect(values(await defOf('platform_audit_target_type_allowed'))).toEqual([...PLATFORM_AUDIT_TARGET_TYPES].sort());
  });

  it('accepts a full row, defaulting details to an empty object', async () => {
    const actor = await insertAdmin();
    const photographerId = await insertPhotographer();
    const row = firstRow(await insertAudit({ actor_user_id: actor, action: 'photographer_approved', target_type: 'photographer', target_id: photographerId, photographer_id: photographerId }));
    expect(row).toMatchObject({ details: {}, photographer_id: photographerId });
    // A target with no uuid: the settings row.
    await insertAudit({ actor_user_id: actor, action: 'settings_updated', target_type: 'platform_setting', details: JSON.stringify({ changed: { trialDays: { before: 30, after: 14 } } }) });
  });

  it.each<[string, Record<string, unknown>]>([
    ['an action outside the vocabulary', { action: 'photographer_deleted' }],
    ['a target type outside the vocabulary', { action: 'category_created', target_type: 'booking' }],
    ['a target id with no type', { action: 'category_created', target_id: '00000000-0000-4000-8000-000000000001' }],
    ['details that are not an object', { action: 'category_created', details: JSON.stringify(['x']) }],
  ])('refuses %s', async (_label, columns) => {
    const actor = await insertAdmin();
    expect(await sqlstateOf(db, () => insertAudit({ actor_user_id: actor, ...columns }))).toBe('23514');
  });

  it('requires an actor that exists, and a photographer that exists', async () => {
    const actor = await insertAdmin();
    expect(await sqlstateOf(db, () => insertAudit({ action: 'category_created' }))).toBe('23502');
    expect(await sqlstateOf(db, () => insertAudit({ actor_user_id: '00000000-0000-4000-8000-000000000001', action: 'category_created' }))).toBe('23503');
    expect(
      await sqlstateOf(db, () => insertAudit({ actor_user_id: actor, action: 'payout_created', photographer_id: '00000000-0000-4000-8000-000000000001' })),
    ).toBe('23503');
  });

  it('keeps history: the acting admin and the photographer cannot be deleted while a row names them (RESTRICT)', async () => {
    const actor = await insertAdmin();
    const photographerId = await insertPhotographer();
    await insertAudit({ actor_user_id: actor, action: 'photographer_suspended', target_type: 'photographer', target_id: photographerId, photographer_id: photographerId });

    expect(await sqlstateOf(db, () => db.query(`DELETE FROM app_user WHERE id = $1`, [actor]))).toBe('23503');
    expect(await sqlstateOf(db, () => db.query(`DELETE FROM photographer WHERE id = $1`, [photographerId]))).toBe('23503');
  });

  it('has the two newest-first indexes', async () => {
    const result = await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'platform_audit' AND indexname <> 'platform_audit_pkey' ORDER BY indexname`,
    );
    expect(result.rows.map((row) => [row.indexname, /\(created_at DESC\)|\(photographer_id, created_at DESC\)/.test(row.indexdef)])).toEqual([
      ['platform_audit_created_at_idx', true],
      ['platform_audit_photographer_id_created_at_idx', true],
    ]);
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
