import { useCallback } from 'react'
import { useNavigate } from 'react-router'
import { AREA_PATHS } from './areas'
import { type Area, clearSession } from './session'

/**
 * Signing out of one area: leave for `to` (the area's login by default), then
 * forget the token. In that order because the area's guard follows the
 * session (`RequireSession`): forgetting first would have it send the visitor
 * to the login with a return path, racing the page they chose. `flushSync`
 * because the router otherwise renders the move in a transition, which the
 * urgent re-render from clearing the session overtakes: the old page's guard
 * would then still see itself mounted and add the return path anyway.
 */
export function useSignOut(area: Area): (to?: string) => void {
  const navigate = useNavigate()
  return useCallback(
    (to: string = AREA_PATHS[area].login) => {
      void Promise.resolve(navigate(to, { replace: true, flushSync: true })).finally(() => clearSession(area))
    },
    [area, navigate],
  )
}
