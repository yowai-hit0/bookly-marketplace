import { Check, ChevronLeft, ChevronRight, Clock, CircleAlert, TriangleAlert } from 'lucide-react'
import { type Ref, useEffect, useId, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { type KigaliDate, kigaliDateOf } from '@/admin/calendar-dates'
import {
  type DayAvailability,
  type KigaliMonth,
  addMonths,
  fetchAvailability,
  kigaliMonthOf,
  monthGrid,
} from '@/catalogue/availability'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { formatDate, formatMonth, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { panelTitle } from '@/pages/client/classes'
import { stepNumber } from './step-number'

/**
 * The public calendar and slot picker (plan.md Task 12, spec §3.1 steps 4-5;
 * restyled per design-system/bookly/client-front.md §8.3): a month of dates,
 * then the genuinely bookable starts on the chosen date for the chosen
 * package. Every start comes from the API's engine as it stands now --
 * nothing is cached, filtered or computed here.
 *
 * Choosing a start asks the API again before accepting it. Availability can
 * change between page load and click (spec §6.1): if the start is gone, the
 * visitor is told plainly that it was just taken and sees the refreshed
 * calendar, rather than carrying a dead slot into a submit that will fail.
 *
 * Changing the package re-queries the same month and keeps the same date, so a
 * longer package shows its fewer starts there; a chosen start the new package
 * cannot have is cleared, whichever month is on screen. Leaving a package or
 * month abandons any check still running for it, and a check that stalls is
 * reported as failed.
 *
 * Keyboard: the month buttons, every bookable date and every start are native
 * buttons in reading order. A date with nothing bookable is disabled, so Tab
 * skips it.
 */

/** What the page can tell the picker. */
export type SlotPickerHandle = {
  /**
   * The API refused `start` when the booking was submitted (spec §6.1, plan.md
   * Task 13): clear it, say plainly it was just taken, and refresh the calendar
   * on its date -- the same state a click on a vanished start produces.
   */
  reportTaken: (start: string) => void
}

type Props = {
  packageId: string
  durationMinutes: number
  /** The chosen start, an ISO-8601 UTC instant, or null. */
  value: string | null
  onChange: (start: string | null) => void
  ref?: Ref<SlotPickerHandle>
}

/** One month's load for one package. `days` is null when it failed. */
type Loaded = { key: string; days: DayAvailability[] | null }

type Notice = 'taken' | 'checkFailed' | null

const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const MS_PER_MINUTE = 60_000
/** A check that has not answered by now is reported as failed rather than left
 *  spinning on a stalled mobile connection. A developer default. */
const CHECK_TIMEOUT_MS = 15_000

export function SlotPicker({ packageId, durationMinutes, value, onChange, ref }: Props) {
  const { t } = useTranslation()
  const headingId = useId()
  const monthLabelId = useId()
  const currentMonth = kigaliMonthOf(new Date())
  const today = kigaliDateOf(new Date())

  const [month, setMonth] = useState<KigaliMonth>(() => (value === null ? currentMonth : kigaliMonthOf(value)))
  const [selectedDate, setSelectedDate] = useState<KigaliDate | null>(() => (value === null ? null : kigaliDateOf(value)))
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  /** The start being checked, and for which package and month. */
  const [checking, setChecking] = useState<{ key: string; start: string } | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  /** Bumped on every "just taken", so a second one moves focus again. */
  const [takenCount, setTakenCount] = useState(0)
  const noticeRef = useRef<HTMLDivElement>(null)

  const key = `${packageId}|${month}`
  const checkingStart = checking?.key === key ? checking.start : null
  /** The check in flight. Leaving its package or month aborts and forgets it. */
  const check = useRef<AbortController | null>(null)
  /** The package `value` was last confirmed free for. */
  const confirmedFor = useRef(value === null ? null : packageId)

  useEffect(
    () => () => {
      check.current?.abort()
      check.current = null
    },
    [key],
  )

  useEffect(() => {
    const controller = new AbortController()
    fetchAvailability(packageId, month, controller.signal)
      .then((days) => !controller.signal.aborted && setLoaded({ key, days }))
      .catch(() => !controller.signal.aborted && setLoaded({ key, days: null }))
    return () => controller.abort()
  }, [packageId, month, key, attempt])

  const current = loaded?.key === key ? loaded : null
  const days = current?.days ?? null

  // A chosen start this package no longer offers -- another package, or a
  // fresh load without it -- is not a choice any more. In the month on screen,
  // the load that is already there answers.
  useEffect(() => {
    if (value === null || days === null || kigaliMonthOf(value) !== month) return
    if (days.some((day) => day.starts.includes(value))) confirmedFor.current = packageId
    else onChange(null)
  }, [days, value, month, packageId, onChange])

  // A chosen start in another month -- the visitor browsed on, then changed package --
  // has to be asked about for the new package on its own. If it cannot be
  // confirmed, it is dropped rather than carried into a booking.
  useEffect(() => {
    if (value === null || kigaliMonthOf(value) === month || confirmedFor.current === packageId) return
    const controller = new AbortController()
    fetchAvailability(packageId, kigaliMonthOf(value), controller.signal)
      .then((fresh) => {
        if (controller.signal.aborted) return
        if (fresh.some((day) => day.starts.includes(value))) confirmedFor.current = packageId
        else onChange(null)
      })
      .catch(() => !controller.signal.aborted && onChange(null))
    return () => controller.abort()
  }, [value, month, packageId, onChange])

  // The start just chosen has vanished from the page; put focus on the reason.
  useEffect(() => {
    if (notice === 'taken') noticeRef.current?.focus()
  }, [notice, takenCount])

  function announceTaken() {
    setNotice('taken')
    setTakenCount((n) => n + 1)
  }

  useImperativeHandle(
    ref,
    () => ({
      reportTaken(start: string) {
        onChange(null)
        confirmedFor.current = null
        setSelectedDate(kigaliDateOf(start))
        announceTaken()
        const startMonth = kigaliMonthOf(start)
        // Reload the start's month: the month shown refetches, another one loads.
        if (startMonth === month) setAttempt((n) => n + 1)
        else setMonth(startMonth)
      },
    }),
    [month, onChange],
  )

  function showMonth(next: KigaliMonth) {
    setNotice(null)
    setMonth(next)
  }

  function retry() {
    setLoaded(null)
    setAttempt((n) => n + 1)
  }

  async function choose(start: string) {
    // One check at a time for what is on screen. A check still running for a
    // package or month the visitor has left was aborted, and blocks nothing.
    if (checkingStart !== null) return
    const requestKey = key
    const controller = new AbortController()
    check.current = controller
    const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
    setNotice(null)
    setChecking({ key: requestKey, start })
    try {
      const fresh = await fetchAvailability(packageId, month, controller.signal)
      if (check.current !== controller) return
      setLoaded({ key: requestKey, days: fresh })
      if (fresh.some((day) => day.starts.includes(start))) {
        confirmedFor.current = packageId
        onChange(start)
      } else {
        onChange(null)
        announceTaken()
      }
    } catch {
      // Still the current check: it failed or timed out, so say so. Superseded
      // by another package or month: there is nothing to say.
      if (check.current === controller) setNotice('checkFailed')
    } finally {
      clearTimeout(timeout)
      if (check.current === controller) check.current = null
      setChecking((current) => (current?.key === requestKey && current.start === start ? null : current))
    }
  }

  const startsByDate = new Map((days ?? []).map((day) => [day.date, day.starts]))
  const dateShown = selectedDate?.startsWith(`${month}-`) ? selectedDate : null
  const startsShown = dateShown === null ? [] : (startsByDate.get(dateShown) ?? [])
  const monthIsEmpty = days !== null && days.every((day) => day.starts.length === 0)

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id={headingId} className={cn(panelTitle, stepNumber)}>
          {t('services:picker.title')}
        </h2>
        {/* An existing string, read by slot-picker.spec.ts page-wide: never duplicated elsewhere on this page. */}
        <p className="text-subtle-foreground text-sm">{t('services:picker.timezone')}</p>
      </div>

      <div className="bg-background flex flex-col gap-4 rounded-xs border p-4">
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label={t('services:picker.previousMonth')}
            disabled={month <= currentMonth}
            onClick={() => showMonth(addMonths(month, -1))}
          >
            <ChevronLeft />
          </Button>
          <h3 id={monthLabelId} className="font-medium" aria-live="polite">
            {formatMonth(month)}
          </h3>
          <Button
            type="button"
            variant="outline"
            size="icon-lg"
            aria-label={t('services:picker.nextMonth')}
            onClick={() => showMonth(addMonths(month, 1))}
          >
            <ChevronRight />
          </Button>
        </div>

        <div role="group" aria-labelledby={monthLabelId} aria-busy={current === null} className="grid grid-cols-7 gap-1.5">
          {WEEKDAYS.map((weekday) => (
            <span
              key={weekday}
              aria-hidden="true"
              className="text-muted-foreground pb-1 text-center font-mono text-xs tracking-wider uppercase"
            >
              {t(`services:picker.weekdays.${weekday}`)}
            </span>
          ))}
          {monthGrid(month).map((date, index) => {
            if (date === null) return <span key={`blank-${index}`} aria-hidden="true" />
            const count = startsByDate.get(date)?.length ?? 0
            const isShown = date === dateShown
            const isToday = date === today
            return (
              <button
                key={date}
                type="button"
                disabled={count === 0}
                aria-pressed={isShown}
                aria-label={
                  count === 0
                    ? t('services:picker.dayUnavailable', { date: formatDate(date) })
                    : t('services:picker.dayAvailable', { date: formatDate(date), count })
                }
                onClick={() => {
                  setNotice(null)
                  setSelectedDate(date)
                }}
                // Bookable dates differ from the rest by weight and by edge, not by colour alone.
                className={cn(
                  'flex h-11 flex-col items-center justify-center gap-1 border font-mono text-sm tabular-nums motion-safe:transition-colors motion-safe:duration-150',
                  count === 0
                    ? 'text-muted-foreground/60 cursor-not-allowed border-transparent'
                    : 'hover:border-input border-border font-medium',
                  isShown && 'bg-primary text-primary-foreground border-primary motion-safe:animate-pop',
                )}
              >
                <span className={cn(isToday && 'decoration-ring underline decoration-2 underline-offset-[3px]')}>
                  {Number(date.slice(8))}
                </span>
                {/* Open (aria-hidden pip, the word "count" already carries meaning in the label). */}
                {count > 0 && (
                  <span aria-hidden="true" className={cn('size-1 rounded-full', isShown ? 'bg-band-accent dark:bg-brand' : 'bg-brand')} />
                )}
              </button>
            )
          })}
        </div>

        <div className="text-muted-foreground flex flex-wrap gap-5 text-[0.8125rem]">
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="border-input size-3 border" />
            {t('services:picker.legendOpen')}
          </span>
          <span className="flex items-center gap-2">
            <span aria-hidden="true" className="bg-primary size-3" />
            {t('services:picker.legendSelected')}
          </span>
        </div>

        {current === null && (
          <p className="text-subtle-foreground text-sm" role="status">
            {t('services:picker.loading')}
          </p>
        )}
        {current !== null && days === null && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              <Button type="button" variant="outline" size="sm" onClick={retry}>
                {t('services:picker.retry')}
              </Button>
            }
          >
            <p>{t('services:picker.loadFailed')}</p>
          </Callout>
        )}
        {monthIsEmpty && (
          <p className="text-subtle-foreground text-sm">{t('services:picker.noTimesThisMonth', { month: formatMonth(month) })}</p>
        )}
      </div>

      {notice !== null && (
        <div ref={noticeRef} tabIndex={-1} role="alert" className="outline-none">
          <Callout
            variant="console"
            tone={notice === 'taken' ? 'warning' : 'destructive'}
            icon={notice === 'taken' ? TriangleAlert : CircleAlert}
          >
            <p className="font-medium">{t(notice === 'taken' ? 'services:picker.justTaken' : 'services:picker.checkFailed')}</p>
          </Callout>
        </div>
      )}

      {dateShown !== null && days !== null && (
        <div className="flex flex-col gap-3">
          <h3 className="font-medium">{t('services:picker.timesFor', { date: formatDate(dateShown) })}</h3>
          {startsShown.length === 0 ? (
            <p className="text-subtle-foreground text-sm">{t('services:picker.noTimesLeft')}</p>
          ) : (
            <ul className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {startsShown.map((start, index) => (
                <li key={start}>
                  <Button
                    type="button"
                    variant={start === value ? 'default' : 'outline'}
                    style={{ animationDelay: `${index * 50}ms` }}
                    className={cn(
                      'h-13 w-full justify-start font-mono text-base tabular-nums motion-safe:animate-rise',
                      start === value
                        ? 'bg-brand hover:bg-brand-hover border-brand text-brand-foreground motion-safe:animate-pop'
                        : 'hover:border-brand hover:text-console-link',
                    )}
                    aria-pressed={start === value}
                    // Not `disabled`: a disabled button drops keyboard focus mid-check.
                    aria-busy={start === checkingStart}
                    onClick={() => void choose(start)}
                  >
                    {formatTime(start)}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {checkingStart !== null && (
        <p className="text-subtle-foreground flex items-center gap-2 text-sm" role="status">
          <Clock aria-hidden="true" className="size-4" />
          {t('services:picker.checking')}
        </p>
      )}
      {value !== null && checkingStart === null && (
        <Callout variant="console" tone="success" icon={Check} role="status">
          <p className="font-medium">
            {t('services:picker.selected', {
              date: formatDate(kigaliDateOf(value)),
              start: formatTime(value),
              end: formatTime(new Date(Date.parse(value) + durationMinutes * MS_PER_MINUTE)),
            })}
          </p>
        </Callout>
      )}
    </section>
  )
}
