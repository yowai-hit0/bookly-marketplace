import { z } from 'zod';

/**
 * A photographer's public handle: their profile is `/p/<handle>` (Phase 2
 * decision 4; marketplace-spec.md URL map, R2.2).
 *
 * The format is the database's own CHECK `photographer_handle_format`, restated
 * so a signup answers 400 rather than the CHECK surfacing as a 500. Lowercased
 * before it is checked, since a handle is case-insensitive to the people typing
 * it into a browser.
 */
export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;

/**
 * Handles no photographer may take: the first path segment of every page the
 * web app serves, and a few names that would read as the platform's own
 * (Phase 2 decision 4). A handle is a path segment under `/p/` today, but the
 * list is kept to the top-level names so a later short URL (`/<handle>`) stays
 * possible without a rename.
 */
export const RESERVED_HANDLES: ReadonlySet<string> = new Set([
  'admin',
  'api',
  'p',
  'studio',
  'platform',
  'account',
  'photographers',
  'services',
  'checkout',
  'booking',
  'my-booking',
  'email-confirm',
  'login',
  'signup',
  'help',
  'docs',
  'static',
  'assets',
]);

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

/** The request field: trimmed, lowercased, then held to the CHECK's format. */
export const handleField = z.string().trim().toLowerCase().regex(HANDLE_PATTERN);
