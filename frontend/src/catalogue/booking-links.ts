import { env } from '@/env'

/**
 * "Email me my links": `POST /api/booking-links` (docs/prompts/client-access-and-admin-polish.md, item 4).
 *
 * The API answers the same 202 whether the address has bookings or not, so
 * this can only ever say "sent" -- which means "if there was anything, it is
 * on its way", never "we found you".
 */
export type BookingLinksResult = 'sent' | 'invalid' | 'failed'

export async function requestBookingLinks(email: string): Promise<BookingLinksResult> {
  let res: Response
  try {
    res = await fetch(`${env.VITE_API_BASE_URL}/booking-links`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ email }),
    })
  } catch {
    return 'failed'
  }
  if (res.status === 202) return 'sent'
  if (res.status === 422) return 'invalid'
  return 'failed'
}
