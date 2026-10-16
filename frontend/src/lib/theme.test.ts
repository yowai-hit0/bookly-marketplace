import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { THEME_STORAGE_KEY as ADMIN_KEY, useAdminTheme } from '@/admin/theme'
import { CLIENT_THEME_STORAGE_KEY, nextPreference, useClientTheme } from './theme'

/**
 * The client theme (design-system/bookly/client-front.md section 1): follows
 * the OS by default and live, a stored choice wins, blocked storage falls back
 * to the OS without failing, the root attribute leaves with the page, and the
 * client's choice and the admin's are separate.
 */

type Listener = (event: MediaQueryListEvent) => void

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
  delete root().dataset.theme
  delete root().dataset.adminTheme
})

describe('the client theme', () => {
  it('follows the operating system when nothing is stored', () => {
    fakeDarkQuery(true)
    const { result } = renderHook(() => useClientTheme())

    expect(result.current.preference).toBe('system')
    expect(root().dataset.theme).toBe('dark')
  })

  it('lets a stored choice win over the operating system', () => {
    fakeDarkQuery(true)
    localStorage.setItem(CLIENT_THEME_STORAGE_KEY, 'light')
    renderHook(() => useClientTheme())

    expect(root().dataset.theme).toBe('light')
  })

  it('still renders, following the system, when storage throws', () => {
    fakeDarkQuery(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })

    const { result } = renderHook(() => useClientTheme())
    expect(root().dataset.theme).toBe('dark')
    act(() => result.current.setPreference('light'))
    expect(root().dataset.theme).toBe('light')
  })

  it('follows a live change of the operating system while set to system', () => {
    const os = fakeDarkQuery(false)
    renderHook(() => useClientTheme())
    expect(root().dataset.theme).toBe('light')

    act(() => os.setDark(true))
    expect(root().dataset.theme).toBe('dark')
  })

  it('removes the attribute, and stops listening, when the page unmounts', () => {
    const os = fakeDarkQuery(true)
    const { unmount } = renderHook(() => useClientTheme())
    expect(root().dataset.theme).toBe('dark')

    unmount()
    expect(root()).not.toHaveAttribute('data-theme')
    expect(os.listeners.size).toBe(0)
  })

  it('keeps its choice apart from the admin’s', () => {
    fakeDarkQuery(false)
    const client = renderHook(() => useClientTheme())
    act(() => client.result.current.setPreference('dark'))
    expect(localStorage.getItem(CLIENT_THEME_STORAGE_KEY)).toBe('dark')
    expect(localStorage.getItem(ADMIN_KEY)).toBeNull()
    client.unmount()

    renderHook(() => useAdminTheme())
    expect(root().dataset.adminTheme).toBe('light')
    expect(root()).not.toHaveAttribute('data-theme')
  })

  it('cycles System, Light, Dark and back', () => {
    expect(nextPreference('system')).toBe('light')
    expect(nextPreference('light')).toBe('dark')
    expect(nextPreference('dark')).toBe('system')
  })
})
