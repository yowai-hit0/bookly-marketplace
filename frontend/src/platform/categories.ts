import { ApiError, apiFetch } from '@/auth/api'

/**
 * The platform's categories (marketplace spec R9.2; Phase 9 user decision 3;
 * backend/openapi/paths/platform-console.yaml): every category, active and
 * inactive, in the platform's order, each with how many photographers have
 * it. Create, rename, deactivate or reactivate, reorder, and delete one
 * nobody has. Carries the platform's own token.
 *
 * Deactivating hides a category from the public side and the studio picker;
 * the photographers who have it keep the tag, and reactivating brings it back.
 * The slug never changes once made: it is in every shared directory link.
 *
 * Each call answers a result the page can act on, like the studio portfolio's
 * client; a 401 still throws `UnauthenticatedError` (the session is gone).
 */

export type PlatformCategory = {
  id: string
  slug: string
  nameEn: string
  isActive: boolean
  sortOrder: number
  /** Photographers tagged with it, of every status. Deleting needs 0. */
  photographerCount: number
  createdAt: string
  updatedAt: string
}

/** The slug's form: lowercase letters and digits in hyphen-separated words (the API's CHECK). */
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/
export const SLUG_MAX = 64
export const NAME_MAX = 80

/** Code points, as the API counts them, so an emoji is one character. */
function length(value: string): number {
  return [...value].length
}

/** What is wrong with a slug as typed, or null when the API would take it (trimmed, as the API trims). */
export function slugProblem(raw: string): 'required' | 'format' | 'long' | null {
  const slug = raw.trim()
  if (slug === '') return 'required'
  if (slug.length > SLUG_MAX) return 'long'
  return SLUG_PATTERN.test(slug) ? null : 'format'
}

/** What is wrong with a name as typed, or null: 1 to 80 characters once trimmed, no NUL. */
export function nameProblem(raw: string): 'required' | 'long' | null {
  const name = raw.trim()
  if (name === '' || name.includes('\u0000')) return 'required'
  return length(name) > NAME_MAX ? 'long' : null
}

/**
 * A slug suggested from a name: lowercase, accents dropped, every other run of
 * characters a single hyphen, at most 64 characters. Only a suggestion; the
 * admin can type over it.
 */
export function slugFromName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '')
}

/** The list with the category at `index` moved one place by `by`; the same list when it cannot move. */
export function movedCategory<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const next = [...list]
  const to = index + by
  const item = next[index]
  const other = next[to]
  if (item === undefined || other === undefined) return next
  next[index] = other
  next[to] = item
  return next
}

function isCategory(value: unknown): value is PlatformCategory {
  const c = value as Partial<Record<keyof PlatformCategory, unknown>> | null
  return (
    typeof c === 'object' &&
    c !== null &&
    typeof c.id === 'string' &&
    typeof c.slug === 'string' &&
    typeof c.nameEn === 'string' &&
    typeof c.isActive === 'boolean' &&
    typeof c.photographerCount === 'number'
  )
}

function categoriesOf(value: unknown): PlatformCategory[] | null {
  const list = (value as { categories?: unknown } | null)?.categories
  return Array.isArray(list) ? list.filter(isCategory) : null
}

function categoryOf(value: unknown): PlatformCategory | null {
  const category = (value as { category?: unknown } | null)?.category
  return isCategory(category) ? category : null
}

type Field = 'slug' | 'nameEn'

export type CreateResult =
  | { status: 'created'; category: PlatformCategory }
  /** 409 `slug_taken`: another category, active or not, has it. */
  | { status: 'slug_taken' }
  | { status: 'invalid'; fields: Field[] }
  | { status: 'failed' }

export type UpdateResult =
  | { status: 'saved'; category: PlatformCategory }
  | { status: 'gone' }
  | { status: 'invalid' }
  | { status: 'failed' }

export type OrderResult =
  | { status: 'saved'; categories: PlatformCategory[] }
  /** 422: not exactly the full set any more (one was created or deleted elsewhere). */
  | { status: 'changed' }
  | { status: 'failed' }

export type DeleteResult =
  | { status: 'deleted' }
  /** 409 `category_in_use`: someone has it now, with how many. */
  | { status: 'in_use'; photographerCount: number }
  | { status: 'gone' }
  | { status: 'failed' }

/** A 401 is the session's to handle; any other refusal is the caller's result. */
function refusal(error: unknown): ApiError {
  if (!(error instanceof ApiError) || error.status === 401) throw error
  return error
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

export const platformCategoriesApi = {
  /** Every category in the platform's order. A 401 throws `UnauthenticatedError`; anything unusable throws. */
  list: async (): Promise<PlatformCategory[]> => {
    const list = categoriesOf(await apiFetch<unknown>('platform', '/platform/categories', { cache: 'no-store' }))
    if (list === null) throw new Error('Unexpected categories answer')
    return list
  },

  create: async (slug: string, nameEn: string): Promise<CreateResult> => {
    try {
      const category = categoryOf(
        await apiFetch<unknown>('platform', '/platform/categories', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify({ slug: slug.trim(), nameEn: nameEn.trim() }),
        }),
      )
      return category === null ? { status: 'failed' } : { status: 'created', category }
    } catch (error) {
      const refused = refusal(error)
      if (refused.status === 409 && refused.message === 'slug_taken') return { status: 'slug_taken' }
      // A malformed slug is the 400 (the CHECK's form).
      if (refused.status === 400) return { status: 'invalid', fields: ['slug'] }
      if (refused.status === 422) {
        const fields = (['slug', 'nameEn'] as const).filter((field) => refused.fields.includes(field))
        return fields.length > 0 ? { status: 'invalid', fields } : { status: 'failed' }
      }
      return { status: 'failed' }
    }
  },

  /** A rename (`nameEn`), a deactivation or reactivation (`isActive`), or both. */
  update: async (id: string, change: { nameEn?: string; isActive?: boolean }): Promise<UpdateResult> => {
    const body = { ...(change.nameEn === undefined ? {} : { nameEn: change.nameEn.trim() }), ...(change.isActive === undefined ? {} : { isActive: change.isActive }) }
    try {
      const category = categoryOf(
        await apiFetch<unknown>('platform', `/platform/categories/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        }),
      )
      return category === null ? { status: 'failed' } : { status: 'saved', category }
    } catch (error) {
      const refused = refusal(error)
      if (refused.status === 404) return { status: 'gone' }
      if (refused.status === 422) return { status: 'invalid' }
      return { status: 'failed' }
    }
  },

  /** Every id, inactive ones included, each once, in the new order. */
  order: async (ids: readonly string[]): Promise<OrderResult> => {
    try {
      const categories = categoriesOf(
        await apiFetch<unknown>('platform', '/platform/categories/order', { method: 'PUT', headers: JSON_HEADERS, body: JSON.stringify({ ids }) }),
      )
      return categories === null ? { status: 'failed' } : { status: 'saved', categories }
    } catch (error) {
      return refusal(error).status === 422 ? { status: 'changed' } : { status: 'failed' }
    }
  },

  remove: async (id: string): Promise<DeleteResult> => {
    try {
      await apiFetch<undefined>('platform', `/platform/categories/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return { status: 'deleted' }
    } catch (error) {
      const refused = refusal(error)
      if (refused.status === 409 && refused.message === 'category_in_use') {
        const count = (refused.body as { photographerCount?: unknown } | null)?.photographerCount
        return { status: 'in_use', photographerCount: typeof count === 'number' && count > 0 ? count : 1 }
      }
      if (refused.status === 404) return { status: 'gone' }
      return { status: 'failed' }
    }
  },
}
