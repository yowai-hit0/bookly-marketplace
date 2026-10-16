import {
  type ResolvedTheme,
  type ThemePreference,
  THEME_PREFERENCES,
  readStoredPreference,
  resolveTheme,
  useRootTheme,
  writeStoredPreference,
} from '@/lib/theme'

/**
 * The admin's light and dark themes (design-system/bookly/admin-console.md
 * section 1). The default follows the operating system and changes with it
 * live; a System / Light / Dark choice overrides it on this device.
 *
 * The resolved theme is written to `<html data-admin-theme>`, not to a wrapper,
 * because Radix popovers portal into `body` and would miss a wrapper's tokens.
 * It is removed when the admin page unmounts, so a client page opened after the
 * admin carries none of its tokens.
 *
 * The mechanics are shared with the client's theme (`lib/theme.ts`); the key
 * and the attribute are the admin's own, so the two choices stay separate.
 */

export type { ResolvedTheme, ThemePreference }
export { THEME_PREFERENCES, resolveTheme }

export const THEME_STORAGE_KEY = 'bookly.admin.theme'

export function readThemePreference(): ThemePreference {
  return readStoredPreference(THEME_STORAGE_KEY)
}

export function writeThemePreference(preference: ThemePreference): void {
  writeStoredPreference(THEME_STORAGE_KEY, preference)
}

/**
 * Applies the admin theme while the calling page is mounted, and hands back the
 * preference and a setter for the toggle.
 */
export function useAdminTheme(): {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
} {
  return useRootTheme(THEME_STORAGE_KEY, 'adminTheme')
}
