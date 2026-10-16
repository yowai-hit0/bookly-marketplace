/**
 * Reporting an error without reporting a secret (plan.md Task 18, spec §7).
 *
 * A client's booking link carries their access token in the path, and the
 * checkout link carries its own. Those paths turn up in error messages, stack
 * traces and `location.href`, so everything logged here passes through
 * `scrubTokens` first -- the token becomes `[redacted]`, and the rest of the
 * message survives, which is the point: a scrubber that redacted whole strings
 * would report nothing useful.
 *
 * There is no third-party error-tracking vendor (spec §7): this writes a
 * structured line to the console and nothing leaves the browser. If one is ever
 * added, it goes behind this function, and this is the only place that has to
 * be right.
 */

const REDACTED = '[redacted]'
/**
 * A path segment, as a token or a reference is written: letters, digits and the
 * few symbols that survive a URL unescaped. Deliberately not "anything but a
 * slash": a stack frame ends a path with `:12:34)`, and a scrubbed frame that
 * lost its line and column would be no use to anyone reading the log.
 */
const SEGMENT = '[A-Za-z0-9._~%-]+'
/** `/booking/<token>` and `/booking/<token>/payments/<ref>`: the client's own link. */
const BOOKING_LINK = new RegExp(`(/booking/)${SEGMENT}`, 'g')
/** `/checkout/<reference>/<token>`: the reference is not a secret, the token is. */
const CHECKOUT_LINK = new RegExp(`(/checkout/${SEGMENT}/)${SEGMENT}`, 'g')
/** `?token=…`, `&t=…`: nothing puts one there today, and nothing may start to. */
const TOKEN_PARAM = /([?&](?:token|t|access_token)=)[^&#\s]+/g

/** The same text with every access token in it replaced. */
export function scrubTokens(value: string): string {
  return value
    .replace(BOOKING_LINK, `$1${REDACTED}`)
    .replace(CHECKOUT_LINK, `$1${REDACTED}`)
    .replace(TOKEN_PARAM, `$1${REDACTED}`)
}

export type ErrorReport = {
  level: 'error'
  event: string
  message: string
  stack?: string
  url?: string
}

/** What would be reported for an error, scrubbed. Exported so a test can read it. */
export function errorReport(error: unknown, event = 'client_error', url?: string): ErrorReport {
  const asError = error instanceof Error ? error : null
  return {
    level: 'error',
    event,
    message: scrubTokens(asError === null ? String(error) : `${asError.name}: ${asError.message}`),
    ...(asError?.stack === undefined ? {} : { stack: scrubTokens(asError.stack) }),
    ...(url === undefined ? {} : { url: scrubTokens(url) }),
  }
}

export function reportError(error: unknown, event?: string, url: string | undefined = currentUrl()): void {
  console.error(JSON.stringify(errorReport(error, event, url)))
}

/** Catches what no component caught: a thrown error, and a rejected promise nobody handled. */
export function installErrorReporter(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => reportError(event.error ?? event.message, 'window_error')
  const onRejection = (event: PromiseRejectionEvent) => reportError(event.reason, 'unhandled_rejection')
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}

function currentUrl(): string | undefined {
  return typeof location === 'undefined' ? undefined : location.href
}
