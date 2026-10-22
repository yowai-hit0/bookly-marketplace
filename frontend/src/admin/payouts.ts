import { adminFetch } from './api'

/**
 * The studio's money pages (marketplace spec Phase 4, R4.1, R4.5;
 * backend/openapi/paths/studio-payouts.yaml): what the photographer has
 * earned, the payouts the platform made by hand, and where it sends them.
 *
 * All amounts are whole RWF and all times ISO instants in UTC. The platform
 * takes no commission: an earning is the payment's full amount, and a
 * `reversal` is the negative of an earning already paid out whose payment was
 * then refunded.
 *
 * The payout method types are the platform's too (`platform/payouts.ts`), so
 * the two consoles describe a destination the same way.
 */

export const MOMO_NETWORKS = ['mtn', 'airtel'] as const

export type MomoNetwork = (typeof MOMO_NETWORKS)[number]

export const PAYOUT_METHOD_KINDS = ['momo', 'bank'] as const

export type PayoutMethodKind = (typeof PAYOUT_METHOD_KINDS)[number]

/** Where the photographer is paid. Immutable: a change retires this row, so `id` changes on every save. */
export type PayoutMethod = {
  id: string
  kind: PayoutMethodKind
  momoNetwork: MomoNetwork | null
  /** E.164, `momo` only. */
  momoNumber: string | null
  bankName: string | null
  bankAccountNumber: string | null
  accountName: string
  createdAt: string
}

export const PAYOUT_ITEM_STATES = ['pending', 'payable', 'in_draft', 'paid', 'voided'] as const

export type PayoutItemState = (typeof PAYOUT_ITEM_STATES)[number]

export type PayoutItem = {
  id: string
  kind: 'earning' | 'reversal'
  /** Positive for an earning, negative for a reversal. */
  amountRwf: number
  state: PayoutItemState
  payoutId: string | null
  createdAt: string
  voidedAt: string | null
  payment: { id: string; kind: string; provider: string; status: string; amountRwf: number; settledAt: string | null }
  booking: { id: string; reference: string; status: string; startsAt: string; endsAt: string }
}

/** A payout as the studio sees it: a cancelled draft is never shown to him. */
export type StudioPayout = {
  id: string
  status: 'draft' | 'paid'
  amountRwf: number
  itemCount: number
  transferReference: string | null
  createdAt: string
  paidAt: string | null
  payoutMethod: PayoutMethod
}

export type StudioPayoutDetail = StudioPayout & { items: PayoutItem[] }

export type EarningsTotals = {
  pendingRwf: number
  /** Nought or negative when reversals outweigh new earnings. */
  payableRwf: number
  inDraftRwf: number
  paidRwf: number
}

export type Earnings = { totals: EarningsTotals; items: PayoutItem[]; payouts: StudioPayout[] }

/** The body `PUT /api/studio/payout-method` takes: one shape per kind, always with the password. */
export type PayoutMethodBody =
  | { kind: 'momo'; momoNetwork: MomoNetwork; momoNumber: string; accountName: string; currentPassword: string }
  | { kind: 'bank'; bankName: string; bankAccountNumber: string; accountName: string; currentPassword: string }

export const payoutsApi = {
  /** Totals, every line newest first (voided ones included), and the payout history. */
  earnings: () => adminFetch<Earnings>('/studio/earnings'),

  /** One of his own payouts; 404 for anyone else's, a cancelled one or an unknown id, 400 for a malformed id. */
  payout: async (id: string): Promise<StudioPayoutDetail> =>
    (await adminFetch<{ payout: StudioPayoutDetail }>(`/studio/payouts/${encodeURIComponent(id)}`)).payout,

  /** The current destination, or null when none has been saved. */
  payoutMethod: async (): Promise<PayoutMethod | null> =>
    (await adminFetch<{ payoutMethod: PayoutMethod | null }>('/studio/payout-method')).payoutMethod,

  /**
   * Saves a new destination, retiring the old one. 403 `invalid_password` or
   * `password_locked`, 422 `validation_failed` with `fields`, 429 `rate_limited`.
   */
  savePayoutMethod: async (body: PayoutMethodBody): Promise<PayoutMethod> =>
    (
      await adminFetch<{ payoutMethod: PayoutMethod }>('/studio/payout-method', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    ).payoutMethod,
}

// --- Mobile numbers -------------------------------------------------------------------------

/** Each network's own prefixes, as the API checks them (MTN 078/079, Airtel 072/073). */
export const MOMO_PREFIXES: Record<MomoNetwork, readonly string[]> = { mtn: ['078', '079'], airtel: ['072', '073'] }

/** E.164 Rwandan mobile: `+2507`, a network digit, then seven digits. */
const RWANDA_MOBILE_E164 = /^\+2507[2389]\d{7}$/

/** Digits with the separators people type between them, and an optional leading `+`. */
const TYPED_PHONE = /^\+?[\d\s\-().]+$/

/**
 * A Rwandan mobile number as people type it (`0788 123 456`, `+250 788 123 456`,
 * `250788123456`), as E.164; null when it cannot be one. The backend's
 * `normalizePhone` read the same way, so what passes here passes there.
 */
export function normalizeMomoNumber(typed: string): string | null {
  const trimmed = typed.trim()
  if (!TYPED_PHONE.test(trimmed)) return null
  const digits = trimmed.replace(/\D/g, '')
  let e164: string
  if (trimmed.startsWith('+')) e164 = `+${digits}`
  else if (/^07\d{8}$/.test(digits)) e164 = `+250${digits.slice(1)}`
  else if (/^2507\d{8}$/.test(digits)) e164 = `+${digits}`
  else return null
  return RWANDA_MOBILE_E164.test(e164) ? e164 : null
}

/** The network a Rwandan E.164 number belongs to, by its prefix; null for any other number. */
export function momoNetworkOf(e164: string): MomoNetwork | null {
  if (!RWANDA_MOBILE_E164.test(e164)) return null
  const local = `0${e164.slice(4, 6)}`
  return MOMO_NETWORKS.find((network) => MOMO_PREFIXES[network].includes(local)) ?? null
}

/** `+250788123456` as `+250 788 123 456`; anything else as it is. */
export function formatMomoNumber(e164: string): string {
  if (!RWANDA_MOBILE_E164.test(e164)) return e164
  return `+250 ${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`
}

/** `+250788123456` as he would type it, `0788 123 456`; anything else as it is. */
export function localMomoNumber(e164: string): string {
  if (!RWANDA_MOBILE_E164.test(e164)) return e164
  return `0${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`
}

// --- The payout-method form -----------------------------------------------------------------

/** What the form holds, every field a string, both kinds' fields at once. */
export type PayoutMethodForm = {
  kind: PayoutMethodKind
  momoNetwork: MomoNetwork
  momoNumber: string
  bankName: string
  bankAccountNumber: string
  accountName: string
  currentPassword: string
}

/** The fields a refusal can name, the API's names and the form's alike. */
export const PAYOUT_METHOD_FIELDS = ['momoNumber', 'bankName', 'bankAccountNumber', 'accountName', 'currentPassword'] as const

export type PayoutMethodField = (typeof PAYOUT_METHOD_FIELDS)[number]

export function isPayoutMethodField(value: string): value is PayoutMethodField {
  return (PAYOUT_METHOD_FIELDS as readonly string[]).includes(value)
}

/** The form for a new method: prefilled from the current one, so fixing one detail keeps the others. The password never is. */
export function payoutMethodFormValues(current: PayoutMethod | null): PayoutMethodForm {
  return {
    kind: current?.kind ?? 'momo',
    momoNetwork: current?.momoNetwork ?? 'mtn',
    momoNumber: current?.momoNumber === null || current?.momoNumber === undefined ? '' : localMomoNumber(current.momoNumber),
    bankName: current?.bankName ?? '',
    bankAccountNumber: current?.bankAccountNumber ?? '',
    accountName: current?.accountName ?? '',
    currentPassword: '',
  }
}

/** Trimmed text of `min` to `max` characters. */
function textWithin(value: string, min: number, max: number): boolean {
  const trimmed = value.trim()
  return trimmed.length >= min && trimmed.length <= max
}

/** Letters, digits, spaces and dashes, with at least one digit (CHECK payout_method_bank_fields_length). */
function isBankAccountNumber(value: string): boolean {
  const trimmed = value.trim()
  return textWithin(trimmed, 5, 40) && /^[0-9A-Za-z -]+$/.test(trimmed) && /\d/.test(trimmed)
}

/**
 * The form's own check, the API's rules over again so a typo is caught before
 * the password is spent on it: the request body, or the fields that are wrong
 * (in the order the form shows them). The API revalidates everything.
 *
 * A MoMo number is sent as E.164; it must be on its own network's prefixes,
 * because a transfer to the other network's number would fail.
 */
export function validatePayoutMethod(form: PayoutMethodForm): { body: PayoutMethodBody } | { invalid: PayoutMethodField[] } {
  const invalid: PayoutMethodField[] = []
  let momoNumber: string | null = null
  if (form.kind === 'momo') {
    momoNumber = normalizeMomoNumber(form.momoNumber)
    if (momoNumber === null || momoNetworkOf(momoNumber) !== form.momoNetwork) invalid.push('momoNumber')
  } else {
    if (!textWithin(form.bankName, 1, 100)) invalid.push('bankName')
    if (!isBankAccountNumber(form.bankAccountNumber)) invalid.push('bankAccountNumber')
  }
  if (!textWithin(form.accountName, 1, 120)) invalid.push('accountName')
  // Sent as typed: a password's spaces are part of it.
  if (form.currentPassword === '') invalid.push('currentPassword')
  if (invalid.length > 0) return { invalid }

  const accountName = form.accountName.trim()
  if (form.kind === 'momo' && momoNumber !== null) {
    return { body: { kind: 'momo', momoNetwork: form.momoNetwork, momoNumber, accountName, currentPassword: form.currentPassword } }
  }
  return {
    body: {
      kind: 'bank',
      bankName: form.bankName.trim(),
      bankAccountNumber: form.bankAccountNumber.trim(),
      accountName,
      currentPassword: form.currentPassword,
    },
  }
}
