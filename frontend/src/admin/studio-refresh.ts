import { createContext, useContext } from 'react'

/**
 * Asks the studio layout to read `/api/studio/me` again, so its banner and its
 * nav follow a change the page just made (the setup page calls it once the
 * studio is submitted for review). The subscription page asks the same through
 * `useSubscriptionRefresh`, which the layout answers with the same read.
 * Provided by the layout around its outlet; the default (a page rendered alone
 * in a test) does nothing.
 */
export const StudioRefreshContext = createContext<() => void>(() => {})

export function useStudioRefresh(): () => void {
  return useContext(StudioRefreshContext)
}
