import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, navItemFor } from './nav'

/**
 * The studio's sections (admin-shell.md; Earnings added in Phase 4, R4.5;
 * Subscription in Phase 5, R5.2):
 * one list the sidebar and the breadcrumb both read, and the section a path
 * belongs to.
 */
describe('the studio nav', () => {
  it('lists the seven sections in sidebar order, Subscription between Earnings and Settings', () => {
    expect(NAV_ITEMS.map((item) => item.page)).toEqual([
      'calendar',
      'bookings',
      'catalogue',
      'availability',
      'earnings',
      'subscription',
      'settings',
    ])
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
    ['/studio/subscription', 'subscription'],
    ['/studio/settings', 'settings'],
  ])('puts %s under %s', (path, page) => {
    expect(navItemFor(path)?.page).toBe(page)
  })

  it.each(['/studio', '/studio/', '/studio/nowhere', '/studio/payout', '/studio/payouts-old', '/studio/subscriptions', '/'])(
    'puts %s under no section',
    (path) => {
      expect(navItemFor(path)).toBeNull()
    },
  )
})
