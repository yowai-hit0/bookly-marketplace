import { env } from '@/env'

/**
 * The public catalogue, as `GET /api/services` and `GET /api/services/:slug`
 * serve it (plan.md Task 11). Anonymous: no token travels with these requests.
 */

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

export async function fetchServices(signal?: AbortSignal): Promise<PublicService[]> {
  const res = await get('/services', signal)
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { services: PublicService[] }).services
}

/** One active service, or null when the slug is unknown or deactivated. */
export async function fetchService(slug: string, signal?: AbortSignal): Promise<PublicServiceDetail | null> {
  const res = await get(`/services/${encodeURIComponent(slug)}`, signal)
  if (res.status === 404) return null
  if (!res.ok) throw new CatalogueLoadError(`http_${res.status}`)
  return ((await res.json()) as { service: PublicServiceDetail }).service
}

function get(path: string, signal?: AbortSignal): Promise<Response> {
  return fetch(`${env.VITE_API_BASE_URL}${path}`, { headers: { Accept: 'application/json' }, signal })
}
