import { Prisma, type PrismaClient } from '@prisma/client';
import { findDayStartsFor } from '../availability/query.js';
import { type KigaliDate, kigaliDateOf, kigaliMinuteToUtc, kigaliWeekday } from '../availability/engine.js';
import { bookableSqlAt, listedSqlAt } from '../photographers/bookable.js';
import { SLOT_GRANULARITY_MINUTES, getPlatformSettings } from '../settings/index.js';

/**
 * The public directory (marketplace-spec.md R6.1; marketplace-data-model.md
 * §3.12): who is listed, filtered by category, district, "from" price and a
 * date they can be booked on, a page of 24 at a time.
 *
 * WHO. Listed photographers only (photographers/bookable.ts, R5.5): approved,
 * with a subscription `trialing`, `active` or `past_due` inside the grace.
 * Pending, suspended and expired never appear. A `past_due` photographer is
 * listed with `takingBookings: false`, after every bookable one, and is left out
 * whenever a date is asked for: they cannot be booked on any date (user
 * decision, Phase 6).
 *
 * PRICE. `fromPriceRwf` is the cheapest ACTIVE package of an ACTIVE service. A
 * photographer with none has nothing to book and is not listed at all. The
 * `min`/`max` filters compare that price.
 *
 * ORDER. Bookable first, then the cheapest price, then the name (lowercased,
 * compared byte by byte so the order does not depend on the database's locale),
 * then the id: a total order, so a page boundary never moves between two
 * requests over the same rows.
 *
 * DATE. Two stages, as §3.12 has it:
 *   1. SQL keeps the candidates that are bookable, open that day by the
 *      working-hours rules (a dated row wins over the weekday's), whose window
 *      fits their shortest package on the slot grid, and that no single block
 *      covers wholly. Every one of those is a necessary condition of a slot, so
 *      the pre-filter never drops a photographer the engine would keep.
 *   2. The availability engine (availability/engine.ts), through
 *      `findDayStartsFor` -- the same loading as the calendar's -- keeps a
 *      candidate only if it offers at least one start for their SHORTEST
 *      active package. Fully booked, blocked in pieces, inside the lead time:
 *      all decided there, so the directory agrees with the calendar.
 *
 * PAGINATION UNDER THE ENGINE. Page n is survivors 24(n-1)+1 .. 24n of the
 * candidates in the order above. The engine runs on candidates in chunks, in
 * order, from the first, until 24n + 1 have survived or the candidates run out:
 * the engine on the current page and what precedes it, never on the rest. So
 * every page is exactly the slice it claims to be, pages never overlap or skip,
 * and `hasMore` is true only when survivor 24n + 1 was actually found. `total`
 * is NOT answered with a date: knowing it would mean running the engine on
 * every candidate, and a count of SQL candidates would overstate it. Without a
 * date, `total` is the exact count, and `hasMore` is `page * 24 < total`.
 *
 * Every value reaches SQL as a bound parameter (`Prisma.sql`); nothing from the
 * request is ever spliced into the text.
 */

export const DIRECTORY_PAGE_SIZE = 24;
/** A developer bound, not a spec value: 24,000 photographers deep. Past it, a 422. */
export const DIRECTORY_MAX_PAGE = 1000;
/**
 * How far ahead the date filter answers (a developer bound; the app has no
 * booking horizon of its own). A year covers every season a client plans for,
 * and bounds what the engine is asked to compute.
 */
export const DIRECTORY_DATE_HORIZON_DAYS = 365;
/** Candidates the engine checks per round trip under the date filter: two pages. */
const ENGINE_CHUNK = 2 * DIRECTORY_PAGE_SIZE;

const DAY_MS = 24 * 60 * 60_000;

export type DirectoryFilters = {
  /** An ACTIVE category's slug; the route has already refused an unknown one. */
  category?: string;
  /** A district code; the route has already refused an unknown one. */
  district?: string;
  /** Inclusive bounds on `fromPriceRwf`. */
  min?: number;
  max?: number;
  /** A Kigali date inside the window `directoryDateWindow` gives. */
  date?: KigaliDate;
  /** 1-based. */
  page: number;
};

export type PublicDistrict = { code: string; name: string };
export type PublicCategory = { slug: string; name: string };

/** One card of the directory. An allowlist: no id, status, login or settings. */
export type DirectoryPhotographer = {
  handle: string;
  displayName: string;
  coverImageUrl: string | null;
  /** The cheapest active package of an active service, whole RWF. */
  fromPriceRwf: number;
  districts: PublicDistrict[];
  categories: PublicCategory[];
  /** False while the subscription is `past_due` (R5.5): listed, not taking bookings. */
  takingBookings: boolean;
};

export type DirectoryPage = {
  photographers: DirectoryPhotographer[];
  page: number;
  pageSize: number;
  hasMore: boolean;
  /** Every match across all pages. Only without a date: see the header. */
  total?: number;
};

type CandidateRow = {
  id: string;
  handle: string;
  display_name: string;
  cover_image_url: string | null;
  from_price_rwf: number;
  shortest_minutes: number;
  taking_bookings: boolean;
};

/**
 * The Kigali dates the date filter accepts at `now`: today (whose later slots
 * may still be free) through `DIRECTORY_DATE_HORIZON_DAYS` ahead. Plain
 * `YYYY-MM-DD` strings compare in calendar order.
 */
export function directoryDateWindow(now: Date): { first: KigaliDate; last: KigaliDate } {
  return { first: kigaliDateOf(now), last: kigaliDateOf(new Date(now.getTime() + DIRECTORY_DATE_HORIZON_DAYS * DAY_MS)) };
}

export async function searchDirectory(prisma: PrismaClient, filters: DirectoryFilters, now: Date): Promise<DirectoryPage> {
  const { subscriptionGraceDays } = await getPlatformSettings(prisma);
  const from = candidatesFrom(filters, now, subscriptionGraceDays);
  const pageStart = (filters.page - 1) * DIRECTORY_PAGE_SIZE;

  if (filters.date === undefined) {
    const [rows, counted] = await Promise.all([
      selectCandidates(prisma, from, now, DIRECTORY_PAGE_SIZE, pageStart),
      prisma.$queryRaw<{ total: number }[]>`SELECT count(*)::int AS total ${from}`,
    ]);
    const total = counted[0]?.total ?? 0;
    return {
      photographers: await toCards(prisma, rows),
      page: filters.page,
      pageSize: DIRECTORY_PAGE_SIZE,
      hasMore: pageStart + rows.length < total,
      total,
    };
  }

  // Survivors in candidate order, until one past this page is known to exist.
  const wanted = pageStart + DIRECTORY_PAGE_SIZE + 1;
  const survivors: CandidateRow[] = [];
  for (let offset = 0; survivors.length < wanted; offset += ENGINE_CHUNK) {
    const chunk = await selectCandidates(prisma, from, now, ENGINE_CHUNK, offset);
    const starts = await findDayStartsFor(prisma, {
      date: filters.date,
      now,
      photographers: chunk.map((row) => ({ photographerId: row.id, packageDurationMinutes: row.shortest_minutes })),
    });
    survivors.push(...chunk.filter((row) => (starts.get(row.id)?.length ?? 0) > 0));
    if (chunk.length < ENGINE_CHUNK) break;
  }

  return {
    photographers: await toCards(prisma, survivors.slice(pageStart, pageStart + DIRECTORY_PAGE_SIZE)),
    page: filters.page,
    pageSize: DIRECTORY_PAGE_SIZE,
    hasMore: survivors.length > pageStart + DIRECTORY_PAGE_SIZE,
  };
}

/**
 * `FROM ... WHERE ...` of every match, shared by the page and the count so
 * they can never disagree. The price lateral reads `package_directory_price_idx`
 * (photographer_id, price_rwf) WHERE is_active; the joins and EXISTS read the
 * subscription's unique photographer_id, the join tables' primary keys, the
 * working-hours partial uniques and `availability_block_range_idx` (§3.12).
 */
function candidatesFrom(filters: DirectoryFilters, now: Date, graceDays: number): Prisma.Sql {
  const conditions: Prisma.Sql[] = [listedSqlAt(now, graceDays)];
  let dateJoin = Prisma.empty;

  if (filters.category !== undefined) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM photographer_category pc JOIN category c ON c.id = pc.category_id
       WHERE pc.photographer_id = ph.id AND c.slug = ${filters.category} AND c.is_active)`);
  }
  if (filters.district !== undefined) {
    conditions.push(Prisma.sql`EXISTS (
      SELECT 1 FROM photographer_district pd WHERE pd.photographer_id = ph.id AND pd.district_code = ${filters.district})`);
  }
  if (filters.min !== undefined) conditions.push(Prisma.sql`price.from_price_rwf >= ${filters.min}::int`);
  if (filters.max !== undefined) conditions.push(Prisma.sql`price.from_price_rwf <= ${filters.max}::int`);

  if (filters.date !== undefined) {
    const dayStart = kigaliMinuteToUtc(filters.date, 0);
    // The engine's step 1 (resolveWindow): a dated row for the date wins over the weekday's, in either direction.
    dateJoin = Prisma.sql`
      JOIN LATERAL (
        SELECT wh.is_open, wh.opens_minute, wh.closes_minute
          FROM working_hours wh
         WHERE wh.photographer_id = ph.id
           AND ((wh.weekday IS NULL AND wh.effective_date = ${filters.date}::date)
             OR (wh.effective_date IS NULL AND wh.weekday = ${kigaliWeekday(filters.date)}::int))
         ORDER BY (wh.effective_date IS NULL) ASC
         LIMIT 1
      ) win ON true`;
    conditions.push(
      // Past-due photographers cannot be booked on any date (user decision, Phase 6).
      bookableSqlAt(now),
      Prisma.sql`win.is_open AND win.opens_minute IS NOT NULL AND win.closes_minute IS NOT NULL`,
      // The engine's first grid start, plus the shortest package, must end by closing (engine step 5).
      Prisma.sql`ceil(win.opens_minute::numeric / ${SLOT_GRANULARITY_MINUTES}::int) * ${SLOT_GRANULARITY_MINUTES}::int
                 + price.shortest_minutes <= win.closes_minute`,
      // Not wholly blocked: no single block covers the open window (engine step 2).
      Prisma.sql`NOT EXISTS (
        SELECT 1 FROM availability_block b
         WHERE b.photographer_id = ph.id
           AND tstzrange(b.starts_at, b.ends_at, '[)') @> tstzrange(
                 ${dayStart}::timestamptz + make_interval(mins => win.opens_minute),
                 ${dayStart}::timestamptz + make_interval(mins => win.closes_minute), '[)'))`,
    );
  }

  return Prisma.sql`
    FROM photographer ph
    JOIN subscription s ON s.photographer_id = ph.id
    JOIN LATERAL (
      SELECT min(p.price_rwf)::int AS from_price_rwf, min(p.duration_minutes)::int AS shortest_minutes
        FROM package p
        JOIN service sv ON sv.id = p.service_id AND sv.photographer_id = p.photographer_id
       WHERE p.photographer_id = ph.id AND p.is_active AND sv.is_active
    ) price ON price.from_price_rwf IS NOT NULL
    ${dateJoin}
   WHERE ${Prisma.join(conditions, ' AND ')}`;
}

function selectCandidates(prisma: PrismaClient, from: Prisma.Sql, now: Date, limit: number, offset: number): Promise<CandidateRow[]> {
  return prisma.$queryRaw<CandidateRow[]>`
    SELECT ph.id::text AS id, ph.handle, ph.display_name, ph.cover_image_url,
           price.from_price_rwf, price.shortest_minutes, ${bookableSqlAt(now)} AS taking_bookings
    ${from}
     ORDER BY taking_bookings DESC, price.from_price_rwf ASC, lower(ph.display_name) COLLATE "C" ASC, ph.id ASC
     LIMIT ${limit}::int OFFSET ${offset}::int`;
}

/** The page's districts (in the migration's order) and active categories (in the platform's order), two reads for the page. */
async function toCards(prisma: PrismaClient, rows: readonly CandidateRow[]): Promise<DirectoryPhotographer[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const [districts, categories] = await Promise.all([
    prisma.photographerDistrict.findMany({
      where: { photographerId: { in: ids } },
      select: { photographerId: true, district: { select: { code: true, name: true } } },
      orderBy: [{ district: { sortOrder: 'asc' } }, { districtCode: 'asc' }],
    }),
    prisma.photographerCategory.findMany({
      where: { photographerId: { in: ids }, category: { isActive: true } },
      select: { photographerId: true, category: { select: { slug: true, nameEn: true } } },
      orderBy: [{ category: { sortOrder: 'asc' } }, { category: { nameEn: 'asc' } }, { category: { slug: 'asc' } }],
    }),
  ]);
  return rows.map((row) => ({
    handle: row.handle,
    displayName: row.display_name,
    coverImageUrl: row.cover_image_url,
    fromPriceRwf: row.from_price_rwf,
    districts: districts.filter((entry) => entry.photographerId === row.id).map((entry) => ({ code: entry.district.code, name: entry.district.name })),
    categories: categories.filter((entry) => entry.photographerId === row.id).map((entry) => ({ slug: entry.category.slug, name: entry.category.nameEn })),
    takingBookings: row.taking_bookings,
  }));
}

// --- Reference data for the filter bar ------------------------------------------------

/** The provinces in the migration's order, with their English names (§3.4). */
export const PROVINCE_NAMES = {
  kigali: 'Kigali City',
  eastern: 'Eastern Province',
  northern: 'Northern Province',
  southern: 'Southern Province',
  western: 'Western Province',
} as const;

export type ProvinceDistricts = { code: string; name: string; districts: PublicDistrict[] };

/** The active categories, in the platform's order (§3.5). An inactive one is not offered as a filter. */
export async function listActiveCategories(prisma: PrismaClient): Promise<PublicCategory[]> {
  const rows = await prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { nameEn: 'asc' }, { slug: 'asc' }],
    select: { slug: true, nameEn: true },
  });
  return rows.map((row) => ({ slug: row.slug, name: row.nameEn }));
}

/** Rwanda's 30 districts, grouped by province, both in the migration's order (§3.4). */
export async function listDistrictsByProvince(prisma: PrismaClient): Promise<ProvinceDistricts[]> {
  const rows = await prisma.district.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] });
  const provinces: ProvinceDistricts[] = [];
  for (const row of rows) {
    let province = provinces.find((entry) => entry.code === row.province);
    if (province === undefined) {
      province = { code: row.province, name: PROVINCE_NAMES[row.province as keyof typeof PROVINCE_NAMES] ?? row.province, districts: [] };
      provinces.push(province);
    }
    province.districts.push({ code: row.code, name: row.name });
  }
  return provinces;
}

/** Whether a category slug names an ACTIVE category, and a district code a district: the route's 422s. */
export async function unknownDirectoryFilters(prisma: PrismaClient, filters: Pick<DirectoryFilters, 'category' | 'district'>): Promise<string[]> {
  const [category, district] = await Promise.all([
    filters.category === undefined ? null : prisma.category.findFirst({ where: { slug: filters.category, isActive: true }, select: { id: true } }),
    filters.district === undefined ? null : prisma.district.findUnique({ where: { code: filters.district }, select: { code: true } }),
  ]);
  const fields: string[] = [];
  if (filters.category !== undefined && category === null) fields.push('category');
  if (filters.district !== undefined && district === null) fields.push('district');
  return fields;
}
