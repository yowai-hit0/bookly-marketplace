import { ChevronDown, ChevronLeft, ChevronRight, CircleAlert, CircleHelp, ClipboardList, Search, X } from 'lucide-react'
import { type FormEvent, useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { UnauthenticatedError } from '@/admin/api'
import { BOOKING_STAGES, BOOKING_STATUSES, type BookingListRow, type BookingStage, type BookingStatus, bookingsApi } from '@/admin/bookings'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusBadge, StatusGlyph } from '@/components/ui/status-badge'
import { formatDate, formatMoney, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CHECKBOX, DATA, EYEBROW, FIELD, META, PAGE, TD, TH, TR } from './console/classes'
import { PageHeader } from './console/PageHeader'
import { LoadingRegion, Line as SkeletonLine } from './console/Skeletons'
import { Toolbar, ToolbarCell } from './console/Toolbar'

/**
 * The bookings list (plan.md Task 19): filtered by stage and date, searched by
 * reference, name, email or phone, and paged by number with a total (admin
 * console fixes, item 5, 2026-09-27).
 *
 * Everything that decides what is shown lives in the URL -- the filters and
 * the page -- so a filtered page can be reloaded, bookmarked and shared with
 * himself on another device. Changing a filter goes back to page 1.
 */

/**
 * The table stacks by its own width, not the viewport's: with the sidebar, the
 * column between `lg` and about 1150px is narrower than a tablet's. Below 56rem
 * of room each booking is one block; from 56rem the columns fit. A cell, when
 * stacked, drops its padding and is indented past the row's status glyph.
 */
const CELL = '@max-[56rem]:block @max-[56rem]:p-0 @max-[56rem]:pl-9'

/** Table cells here are a step tighter than the shared `px-4`. */
const TIGHT = 'px-3 first:pl-0 last:pr-0'

const COLUMNS = ['when', 'client', 'service', 'status', 'money'] as const

type Loaded = { key: string; rows: BookingListRow[]; total: number; page: number; pageSize: number; pageCount: number }

export function AdminBookings() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const searchId = useId()

  // The list filters by display stage (2026-09-25). A link from before, with
  // `?status=`, opens on the stages that status now spans, so it still shows
  // the same bookings; the next change to the filter writes `?stage=`.
  const stages = [
    ...new Set([...params.getAll('stage').filter(isStage), ...params.getAll('status').filter(isStatus).flatMap(stagesOfStatus)]),
  ]
  const from = params.get('from') ?? ''
  const to = params.get('to') ?? ''
  const search = params.get('search') ?? ''
  const pageAsked = pageOf(params.get('page'))
  const key = `${stages.join(',')}|${from}|${to}|${search}|${pageAsked}`

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setFailed(false)
    bookingsApi
      .list({
        stages,
        ...(from === '' ? {} : { from }),
        ...(to === '' ? {} : { to }),
        ...(search === '' ? {} : { search }),
        // Page 1 is the default, so it is left out of the request, as of the URL.
        ...(pageAsked > 1 ? { page: pageAsked } : {}),
      })
      .then((answer) => {
        if (cancelled) return
        // A page past the end (a bookmarked link, a filter that narrowed) comes
        // back as the last real page: the URL is corrected to match, in place.
        if (answer.page !== pageAsked) {
          setParams(
            (current) => {
              const next = new URLSearchParams(current)
              if (answer.page <= 1) next.delete('page')
              else next.set('page', String(answer.page))
              return next
            },
            { replace: true },
          )
          return
        }
        setLoaded({ key, rows: answer.bookings, total: answer.total, page: answer.page, pageSize: answer.pageSize, pageCount: answer.pageCount })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          void navigate('/admin/login', { replace: true })
          return
        }
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
    // `stages` is rebuilt each render from the URL; `key` is its value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, navigate])

  /** A change of filter always starts again at page 1: the page param is not carried. */
  function applyFilter(next: { stages?: BookingStage[]; from?: string; to?: string; search?: string }) {
    const query = new URLSearchParams()
    for (const stage of next.stages ?? stages) query.append('stage', stage)
    for (const [name, value] of [
      ['from', next.from ?? from],
      ['to', next.to ?? to],
      ['search', next.search ?? search],
    ] as const) {
      if (value !== '') query.set(name, value)
    }
    setParams(query, { replace: true })
  }

  function goToPage(page: number) {
    const query = new URLSearchParams(params)
    if (page <= 1) query.delete('page')
    else query.set('page', String(page))
    setParams(query)
  }

  function toggleStage(stage: BookingStage) {
    applyFilter({ stages: stages.includes(stage) ? stages.filter((s) => s !== stage) : [...stages, stage] })
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    applyFilter({ search: String(new FormData(event.currentTarget).get('search') ?? '').trim() })
  }

  const current = loaded?.key === key ? loaded : null
  // While a page loads, the pager keeps the last numbers it had, so it does not jump.
  const pager = current ?? loaded
  const filtering = stages.length > 0 || from !== '' || to !== '' || search !== ''

  return (
    // Tall enough to hold the pager at the bottom of the screen even when the
    // list is short; the pager itself sticks there when the list is long.
    <main className={cn(PAGE, 'max-w-6xl pb-0 lg:min-h-[calc(100dvh-3.5rem)] lg:pb-0')}>
      {/* <PageHeader eyebrow={t('admin:nav.label')} eyebrowIcon={ClipboardList} title={t('admin:bookings.title')} /> */}
      <PageHeader
        eyebrow={t('admin:nav.label')}
        eyebrowIcon={ClipboardList}
        title={t('admin:bookings.title')}
        actions={
          filtering && (
            <Button variant="ghost" size="console-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
              <X aria-hidden="true" />
              {t('admin:bookings.filters.clear')}
            </Button>
          )
        }
      />
      <section className="flex flex-col gap-4" aria-label={t('admin:bookings.filters.label')}>
        <Toolbar>
          <ToolbarCell className="max-lg:py-2">
            <StatusFilter stages={stages} onToggle={toggleStage} onClear={() => applyFilter({ stages: [] })} />
            <StatusLegend />
          </ToolbarCell>
          <ToolbarCell className="max-lg:py-2">
            <Label htmlFor={`${searchId}from`} className={cn(EYEBROW, 'shrink-0')}>
              {t('admin:bookings.filters.from')}
            </Label>
            <Input
              id={`${searchId}from`}
              type="date"
              value={from}
              onChange={(event) => applyFilter({ from: event.target.value })}
              className={cn(FIELD, 'w-full px-1 tabular-nums lg:w-40')}
            />
          </ToolbarCell>
          <ToolbarCell className="max-lg:py-2">
            <Label htmlFor={`${searchId}to`} className={cn(EYEBROW, 'shrink-0')}>
              {t('admin:bookings.filters.to')}
            </Label>
            <Input
              id={`${searchId}to`}
              type="date"
              value={to}
              onChange={(event) => applyFilter({ to: event.target.value })}
              className={cn(FIELD, 'w-full px-1 tabular-nums lg:w-40')}
            />
          </ToolbarCell>
          <ToolbarCell grow className="max-lg:py-2">
            <form onSubmit={submitSearch} className="flex min-w-0 flex-1 items-center gap-3">
              <Search aria-hidden="true" className="text-muted-foreground size-4.5 shrink-0" />
              {/* The button beside it says "Search" too, so the field's own label is for assistive tech only. */}
              <Label htmlFor={`${searchId}search`} className="sr-only">
                {t('admin:bookings.filters.search')}
              </Label>
              <Input id={`${searchId}search`} name="search" defaultValue={search} className={cn(FIELD, 'min-w-0 flex-1 px-1')} />
              <Button type="submit" variant="console-outline" size="console-sm">
                {t('admin:bookings.filters.apply')}
              </Button>
            </form>
          </ToolbarCell>
          {/* {filtering && (
            <ToolbarCell className="max-lg:py-2">
              <Button variant="ghost" size="console-sm" onClick={() => setParams(new URLSearchParams(), { replace: true })}>
                <X aria-hidden="true" />
                {t('admin:bookings.filters.clear')}
              </Button>
            </ToolbarCell>
          )} */}
        </Toolbar>
      </section>

      {failed && (
        <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('admin:bookings.loadFailed')}
        </p>
      )}

      {/* While a page of bookings loads, only the rows are placeholders: the
          filters above and the pager below stay as they are (item 2). */}
      {current === null && !failed && (
        <LoadingRegion label={t('admin:bookings.loading')} className="@container flex flex-col">
          <div className="border-b py-3">
            <SkeletonLine w="w-full max-w-md" className="h-3" />
          </div>
          {Array.from({ length: 8 }, (_, row) => (
            <div key={row} className="flex items-start gap-3.5 border-b py-4 last:border-b-0">
              <Skeleton className="size-5.5 shrink-0 rounded-full" />
              <div className="grid flex-1 gap-2 @min-[56rem]:grid-cols-[2fr_1.5fr_1.5fr_1.3fr_1fr] @min-[56rem]:gap-6">
                <div className="flex flex-col gap-2">
                  <SkeletonLine w="w-44 max-w-full" />
                  <SkeletonLine w="w-24" className="h-3" />
                </div>
                <SkeletonLine w="w-32" />
                <div className="flex flex-col gap-2">
                  <SkeletonLine w="w-28" />
                  <SkeletonLine w="w-20" className="h-3" />
                </div>
                <Skeleton className="h-6 w-28 rounded-xs" />
                <SkeletonLine w="w-24 @min-[56rem]:ml-auto" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && current.rows.length === 0 && <p className="text-muted-foreground text-sm">{t('admin:bookings.empty')}</p>}

      {current !== null && current.rows.length > 0 && (
        // From 56rem of room a table with columns; with less, each booking
        // stacks into one block, so nothing scrolls sideways. The explicit
        // roles keep it a table for assistive tech after `display` changes
        // (Safari drops table semantics without them).
        <div className="@container">
          <table role="table" className="w-full border-collapse text-[0.9375rem]">
            <caption className="sr-only">{t('admin:bookings.title')}</caption>
            <thead role="rowgroup" className="@max-[56rem]:sr-only">
              <tr role="row" className="border-b">
                {COLUMNS.map((column) => (
                  <th key={column} role="columnheader" scope="col" className={cn(TH, TIGHT, column === 'money' && 'text-right')}>
                    {t(`admin:bookings.columns.${column}`)}
                  </th>
                ))}
                {/* The row's arrow is decoration, so its column has no header text. */}
                <td aria-hidden="true" className={cn(TIGHT, 'w-8')} />
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[56rem]:block">
              {current.rows.map((booking) => (
                <tr
                  key={booking.id}
                  role="row"
                  // The whole row is the target: one real link, stretched over
                  // it, so a click anywhere, the keyboard, a middle-click and
                  // "open in new tab" all work (item 5, 2026-09-27).
                  className={cn(
                    TR,
                    'group/row relative cursor-pointer has-[a:focus-visible]:bg-accent',
                    '@max-[56rem]:flex @max-[56rem]:flex-col @max-[56rem]:gap-2 @max-[56rem]:py-4',
                  )}
                >
                  <td role="cell" className={cn(TD, TIGHT, CELL, '@max-[56rem]:pl-0 @min-[56rem]:whitespace-nowrap')}>
                    <Link
                      to={`/admin/bookings/${booking.id}`}
                      className="absolute inset-0 z-10 rounded-xs focus-visible:-outline-offset-2!"
                    >
                      {/* The reference names the link; it is no longer a column. */}
                      <span className="sr-only">{booking.reference}</span>
                    </Link>
                    <div className="flex items-start gap-3.5">
                      <StatusGlyph status={booking.stage} className="mt-px" />
                      <div className="flex flex-col gap-1">
                        <span>{formatDate(kigaliDateOf(booking.startsAt))}</span>
                        <span className={cn(META, 'font-mono tabular-nums')}>
                          {formatTime(booking.startsAt)} – {formatTime(booking.endsAt)}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, TIGHT, CELL)}>
                    <span className="wrap-break-word">{booking.contactName}</span>
                  </td>
                  <td role="cell" className={cn(TD, TIGHT, CELL)}>
                    <div className="flex flex-col gap-1">
                      <span>{booking.serviceName}</span>
                      <span className={META}>{booking.packageName}</span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, TIGHT, CELL)}>
                    <StatusBadge status={booking.stage}>{t(`admin:bookings.stage.${booking.stage}`)}</StatusBadge>
                  </td>
                  <td role="cell" className={cn(TD, TIGHT, CELL, '@min-[56rem]:text-right')}>
                    <div className="flex flex-col gap-1 @min-[56rem]:items-end">
                      <span className={cn(DATA, 'whitespace-nowrap')}>{formatMoney(booking.grandTotalRwf)}</span>
                      {booking.outstandingRwf > 0 && (
                        <span className={META}>
                          {keepAmountWhole(
                            t('admin:bookings.outstanding', { amount: formatMoney(booking.outstandingRwf) }),
                            formatMoney(booking.outstandingRwf),
                          )}
                        </span>
                      )}
                      {booking.hasRefundDue && (
                        <span className="text-destructive text-sm">
                          {keepAmountWhole(
                            t('admin:bookings.refundDue', { amount: formatMoney(booking.refundDueRwf) }),
                            formatMoney(booking.refundDueRwf),
                          )}
                        </span>
                      )}
                    </div>
                  </td>
                  <td role="cell" aria-hidden="true" className={cn(TD, TIGHT, 'text-muted-foreground align-middle @max-[56rem]:hidden')}>
                    <ChevronRight className="group-hover/row:text-foreground size-4.5 motion-safe:transition-colors" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pager !== null && <Pager total={pager.total} page={pager.page} pageSize={pager.pageSize} pageCount={pager.pageCount} onPage={goToPage} />}
    </main>
  )
}

/**
 * "Status: All" or "Status: 3 selected", opening the ten stages as checkboxes.
 * It filters the moment a box changes, as the chips it replaced did.
 */
function StatusFilter({
  stages,
  onToggle,
  onClear,
}: {
  stages: readonly BookingStage[]
  onToggle: (stage: BookingStage) => void
  onClear: () => void
}) {
  const { t } = useTranslation()
  const idPrefix = useId()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="console-outline" size="console-sm" className="flex-1 justify-between lg:flex-none">
          {stages.length === 0 ? t('admin:bookings.statusFilter.all') : t('admin:bookings.statusFilter.some', { count: stages.length })}
          <ChevronDown aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-2">
        <ul className="flex flex-col">
          {BOOKING_STAGES.map((stage) => {
            const id = `${idPrefix}-${stage}`
            return (
              <li key={stage}>
                <label htmlFor={id} className="hover:bg-accent flex min-h-11 cursor-pointer items-center gap-3 rounded-xs px-2 lg:min-h-9">
                  <Checkbox id={id} className={CHECKBOX} checked={stages.includes(stage)} onCheckedChange={() => onToggle(stage)} />
                  <StatusGlyph status={stage} className="size-4" />
                  <span className="text-sm">{t(`admin:bookings.stage.${stage}`)}</span>
                </label>
              </li>
            )
          })}
        </ul>
        {stages.length > 0 && (
          <div className="mt-1 border-t pt-2">
            <Button variant="ghost" size="console-sm" className="w-full justify-start" onClick={onClear}>
              {t('admin:bookings.statusFilter.clear')}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * The ❔ beside the filter: every stage the photographer can meet, as its
 * badge, then what it means and what to do about it (meanings from
 * `backend/src/booking/stage.ts`, 2026-09-27). A popover, not a hover
 * tooltip, so it opens by click, tap, Enter and Space.
 */
function StatusLegend() {
  const { t } = useTranslation()
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="console-icon" aria-label={t('admin:bookings.stageLegend.label')} className="text-muted-foreground shrink-0 lg:size-8">
          <CircleHelp aria-hidden="true" className="size-4.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(32rem,calc(100dvh-8rem))] w-96 overflow-y-auto">
        <p className="mb-3 font-medium">{t('admin:bookings.stageLegend.title')}</p>
        <ul className="flex flex-col gap-3">
          {BOOKING_STAGES.map((stage) => (
            <li key={stage} className="flex flex-col items-start gap-1">
              <StatusBadge status={stage}>{t(`admin:bookings.stage.${stage}`)}</StatusBadge>
              <span className="text-muted-foreground text-pretty">
                {t(`admin:bookings.stageHelp.${stage}`)} {t(`admin:bookings.stageAction.${stage}`)}
              </span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

/**
 * "Showing 21-40 of 132" and ‹ 1 2 … 7 ›, pinned to the bottom of the screen
 * (item 5). Always there: on a single page its arrows are disabled rather than
 * gone, so the page never changes shape.
 */
function Pager({
  total,
  page,
  pageSize,
  pageCount,
  onPage,
}: {
  total: number
  page: number
  pageSize: number
  pageCount: number
  onPage: (page: number) => void
}) {
  const { t } = useTranslation()
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(page * pageSize, total)
  return (
    <nav
      aria-label={t('admin:bookings.pager.label')}
      className="bg-background sticky bottom-0 z-20 -mx-4 mt-auto flex flex-col gap-3 border-t px-4 py-3 sm:flex-row sm:items-center sm:justify-between lg:-mx-12 lg:px-12"
    >
      <p className={cn(META, 'tabular-nums')} aria-live="polite">
        {total === 0 ? t('admin:bookings.pager.showingNone') : t('admin:bookings.pager.showing', { from: first, to: last, total })}
      </p>
      <ul className="flex flex-wrap items-center gap-1">
        <li>
          <Button
            variant="console-outline"
            size="console-icon"
            className="lg:size-8"
            aria-label={t('admin:bookings.pager.previous')}
            disabled={page <= 1}
            onClick={() => onPage(page - 1)}
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
        </li>
        {pageList(page, pageCount).map((entry, index) =>
          entry === 'gap' ? (
            <li key={`gap${index}`} aria-hidden="true" className="text-muted-foreground px-1">
              …
            </li>
          ) : (
            <li key={entry}>
              <Button
                variant={entry === page ? 'default' : 'ghost'}
                size="console-icon"
                className="font-mono tabular-nums lg:size-8"
                aria-label={t('admin:bookings.pager.page', { page: entry })}
                aria-current={entry === page ? 'page' : undefined}
                onClick={() => onPage(entry)}
              >
                {entry}
              </Button>
            </li>
          ),
        )}
        <li>
          <Button
            variant="console-outline"
            size="console-icon"
            className="lg:size-8"
            aria-label={t('admin:bookings.pager.next')}
            disabled={page >= pageCount}
            onClick={() => onPage(page + 1)}
          >
            <ChevronRight aria-hidden="true" />
          </Button>
        </li>
      </ul>
    </nav>
  )
}

/** The first and last pages, the current one and its neighbours, and gaps between. */
function pageList(page: number, pageCount: number): (number | 'gap')[] {
  const wanted = new Set([1, pageCount, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pageCount))
  const sorted = [...wanted].sort((a, b) => a - b)
  const out: (number | 'gap')[] = []
  for (const n of sorted) {
    const previous = out.at(-1)
    if (typeof previous === 'number' && n - previous > 1) out.push(n - previous === 2 ? previous + 1 : 'gap')
    out.push(n)
  }
  return out
}

/** A 1-based page from the URL; anything else is page 1. */
function pageOf(value: string | null): number {
  const page = Number(value)
  return Number.isInteger(page) && page >= 1 ? page : 1
}

/**
 * A sentence with an amount in it ("30,000 RWF still to pay") that may wrap
 * between its words but never inside the amount. The text is unchanged.
 */
function keepAmountWhole(sentence: string, amount: string) {
  const at = sentence.indexOf(amount)
  if (at < 0) return sentence
  return (
    <>
      {sentence.slice(0, at)}
      <span className="whitespace-nowrap">{amount}</span>
      {sentence.slice(at + amount.length)}
    </>
  )
}

function isStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value)
}

function isStage(value: string): value is BookingStage {
  return (BOOKING_STAGES as readonly string[]).includes(value)
}

/** The stages a stored status spans, for links made before stages. */
function stagesOfStatus(status: BookingStatus): BookingStage[] {
  switch (status) {
    case 'pending_payment':
      return ['awaiting_payment']
    case 'confirmed':
      return ['confirmed', 'in_progress', 'needs_review']
    case 'completed':
      return ['completed', 'closed']
    default:
      return [status]
  }
}
