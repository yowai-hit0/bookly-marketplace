import { env } from '@/env'

/**
 * The public catalogue (plan.md Task 11; marketplace brief decision 4): the
 * photographers who can be booked, one photographer's public profile, and
 * that photographer's services, as `GET /api/photographers`,
 * `/api/photographers/:handle`, `.../services` and `.../services/:slug` serve
 * them. Anonymous: no token travels with these requests.
 *
 * An unknown handle and a photographer who cannot be booked are the same 404,
 * so each per-photographer read answers null for both: to the public neither
 * exists.
 */

/** One photographer on the list. */
export type PublicPhotographerSummary = {
  handle: string
  displayName: string
  /** A pasted link; put through `safeHttpsUrl` before it reaches an `src`. */
  coverImageUrl: string | null
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

export type PublicPhotographerProfile = PublicPhotographerSummary & {
  bio: string | null
  contactPhone: string | null
  whatsappPhone: string | null
  email: string | null
  cancellationPolicy: CancellationPolicy
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

/** Every photographer who can be booked. */
export async function fetchPhotographers(signal?: AbortSignal): Promise<PublicPhotographerSummary[]> {
  const res = await get('/photographers', signal)
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { photographers: PublicPhotographerSummary[] }).photographers
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
