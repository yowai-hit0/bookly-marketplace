import { apiFetch } from '@/auth/api'

export { ApiError, UnauthenticatedError, apiUrl } from '@/auth/api'

/**
 * A JSON request to a studio endpoint (`/studio/...`), carrying the studio's
 * bearer token: `apiFetch('studio')` (marketplace spec R2.6). A 401 drops the
 * studio session and nothing else.
 */
export function adminFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  return apiFetch<T>('studio', path, init)
}
