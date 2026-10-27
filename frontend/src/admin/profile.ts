import { isValidHandle, normaliseHandle } from '@/auth/handle'
import type { PublicCategory, PublicDistrict } from '@/catalogue/api'
import { ApiError, adminFetch } from './api'
import type { StudioStatus } from './studio-me'

/**
 * The photographer's own profile (marketplace spec R7.2;
 * backend/openapi/paths/studio-profile.yaml): what the public profile shows.
 *
 * `PATCH` takes any subset and changes only what it is sent, so the page sends
 * only what changed. Text is trimmed by the API and an optional field clears
 * with null; the handle can change only until the studio is first approved
 * (`handleEditable`). The district and category lists the editor offers are
 * the public `GET /api/districts` and `GET /api/categories`.
 *
 * The API answers a value it cannot read (a handle outside its format, an
 * address or link that is not one) with a 400 that names no field, so this
 * module checks those first and the page marks the field instead.
 */

export type StudioProfile = {
  handle: string
  handleEditable: boolean
  displayName: string
  bio: string | null
  contactPhone: string | null
  whatsappPhone: string | null
  contactEmail: string | null
  coverImageUrl: string | null
  districts: PublicDistrict[]
  categories: PublicCategory[]
  status: StudioStatus
  /** When the studio was submitted for review (R7.3); null until then, and for an API from before the field. */
  submittedAt: string | null
}

/**
 * Whether a new handle would alert the platform (Phase 7, user decision
 * 2026-10-27): the studio is pending and submitted for review, so the change
 * still saves but every platform admin is emailed the old and the new handle.
 */
export function handleChangeNotifies(profile: StudioProfile): boolean {
  return profile.handleEditable && profile.status === 'pending' && profile.submittedAt !== null
}

/** The body `PATCH /api/studio/profile` takes: any subset. Null clears an optional field. */
export type ProfilePatch = Partial<{
  handle: string
  displayName: string
  bio: string | null
  contactPhone: string | null
  whatsappPhone: string | null
  contactEmail: string | null
  coverImageUrl: string | null
  districts: string[]
  categories: string[]
}>

export type ProfileField = keyof Required<ProfilePatch>

export const PROFILE_TEXT_FIELDS = ['displayName', 'bio', 'contactPhone', 'whatsappPhone', 'contactEmail', 'coverImageUrl'] as const
export type ProfileTextField = (typeof PROFILE_TEXT_FIELDS)[number]

/** What the form holds: every text as typed, and the two sets as codes and slugs. */
export type ProfileForm = Record<ProfileTextField, string> & {
  handle: string
  districts: ReadonlySet<string>
  categories: ReadonlySet<string>
}

export function profileForm(profile: StudioProfile): ProfileForm {
  return {
    handle: profile.handle,
    displayName: profile.displayName,
    bio: profile.bio ?? '',
    contactPhone: profile.contactPhone ?? '',
    whatsappPhone: profile.whatsappPhone ?? '',
    contactEmail: profile.contactEmail ?? '',
    coverImageUrl: profile.coverImageUrl ?? '',
    districts: new Set(profile.districts.map((district) => district.code)),
    categories: new Set(profile.categories.map((category) => category.slug)),
  }
}

/** Characters as the API and PostgreSQL count them: code points, not UTF-16 units. */
export function charCount(value: string): number {
  return [...value].length
}

const OPTIONAL = ['bio', 'contactPhone', 'whatsappPhone', 'contactEmail', 'coverImageUrl'] as const satisfies readonly ProfileTextField[]

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((value) => b.has(value))
}

/**
 * Only what changed between what was loaded and what is in the form, as the
 * API will store it: trimmed, a blank optional field as null, the handle
 * lowercased (the current handle in any case is never a change), and each set
 * compared as a set. An empty object means nothing to save.
 */
export function profilePatch(saved: ProfileForm, form: ProfileForm, handleEditable: boolean): ProfilePatch {
  const patch: ProfilePatch = {}
  if (handleEditable && normaliseHandle(form.handle) !== normaliseHandle(saved.handle)) patch.handle = normaliseHandle(form.handle)
  if (form.displayName.trim() !== saved.displayName.trim()) patch.displayName = form.displayName.trim()
  for (const field of OPTIONAL) {
    const next = form[field].trim()
    if (next !== saved[field].trim()) patch[field] = next === '' ? null : next
  }
  if (!sameSet(form.districts, saved.districts)) patch.districts = [...form.districts]
  if (!sameSet(form.categories, saved.categories)) patch.categories = [...form.categories]
  return patch
}

const URL_MAX = 2000
const PHONE_MAX = 40
/** Digits with the separators people type, an optional leading `+`, and at least one digit. */
const TYPED_PHONE = /^\+?[\d\s\-().]*\d[\d\s\-().]*$/
/** Enough of an address to send; the API's own check is stricter, and its 400 is a form-level error. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** An https link of at most 2,000 characters, the cover's and a portfolio image's rule. */
export function isHttpsLink(raw: string): boolean {
  const value = raw.trim()
  return value.length <= URL_MAX && URL.canParse(value) && new URL(value).protocol === 'https:'
}

/** The fields of `patch` the page can tell are wrong before sending it. */
export function invalidProfileFields(patch: ProfilePatch): ProfileField[] {
  const invalid: ProfileField[] = []
  if (patch.handle !== undefined && !isValidHandle(patch.handle)) invalid.push('handle')
  if (patch.displayName !== undefined && (charCount(patch.displayName) < 1 || charCount(patch.displayName) > 80)) invalid.push('displayName')
  if (typeof patch.bio === 'string' && charCount(patch.bio) > 2000) invalid.push('bio')
  for (const field of ['contactPhone', 'whatsappPhone'] as const) {
    const value = patch[field]
    if (typeof value === 'string' && (value.length > PHONE_MAX || !TYPED_PHONE.test(value))) invalid.push(field)
  }
  if (typeof patch.contactEmail === 'string' && (patch.contactEmail.length > 320 || !EMAIL.test(patch.contactEmail))) invalid.push('contactEmail')
  if (typeof patch.coverImageUrl === 'string' && !isHttpsLink(patch.coverImageUrl)) invalid.push('coverImageUrl')
  return invalid
}

export type SaveResult =
  | { status: 'saved'; profile: StudioProfile }
  /** 409 `handle_taken` or `handle_locked`, or 422 naming these fields. */
  | { status: 'invalid'; fields: ProfileField[]; handle?: 'taken' | 'locked' }
  /** 400: something the API could not read. */
  | { status: 'unreadable' }
  | { status: 'failed' }

const PATCH_FIELDS: ReadonlySet<string> = new Set<ProfileField>([
  'handle',
  'displayName',
  'bio',
  'contactPhone',
  'whatsappPhone',
  'contactEmail',
  'coverImageUrl',
  'districts',
  'categories',
])

function isProfile(value: unknown): value is Omit<StudioProfile, 'submittedAt'> & { submittedAt?: unknown } {
  const profile = value as Partial<StudioProfile> | null
  return (
    typeof profile === 'object' &&
    profile !== null &&
    typeof profile.handle === 'string' &&
    typeof profile.displayName === 'string' &&
    Array.isArray(profile.districts) &&
    Array.isArray(profile.categories)
  )
}

/** A profile without a readable `submittedAt` is one not submitted. */
function withSubmittedAt(profile: Omit<StudioProfile, 'submittedAt'> & { submittedAt?: unknown }): StudioProfile {
  return { ...profile, submittedAt: typeof profile.submittedAt === 'string' ? profile.submittedAt : null }
}

export const profileApi = {
  /** The profile. A 401 throws `UnauthenticatedError`; anything unusable throws. */
  load: async (): Promise<StudioProfile> => {
    const body = await adminFetch<{ profile?: unknown } | null>('/studio/profile', { cache: 'no-store' })
    if (!isProfile(body?.profile)) throw new ApiError(200, 'unexpected_body')
    return withSubmittedAt(body.profile)
  },

  /** Saves `patch`. Never throws for a refusal: each is a `SaveResult`. A 401 still throws. */
  save: async (patch: ProfilePatch): Promise<SaveResult> => {
    try {
      const body = await adminFetch<{ profile?: unknown } | null>('/studio/profile', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      return isProfile(body?.profile) ? { status: 'saved', profile: withSubmittedAt(body.profile) } : { status: 'failed' }
    } catch (error) {
      if (!(error instanceof ApiError) || error.status === 401) throw error
      if (error.status === 409 && error.message === 'handle_taken') return { status: 'invalid', fields: ['handle'], handle: 'taken' }
      if (error.status === 409 && error.message === 'handle_locked') return { status: 'invalid', fields: ['handle'], handle: 'locked' }
      if (error.status === 422) {
        // A list's item comes back as its path (`districts.3`): the field is the list.
        const named = [...new Set(error.fields.map((field) => field.split('.')[0] ?? ''))]
        const fields = named.filter((field): field is ProfileField => PATCH_FIELDS.has(field))
        return fields.length > 0 ? { status: 'invalid', fields } : { status: 'failed' }
      }
      if (error.status === 400) return { status: 'unreadable' }
      return { status: 'failed' }
    }
  },
}
