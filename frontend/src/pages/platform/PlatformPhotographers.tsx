import { CircleAlert, CircleCheck, CircleX, Clock, PencilLine, Users } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatDate } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type Moderation,
  PHOTOGRAPHER_STATUSES,
  type PhotographerStatus,
  type PhotographerFilter,
  type PlatformPhotographer,
  REVIEW_FILTERS,
  type ReviewFilter,
  awaitsSubmission,
  handleChangedSinceSubmission,
  isPhotographerStatus,
  isReviewFilter,
  matchesFilter,
  movesFor,
  normalisePhotographer,
  platformApi,
} from '@/platform/photographers'
import { AdminField } from '@/pages/admin/AdminField'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import { Toolbar, ToolbarCell } from '@/pages/admin/console/Toolbar'
import { EYEBROW, META, PAGE, SELECT, TD, TEXTAREA, TH, TR } from '@/pages/admin/console/classes'

/** The API's cap on a suspension reason, trimmed. */
const MAX_REASON = 500

type Notice = { tone: 'success' | 'warning'; text: string }
type Pending = { photographer: PlatformPhotographer; action: Moderation }

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
  const [pending, setPending] = useState<Pending | null>(null)
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
                      <span className="wrap-anywhere">{photographer.displayName}</span>
                      <span className={cn(META, 'font-mono')}>/p/{photographer.handle}</span>
                      {handleChangedSinceSubmission(photographer) && (
                        <div className="flex flex-col items-start gap-1" data-handle-changed={photographer.handleChangedAt}>
                          <Badge variant="console" className="bg-console-warning-tint text-console-warning">
                            <PencilLine aria-hidden="true" />
                            {t('platform:photographers.handleChanged')}
                          </Badge>
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
                      <StatusBadge status={photographer.status} />
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
                    <div className="flex flex-col gap-1.5 @min-[48rem]:items-end">
                      <div className="flex flex-wrap gap-2 @min-[48rem]:flex-nowrap @min-[48rem]:justify-end">
                        {movesFor(photographer.status).map((action) => {
                          const blocked = action === 'approve' && awaitsSubmission(photographer)
                          return (
                            <Button
                              key={action}
                              variant="console-outline"
                              size="console-sm"
                              // Every row has the same verbs: the name says whose, and starts with the visible word.
                              aria-label={`${t(`platform:photographers.${action}`)} ${photographer.displayName}`}
                              disabled={blocked}
                              aria-describedby={blocked ? `${photographer.id}-not-submitted` : undefined}
                              onClick={() => {
                                setNotice(null)
                                setPending({ photographer, action })
                              }}
                            >
                              {t(`platform:photographers.${action}`)}
                            </Button>
                          )
                        })}
                      </div>
                      {awaitsSubmission(photographer) && (
                        <p id={`${photographer.id}-not-submitted`} className="text-muted-foreground text-[0.8125rem]">
                          {t('platform:photographers.approveNeedsSubmission')}
                        </p>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending !== null && (
        <ConfirmDialog
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

/** The status in a console badge: its word, with an icon of its own shape, never colour alone. */
function StatusBadge({ status }: { status: PhotographerStatus }) {
  const { t } = useTranslation()
  const label = t(`platform:photographers.status.${status}`)
  if (status === 'approved') {
    return (
      <Badge variant="console-success">
        <CircleCheck aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  if (status === 'suspended') {
    return (
      <Badge variant="console" className="bg-console-danger-tint text-destructive">
        <CircleX aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  return (
    <Badge variant="console">
      <Clock aria-hidden="true" />
      {label}
    </Badge>
  )
}

/**
 * The confirmation step. A suspension asks for its reason (1 to 500
 * characters, trimmed); approve and reactivate only confirm. A refusal that
 * the dialog can fix (the reason) or retry (a failure) stays in it; a stale
 * or vanished row closes it and the page says why.
 */
function ConfirmDialog({
  pending,
  onClose,
  onDone,
  onStale,
  onNotSubmitted,
  onGone,
}: {
  pending: Pending
  onClose: () => void
  onDone: (action: Moderation, photographer: PlatformPhotographer) => void
  onStale: (photographer: PlatformPhotographer) => void
  onNotSubmitted: (photographer: PlatformPhotographer) => void
  onGone: (id: string) => void
}) {
  const { t } = useTranslation()
  const { photographer, action } = pending
  const name = photographer.displayName
  const [busy, setBusy] = useState(false)
  const [reasonError, setReasonError] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    if (action === 'suspend' && (reason === '' || reason.length > MAX_REASON)) {
      setReasonError(true)
      return
    }
    setReasonError(false)
    setFailed(false)
    setBusy(true)
    try {
      const answer =
        action === 'approve'
          ? await platformApi.approve(photographer.id)
          : action === 'suspend'
            ? await platformApi.suspend(photographer.id, reason)
            : await platformApi.reactivate(photographer.id)
      onDone(action, answer)
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      if (error instanceof ApiError && error.status === 409) {
        const now = (error.body as { photographer?: PlatformPhotographer } | null)?.photographer
        if (now !== undefined && error.message === 'not_submitted') {
          onNotSubmitted(normalisePhotographer(now))
          return
        }
        if (now !== undefined) {
          onStale(normalisePhotographer(now))
          return
        }
      }
      if (error instanceof ApiError && error.status === 404) {
        onGone(photographer.id)
        return
      }
      if (error instanceof ApiError && error.status === 422) {
        setReasonError(true)
        return
      }
      setFailed(true)
    }
  }

  const title = t(`platform:photographers.confirm.${action}Title`, { name })
  const body = t(`platform:photographers.confirm.${action}Body`)

  return (
    <FormDialog open onClose={onClose} title={title} description={body}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
        {action === 'suspend' && (
          <AdminField
            label={t('platform:photographers.confirm.reason')}
            hint={t('platform:photographers.confirm.reasonHint')}
            error={reasonError ? t('platform:photographers.confirm.reasonRequired') : null}
          >
            {(props) => <Textarea {...props} name="reason" rows={3} maxLength={MAX_REASON} required className={TEXTAREA} />}
          </AdminField>
        )}
        {failed && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:photographers.failed')}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:photographers.confirm.cancel')}
          </Button>
          <Button type="submit" variant={action === 'suspend' ? 'console-destructive-solid' : 'default'} size="console" disabled={busy}>
            {busy ? t('platform:photographers.confirm.working') : t(`platform:photographers.${action}`)}
          </Button>
        </div>
      </form>
    </FormDialog>
  )
}
