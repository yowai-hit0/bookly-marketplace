import { CalendarClock, CalendarDays, ClipboardList, type LucideIcon, Package, Settings, Wallet } from 'lucide-react'

/**
 * The admin pages, in the order the sidebar lists them
 * (design-system/bookly/pages/admin-shell.md; Earnings added in Phase 4,
 * R4.5). The sidebar and the breadcrumb both read this, so a page's label and
 * icon cannot drift between the two. Labels are `admin:nav.<page>`.
 *
 * `also` names the pages that live under a section without a nav link of
 * their own: one payout and the payout method belong to Earnings.
 */
export const NAV_ITEMS = [
  { page: 'calendar', icon: CalendarDays },
  { page: 'bookings', icon: ClipboardList },
  { page: 'catalogue', icon: Package },
  { page: 'availability', icon: CalendarClock },
  { page: 'earnings', icon: Wallet, also: ['payouts', 'payout-method'] },
  { page: 'settings', icon: Settings },
] as const satisfies readonly { page: string; icon: LucideIcon; also?: readonly string[] }[]

export type NavItem = (typeof NAV_ITEMS)[number]

/** The nav item a path belongs to: `/studio/bookings/b1` is under Bookings, `/studio/payouts/p1` under Earnings. */
export function navItemFor(pathname: string): NavItem | null {
  const segment = pathname.split('/')[2] ?? ''
  return (
    NAV_ITEMS.find((item) => item.page === segment || ('also' in item && (item.also as readonly string[]).includes(segment))) ?? null
  )
}
