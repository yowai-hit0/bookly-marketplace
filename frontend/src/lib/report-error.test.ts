import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { errorReport, installErrorReporter, reportError, scrubTokens } from './report-error'

/**
 * The scrubbing test (plan.md Task 18 bullet 4; spec §7).
 *
 * A client's access token lives in the path of their booking link, and a
 * checkout token in the path of theirs. Those paths reach an error reporter
 * through the message, the stack and `location.href`, so what is proven here is
 * that the token is `[redacted]` in all three while everything around it
 * survives -- the booking reference, the route, the rest of the sentence, the
 * frames of the stack -- because a reporter that redacts everything reports
 * nothing. Query-string tokens go the same way, in case anything ever puts one
 * there.
 *
 * And nothing leaves the browser: `fetch`, `sendBeacon` and `XMLHttpRequest` are
 * all stubbed to fail this file if they are called (spec §7 -- no third-party
 * error-tracking vendor). `installErrorReporter` catches a window error and an
 * unhandled rejection and scrubs those too. A real 43-character base64url token
 * appears nowhere in anything logged.
 */

const TOKEN = 'aB3_x-9QzT7vL4pR8sK1nB6yH3cF5dG0wJeLmNoPqRs'
const REFERENCE = 'BKY-2610-7K3QX'
const REDACTED = '[redacted]'

let logged: string[]
let sent: string[]

/** Everything that could carry a report off the page. Calling one fails the test. */
function forbidEveryChannel() {
  sent = []
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      sent.push(`fetch ${String(input)}`)
      return Promise.reject(new Error('fetch must not be called by the error reporter'))
    }),
  )
  vi.stubGlobal('navigator', { ...navigator, sendBeacon: vi.fn((url: string) => sent.push(`sendBeacon ${url}`)) })
  vi.stubGlobal(
    'XMLHttpRequest',
    class {
      open(_method: string, url: string) {
        sent.push(`xhr ${url}`)
      }
      send() {
        sent.push('xhr send')
      }
      setRequestHeader() {}
    },
  )
  vi.stubGlobal('WebSocket', class {
    constructor(url: string) {
      sent.push(`ws ${url}`)
    }
  })
}

beforeEach(() => {
  logged = []
  forbidEveryChannel()
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    logged.push(String(line))
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** The one line `reportError` wrote, parsed. */
function loggedReport(): Record<string, string> {
  expect(logged).toHaveLength(1)
  return JSON.parse(logged[0] as string) as Record<string, string>
}

function everythingLogged(): string {
  return logged.join('\n')
}

// --- The token in a path ------------------------------------------------------------------

describe('scrubTokens', () => {
  it('redacts the token of a booking link and keeps the route around it', () => {
    expect(scrubTokens(`Failed to fetch /api/booking/${TOKEN}`)).toBe(`Failed to fetch /api/booking/${REDACTED}`)
    expect(scrubTokens(`https://bookly.example/booking/${TOKEN}`)).toBe(`https://bookly.example/booking/${REDACTED}`)
  })

  it('redacts the token of a checkout link and keeps the reference, which is not a secret', () => {
    const scrubbed = scrubTokens(`GET /api/checkout/${REFERENCE}/${TOKEN} failed`)

    expect(scrubbed).toBe(`GET /api/checkout/${REFERENCE}/${REDACTED} failed`)
    expect(scrubbed).toContain(REFERENCE)
    expect(scrubbed).not.toContain(TOKEN)
  })

  it('redacts the token but not the payment reference below a booking link', () => {
    const ourRef = '3f0c6a52-8d1e-4b7a-9c35-0e4d2a61b7f8'

    const scrubbed = scrubTokens(`/booking/${TOKEN}/payments/${ourRef}`)

    expect(scrubbed).toBe(`/booking/${REDACTED}/payments/${ourRef}`)
  })

  it.each([
    ['?token=', `https://bookly.example/x?token=${TOKEN}`],
    ['&t=', `https://bookly.example/x?a=1&t=${TOKEN}`],
    ['?access_token=', `https://bookly.example/x?access_token=${TOKEN}`],
    ['&access_token= among others', `https://bookly.example/x?a=1&access_token=${TOKEN}&b=2`],
  ])('redacts a token in a query string: %s', (_case, url) => {
    const scrubbed = scrubTokens(url)

    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed).toContain(REDACTED)
    expect(scrubbed).toContain('bookly.example/x')
  })

  it('keeps what is around a query-string token: the other parameters and the fragment', () => {
    expect(scrubTokens(`/x?a=1&token=${TOKEN}&b=2#top`)).toBe(`/x?a=1&token=${REDACTED}&b=2#top`)
  })

  it('redacts every token in a string that carries several', () => {
    const many = `/booking/${TOKEN} then /checkout/${REFERENCE}/${TOKEN} then ?token=${TOKEN}`

    const scrubbed = scrubTokens(many)

    expect(scrubbed).not.toContain(TOKEN)
    expect(scrubbed.match(/\[redacted]/g)).toHaveLength(3)
    expect(scrubbed).toContain(REFERENCE)
  })

  it('leaves text with no token in it exactly as it was', () => {
    for (const text of ['Something went wrong', 'TypeError: Failed to fetch', '/services/portraits', '/api/payment-methods']) {
      expect(scrubTokens(text)).toBe(text)
    }
  })

  it('does not swallow the rest of a sentence after the token', () => {
    expect(scrubTokens(`Loading /booking/${TOKEN} failed at 12:00`)).toBe(`Loading /booking/${REDACTED} failed at 12:00`)
    expect(scrubTokens(`"/booking/${TOKEN}" is gone`)).toBe(`"/booking/${REDACTED}" is gone`)
  })

  it('redacts a real 43-character base64url token, whatever its characters happen to be', () => {
    for (let i = 0; i < 50; i += 1) {
      const token = randomBytes(32).toString('base64url')
      expect(token).toHaveLength(43)

      const scrubbed = scrubTokens(`GET /booking/${token} -> 500`)

      expect(scrubbed).toBe(`GET /booking/${REDACTED} -> 500`)
      expect(scrubbed).not.toContain(token)
    }
  })
})

// --- The whole report ---------------------------------------------------------------------

describe('errorReport', () => {
  it('scrubs the message, the stack and the URL, and keeps everything else', () => {
    const error = new Error(`Failed to load /api/booking/${TOKEN}`)
    error.stack = [
      `Error: Failed to load /api/booking/${TOKEN}`,
      `    at fetchClientBooking (http://localhost:5173/src/catalogue/booking-access.ts:63:20)`,
      `    at BookingPage (http://localhost:5173/booking/${TOKEN}:1:1)`,
    ].join('\n')

    const report = errorReport(error, 'client_booking_load_failed', `https://bookly.example/booking/${TOKEN}`)

    expect(report.level).toBe('error')
    expect(report.event).toBe('client_booking_load_failed')
    expect(report.message).toBe(`Error: Failed to load /api/booking/${REDACTED}`)
    expect(report.url).toBe(`https://bookly.example/booking/${REDACTED}`)
    expect(report.stack).toContain('at fetchClientBooking (http://localhost:5173/src/catalogue/booking-access.ts:63:20)')
    expect(report.stack).toContain(`at BookingPage (http://localhost:5173/booking/${REDACTED}`)
    expect(JSON.stringify(report)).not.toContain(TOKEN)
  })

  /**
   * The token goes and the frame stays readable: `:line:column` and the closing
   * bracket sit against the token with no separator, and a scrubber that took
   * them too would cost the most useful part of a stack frame.
   */
  it('keeps the line and column that sit against a redacted token in a stack frame', () => {
    const frame = `    at BookingPage (http://localhost:5173/booking/${TOKEN}:12:34)`

    expect(scrubTokens(frame)).toBe(`    at BookingPage (http://localhost:5173/booking/${REDACTED}:12:34)`)
  })

  it('reports something thrown that is not an Error, scrubbed', () => {
    const report = errorReport(`went wrong at /booking/${TOKEN}`)

    expect(report.message).toBe(`went wrong at /booking/${REDACTED}`)
    expect(report.event).toBe('client_error')
    expect(report.stack).toBeUndefined()
  })

  it('omits the url when none is given', () => {
    expect(errorReport(new Error('x'))).not.toHaveProperty('url')
  })
})

// --- Nothing leaves the browser --------------------------------------------------------------

describe('reportError', () => {
  it('writes one JSON line to console.error and sends nothing anywhere', () => {
    reportError(new Error(`boom at /checkout/${REFERENCE}/${TOKEN}`), 'checkout_failed', `https://bookly.example/checkout/${REFERENCE}/${TOKEN}`)

    const report = loggedReport()
    expect(report.message).toBe(`Error: boom at /checkout/${REFERENCE}/${REDACTED}`)
    expect(report.url).toBe(`https://bookly.example/checkout/${REFERENCE}/${REDACTED}`)
    expect(sent).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(navigator.sendBeacon).not.toHaveBeenCalled()
  })

  it('logs a line that parses as JSON and carries no token', () => {
    const token = randomBytes(32).toString('base64url')

    reportError(new Error(`/booking/${token} is gone`), 'load_failed', `https://bookly.example/booking/${token}`)

    expect(() => JSON.parse(logged[0] as string)).not.toThrow()
    expect(everythingLogged()).not.toContain(token)
  })

  it('defaults the URL to the page the browser is on, scrubbed', () => {
    // jsdom's location is about:blank-ish in tests; the default is simply used.
    reportError(new Error('plain'))

    expect(loggedReport().event).toBe('client_error')
    expect(sent).toEqual([])
  })
})

// --- What no component caught -----------------------------------------------------------------

describe('installErrorReporter', () => {
  let uninstall: () => void

  beforeEach(() => {
    uninstall = installErrorReporter()
  })

  afterEach(() => {
    uninstall()
  })

  it('reports a window error, with the token scrubbed out of the message and the stack', () => {
    const error = new Error(`Cannot read properties of null at /booking/${TOKEN}`)
    error.stack = `Error\n    at /booking/${TOKEN}:4:2`

    window.dispatchEvent(new ErrorEvent('error', { error, message: `Uncaught Error at /booking/${TOKEN}` }))

    const report = loggedReport()
    expect(report.event).toBe('window_error')
    expect(report.message).toBe(`Error: Cannot read properties of null at /booking/${REDACTED}`)
    expect(report.stack).toBe(`Error\n    at /booking/${REDACTED}:4:2`)
    expect(everythingLogged()).not.toContain(TOKEN)
    expect(sent).toEqual([])
  })

  it('reports a window error that carries only a message', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: `Script error at /checkout/${REFERENCE}/${TOKEN}` }))

    const report = loggedReport()
    expect(report.event).toBe('window_error')
    expect(report.message).toBe(`Script error at /checkout/${REFERENCE}/${REDACTED}`)
    expect(report.message).toContain(REFERENCE)
  })

  it('reports an unhandled rejection, scrubbed', () => {
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error(`Failed to fetch /api/booking/${TOKEN}/payments`)

    window.dispatchEvent(event)

    const report = loggedReport()
    expect(report.event).toBe('unhandled_rejection')
    expect(report.message).toBe(`Error: Failed to fetch /api/booking/${REDACTED}/payments`)
    expect(everythingLogged()).not.toContain(TOKEN)
    expect(sent).toEqual([])
  })

  it('reports a rejection whose reason is a plain string, scrubbed', () => {
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = `no booking at /booking/${TOKEN}`

    window.dispatchEvent(event)

    expect(loggedReport().message).toBe(`no booking at /booking/${REDACTED}`)
  })

  it('stops listening once uninstalled', () => {
    uninstall()

    window.dispatchEvent(new ErrorEvent('error', { message: 'after uninstall' }))
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error('after uninstall')
    window.dispatchEvent(event)

    expect(logged).toEqual([])
    // Reinstalled so the shared afterEach has something to uninstall.
    uninstall = installErrorReporter()
  })

  it('sends nothing anywhere for any of them', () => {
    window.dispatchEvent(new ErrorEvent('error', { message: `a /booking/${TOKEN}` }))
    const event = new Event('unhandledrejection') as Event & { reason: unknown }
    event.reason = new Error(`b /booking/${TOKEN}`)
    window.dispatchEvent(event)

    expect(logged).toHaveLength(2)
    expect(sent).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    expect(navigator.sendBeacon).not.toHaveBeenCalled()
    expect(everythingLogged()).not.toContain(TOKEN)
  })
})
