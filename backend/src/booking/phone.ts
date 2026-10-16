/**
 * A phone number as a booking stores it: E.164 where it can be read as one,
 * otherwise the digits as typed (data-model_v2.md §5.8). Nothing here is
 * verification -- the number is contact information, and the photographer
 * reaches the client on it the way he always has.
 *
 * Rwanda's own formats are the common case: `078 123 4567` and
 * `250 78 123 4567` both become `+250781234567`.
 */

/** E.164 allows at most 15 digits; fewer than 7 is not a reachable number anywhere. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

/** Digits with the separators people type between them, and an optional leading `+`. */
const TYPED_PHONE = /^\+?[\d\s\-().]+$/;

/** The normalised number, or null when the input cannot be a phone number. */
export function normalizePhone(typed: string): string | null {
  const trimmed = typed.trim();
  if (!TYPED_PHONE.test(trimmed)) return null;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;

  if (trimmed.startsWith('+')) return `+${digits}`;
  // Rwanda: a 10-digit national number with its trunk 0, or the country code without a `+`.
  if (/^07\d{8}$/.test(digits)) return `+250${digits.slice(1)}`;
  if (/^2507\d{8}$/.test(digits)) return `+${digits}`;
  return digits;
}
