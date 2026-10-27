import { describe, expect, it } from 'vitest'
import { NAV_ITEMS, navItemFor, navItemsFor } from './nav'

/**
 * The studio's sections (admin-shell.md; Earnings added in Phase 4, R4.5;
 * Subscription in Phase 5, R5.2; Setup, Profile and Portfolio in Phase 7):
 * one list the sidebar and the breadcrumb both read, which links a studio in
 * each state sees, and the section a path belongs to.
 */
describe('the studio nav', () => {
  const EVERY_STUDIO = ['calendar', 'bookings', 'catalogue', 'availability', 'profile', 'portfolio', 'earnings', 'subscription', 'settings']

  it('lists the sections in sidebar order: Setup first, Profile and Portfolio after Availability, Settings last', () => {
    expect(NAV_ITEMS.map((item) => item.page)).toEqual(['setup', ...EVERY_STUDIO])
  })

  it('links Setup only while the studio is pending', () => {
    expect(navItemsFor('pending').map((item) => item.page)).toEqual(['setup', ...EVERY_STUDIO])
    expect(navItemsFor('approved').map((item) => item.page)).toEqual(EVERY_STUDIO)
    expect(navItemsFor('suspended').map((item) => item.page)).toEqual(EVERY_STUDIO)
  })

  it('leaves Setup out while the status is unknown, so it never appears and vanishes for an approved studio', () => {
    expect(navItemsFor(null).map((item) => item.page)).toEqual(EVERY_STUDIO)
  })

  it.each([
    ['/studio/calendar', 'calendar'],
    ['/studio/bookings', 'bookings'],
    ['/studio/bookings/b1', 'bookings'],
    ['/studio/catalogue', 'catalogue'],
    ['/studio/availability', 'availability'],
    ['/studio/profile', 'profile'],
    ['/studio/portfolio', 'portfolio'],
    ['/studio/setup', 'setup'],
    ['/studio/earnings', 'earnings'],
    ['/studio/payouts/p1', 'earnings'],
    ['/studio/payout-method', 'earnings'],
    ['/studio/subscription', 'subscription'],
    ['/studio/settings', 'settings'],
  ])('puts %s under %s', (path, page) => {
    expect(navItemFor(path)?.page).toBe(page)
  })

  it.each(['/studio', '/studio/', '/studio/nowhere', '/studio/payout', '/studio/payouts-old', '/studio/subscriptions', '/studio/profiles', '/'])(
    'puts %s under no section',
    (path) => {
      expect(navItemFor(path)).toBeNull()
    },
  )
})
