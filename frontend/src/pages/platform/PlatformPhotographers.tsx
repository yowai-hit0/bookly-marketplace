import { CircleAlert, CircleCheck, Users } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { UnauthenticatedError } from '@/auth/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Label } from '@/components/ui/label'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type Moderation,
  PHOTOGRAPHER_STATUSES,
  type PhotographerFilter,
  type PlatformPhotographer,
  REVIEW_FILTERS,
  type ReviewFilter,
  handleChangedSinceSubmission,
  isPhotographerStatus,
  isReviewFilter,
  matchesFilter,
  platformApi,
} from '@/platform/photographers'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import { Toolbar, ToolbarCell } from '@/pages/admin/console/Toolbar'
import { EYEBROW, LINK, META, PAGE, SELECT, TD, TH, TR } from '@/pages/admin/console/classes'
import { HandleChangedBadge, ModerationButtons, ModerationDialog, type PendingModeration, PhotographerStatusBadge } from './PhotographerModeration'

type Notice = { tone: 'success' | 'warning'; text: string }

/** The list's view, carried to a photographer's detail page so its Back link returns to it. */
export type PhotographersListState = { listSearch: string }

/**
 * `/platform/photographers` (Phase 2 brief decision 7): every photographer,
 * newest first, filtered by status through `?status=`, with the moderation
 * the API allows from each status. Each change is confirmed in a dialog first
 * (a suspension asks for its reason, which the photographer is emailed), and
 * the row then shows what the API answered: no optimistic update.
 *
 * A change another admin made first comes back as a 409 carrying the row as
 * it now is; the row is replaced and the page says so.
 *
 * The review queue (Phase 7): `?review=awaiting` lists the studios submitted
 * for review (the admins' email links there), `?review=setting_up` the pending
 * ones still setting up; both are pending, so the status filter steps aside
 * while either is chosen. A pending photographer who has not submitted cannot
 * be approved: the button is disabled with the reason beside it, and the API's
 * own 409 `not_submitted` (a race) says so and refreshes the row.
 *
 * A studio awaiting review whose handle changed after it was submitted is
 * flagged under its name, with the current handle and the date (Phase 7, user
 * decision 2026-10-27): the handle becomes its public address at approval.
 */
export function PlatformPhotographers() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const rawReview = params.get('review')
  const review = isReviewFilter(rawReview) ? rawReview : undefined
  const raw = params.get('status')
  // A review view is pending by definition: the status filter steps aside.
  const status = review === undefined && isPhotographerStatus(raw) ? raw : undefined
  const filter: PhotographerFilter = review === undefined ? (status === undefined ? {} : { status }) : { review }
  const filterId = useId()

  const [rows, setRows] = useState<{ key: string; list: PlatformPhotographer[] } | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState<PendingModeration | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const key = review === undefined ? (status ?? 'all') : `review:${review}`
  // A failure belongs to the load that failed: another filter or a retry is a new load.
  const failed = failedFor === `${key}:${attempt}`

  useEffect(() => {
    let cancelled = false
    platformApi.list(review === undefined ? (status === undefined ? {} : { status }) : { review }).then(
      (list) => !cancelled && setRows({ key, list }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setFailedFor(`${key}:${attempt}`)
      },
    )
    return () => {
      cancelled = true
    }
  }, [key, status, review, attempt])

  const current = rows !== null && rows.key === key ? rows.list : null

  function chooseStatus(next: string) {
    setNotice(null)
    setParams(next === 'all' ? new URLSearchParams() : new URLSearchParams({ status: next }), { replace: true })
  }

  /** Puts the API's answer in place; a row whose new status the filter excludes leaves the list. */
  function showRow(photographer: PlatformPhotographer) {
    setRows((now) =>
      now === null
        ? now
        : {
            ...now,
            list: now.list.flatMap((row) => (row.id !== photographer.id ? [row] : matchesFilter(photographer, filter) ? [photographer] : [])),
          },
    )
  }

  function dropRow(id: string) {
    setRows((now) => (now === null ? now : { ...now, list: now.list.filter((row) => row.id !== id) }))
  }

  function onDone(action: Moderation, photographer: PlatformPhotographer) {
    setPending(null)
    showRow(photographer)
    const done = action === 'approve' ? 'approved' : action === 'suspend' ? 'suspended' : 'reactivated'
    setNotice({ tone: 'success', text: t(`platform:photographers.done.${done}`, { name: photographer.displayName }) })
  }

  function onStale(photographer: PlatformPhotographer) {
    setPending(null)
    showRow(photographer)
    setNotice({
      tone: 'warning',
      text: t('platform:photographers.stale', {
        name: photographer.displayName,
        status: t(`platform:photographers.status.${photographer.status}`).toLowerCase(),
      }),
    })
  }

  /** 409 `not_submitted`: the studio has not been submitted for review, so it cannot be approved yet. */
  function onNotSubmitted(photographer: PlatformPhotographer) {
    setPending(null)
    showRow(photographer)
    setNotice({ tone: 'warning', text: t('platform:photographers.notSubmittedError', { name: photographer.displayName }) })
  }

  function onGone(id: string) {
    setPending(null)
    dropRow(id)
    setNotice({ tone: 'warning', text: t('platform:photographers.notFound') })
  }

  return (
    <main className={cn(PAGE, 'max-w-6xl')}>
      <PageHeader eyebrow={t('platform:nav.label')} eyebrowIcon={Users} title={t('platform:photographers.title')} />

      {/* The review views and the status filter, one row from `lg`. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:gap-6">
        <ReviewViews review={review} onChoose={() => setNotice(null)} />

        {review === undefined && (
          <Toolbar>
            <ToolbarCell className="max-lg:py-2">
              <Label htmlFor={filterId} className={cn(EYEBROW, 'shrink-0')}>
                {t('platform:photographers.filter.label')}
              </Label>
              <select
                id={filterId}
                value={key}
                onChange={(event) => chooseStatus(event.target.value)}
                className={cn(SELECT, 'lg:w-48')}
              >
                <option value="all">{t('platform:photographers.filter.all')}</option>
                {PHOTOGRAPHER_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(`platform:photographers.status.${value}`)}
                  </option>
                ))}
              </select>
            </ToolbarCell>
          </Toolbar>
        )}
      </div>

      {notice !== null && (
        <Callout
          variant="console"
          tone={notice.tone}
          icon={notice.tone === 'success' ? CircleCheck : CircleAlert}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          <p>{notice.text}</p>
        </Callout>
      )}

      {failed && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:photographers.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:photographers.retry')}
          </Button>
        </div>
      )}

      {current === null && !failed && (
        <LoadingRegion label={t('platform:photographers.loading')} className="flex flex-col">
          {Array.from({ length: 5 }, (_, row) => (
            <div key={row} className="flex items-center gap-6 border-b py-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Line w="w-44 max-w-full" />
                <Line w="w-24" className="h-3" />
              </div>
              <Line w="w-40 max-sm:hidden" />
              <Line w="w-20" />
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && current.length === 0 && (
        <p className={META}>
          {review === 'awaiting'
            ? t('platform:photographers.emptyAwaiting')
            : review === 'setting_up'
              ? t('platform:photographers.emptySettingUp')
              : status === undefined
                ? t('platform:photographers.empty')
                : t('platform:photographers.emptyFiltered')}
        </p>
      )}

      {current !== null && current.length > 0 && (
        <div className="@container">
          <table role="table" className="w-full border-collapse text-[0.9375rem]">
            <caption className="sr-only">{t('platform:photographers.title')}</caption>
            <thead role="rowgroup" className="@max-[48rem]:sr-only">
              <tr role="row" className="border-b">
                {(['photographer', 'email', 'status', 'applied', 'submitted', 'actions'] as const).map((column) => (
                  <th key={column} role="columnheader" scope="col" className={cn(TH, column === 'actions' && 'text-right')}>
                    {t(`platform:photographers.columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[48rem]:block">
              {current.map((photographer) => (
                <tr key={photographer.id} role="row" className={cn(TR, '@max-[48rem]:flex @max-[48rem]:flex-col @max-[48rem]:gap-2 @max-[48rem]:py-4')}>
                  <td role="cell" className={cn(TD, '@max-[48rem]:p-0')}>
                    <div className="flex flex-col gap-1">
                      <Link
                        to={`/platform/photographers/${encodeURIComponent(photographer.id)}`}
                        state={{ listSearch: params.toString() } satisfies PhotographersListState}
                        data-photographer-link={photographer.id}
                        className={cn(LINK, 'self-start wrap-anywhere inline-flex items-center max-lg:min-h-11 pointer-coarse:min-h-11')}
                      >
                        {photographer.displayName}
                      </Link>
                      <span className={cn(META, 'font-mono')}>/p/{photographer.handle}</span>
                      {handleChangedSinceSubmission(photographer) && (
                        <div className="flex flex-col items-start gap-1" data-handle-changed={photographer.handleChangedAt}>
                          <HandleChangedBadge />
                          <span className={cn(META, 'wrap-anywhere')}>
                            {t('platform:photographers.handleChangedDetail', {
                              handle: photographer.handle,
                              date: formatDate(kigaliDateOf(photographer.handleChangedAt)),
                            })}
                          </span>
                        </div>
                      )}
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, 'wrap-anywhere @max-[48rem]:p-0')}>
                    {photographer.email}
                  </td>
                  <td role="cell" className={cn(TD, '@max-[48rem]:p-0')}>
                    <div className="flex flex-col items-start gap-1">
                      <PhotographerStatusBadge status={photographer.status} />
                      {photographer.status === 'suspended' && photographer.suspensionReason !== null && (
                        <span className={cn(META, 'wrap-anywhere')}>
                          {t('platform:photographers.suspendedReason', { reason: photographer.suspensionReason })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, 'tabular-nums @max-[48rem]:p-0')}>
                    {formatDate(kigaliDateOf(photographer.createdAt))}
                  </td>
                  <td role="cell" className={cn(TD, 'tabular-nums @max-[48rem]:p-0')} data-submitted={photographer.submittedAt ?? ''}>
                    {photographer.submittedAt === null ? (
                      <span className={META}>{t('platform:photographers.notSubmitted')}</span>
                    ) : (
                      <>
                        {/* Stacked, the column header is hidden: the word says what the date is. */}
                        <span className="text-muted-foreground mr-1.5 @min-[48rem]:sr-only">{t('platform:photographers.columns.submitted')}</span>
                        {formatDate(kigaliDateOf(photographer.submittedAt))}
                      </>
                    )}
                  </td>
                  <td role="cell" className={cn(TD, '@max-[48rem]:p-0')}>
                    <ModerationButtons
                      photographer={photographer}
                      className="@min-[48rem]:items-end"
                      buttonsClassName="@min-[48rem]:flex-nowrap @min-[48rem]:justify-end"
                      onChoose={(next) => {
                        setNotice(null)
                        setPending(next)
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending !== null && (
        <ModerationDialog
          key={`${pending.photographer.id}:${pending.action}`}
          pending={pending}
          onClose={() => setPending(null)}
          onDone={onDone}
          onStale={onStale}
          onNotSubmitted={onNotSubmitted}
          onGone={onGone}
        />
      )}
    </main>
  )
}

/**
 * The three views of the list as links that keep the URL in step (the
 * admins' email opens `?review=awaiting`): every photographer, the studios
 * awaiting review, and those still setting up. The current one is marked
 * `aria-current`, a fill and a weight, not colour alone.
 */
function ReviewViews({ review, onChoose }: { review: ReviewFilter | undefined; onChoose: () => void }) {
  const { t } = useTranslation()
  const views: (ReviewFilter | 'all')[] = ['all', ...REVIEW_FILTERS]
  return (
    <nav aria-label={t('platform:photographers.review.label')} className="lg:self-start">
      <ul className="border-input divide-input flex flex-col divide-y rounded-xs border sm:flex-row sm:divide-x sm:divide-y-0">
        {views.map((view) => {
          const active = (review ?? 'all') === view
          return (
            <li key={view} className="flex">
              <Link
                to={view === 'all' ? { search: '' } : { search: `?review=${view}` }}
                replace
                aria-current={active ? 'page' : undefined}
                data-review-view={view}
                onClick={onChoose}
                className={cn(
                  'flex min-h-11 flex-1 items-center px-4 text-[0.9375rem] motion-safe:transition-colors motion-safe:duration-150 lg:min-h-12',
                  active ? 'bg-sidebar-primary text-sidebar-primary-foreground font-medium' : 'hover:bg-accent text-foreground',
                )}
              >
                {t(`platform:photographers.review.${view}`)}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
