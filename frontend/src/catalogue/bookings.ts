import { z } from 'zod'
import { env } from '@/env'

/**
 * Creating a booking: `POST /api/bookings` (plan.md Task 13, spec §3.1 steps
 * 6-8), and the booking form's schema.
 *
 * The schema is a convenience with no authority: it marks a mistake before a
 * round trip, and the API revalidates everything and prices everything again.
 * Its limits mirror the API's so the two rarely disagree; when they do, the
 * API's 422 names the fields and the form marks those instead.
 */

export const DETAIL_FIELDS = ['fullName', 'email', 'phone', 'location', 'partySize', 'specialRequests', 'consent'] as const

export type DetailField = (typeof DETAIL_FIELDS)[number]

const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value)

/** Digits and the separators people type, 7 to 15 digits: what the API accepts. */
export function isPlausiblePhone(value: string): boolean {
  if (!/^\+?[\d\s\-().]+$/.test(value)) return false
  const digits = value.replace(/\D/g, '').length
  return digits >= 7 && digits <= 15
}

export const bookingDetailsSchema = z.object({
  fullName: z.string().trim().min(1).max(200),
  email: z.string().trim().max(320).pipe(z.email()),
  phone: z.string().trim().max(40).refine(isPlausiblePhone),
  location: z.string().trim().min(1).max(500),
  /** Blank is a product shoot: no people to count. */
  partySize: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .regex(/^\d{1,4}$/)
      .transform(Number)
      .refine((people) => people >= 1 && people <= 1000)
      .nullable(),
  ),
  specialRequests: z.preprocess(blankToNull, z.string().trim().max(2000).nullable()),
  consent: z.literal(true),
})

export type BookingDetails = z.output<typeof bookingDetailsSchema>

/** The form's values, or the fields that are wrong, in form order. */
export function parseBookingDetails(form: FormData): { ok: true; details: BookingDetails } | { ok: false; fields: DetailField[] } {
  const result = bookingDetailsSchema.safeParse({
    fullName: String(form.get('fullName') ?? ''),
    email: String(form.get('email') ?? ''),
    phone: String(form.get('phone') ?? ''),
    location: String(form.get('location') ?? ''),
    partySize: String(form.get('partySize') ?? ''),
    specialRequests: String(form.get('specialRequests') ?? ''),
    consent: form.get('consent') === 'on',
  })
  if (result.success) return { ok: true, details: result.data }
  const wrong = new Set(result.error.issues.map((issue) => String(issue.path[0])))
  return { ok: false, fields: DETAIL_FIELDS.filter((field) => wrong.has(field)) }
}

/** What the API answers for a booking now holding its slot. */
export type HeldBooking = {
  reference: string
  status: 'pending_payment'
  startsAt: string
  endsAt: string
  holdExpiresAt: string | null
  serviceName: string
  packageName: string
  packagePriceRwf: number
  addons: { name: string; priceRwf: number }[]
  totalRwf: number
  /** The rate frozen onto the booking, 0 to 1. */
  bookingFeeRate: number
  bookingFeeRwf: number
  sessionFeeRwf: number
  /** Opens this booking's checkout (plan.md Task 16). */
  checkoutToken?: string
}

export type BookingPayload = BookingDetails & {
  packageId: string
  addonIds: string[]
  /** ISO-8601 UTC instant, as the slot picker holds it. */
  startsAt: string
}

export type SubmitBookingResult =
  | { status: 'created'; booking: HeldBooking }
  /** The API's 422: the fields it refused, which may include `startsAt`, `packageId` or `addonIds`. */
  | { status: 'invalid'; fields: string[] }
  /** The 409: the slot went between the calendar and the claim (spec §6.1). */
  | { status: 'slot_taken' }
  /** Unreachable, or an answer this form cannot act on. */
  | { status: 'failed' }

export async function submitBooking(payload: BookingPayload): Promise<SubmitBookingResult> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/bookings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
  } catch {
    return { status: 'failed' }
  }

  try {
    if (res.status === 201) {
      const { booking } = (await res.json()) as { booking?: Partial<HeldBooking> | null }
      // A 201 that does not describe the booking cannot be shown as one.
      if (typeof booking?.reference === 'string') return { status: 'created', booking: booking as HeldBooking }
      return { status: 'failed' }
    }
    if (res.status === 409) return { status: 'slot_taken' }
    if (res.status === 422) {
      const { fields } = (await res.json()) as { fields?: unknown }
      return Array.isArray(fields) ? { status: 'invalid', fields: fields.map(String) } : { status: 'failed' }
    }
  } catch {
    // A body that is not the JSON this status promises.
  }
  return { status: 'failed' }
}
