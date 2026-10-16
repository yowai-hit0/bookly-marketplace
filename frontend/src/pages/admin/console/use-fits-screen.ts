import { useSyncExternalStore } from 'react'

/**
 * True on a screen of at least 1280x720, where the admin's fit-to-screen pages
 * (the calendar) show everything without page scroll (admin console fixes,
 * items 3 and 4, 2026-09-27). Live: it follows a resized window. False where
 * there is no `matchMedia` (jsdom), so tests see the scrolling layout.
 */
const QUERY = '(min-width: 1280px) and (min-height: 720px)'

function subscribe(onChange: () => void): () => void {
  if (typeof window.matchMedia !== 'function') return () => {}
  const query = window.matchMedia(QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches
}

export function useFitsScreen(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false)
}
