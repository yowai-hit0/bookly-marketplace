/**
 * The URL itself when it is an absolute `https:` URL, otherwise null.
 *
 * For every pasted URL the page puts in an `href` or `src` -- a delivery link,
 * and later a photographer's cover and portfolio images. React does not block
 * `javascript:` in `href`, so the server's https-only rule is checked again
 * here, at the sink (security review 2026-10-11, finding 5).
 */
export function safeHttpsUrl(value: string | null | undefined): string | null {
  if (value == null || !URL.canParse(value)) return null
  return new URL(value).protocol === 'https:' ? value : null
}
