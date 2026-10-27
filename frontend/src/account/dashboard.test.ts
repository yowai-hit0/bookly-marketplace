import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAccountMe, forgetAccountMe } from '@/auth/account'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { readSession, saveSession } from '@/auth/session'
import { json, stubApi } from '@/test/fetch'
import {
  CLIENT_BOOKING,
  OUR_REF,
  PAYMENT,
  RECEIPT,
  REFERENCE,
  ROW,
  SESSION,
  USER,
  bookingsPage,
  detail,
  paymentsPage,
  signedIn,
} from '@/test/account-fixtures'
import {
  accountBookingPath,
  accountPaymentPath,
  accountReceiptPath,
  cancelAccountBooking,
  changeAccountPassword,
  confirmAccountEmailChange,
  deleteAccount,
  downloadAccountExport,
  exportFileName,
  fetchAccountBooking,
  fetchAccountBookings,
  fetchAccountPayments,
  fetchAccountProfile,
  fetchAccountReceipt,
  fileSaver,
  pageOf,
  requestAccountEmailChange,
  safeCheckoutPath,
  scopeOf,
  setAccountPassword,
  startAccountSessionFeePayment,
  updateAccountProfile,
} from './dashboard'

/**
 * The dashboard's API client (marketplace-spec R8.1-R8.4): every call carries
 * the account token and nothing else names the user; 404 is "not yours";
 * refusals keep the API's code and body; a credential change keeps the fresh
 * token; the export travels as a blob, never with the token in a URL.
 */

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
  forgetAccountMe()
})

function signIn() {
  saveSession('account', SESSION)
}

describe('paths and URL parsing', () => {
  it('builds the dashboard paths, encoding what it is given', () => {
    expect(accountBookingPath(REFERENCE)).toBe(`/account/bookings/${REFERENCE}`)
    expect(accountPaymentPath(REFERENCE, OUR_REF)).toBe(`/account/bookings/${REFERENCE}/payments/${OUR_REF}`)
    expect(accountReceiptPath(OUR_REF)).toBe(`/account/payments/${OUR_REF}/receipt`)
    expect(accountBookingPath('a/b?c')).toBe('/account/bookings/a%2Fb%3Fc')
  })

  it('reads the scope, defaulting anything unknown to upcoming', () => {
    expect(scopeOf('past')).toBe('past')
    expect(scopeOf('upcoming')).toBe('upcoming')
    expect(scopeOf(null)).toBe('upcoming')
    expect(scopeOf('PAST')).toBe('upcoming')
    expect(scopeOf('expired')).toBe('upcoming')
  })

  it('reads the page as a whole number in range, else 1', () => {
    expect(pageOf('3')).toBe(3)
    expect(pageOf('1000000')).toBe(1_000_000)
    for (const raw of [null, '', '0', '-1', '1.5', '1e3', 'two', '1000001', '99999999', ' 2']) expect(pageOf(raw), String(raw)).toBe(1)
  })

  it('accepts only the web app’s own checkout path', () => {
    expect(safeCheckoutPath('/checkout/BKY-2611-9QW2E/Zx9Q2mT7_vL4-pR8')).toBe('/checkout/BKY-2611-9QW2E/Zx9Q2mT7_vL4-pR8')
    for (const raw of [
      null,
      undefined,
      '',
      'https://evil.example/checkout/a/b',
      '//evil.example/checkout/a/b',
      '/checkout/a',
      '/checkout/a/b/c',
      '/booking/abc',
      'javascript:alert(1)',
      '/checkout/a/b?x=1',
    ]) {
      expect(safeCheckoutPath(raw), String(raw)).toBeNull()
    }
  })

  it('names the export file from the API, else from today in Kigali', () => {
    expect(exportFileName('attachment; filename="bookly-account-2026-10-27.json"')).toBe('bookly-account-2026-10-27.json')
    // 23:30 UTC is already the next day in Kigali (UTC+2).
    expect(exportFileName(null, new Date('2026-10-27T23:30:00Z'))).toBe('bookly-account-2026-10-28.json')
    // Only the shape the API sends is trusted as a file name.
    expect(exportFileName('attachment; filename="../../evil.exe"', new Date('2026-10-27T08:00:00Z'))).toBe('bookly-account-2026-10-27.json')
  })
})

describe('bookings', () => {
  it('lists a scope and page with the account token, leaving page 1 implicit', async () => {
    signIn()
    const api = stubApi(() => json(bookingsPage([ROW])))
    await fetchAccountBookings('upcoming', 1)
    await fetchAccountBookings('past', 3)

    expect(api.sent.map((call) => call.url)).toEqual(['/api/account/bookings?scope=upcoming', '/api/account/bookings?scope=past&page=3'])
    expect(api.sent.every((call) => call.headers.get('Authorization') === `Bearer ${SESSION.token}`)).toBe(true)
  })

  it('refuses without a session, asking nothing', async () => {
    const api = stubApi(() => json(bookingsPage([])))
    await expect(fetchAccountBookings('upcoming', 1)).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(api.sent).toEqual([])
  })

  it('drops the session on a 401', async () => {
    signIn()
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(fetchAccountBookings('past', 1)).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('account')).toBeNull()
  })

  it('reads one booking, and a 404 (not the account’s) as null', async () => {
    signIn()
    stubApi(({ url }) => (url === `/api/account/bookings/${REFERENCE}` ? json(detail()) : json({ error: 'not_found' }, 404)))

    expect((await fetchAccountBooking(REFERENCE))?.booking.reference).toBe(REFERENCE)
    expect(await fetchAccountBooking('BKY-0000-OTHER')).toBeNull()
  })

  it('throws on any other failure, and on an answer that is not a booking', async () => {
    signIn()
    stubApi(() => json({ error: 'internal_error' }, 500))
    await expect(fetchAccountBooking(REFERENCE)).rejects.toMatchObject({ status: 500 })

    stubApi(() => json({ booking: { reference: REFERENCE } }))
    await expect(fetchAccountBooking(REFERENCE)).rejects.toBeInstanceOf(ApiError)
  })

  it('cancels: 200 cancelled, 409 not cancellable with the booking, 404, anything else failed', async () => {
    signIn()
    const cancelled = { ...CLIENT_BOOKING, status: 'cancelled_by_client' }
    let reply: Response = json(detail(cancelled))
    const api = stubApi(() => reply)

    expect(await cancelAccountBooking(REFERENCE)).toEqual({ status: 'cancelled', booking: cancelled })
    expect(api.sent[0]).toMatchObject({ url: `/api/account/bookings/${REFERENCE}/cancel`, method: 'POST' })

    reply = json({ error: 'not_cancellable', ...detail(cancelled) }, 409)
    expect(await cancelAccountBooking(REFERENCE)).toEqual({ status: 'not_cancellable', booking: cancelled })
    reply = json({ error: 'not_found' }, 404)
    expect(await cancelAccountBooking(REFERENCE)).toEqual({ status: 'not_found' })
    reply = json({ error: 'internal_error' }, 500)
    expect(await cancelAccountBooking(REFERENCE)).toEqual({ status: 'failed' })
  })

  it('a network failure while cancelling is failed, not thrown', async () => {
    signIn()
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))))
    expect(await cancelAccountBooking(REFERENCE)).toEqual({ status: 'failed' })
  })

  it('pays the session fee with the method and phone, mapping every answer as the guest page does', async () => {
    signIn()
    let reply: Response = json({ payment: { ourRef: OUR_REF, status: 'pending' } }, 201)
    const api = stubApi(() => reply)
    const request = { method: 'momo_mtn' as const, phone: '0788123456' }

    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'started', ourRef: OUR_REF })
    expect(api.sent[0]).toMatchObject({ url: `/api/account/bookings/${REFERENCE}/payments`, method: 'POST', body: request })
    expect(api.sent[0]?.headers.get('Content-Type')).toBe('application/json')

    reply = json({ error: 'payment_in_progress', payment: { ourRef: 'other' } }, 409)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'in_progress', ourRef: 'other' })
    reply = json({ error: 'nothing_to_pay', ...detail() }, 409)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'closed' })
    reply = json({ error: 'validation_failed', fields: ['phone'] }, 422)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'invalid', fields: ['phone'] })
    reply = json({ error: 'payment_not_started', reason: 'rejected', payment: { ourRef: OUR_REF, status: 'failed' } }, 502)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'not_started', reason: 'rejected' })
    reply = json({ error: 'not_found' }, 404)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'not_found' })
    reply = json({ error: 'rate_limited' }, 429)
    expect(await startAccountSessionFeePayment(REFERENCE, request)).toEqual({ status: 'failed' })
  })
})

describe('payments and receipts', () => {
  it('lists a page of payments', async () => {
    signIn()
    const api = stubApi(() => json(paymentsPage([PAYMENT])))
    expect((await fetchAccountPayments(1)).payments).toEqual([PAYMENT])
    await fetchAccountPayments(2)
    expect(api.sent.map((call) => call.url)).toEqual(['/api/account/payments', '/api/account/payments?page=2'])
  })

  it('reads a receipt; 409 no_receipt carries the payment’s status; 404 is missing', async () => {
    signIn()
    let reply: Response = json({ receipt: RECEIPT })
    stubApi(() => reply)

    expect(await fetchAccountReceipt(OUR_REF)).toEqual({ status: 'ok', receipt: RECEIPT })
    reply = json({ error: 'no_receipt', payment: { status: 'pending' } }, 409)
    expect(await fetchAccountReceipt(OUR_REF)).toEqual({ status: 'no_receipt', paymentStatus: 'pending' })
    reply = json({ error: 'no_receipt', payment: { status: 'surprising' } }, 409)
    expect(await fetchAccountReceipt(OUR_REF)).toEqual({ status: 'no_receipt', paymentStatus: null })
    reply = json({ error: 'not_found' }, 404)
    expect(await fetchAccountReceipt(OUR_REF)).toEqual({ status: 'missing' })
    reply = json({ error: 'internal_error' }, 500)
    await expect(fetchAccountReceipt(OUR_REF)).rejects.toMatchObject({ status: 500 })
  })
})

describe('profile and credentials', () => {
  it('reads and patches the profile', async () => {
    signIn()
    const api = stubApi(({ method }) => json({ profile: method === 'PATCH' ? { fullName: 'Aline U.', phone: null } : { fullName: 'Aline', phone: '+250788123456' } }))
    expect(await fetchAccountProfile()).toEqual({ fullName: 'Aline', phone: '+250788123456' })
    expect(await updateAccountProfile({ fullName: 'Aline U.', phone: null })).toEqual({ fullName: 'Aline U.', phone: null })
    expect(api.sent[1]).toMatchObject({ method: 'PATCH', url: '/api/account/profile', body: { fullName: 'Aline U.', phone: null } })
  })

  it('a 422 keeps the fields it names', async () => {
    signIn()
    stubApi(() => json({ error: 'validation_failed', fields: ['phone'] }, 422))
    await expect(updateAccountProfile({ phone: 'abc' })).rejects.toMatchObject({ status: 422, fields: ['phone'] })
  })

  it('a password change keeps the fresh token and primes the account, so /me is not asked again', async () => {
    signIn()
    const api = stubApi(({ url }) => (url === '/api/account/password' ? json(signedIn('fresh.jwt')) : undefined))
    await changeAccountPassword('old password!', 'a brand new long one')

    expect(api.sent[0]).toMatchObject({ method: 'POST', body: { currentPassword: 'old password!', newPassword: 'a brand new long one' } })
    expect(readSession('account')?.token).toBe('fresh.jwt')
    expect(await fetchAccountMe('fresh.jwt')).toEqual(USER)
    expect(api.sent).toHaveLength(1)
  })

  it('a refused password change keeps the old token and the code', async () => {
    signIn()
    stubApi(() => json({ error: 'invalid_password' }, 403))
    await expect(changeAccountPassword('wrong', 'a brand new long one')).rejects.toMatchObject({ status: 403, message: 'invalid_password' })
    expect(readSession('account')?.token).toBe(SESSION.token)
  })

  it('adding a first password keeps the fresh token too', async () => {
    signIn()
    const api = stubApi(() => json(signedIn('added.jwt', { hasPassword: true, hasGoogle: true })))
    const user = await setAccountPassword('a brand new long one')
    expect(api.sent[0]).toMatchObject({ url: '/api/account/password/set', body: { newPassword: 'a brand new long one' } })
    expect(user.hasPassword).toBe(true)
    expect(readSession('account')?.token).toBe('added.jwt')
  })

  it('asks for an address change with the password', async () => {
    signIn()
    const api = stubApi(() => json({ ok: true }, 202))
    await requestAccountEmailChange('new@example.com', 'my password')
    expect(api.sent[0]).toMatchObject({ url: '/api/account/email', method: 'POST', body: { newEmail: 'new@example.com', password: 'my password' } })
  })

  it('confirms an address change with no session at all, and signs in with the answer', async () => {
    const api = stubApi(() => json(signedIn('confirmed.jwt', { email: 'new@example.com' })))
    const user = await confirmAccountEmailChange('tok-123', 'my password')

    expect(api.sent[0]).toMatchObject({ url: '/api/account/email/confirm', method: 'POST', body: { token: 'tok-123', password: 'my password' } })
    expect(api.sent[0]?.headers.get('Authorization')).toBeNull()
    expect(user.email).toBe('new@example.com')
    expect(readSession('account')?.token).toBe('confirmed.jwt')
  })

  it('a refused confirmation signs nobody in', async () => {
    stubApi(() => json({ error: 'email_taken' }, 409))
    await expect(confirmAccountEmailChange('tok', 'pw')).rejects.toMatchObject({ status: 409, message: 'email_taken' })
    expect(readSession('account')).toBeNull()
  })
})

describe('export and deletion', () => {
  it('downloads the export as a blob through the bearer header; the token is never in a URL', async () => {
    signIn()
    const saved: { blob: Blob; name: string }[] = []
    vi.spyOn(fileSaver, 'save').mockImplementation((blob, name) => saved.push({ blob, name }))
    const api = stubApi(
      () =>
        new Response(JSON.stringify({ format: 'bookly-account-export' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="bookly-account-2026-10-27.json"' },
        }),
    )

    await downloadAccountExport()

    expect(api.sent[0]?.url).toBe('/api/account/export')
    expect(api.sent[0]?.url).not.toContain(SESSION.token)
    expect(api.sent[0]?.headers.get('Authorization')).toBe(`Bearer ${SESSION.token}`)
    expect(saved).toHaveLength(1)
    expect(saved[0]?.name).toBe('bookly-account-2026-10-27.json')
    expect(JSON.parse(await saved[0]!.blob.text())).toEqual({ format: 'bookly-account-export' })
  })

  it('a rate-limited export saves nothing and says 429', async () => {
    signIn()
    const save = vi.spyOn(fileSaver, 'save').mockImplementation(() => {})
    stubApi(() => json({ error: 'rate_limited' }, 429))
    await expect(downloadAccountExport()).rejects.toMatchObject({ status: 429 })
    expect(save).not.toHaveBeenCalled()
  })

  it('an export after the session ended is a 401 that drops the session', async () => {
    signIn()
    const save = vi.spyOn(fileSaver, 'save').mockImplementation(() => {})
    stubApi(() => json({ error: 'invalid_token' }, 401))
    await expect(downloadAccountExport()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(readSession('account')).toBeNull()
    expect(save).not.toHaveBeenCalled()
  })

  it('the saver hands the browser an object URL and revokes it afterwards', () => {
    vi.useFakeTimers()
    try {
      const create = vi.fn(() => 'blob:mock')
      const revoke = vi.fn()
      vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke }))
      const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

      fileSaver.save(new Blob(['{}']), 'bookly-account-2026-10-27.json')

      expect(click).toHaveBeenCalledTimes(1)
      const link = click.mock.contexts[0] as HTMLAnchorElement
      expect(link.download).toBe('bookly-account-2026-10-27.json')
      expect(link.href).toBe('blob:mock')
      expect(document.querySelector('a[download]')).toBeNull()
      expect(revoke).not.toHaveBeenCalled()
      vi.runAllTimers()
      expect(revoke).toHaveBeenCalledWith('blob:mock')
    } finally {
      vi.useRealTimers()
    }
  })

  it('deletes with the password or the typed address; refusals keep their code', async () => {
    signIn()
    let reply: Response = new Response(null, { status: 204 })
    const api = stubApi(() => reply)

    await deleteAccount({ password: 'my password' })
    expect(api.sent[0]).toMatchObject({ url: '/api/account/delete', method: 'POST', body: { password: 'my password' } })
    await deleteAccount({ confirmEmail: 'aline@example.com' })
    expect(api.sent[1]?.body).toEqual({ confirmEmail: 'aline@example.com' })

    reply = json({ error: 'invalid_confirmation' }, 403)
    await expect(deleteAccount({ confirmEmail: 'x@example.com' })).rejects.toMatchObject({ status: 403, message: 'invalid_confirmation' })
  })
})
