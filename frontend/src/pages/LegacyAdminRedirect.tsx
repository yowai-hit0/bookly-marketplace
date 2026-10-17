import { Navigate, useLocation } from 'react-router'

/**
 * `/admin` and everything below it, from before the studio had its name
 * (Phase 2): the same place under `/studio`, with the query and the fragment
 * kept, because emailed reset links carry their token in the fragment. The
 * target is always under `/studio`, so this cannot send anyone off the site.
 */
export function LegacyAdminRedirect() {
  const { pathname, search, hash } = useLocation()
  return <Navigate to={`${pathname.replace(/^\/admin(?=\/|$)/, '/studio')}${search}${hash}`} replace />
}
