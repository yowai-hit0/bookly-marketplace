import { createContext, useContext, useEffect, useState } from 'react'

/**
 * The breadcrumb's last crumb, reported by the page (design-system/bookly/
 * admin-console.md section 6.2). A booking's reference is only known once the
 * booking page has loaded it, so the page hands it up through this context
 * instead of the breadcrumb fetching the booking a second time.
 */

export type BreadcrumbTail = { state: 'loading' } | { state: 'ready'; label: string }

/** Provided by the admin layout around its outlet. The default does nothing. */
export const BreadcrumbTailContext = createContext<(tail: BreadcrumbTail | null) => void>(() => {})

/** Owned by the admin layout: the tail the current page has reported. */
export function useBreadcrumbTailState() {
  return useState<BreadcrumbTail | null>(null)
}

/**
 * A page's last crumb: a neutral placeholder while `loading`, then `label`;
 * nothing when `label` is null (a failed or missing load drops the crumb).
 * Outside the admin layout (a page rendered alone in a test) it does nothing.
 */
export function useBreadcrumbTail(loading: boolean, label: string | null): void {
  const setTail = useContext(BreadcrumbTailContext)
  useEffect(() => {
    setTail(loading ? { state: 'loading' } : label === null ? null : { state: 'ready', label })
    return () => setTail(null)
  }, [setTail, loading, label])
}
