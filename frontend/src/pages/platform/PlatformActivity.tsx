import { ArrowLeft, ArrowRight, CircleAlert, History, X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useSearchParams } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { Button, buttonVariants } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import {
  AUDIT_AREAS,
  AUDIT_GROUPS,
  type AuditPage,
  type AuditQuery,
  paramsFromQuery,
  platformAuditApi,
  queryFromParams,
} from '@/platform/audit'
import { EYEBROW, LINK, META, PAGE, SELECT } from '@/pages/admin/console/classes'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import { Toolbar, ToolbarCell } from '@/pages/admin/console/Toolbar'
import { AuditEntryRow } from './AuditEntryRow'

/** What a photographer's detail page passes along with its "See all activity" link. */
export type ActivityLinkState = { photographerId: string; photographerName: string }

type Loaded = { key: string; attempt: number } & ({ kind: 'ready'; page: AuditPage } | { kind: 'refused' } | { kind: 'failed' })

/**
 * `/platform/activity` (marketplace spec R9.4; Phase 9 user decision 1): the
 * platform's audit trail, read-only, newest first, 50 a page. The view is in
 * the URL (`?action=&photographerId=&page=`) so a reload or a shared link
 * keeps it; a value the API would refuse is dropped before asking.
 *
 * The action filter is the vocabulary grouped by area. A photographer filter
 * (from a photographer's detail page) says whose it is and can be cleared.
 * Each entry is one sentence (`describeEntry`), never raw JSON.
 */
export function PlatformActivity() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const actionId = useId()
  const query = queryFromParams(params)
  const key = paramsFromQuery(query).toString()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    platformAuditApi.list(queryFromParams(new URLSearchParams(key))).then(
      (page) => !cancelled && setLoaded({ key, attempt, kind: 'ready', page }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        const refused = error instanceof ApiError && (error.status === 400 || error.status === 422)
        setLoaded({ key, attempt, kind: refused ? 'refused' : 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, attempt])

  const current = loaded !== null && loaded.key === key && loaded.attempt === attempt ? loaded : null
  const page = current?.kind === 'ready' ? current.page : null

  /** A filter change starts again from page 1, and replaces the history entry. */
  function filterTo(next: AuditQuery) {
    setParams(paramsFromQuery({ ...next, page: undefined }), { replace: true, state: location.state })
  }

  const linkState = location.state as Partial<ActivityLinkState> | null
  const photographerName =
    query.photographerId === undefined
      ? null
      : linkState?.photographerId === query.photographerId && typeof linkState.photographerName === 'string'
        ? linkState.photographerName
        : (page?.entries.find((entry) => entry.photographer?.id === query.photographerId)?.photographer?.displayName ??
          t('platform:activity.filter.onePhotographer'))

  const filtered = query.action !== undefined || query.photographerId !== undefined
  const pageHref = (number: number) => {
    const search = paramsFromQuery({ ...query, page: number }).toString()
    return search === '' ? '/platform/activity' : `/platform/activity?${search}`
  }

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      <PageHeader
        eyebrow={t('platform:nav.label')}
        eyebrowIcon={History}
        title={t('platform:activity.title')}
        badges={
          page !== null && (
            <Badge variant="console-count" data-activity-total={page.total}>
              {t('platform:activity.count', { count: page.total })}
            </Badge>
          )
        }
      >
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:activity.intro')}</p>
      </PageHeader>

      <Toolbar className="lg:self-start">
        <ToolbarCell className="max-lg:py-2">
          <Label htmlFor={actionId} className={cn(EYEBROW, 'shrink-0')}>
            {t('platform:activity.filter.action')}
          </Label>
          <select
            id={actionId}
            value={query.action ?? 'all'}
            onChange={(event) => {
              const value = event.target.value
              const action = AUDIT_AREAS.flatMap((area) => AUDIT_GROUPS[area]).find((each) => each === value)
              filterTo({ ...query, action })
            }}
            className={cn(SELECT, 'lg:w-64')}
          >
            <option value="all">{t('platform:activity.filter.all')}</option>
            {AUDIT_AREAS.map((area) => (
              <optgroup key={area} label={t(`platform:activity.filter.groups.${area}`)}>
                {AUDIT_GROUPS[area].map((action) => (
                  <option key={action} value={action}>
                    {t(`platform:activity.actions.${action}`)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </ToolbarCell>
        {photographerName !== null && (
          <ToolbarCell className="justify-between max-lg:py-1.5">
            <span className="text-[0.9375rem] wrap-anywhere" data-photographer-filter={query.photographerId}>
              {t('platform:activity.filter.filteredTo', { name: photographerName })}
            </span>
            <Button
              variant="ghost"
              size="console-sm"
              aria-label={t('platform:activity.filter.clearLabel')}
              onClick={() => filterTo({ ...query, photographerId: undefined })}
            >
              <X aria-hidden="true" />
              {t('platform:activity.filter.clear')}
            </Button>
          </ToolbarCell>
        )}
      </Toolbar>

      {current === null && (
        <LoadingRegion label={t('platform:activity.loading')} className="flex flex-col rounded-xs border">
          {Array.from({ length: 6 }, (_, row) => (
            <div key={row} className="flex gap-4 border-b p-4 last:border-b-0 sm:px-6">
              <Line w="size-8 shrink-0" className="h-8" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Line w="w-96 max-w-full" />
                <Line w="w-56 max-w-full" className="h-3" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      )}

      {current?.kind === 'failed' && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:activity.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:activity.retry')}
          </Button>
        </div>
      )}

      {current?.kind === 'refused' && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:activity.refused')}
          </p>
          <Link to="/platform/activity" className={cn(LINK, 'inline-flex items-center text-sm max-lg:min-h-11 pointer-coarse:min-h-11')}>
            {t('platform:activity.showAll')}
          </Link>
        </div>
      )}

      {page !== null && page.entries.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-start gap-2 rounded-xs border border-dashed p-6" data-activity-empty="">
          <History aria-hidden="true" className="size-5" />
          {page.total > 0 ? (
            <>
              <p className="text-sm">{t('platform:activity.pastEnd')}</p>
              <Link to={pageHref(1)} className={cn(LINK, 'inline-flex items-center text-sm max-lg:min-h-11 pointer-coarse:min-h-11')}>
                {t('platform:activity.firstPage')}
              </Link>
            </>
          ) : (
            <p className="text-sm">{filtered ? t('platform:activity.emptyFiltered') : t('platform:activity.empty')}</p>
          )}
        </div>
      )}

      {page !== null && page.entries.length > 0 && (
        <ol aria-label={t('platform:activity.listLabel')} className="flex flex-col rounded-xs border">
          {page.entries.map((entry) => (
            <AuditEntryRow key={entry.id} entry={entry} />
          ))}
        </ol>
      )}

      {page !== null && page.pageCount > 1 && (
        <nav aria-label={t('platform:activity.pages.label')} className="flex flex-wrap items-center gap-3">
          <PageStep to={page.page > 1 ? pageHref(page.page - 1) : null} direction="previous" />
          <span className="font-mono text-sm tabular-nums" data-page-of="">
            {t('platform:activity.pages.of', { page: page.page, count: page.pageCount })}
          </span>
          <PageStep to={page.page < page.pageCount ? pageHref(page.page + 1) : null} direction="next" />
        </nav>
      )}
    </main>
  )
}

/** Previous or Next: a link while there is a page that way, a disabled-looking word at the end. */
function PageStep({ to, direction }: { to: string | null; direction: 'previous' | 'next' }) {
  const { t } = useTranslation()
  const label = t(`platform:activity.pages.${direction}`)
  const icon = direction === 'previous' ? <ArrowLeft aria-hidden="true" /> : <ArrowRight aria-hidden="true" />
  // Through `cn`, as `Button` does, so the variant's edge wins over the base's transparent one.
  const look = cn(buttonVariants({ variant: 'console-outline', size: 'console-sm' }))
  if (to === null) {
    return (
      <span aria-disabled="true" className={cn(look, 'pointer-events-none opacity-50')}>
        {direction === 'previous' && icon}
        {label}
        {direction === 'next' && icon}
      </span>
    )
  }
  return (
    <Link to={to} className={look} rel={direction === 'previous' ? 'prev' : 'next'}>
      {direction === 'previous' && icon}
      {label}
      {direction === 'next' && icon}
    </Link>
  )
}
