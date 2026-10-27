import {
  CalendarClock,
  CalendarDays,
  ClipboardList,
  Images,
  ListChecks,
  type LucideIcon,
  Package,
  Repeat,
  Settings,
  UserRound,
  Wallet,
} from 'lucide-react'
import type { StudioStatus } from './studio-me'

/**
 * The studio pages, in the order the sidebar lists them
 * (design-system/bookly/pages/admin-shell.md; Earnings added in Phase 4,
 * R4.5; Subscription in Phase 5, R5.2; Setup, Profile and Portfolio in Phase
 * 7, R7.2-R7.3). The sidebar and the breadcrumb both read this, so a page's
 * label and icon cannot drift between the two. Labels are `admin:nav.<page>`.
 *
 * `also` names the pages that live under a section without a nav link of
 * their own: one payout and the payout method belong to Earnings.
 *
 * `pendingOnly`: Setup is linked only while the studio is pending (it is the
 * pending photographer's to-do list, first in the list); once approved or
 * suspended the page still answers, but the link is gone (`navItemsFor`).
 */
export const NAV_ITEMS = [
  { page: 'setup', icon: ListChecks, pendingOnly: true },
  { page: 'calendar', icon: CalendarDays },
  { page: 'bookings', icon: ClipboardList },
  { page: 'catalogue', icon: Package },
  { page: 'availability', icon: CalendarClock },
  { page: 'profile', icon: UserRound },
  { page: 'portfolio', icon: Images },
  { page: 'earnings', icon: Wallet, also: ['payouts', 'payout-method'] },
  { page: 'subscription', icon: Repeat },
  { page: 'settings', icon: Settings },
] as const satisfies readonly { page: string; icon: LucideIcon; also?: readonly string[]; pendingOnly?: true }[]

export type NavItem = (typeof NAV_ITEMS)[number]

/**
 * The links the sidebar shows for a studio in `status`: Setup only while
 * pending. Null (`/me` has not answered, or failed) shows the links every
 * studio has, so nothing appears and then vanishes for an approved one.
 */
export function navItemsFor(status: StudioStatus | null): NavItem[] {
  return NAV_ITEMS.filter((item) => !('pendingOnly' in item) || status === 'pending')
}

/** The nav item a path belongs to: `/studio/bookings/b1` is under Bookings, `/studio/payouts/p1` under Earnings. */
export function navItemFor(pathname: string): NavItem | null {
  const segment = pathname.split('/')[2] ?? ''
  return (
    NAV_ITEMS.find((item) => item.page === segment || ('also' in item && (item.also as readonly string[]).includes(segment))) ?? null
  )
}
