import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY, readThemePreference, useAdminTheme, writeThemePreference } from './theme'

/**
 * The admin theme (design-system/bookly/admin-console.md section 1): follows
 * the OS by default and live, a stored choice wins, blocked storage falls back
 * to the OS without failing, and the root attribute leaves with the page.
 */

type Listener = (event: MediaQueryListEvent) => void

/** A `prefers-color-scheme: dark` query whose answer a test can flip. */
function fakeDarkQuery(initiallyDark: boolean) {
  const listeners = new Set<Listener>()
  const query = {
    matches: initiallyDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, listener: Listener) => listeners.add(listener),
    removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
  }
  vi.stubGlobal('matchMedia', vi.fn(() => query))
  return {
    listeners,
    setDark(dark: boolean) {
      query.matches = dark
      for (const listener of listeners) listener({ matches: dark } as MediaQueryListEvent)
    },
  }
}

const root = () => document.documentElement

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
  delete root().dataset.adminTheme
})

describe('the admin theme', () => {
  it('follows the operating system when nothing is stored', () => {
    fakeDarkQuery(true)
    const { result } = renderHook(() => useAdminTheme())

    expect(result.current.preference).toBe('system')
    expect(result.current.resolved).toBe('dark')
    expect(root().dataset.adminTheme).toBe('dark')
  })

  it('uses light when the operating system asks for light, or cannot say', () => {
    fakeDarkQuery(false)
    const { unmount } = renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('light')
    unmount()

    // jsdom has no matchMedia; neither do some embedded browsers.
    vi.stubGlobal('matchMedia', undefined)
    renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('light')
  })

  it('lets a stored choice win over the operating system', () => {
    fakeDarkQuery(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    const { result } = renderHook(() => useAdminTheme())

    expect(result.current.preference).toBe('light')
    expect(root().dataset.adminTheme).toBe('light')
  })

  it('ignores a stored value it does not know', () => {
    fakeDarkQuery(true)
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia')

    expect(readThemePreference()).toBe('system')
    renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('dark')
  })

  it('remembers a choice on this device, and forgets it when set back to system', () => {
    fakeDarkQuery(false)
    const { result } = renderHook(() => useAdminTheme())

    act(() => result.current.setPreference('dark'))
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark')
    expect(root().dataset.adminTheme).toBe('dark')

    act(() => result.current.setPreference('system'))
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull()
    expect(root().dataset.adminTheme).toBe('light')
  })

  it('still renders, following the system, when storage throws', () => {
    fakeDarkQuery(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const { result } = renderHook(() => useAdminTheme())
    expect(result.current.preference).toBe('system')
    expect(root().dataset.adminTheme).toBe('dark')

    // The choice still applies for this visit, even though it cannot be kept.
    act(() => result.current.setPreference('light'))
    expect(root().dataset.adminTheme).toBe('light')
    expect(() => writeThemePreference('dark')).not.toThrow()
  })

  it('follows a live change of the operating system while set to system', () => {
    const os = fakeDarkQuery(false)
    renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('light')

    act(() => os.setDark(true))
    expect(root().dataset.adminTheme).toBe('dark')

    act(() => os.setDark(false))
    expect(root().dataset.adminTheme).toBe('light')
  })

  it('keeps a fixed choice when the operating system changes', () => {
    const os = fakeDarkQuery(false)
    localStorage.setItem(THEME_STORAGE_KEY, 'light')
    renderHook(() => useAdminTheme())

    act(() => os.setDark(true))
    expect(root().dataset.adminTheme).toBe('light')
  })

  it('removes the attribute, and stops listening, when the admin page unmounts', () => {
    const os = fakeDarkQuery(true)
    const { unmount } = renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('dark')
    expect(os.listeners.size).toBe(1)

    unmount()
    expect(root()).not.toHaveAttribute('data-admin-theme')
    expect(os.listeners.size).toBe(0)
  })
})
