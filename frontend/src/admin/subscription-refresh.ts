import { createContext, useContext } from 'react'

/**
 * Asks the studio layout to read the subscription again, so its banner stops
 * saying "past due" the moment a payment succeeds rather than on the next
 * visit. The subscription page calls it once a payment settles. Provided by
 * the layout around its outlet; the default (a page rendered alone in a test)
 * does nothing.
 */
export const SubscriptionRefreshContext = createContext<() => void>(() => {})

export function useSubscriptionRefresh(): () => void {
  return useContext(SubscriptionRefreshContext)
}
