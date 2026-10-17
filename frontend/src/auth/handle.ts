/**
 * A photographer's handle, `/p/<handle>` (marketplace spec R2.2, Phase 2 brief
 * decision 4). The API trims and lowercases what it is sent, then requires
 * the database's `photographer_handle_format`,
 * `^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$`. This mirrors it so the signup form can
 * say, as the photographer types, which part of the rule is met. Reserved
 * names (`admin`, `studio`, …) are the API's to refuse: it answers them like
 * a taken handle, and keeping that list in one place keeps it from drifting.
 */

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

export function normaliseHandle(raw: string): string {
  return raw.trim().toLowerCase()
}

export type HandleRules = { length: boolean; chars: boolean; edges: boolean }

/** Each part of the rule for what the photographer typed, normalised as the API will. */
export function handleRules(raw: string): HandleRules {
  const handle = normaliseHandle(raw)
  return {
    length: handle.length >= 3 && handle.length <= 30,
    chars: handle !== '' && /^[a-z0-9-]+$/.test(handle),
    edges: /^[a-z0-9]/.test(handle) && /[a-z0-9]$/.test(handle),
  }
}

/** The whole rule: true exactly when every part of `handleRules` holds. */
export function isValidHandle(raw: string): boolean {
  return HANDLE_PATTERN.test(normaliseHandle(raw))
}
