import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, navItemFor } from './nav'

/**
 * The studio's sections (admin-shell.md; Earnings added in Phase 4, R4.5):
 * one list the sidebar and the breadcrumb both read, and the section a path
 * belongs to.
 */
describe('the studio nav', () => {
  it('lists the six sections in sidebar order, Earnings before Settings', () => {
    expect(NAV_ITEMS.map((item) => item.page)).toEqual(['calendar', 'bookings', 'catalogue', 'availability', 'earnings', 'settings'])
  })

  it.each([
    ['/studio/calendar', 'calendar'],
    ['/studio/bookings', 'bookings'],
    ['/studio/bookings/b1', 'bookings'],
    ['/studio/catalogue', 'catalogue'],
    ['/studio/availability', 'availability'],
    ['/studio/earnings', 'earnings'],
    ['/studio/payouts/p1', 'earnings'],
    ['/studio/payout-method', 'earnings'],
    ['/studio/settings', 'settings'],
  ])('puts %s under %s', (path, page) => {
    expect(navItemFor(path)?.page).toBe(page)
  })

  it.each(['/studio', '/studio/', '/studio/nowhere', '/studio/payout', '/studio/payouts-old', '/'])(
    'puts %s under no section',
    (path) => {
      expect(navItemFor(path)).toBeNull()
    },
  )
})
