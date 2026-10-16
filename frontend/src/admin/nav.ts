import { CalendarClock, CalendarDays, ClipboardList, type LucideIcon, Package, Settings } from 'lucide-react'

/**
 * The five admin pages, in the order the sidebar lists them
 * (design-system/bookly/pages/admin-shell.md). The sidebar and the breadcrumb
 * both read this, so a page's label and icon cannot drift between the two.
 * Labels are `admin:nav.<page>`.
 */
export const NAV_ITEMS = [
  { page: 'calendar', icon: CalendarDays },
  { page: 'bookings', icon: ClipboardList },
  { page: 'catalogue', icon: Package },
  { page: 'availability', icon: CalendarClock },
  { page: 'settings', icon: Settings },
] as const satisfies readonly { page: string; icon: LucideIcon }[]

export type NavItem = (typeof NAV_ITEMS)[number]

/** The nav item a path belongs to: `/admin/bookings/b1` is under Bookings. */
export function navItemFor(pathname: string): NavItem | null {
  const segment = pathname.split('/')[2] ?? ''
  return NAV_ITEMS.find((item) => item.page === segment) ?? null
}
