import { ApiError, adminFetch } from './api'
import { charCount, isHttpsLink } from './profile'

/**
 * The photographer's portfolio (marketplace spec R7.2;
 * backend/openapi/paths/studio-profile.yaml): up to 24 images, each a pasted
 * `https://` link with an optional caption, in the photographer's order, which
 * the public profile shows. Bookly stores the links, never the files.
 *
 * A reorder sends every id in its new place; the API takes it only when it is
 * exactly the photographer's set, so a list changed elsewhere (another tab
 * added or removed a photo) answers 422 and the page reloads.
 */

export type PortfolioImage = {
  id: string
  url: string
  caption: string | null
  sortOrder: number
  createdAt: string
}

export type Portfolio = { images: PortfolioImage[]; limit: number }

/** The API's own cap, should an answer ever leave it out. */
export const PORTFOLIO_LIMIT = 24
export const CAPTION_MAX = 200

/** The fields of a new image the page can tell are wrong before sending it. */
export function invalidImageFields(url: string, caption: string): ('url' | 'caption')[] {
  const invalid: ('url' | 'caption')[] = []
  if (!isHttpsLink(url)) invalid.push('url')
  if (charCount(caption.trim()) > CAPTION_MAX) invalid.push('caption')
  return invalid
}

/** A blank caption is no caption: null, which the API stores as none. */
function captionOrNull(caption: string): string | null {
  const trimmed = caption.trim()
  return trimmed === '' ? null : trimmed
}

function isImage(value: unknown): value is PortfolioImage {
  const image = value as Partial<PortfolioImage> | null
  return typeof image === 'object' && image !== null && typeof image.id === 'string' && typeof image.url === 'string'
}

function images(value: unknown): PortfolioImage[] {
  return Array.isArray(value) ? value.filter(isImage) : []
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export type AddResult =
  | { status: 'added'; image: PortfolioImage }
  /** 409 `portfolio_full`: the limit was reached elsewhere first. */
  | { status: 'full' }
  /** 422 naming these fields, or a 400 (an unreadable link: the url). */
  | { status: 'invalid'; fields: ('url' | 'caption')[] }
  | { status: 'failed' }

export type CaptionResult =
  | { status: 'saved'; image: PortfolioImage }
  | { status: 'gone' }
  | { status: 'invalid' }
  | { status: 'failed' }

export type RemoveResult = { status: 'removed' } | { status: 'gone' } | { status: 'failed' }

export type OrderResult =
  | { status: 'saved'; images: PortfolioImage[] }
  /** 422: not exactly the photographer's set any more; reload. */
  | { status: 'changed' }
  | { status: 'failed' }

/** A refusal the page can act on, or rethrow: a 401 (the session is gone) and anything not from the API. */
function refusal(error: unknown): ApiError {
  if (!(error instanceof ApiError) || error.status === 401) throw error
  return error
}

export const portfolioApi = {
  /** The images in order. A 401 throws `UnauthenticatedError`; anything unusable throws. */
  load: async (): Promise<Portfolio> => {
    const body = await adminFetch<{ images?: unknown; limit?: unknown } | null>('/studio/portfolio', { cache: 'no-store' })
    if (body === null || typeof body !== 'object' || !Array.isArray(body.images)) throw new ApiError(200, 'unexpected_body')
    return { images: images(body.images), limit: typeof body.limit === 'number' ? body.limit : PORTFOLIO_LIMIT }
  },

  add: async (url: string, caption: string): Promise<AddResult> => {
    try {
      const body = await adminFetch<{ image?: unknown } | null>('/studio/portfolio', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ url: url.trim(), caption: captionOrNull(caption) }),
      })
      return isImage(body?.image) ? { status: 'added', image: body.image } : { status: 'failed' }
    } catch (error) {
      const refused = refusal(error)
      if (refused.status === 409 && refused.message === 'portfolio_full') return { status: 'full' }
      if (refused.status === 400) return { status: 'invalid', fields: ['url'] }
      if (refused.status === 422) {
        const fields = (['url', 'caption'] as const).filter((field) => refused.fields.includes(field))
        return fields.length > 0 ? { status: 'invalid', fields } : { status: 'failed' }
      }
      return { status: 'failed' }
    }
  },

  caption: async (id: string, caption: string): Promise<CaptionResult> => {
    try {
      const body = await adminFetch<{ image?: unknown } | null>(`/studio/portfolio/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ caption: captionOrNull(caption) }),
      })
      return isImage(body?.image) ? { status: 'saved', image: body.image } : { status: 'failed' }
    } catch (error) {
      const refused = refusal(error)
      if (refused.status === 404) return { status: 'gone' }
      if (refused.status === 422 || refused.status === 400) return { status: 'invalid' }
      return { status: 'failed' }
    }
  },

  remove: async (id: string): Promise<RemoveResult> => {
    try {
      await adminFetch<undefined>(`/studio/portfolio/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return { status: 'removed' }
    } catch (error) {
      const refused = refusal(error)
      return refused.status === 404 ? { status: 'gone' } : { status: 'failed' }
    }
  },

  order: async (ids: readonly string[]): Promise<OrderResult> => {
    try {
      const body = await adminFetch<{ images?: unknown } | null>('/studio/portfolio/order', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids }),
      })
      return Array.isArray(body?.images) ? { status: 'saved', images: images(body.images) } : { status: 'failed' }
    } catch (error) {
      const refused = refusal(error)
      // A 400 (an id that is not one) cannot come from the page's own list; treat it as changed too.
      return refused.status === 422 || refused.status === 400 ? { status: 'changed' } : { status: 'failed' }
    }
  },
}

/** `ids` with the one at `index` moved one place up (-1) or down (+1); unchanged at either end. */
export function moved<T>(items: readonly T[], index: number, by: -1 | 1): T[] {
  const target = index + by
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items]
  const next = [...items]
  const [item] = next.splice(index, 1)
  next.splice(target, 0, item as T)
  return next
}
