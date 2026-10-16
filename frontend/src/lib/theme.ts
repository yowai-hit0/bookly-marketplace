import { useCallback, useLayoutEffect, useState } from 'react'

/**
 * Light and dark themes that follow the operating system by default, live,
 * with a System / Light / Dark choice that overrides it on this device. The
 * admin (`admin/theme.ts`) and the client (`useClientTheme`) each build one
 * from here, with their own storage key and root attribute: the two choices
 * are separate on purpose, so the photographer's admin theme never repaints
 * the public site (design-system/bookly/client-front.md section 1).
 *
 * The resolved theme is written to an attribute on `<html>`, not a wrapper,
 * because Radix popovers portal into `body` and would miss a wrapper's tokens.
 * It is removed when the calling page unmounts.
 *
 * Storage can be blocked (a private window, a sandboxed preview), so every
 * read and write is guarded and falls back to following the system.
 */

export type ThemePreference = 'system' | 'light' | 'dark'
export type ResolvedTheme = 'light' | 'dark'

export const THEME_PREFERENCES: readonly ThemePreference[] = ['system', 'light', 'dark']
const DARK_QUERY = '(prefers-color-scheme: dark)'

function isPreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function readStoredPreference(storageKey: string): ThemePreference {
  try {
    const stored = window.localStorage.getItem(storageKey)
    return isPreference(stored) ? stored : 'system'
  } catch {
    return 'system'
  }
}

export function writeStoredPreference(storageKey: string, preference: ThemePreference): void {
  try {
    if (preference === 'system') window.localStorage.removeItem(storageKey)
    else window.localStorage.setItem(storageKey, preference)
  } catch {
    // Not remembered on this device; the choice still applies until the page closes.
  }
}

function darkQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null
}

function systemTheme(): ResolvedTheme {
  return darkQuery()?.matches === true ? 'dark' : 'light'
}

export function resolveTheme(preference: ThemePreference, system: ResolvedTheme): ResolvedTheme {
  return preference === 'system' ? system : preference
}

export type ThemeState = {
  preference: ThemePreference
  resolved: ResolvedTheme
  setPreference: (preference: ThemePreference) => void
}

/**
 * Applies a theme while the calling page is mounted, and hands back the
 * preference and a setter. Both states start from synchronous reads, and the
 * attribute is set in a layout effect, before the first paint, so there is no
 * flash of the other theme.
 *
 * `datasetKey` is the camel-cased `data-*` name (`adminTheme` for
 * `data-admin-theme`).
 */
export function useRootTheme(storageKey: string, datasetKey: string): ThemeState {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readStoredPreference(storageKey))
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme)
  const resolved = resolveTheme(preference, system)

  useLayoutEffect(() => {
    const query = darkQuery()
    if (query === null) return
    const onChange = (event: MediaQueryListEvent) => setSystem(event.matches ? 'dark' : 'light')
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  useLayoutEffect(() => {
    const root = document.documentElement
    root.dataset[datasetKey] = resolved
    return () => {
      delete root.dataset[datasetKey]
    }
  }, [datasetKey, resolved])

  const setPreference = useCallback(
    (next: ThemePreference) => {
      writeStoredPreference(storageKey, next)
      setPreferenceState(next)
    },
    [storageKey],
  )

  return { preference, resolved, setPreference }
}

/** The client's own theme: `bookly.theme`, `<html data-theme>`. */
export const CLIENT_THEME_STORAGE_KEY = 'bookly.theme'

export function useClientTheme(): ThemeState {
  return useRootTheme(CLIENT_THEME_STORAGE_KEY, 'theme')
}

/** The next setting the client's one-button control moves to: System, Light, Dark, System. */
export function nextPreference(preference: ThemePreference): ThemePreference {
  const index = THEME_PREFERENCES.indexOf(preference)
  return THEME_PREFERENCES[(index + 1) % THEME_PREFERENCES.length] ?? 'system'
}
