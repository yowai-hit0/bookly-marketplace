import { env } from '@/env'

/**
 * The public catalogue (plan.md Task 11; marketplace brief decision 4; Phase 6
 * R6.1, R6.2): the directory and its filter lists, one photographer's public
 * profile, and that photographer's services, as `GET /api/photographers`,
 * `/api/categories`, `/api/districts`, `/api/photographers/:handle`,
 * `.../services` and `.../services/:slug` serve them. Anonymous: no token
 * travels with these requests.
 *
 * An unknown handle and a photographer who is not listed (pending, suspended,
 * or with an expired subscription) are the same 404, so each per-photographer
 * read answers null for both: to the public neither exists, and the pages word
 * it as "unavailable" (marketplace spec R5.5). A listed photographer whose
 * subscription is past due is served with `takingBookings: false`: shown, with
 * a notice, and never offered a booking.
 */

/** A district, as the filter bar and the cards name it. */
export type PublicDistrict = { code: string; name: string }

/** An active category: what a photographer shoots. */
export type PublicCategory = { slug: string; name: string }

/** One of Rwanda's five provinces with its districts, for the district filter's groups. */
export type ProvinceDistricts = { code: string; name: string; districts: PublicDistrict[] }

/** What every public view of a photographer carries. */
type PhotographerBase = {
  handle: string
  displayName: string
  /** A pasted link; put through `safeHttpsUrl` before it reaches an `src`. */
  coverImageUrl: string | null
  /** False while the subscription is past due (R5.5): listed, not bookable. */
  takingBookings: boolean
  /** Where they work, in the districts' fixed order. */
  districts: PublicDistrict[]
  /** What they shoot, active categories only. */
  categories: PublicCategory[]
}

/** One photographer on the directory (R6.1). */
export type PublicPhotographerSummary = PhotographerBase & {
  /** The cheapest active package of an active service, whole RWF. */
  fromPriceRwf: number
}

/**
 * The client cancellation terms a photographer offers new bookings, as set
 * now. A booking keeps its own copy when it is made, so a booking's pages read
 * the booking's terms (`CancellationTerms`), never these.
 */
export type CancellationPolicy = {
  /** A client may cancel until this many hours before the shoot; 0 = any time before it. */
  cutoffHours: number
  /** Whether a client's own cancellation refunds the booking fee. */
  bookingFeeRefundable: boolean
}

/** One portfolio image: an `https://` URL the photographer pasted, and its caption. */
export type PortfolioImage = { url: string; caption: string | null }

/** A service as the profile lists it: no packages, just the "from" price. */
export type PublicServiceSummary = {
  slug: string
  nameEn: string
  descriptionEn: string | null
  coverImageUrl: string | null
  /** The cheapest active package; null while the service has none. */
  fromPriceRwf: number | null
}

/**
 * A photographer's profile page (R6.2). Every text field is verbatim from the
 * photographer, markup and all: render it as plain text, never as HTML (R6.5,
 * T6.4). Each contact field is null when not set.
 */
export type PublicPhotographerProfile = PhotographerBase & {
  bio: string | null
  contactPhone: string | null
  whatsappPhone: string | null
  email: string | null
  cancellationPolicy: CancellationPolicy
  /** At most 24, in the photographer's order. */
  portfolio: PortfolioImage[]
  /** The active services, in catalogue order. */
  services: PublicServiceSummary[]
}

export type PublicPackage = {
  id: string
  nameEn: string
  descriptionEn: string | null
  priceRwf: number
  photoCount: number
  durationMinutes: number
}

export type PublicAddon = {
  id: string
  nameEn: string
  priceRwf: number
}

export type PublicService = {
  id: string
  slug: string
  nameEn: string
  descriptionEn: string | null
  coverImageUrl: string | null
  packages: PublicPackage[]
  addons: PublicAddon[]
}

export type PublicServiceDetail = PublicService & {
  /** What this service's booking fee is charged at, 0 to 1. */
  bookingFeeRate: number
  /** The photographer's, as on their profile: whether the slot picker and the booking form are offered. */
  takingBookings: boolean
}

/** The API could not be reached, or answered with something other than the data. */
export class CatalogueLoadError extends Error {
  override readonly name = 'CatalogueLoadError'
}

/** Where a photographer's services are listed. */
export function photographerPath(handle: string): string {
  return `/p/${encodeURIComponent(handle)}`
}

/** Where one of a photographer's services is booked. */
export function servicePath(handle: string, slug: string): string {
  return `${photographerPath(handle)}/${encodeURIComponent(slug)}`
}

/** The directory's filters, as the URL carries them: every value a non-empty string. */
export type DirectoryQuery = Partial<Record<DirectoryParam, string>>

/** The directory's query keys, in the order they are sent. */
export const DIRECTORY_PARAMS = ['category', 'district', 'min', 'max', 'date', 'page'] as const
export type DirectoryParam = (typeof DIRECTORY_PARAMS)[number]

/** One page of the directory, as `GET /api/photographers` answers it. */
export type DirectoryPage = {
  photographers: PublicPhotographerSummary[]
  page: number
  pageSize: number
  hasMore: boolean
  /** Every match across all pages; absent when a date is filtered on. */
  total?: number
}

/**
 * What a directory search can come back with: a page; a `422` naming the
 * filters it refused (`fields`); or a `400`, a request the API cannot read at
 * all (a hand-edited link). Anything else is thrown as `CatalogueLoadError`.
 */
export type DirectoryResult =
  | { status: 'ok'; page: DirectoryPage }
  | { status: 'invalid'; fields: string[] }
  | { status: 'badRequest' }

/** The query string the API is sent: known keys only, empty values left out (an empty value is a 400). */
export function directorySearch(query: DirectoryQuery): string {
  const params = new URLSearchParams()
  for (const key of DIRECTORY_PARAMS) {
    const value = query[key]?.trim()
    if (value) params.set(key, value)
  }
  const search = params.toString()
  return search === '' ? '' : `?${search}`
}

/** One page of the directory, filtered (R6.1). */
export async function searchDirectory(query: DirectoryQuery, signal?: AbortSignal): Promise<DirectoryResult> {
  const res = await get(`/photographers${directorySearch(query)}`, signal)
  if (res.ok) return { status: 'ok', page: (await res.json()) as DirectoryPage }
  if (res.status === 422) {
    const body = (await res.json().catch(() => null)) as { fields?: unknown } | null
    const fields = Array.isArray(body?.fields) ? body.fields.filter((field): field is string => typeof field === 'string') : []
    return { status: 'invalid', fields }
  }
  if (res.status === 400) return { status: 'badRequest' }
  throw new CatalogueLoadError(`http_${res.status}`)
}

/** The first page of the directory, unfiltered: the landing page's featured strip. */
export async function fetchPhotographers(signal?: AbortSignal): Promise<PublicPhotographerSummary[]> {
  const res = await get('/photographers', signal)
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { photographers: PublicPhotographerSummary[] }).photographers
}

/** The active categories, in the platform's order. */
export async function fetchCategories(signal?: AbortSignal): Promise<PublicCategory[]> {
  const res = await get('/categories', signal)
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { categories?: PublicCategory[] }).categories ?? []
}

/** Rwanda's districts, grouped by province, in their fixed order. */
export async function fetchDistricts(signal?: AbortSignal): Promise<ProvinceDistricts[]> {
  const res = await get('/districts', signal)
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { provinces?: ProvinceDistricts[] }).provinces ?? []
}

/** A photographer's public profile, or null when the handle names nobody who can be booked. */
export async function fetchPhotographer(handle: string, signal?: AbortSignal): Promise<PublicPhotographerProfile | null> {
  const res = await get(`/photographers/${encodeURIComponent(handle)}`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { photographer: PublicPhotographerProfile }).photographer
}

/** A photographer's active services, or null when the handle names nobody who can be booked. */
export async function fetchServices(handle: string, signal?: AbortSignal): Promise<PublicService[] | null> {
  const res = await get(`/photographers/${encodeURIComponent(handle)}/services`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { services: PublicService[] }).services
}

/** One of a photographer's active services, or null when the handle or the slug is unknown or retired. */
export async function fetchService(handle: string, slug: string, signal?: AbortSignal): Promise<PublicServiceDetail | null> {
  const res = await get(`/photographers/${encodeURIComponent(handle)}/services/${encodeURIComponent(slug)}`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { service: PublicServiceDetail }).service
}

function get(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${env.VITE_API_BASE_URL}${path}`, { headers: { Accept: 'application/json' }, signal })
}
