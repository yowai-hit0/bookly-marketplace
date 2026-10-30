import type { TFunction } from 'i18next'
import { apiFetch } from '@/auth/api'
import { formatDateTime, formatMoney } from '@/lib/format'

/**
 * The platform's audit trail (marketplace spec R9.4; Phase 9 user decision 1;
 * backend/openapi/paths/platform-console.yaml `audit`): every platform action
 * that changed something, newest first, 50 a page, read-only. Carries the
 * platform's own token.
 *
 * Each entry is shown as one plain-language sentence built from i18n keys
 * (`describeEntry`), never as raw JSON. `details` is read defensively: a
 * missing or mistyped field drops the clause that needs it, an unknown action
 * or setting still reads as words, and nothing throws.
 */

export const AUDIT_ACTIONS = [
  'photographer_approved',
  'photographer_suspended',
  'photographer_reactivated',
  'payout_created',
  'payout_paid',
  'payout_cancelled',
  'refund_recorded',
  'settings_updated',
  'category_created',
  'category_updated',
  'category_reordered',
  'category_deactivated',
  'category_reactivated',
  'category_deleted',
] as const

export type AuditAction = (typeof AUDIT_ACTIONS)[number]

export function isAuditAction(value: unknown): value is AuditAction {
  return typeof value === 'string' && (AUDIT_ACTIONS as readonly string[]).includes(value)
}

/** The areas the action filter groups the vocabulary by, in the nav's order. */
export const AUDIT_AREAS = ['photographers', 'money', 'settings', 'categories'] as const
export type AuditArea = (typeof AUDIT_AREAS)[number]

export const AUDIT_GROUPS: Record<AuditArea, readonly AuditAction[]> = {
  photographers: ['photographer_approved', 'photographer_suspended', 'photographer_reactivated'],
  money: ['payout_created', 'payout_paid', 'payout_cancelled', 'refund_recorded'],
  settings: ['settings_updated'],
  categories: ['category_created', 'category_updated', 'category_reordered', 'category_deactivated', 'category_reactivated', 'category_deleted'],
}

/** Which area an action belongs to; an action outside the vocabulary has none. */
export function areaOf(action: string): AuditArea | null {
  for (const area of AUDIT_AREAS) if ((AUDIT_GROUPS[area] as readonly string[]).includes(action)) return area
  return null
}

export type AuditEntry = {
  id: string
  /** One of `AUDIT_ACTIONS`, typed loosely: a newer API may send one this page does not know. */
  action: string
  actor: { id: string; email: string }
  target: { type: string | null; id: string | null }
  photographer: { id: string; handle: string; displayName: string } | null
  details: Record<string, unknown>
  createdAt: string
}

export type AuditPage = {
  entries: AuditEntry[]
  total: number
  page: number
  pageSize: number
  pageCount: number
}

export type AuditQuery = { action?: AuditAction; photographerId?: string; page?: number }

/** The API's bounds on `page` (a value outside them is a 422). */
export const MAX_PAGE = 1_000_000

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

/** A `?page=` the API would take: a whole number from 1 to 1,000,000, written plainly; anything else is null. */
export function parsePage(value: string | null): number | null {
  if (value === null || !/^[1-9]\d*$/.test(value)) return null
  const page = Number(value)
  return page <= MAX_PAGE ? page : null
}

/**
 * The query the page's URL asks for, keeping only what the API would accept:
 * a value it would refuse (400 or 422) is dropped, so a hand-edited link
 * shows the unfiltered list rather than an error.
 */
export function queryFromParams(params: URLSearchParams): AuditQuery {
  const action = params.get('action')
  const photographerId = params.get('photographerId')
  const page = parsePage(params.get('page'))
  return {
    ...(isAuditAction(action) ? { action } : {}),
    ...(isUuid(photographerId) ? { photographerId } : {}),
    ...(page !== null && page > 1 ? { page } : {}),
  }
}

/** The URL search for a query (page 1 is left out), in a fixed key order. */
export function paramsFromQuery(query: AuditQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.action !== undefined) params.set('action', query.action)
  if (query.photographerId !== undefined) params.set('photographerId', query.photographerId)
  if (query.page !== undefined && query.page > 1) params.set('page', String(query.page))
  return params
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One entry as the page can rely on it; anything the shape does not hold is null. */
export function normaliseEntry(value: unknown): AuditEntry | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.action !== 'string' || typeof value.createdAt !== 'string') return null
  if (Number.isNaN(new Date(value.createdAt).getTime())) return null
  const actor = isRecord(value.actor) ? value.actor : {}
  const target = isRecord(value.target) ? value.target : {}
  const who = value.photographer
  const photographer =
    isRecord(who) && typeof who.id === 'string' && typeof who.handle === 'string' && typeof who.displayName === 'string'
      ? { id: who.id, handle: who.handle, displayName: who.displayName }
      : null
  return {
    id: value.id,
    action: value.action,
    actor: { id: typeof actor.id === 'string' ? actor.id : '', email: typeof actor.email === 'string' ? actor.email : '' },
    target: { type: typeof target.type === 'string' ? target.type : null, id: typeof target.id === 'string' ? target.id : null },
    photographer,
    details: isRecord(value.details) ? value.details : {},
    createdAt: value.createdAt,
  }
}

export function normaliseEntries(value: unknown): AuditEntry[] {
  return Array.isArray(value) ? value.flatMap((each) => normaliseEntry(each) ?? []) : []
}

function whole(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

export const platformAuditApi = {
  list: async (query: AuditQuery = {}): Promise<AuditPage> => {
    const search = paramsFromQuery(query).toString()
    const answer = await apiFetch<Partial<Record<keyof AuditPage, unknown>>>('platform', `/platform/audit${search === '' ? '' : `?${search}`}`, {
      cache: 'no-store',
    })
    const entries = normaliseEntries(answer.entries)
    return {
      entries,
      total: whole(answer.total, entries.length),
      page: Math.max(1, whole(answer.page, query.page ?? 1)),
      pageSize: Math.max(1, whole(answer.pageSize, 50)),
      pageCount: whole(answer.pageCount, entries.length > 0 ? 1 : 0),
    }
  },
}

// --- The sentence -----------------------------------------------------------

export type EntryWords = {
  /** The one plain-language sentence. */
  sentence: string
  /** Lines under it: a suspension's reason, one per setting when several changed. */
  lines: string[]
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function amount(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function instant(value: unknown): string | null {
  return typeof value === 'string' && !Number.isNaN(new Date(value).getTime()) ? value : null
}

const numbers = new Intl.NumberFormat('en-GB')

/** The settings the trail can name; another field reads "Changed <field>". */
const SETTING_FIELDS = [
  'holdMinutes',
  'trialDays',
  'subscriptionMonthlyPriceRwf',
  'subscriptionYearlyPriceRwf',
  'subscriptionGraceDays',
  'subscriptionReminderDays',
] as const

function settingValue(t: TFunction, value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return numbers.format(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return t('platform:activity.settings.none')
    return value.every((day) => typeof day === 'number') ? value.map((day: number) => numbers.format(day)).join(', ') : null
  }
  return null
}

function settingSentence(t: TFunction, field: string, change: unknown): string {
  const known = (SETTING_FIELDS as readonly string[]).includes(field)
  const pair = isRecord(change) ? change : {}
  const before = settingValue(t, pair.before)
  const after = settingValue(t, pair.after)
  if (!known) return t('platform:activity.settings.unknown', { field })
  if (before === null || after === null) return t(`platform:activity.settings.${field}`)
  return t(`platform:activity.settings.${field}Change`, { before, after })
}

/**
 * The words for one entry. `t` is the page's translator; every value goes in
 * through interpolation and is rendered as plain text.
 */
export function describeEntry(t: TFunction, entry: AuditEntry): EntryWords {
  const d = entry.details
  const name = entry.photographer?.displayName ?? null
  const who = name ?? t('platform:activity.someone')
  const money = (value: unknown) => {
    const rwf = amount(value)
    return rwf === null ? null : formatMoney(rwf)
  }
  const s = (key: string, values: Record<string, unknown> = {}) => t(`platform:activity.sentence.${key}`, values)

  switch (entry.action) {
    case 'photographer_approved': {
      const ends = d.trialStarted === true ? instant(d.trialEndsAt) : null
      return { sentence: ends === null ? s('approved', { name: who }) : s('approvedTrial', { name: who, date: formatDateTime(ends) }), lines: [] }
    }
    case 'photographer_suspended': {
      const reason = text(d.reason)
      return { sentence: s('suspended', { name: who }), lines: reason === null ? [] : [t('platform:photographers.suspendedReason', { reason })] }
    }
    case 'photographer_reactivated':
      return {
        sentence: d.status === 'approved' ? s('reactivatedApproved', { name: who }) : d.status === 'pending' ? s('reactivatedPending', { name: who }) : s('reactivated', { name: who }),
        lines: [],
      }
    case 'payout_created': {
      const total = money(d.amountRwf)
      const count = amount(d.itemCount)
      if (total === null) return { sentence: s('payoutCreatedPlain', { name: who }), lines: [] }
      return { sentence: count === null ? s('payoutCreated', { name: who, amount: total }) : s('payoutCreatedLines', { name: who, amount: total, count }), lines: [] }
    }
    case 'payout_paid': {
      const total = money(d.amountRwf)
      const reference = text(d.transferReference)
      if (total === null) return { sentence: s('payoutPaidPlain', { name: who }), lines: [] }
      return { sentence: reference === null ? s('payoutPaid', { name: who, amount: total }) : s('payoutPaidRef', { name: who, amount: total, reference }), lines: [] }
    }
    case 'payout_cancelled': {
      const total = money(d.amountRwf)
      return { sentence: total === null ? s('payoutCancelledPlain', { name: who }) : s('payoutCancelled', { name: who, amount: total }), lines: [] }
    }
    case 'refund_recorded': {
      const total = money(d.amountRwf)
      const reference = text(d.reference)
      const kind = d.paymentKind === 'booking_fee' || d.paymentKind === 'session_fee' || d.paymentKind === 'subscription' ? t(`platform:activity.paymentKind.${d.paymentKind}`) : t('platform:activity.paymentKind.other')
      const overpayment = d.refundKind === 'overpayment'
      if (total === null) return { sentence: s(overpayment ? 'overpaymentPlain' : 'refundPlain', { name: who, kind }), lines: [] }
      const values = { name: who, kind, amount: total, reference }
      return { sentence: s(`${overpayment ? 'overpayment' : 'refund'}${reference === null ? '' : 'Ref'}`, values), lines: [] }
    }
    case 'settings_updated': {
      const changed = isRecord(d.changed) ? Object.entries(d.changed) : []
      const sentences = changed.map(([field, change]) => settingSentence(t, field, change))
      if (sentences.length === 0) return { sentence: s('settings'), lines: [] }
      if (sentences.length === 1) return { sentence: sentences[0] ?? s('settings'), lines: [] }
      return { sentence: s('settingsMany', { count: sentences.length }), lines: sentences }
    }
    case 'category_created': {
      const category = text(d.nameEn)
      const slug = text(d.slug)
      return { sentence: category === null ? s('categoryCreatedPlain') : slug === null ? s('categoryCreated', { category }) : s('categoryCreatedSlug', { category, slug }), lines: [] }
    }
    case 'category_updated': {
      const rename = isRecord(d.nameEn) ? d.nameEn : {}
      const before = text(rename.before)
      const after = text(rename.after)
      const slug = text(d.slug)
      if (before !== null && after !== null) return { sentence: s('categoryRenamed', { before, after }), lines: [] }
      return { sentence: slug === null ? s('categoryUpdatedPlain') : s('categoryUpdated', { slug }), lines: [] }
    }
    case 'category_deactivated':
    case 'category_reactivated': {
      // The name when the row carries it; rows from before it did, the slug.
      const slug = text(d.nameEn) ?? text(d.slug) ?? t('platform:activity.aCategory')
      const count = amount(d.photographerCount)
      const base = entry.action === 'category_deactivated' ? 'categoryDeactivated' : 'categoryReactivated'
      return { sentence: count === null || count === 0 ? s(base, { slug }) : s(`${base}Count`, { slug, count }), lines: [] }
    }
    case 'category_reordered':
      return { sentence: s('categoryReordered'), lines: [] }
    case 'category_deleted': {
      const category = text(d.nameEn)
      const slug = text(d.slug)
      return { sentence: category === null ? s('categoryDeletedPlain') : slug === null ? s('categoryDeleted', { category }) : s('categoryDeletedSlug', { category, slug }), lines: [] }
    }
    default:
      return { sentence: s('unknown', { action: entry.action }), lines: [] }
  }
}
