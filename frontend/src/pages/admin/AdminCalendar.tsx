import type {
  CalendarOptions,
  DatesSetArg,
  EventClickArg,
  EventContentArg,
  EventSourceFuncArg,
  FormatterInput,
} from '@fullcalendar/core'
import enGbLocale from '@fullcalendar/core/locales/en-gb'
import dayGridPlugin from '@fullcalendar/daygrid'
import luxonPlugin from '@fullcalendar/luxon3'
import FullCalendar from '@fullcalendar/react'
import timeGridPlugin from '@fullcalendar/timegrid'
import { CalendarDays, CircleAlert, Globe, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useSearchParams } from 'react-router'
import { UnauthenticatedError, adminFetch } from '@/admin/api'
import { availabilityApi, blockFormValues } from '@/admin/availability'
import { CALENDAR_VIEWS, type CalendarView, isKigaliDate, kigaliDateOf } from '@/admin/calendar-dates'
import { type CalendarData, type CalendarEntry, kigaliRangeOf, toEventInputs } from '@/admin/calendar-events'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusGlyph } from '@/components/ui/status-badge'
import { TIME_ZONE } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BlockForm } from './BlockForm'
import { PAGE } from './console/classes'
import { FormDialog } from './console/FormDialog'
import { useFitsScreen } from './console/use-fits-screen'
import { MetaItem, PageHeader } from './console/PageHeader'

/**
 * The admin calendar (plan.md Task 9, spec §3.3 step 1): bookings, live holds
 * and blocks in month, week and day views, drawn by FullCalendar.
 *
 * FullCalendar runs in Africa/Kigali through its Luxon plugin, so every time
 * and every day boundary is Kigali's whatever the browser's zone is (spec
 * §6.5). It fetches exactly the range it shows, once per range, through the
 * event source below.
 *
 * The URL records the view and date (`?view=week&date=2026-10-05`): they are
 * read once to open the calendar there, and rewritten whenever he navigates,
 * so a reload or a shared link lands on the same page.
 */

const PLUGINS = [luxonPlugin, dayGridPlugin, timeGridPlugin]

const FULLCALENDAR_VIEW: Record<CalendarView, string> = {
  month: 'dayGridMonth',
  week: 'timeGridWeek',
  day: 'timeGridDay',
}

const HEADER_TOOLBAR = {
  left: 'prev,next today',
  center: 'title',
  right: 'dayGridMonth,timeGridWeek,timeGridDay',
}

const TIME_FORMAT: FormatterInput = { hour: '2-digit', minute: '2-digit', hour12: false }

const VIEW_OPTIONS: CalendarOptions['views'] = {
  dayGridMonth: { dayHeaderFormat: { weekday: 'short' } },
  timeGridWeek: { dayHeaderFormat: { weekday: 'short', day: 'numeric', month: 'short' } },
  timeGridDay: { dayHeaderFormat: { weekday: 'long', day: 'numeric', month: 'long' } },
}

/**
 * On a screen of at least 1280x720 the calendar fills the height left under
 * the header and the page itself never scrolls (item 4, 2026-09-27): month
 * shows every week, busy days folding into "+N more", and the hourly grids
 * scroll inside themselves only. Below that size, month grows to fit its weeks
 * and the hourly grids scroll inside this fixed height. Either way they open
 * at 08:00, so the working day is in view while 01:00 stays reachable. Set
 * from the page, because FullCalendar ignores `height` given per view.
 */
const TIME_GRID_HEIGHT = 760
const SCROLL_TIME = '08:00:00'

function isView(value: string | null): value is CalendarView {
  return value !== null && (CALENDAR_VIEWS as readonly string[]).includes(value)
}

function viewOf(fullCalendarView: string): CalendarView {
  return CALENDAR_VIEWS.find((view) => FULLCALENDAR_VIEW[view] === fullCalendarView) ?? 'month'
}

export function AdminCalendar() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const calendarRef = useRef<FullCalendar>(null)
  const fits = useFitsScreen()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  // Read once, on mount. From then on FullCalendar owns navigation and the URL
  // follows it, so the two can never disagree.
  const [initial] = useState(() => {
    const view = params.get('view')
    const date = params.get('date')
    return {
      view: FULLCALENDAR_VIEW[isView(view) ? view : 'month'],
      date: date !== null && isKigaliDate(date) ? date : kigaliDateOf(new Date()),
    }
  })

  // Stable identities: a new function or object here would make FullCalendar
  // reset the option, and a new event source would refetch.
  const fetchEvents = useCallback(
    async ({ startStr, endStr }: EventSourceFuncArg) => {
      const { from, to } = kigaliRangeOf(startStr, endStr)
      try {
        const data = await adminFetch<CalendarData>(`/admin/calendar?from=${from}&to=${to}`)
        setFailed(false)
        return toEventInputs(data)
      } catch (error) {
        if (error instanceof UnauthenticatedError) navigate('/admin/login', { replace: true })
        else setFailed(true)
        throw error
      }
    },
    [navigate],
  )

  // FullCalendar reports its first dates while it mounts, before this page's
  // own effects have run -- too early to navigate. The URL is updated from an
  // effect instead.
  const [shown, setShown] = useState<string | null>(null)
  const [viewType, setViewType] = useState(initial.view)
  /** The Kigali dates the view spans, so "Block time" can open on a day in it. */
  const [span, setSpan] = useState({ from: initial.date, to: initial.date })
  const onDatesSet = useCallback(({ view }: DatesSetArg) => {
    setViewType(view.type)
    setShown(`?view=${viewOf(view.type)}&date=${view.calendar.formatIso(view.currentStart, true)}`)
    setSpan({
      from: view.calendar.formatIso(view.currentStart, true).slice(0, 10),
      to: view.calendar.formatIso(view.currentEnd, true).slice(0, 10),
    })
  }, [])

  /** Today when it is on screen, else the first day shown: the likeliest day to block. */
  const today = kigaliDateOf(new Date())
  const blockDate = today >= span.from && today < span.to ? today : span.from

  const [blocking, setBlocking] = useState(false)

  /**
   * Opening what an event stands for: a booking its own page (plan.md Task 19),
   * a block the availability page that edits it. FullCalendar puts every event
   * in the tab order once this is registered and fires it for Enter as well as
   * for a click, so both kinds lead somewhere rather than sitting focusable and
   * inert.
   */
  const onEventClick = useCallback(
    (arg: EventClickArg) => {
      arg.jsEvent.preventDefault()
      const entry = arg.event.extendedProps.entry as CalendarEntry
      navigate(entry.kind === 'booking' ? `/admin/bookings/${entry.booking.id}` : '/admin/availability')
    },
    [navigate],
  )
  useEffect(() => {
    if (shown !== null) navigate({ search: shown }, { replace: true })
  }, [shown, navigate])

  // Switching from month, FullCalendar scrolls to SCROLL_TIME while the grid is
  // still auto-height, so there is nothing to scroll; do it again once the
  // fixed height has rendered. Moving between dates re-applies it on its own.
  useEffect(() => {
    if (viewType !== FULLCALENDAR_VIEW.month) calendarRef.current?.getApi().scrollToTime(SCROLL_TIME)
  }, [viewType])

  const buttonText = useMemo(
    () => ({
      today: t('admin:calendar.today'),
      month: t('admin:calendar.views.month'),
      week: t('admin:calendar.views.week'),
      day: t('admin:calendar.views.day'),
    }),
    [t],
  )
  const buttonHints = useMemo(
    () => ({ prev: t('admin:calendar.previous'), next: t('admin:calendar.next'), today: t('admin:calendar.today') }),
    [t],
  )

  function retry() {
    setFailed(false)
    calendarRef.current?.getApi().refetchEvents()
  }

  return (
    <main
      className={cn(
        PAGE,
        'max-w-7xl',
        // Exactly the height under the 56px top bar, with a tighter rhythm, so
        // the calendar below takes the rest and nothing scrolls the page.
        fits && 'h-[calc(100dvh-3.5rem)] overflow-hidden lg:gap-6 lg:py-6',
      )}
    >
      <PageHeader
        eyebrow={t('admin:nav.label')}
        eyebrowIcon={CalendarDays}
        title={t('admin:calendar.title')}
        meta={<MetaItem icon={Globe}>{t('admin:calendar.timezoneNote')}</MetaItem>}
        actions={
          // Stays mounted while the dialog is open, so focus returns to it on close.
          <Button size="console" onClick={() => setBlocking(true)}>
            {t('admin:calendar.blockTime')}
          </Button>
        }
      />

      {/* Blocking time is most often decided while looking at the calendar, so
          the form opens here, in a dialog, rather than sending him to the
          availability page. */}
      <FormDialog open={blocking} onClose={() => setBlocking(false)} title={t('admin:availability.blocks.new')} wide>
        <BlockForm
          title={t('admin:availability.blocks.new')}
          submitLabel={t('admin:availability.create')}
          values={blockFormValues(undefined, blockDate)}
          onSave={async (payload) => {
            await availabilityApi.createBlock(payload)
            setBlocking(false)
            calendarRef.current?.getApi().refetchEvents()
          }}
          onCancel={() => setBlocking(false)}
        />
      </FormDialog>

      {/* The loading line and the failure sit close above the calendar they
          are about, not a section's gap away from it. */}
      <div className={cn('flex min-w-0 flex-col gap-4', fits && 'bookly-calendar-fit min-h-0 flex-1')} aria-busy={loading}>
        {/* The grid is the real layout from the first paint; only the events
            are awaited. A visible line here pushed the grid down on every range
            load, so the wait is announced, not shown (item 2, 2026-09-27). */}
        {loading && (
          <p className="sr-only" role="status">
            {t('admin:calendar.loading')}
          </p>
        )}
        {failed && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              <Button variant="console-outline" size="console-sm" onClick={retry}>
                {t('admin:calendar.retry')}
              </Button>
            }
          >
            <p>{t('admin:calendar.loadFailed')}</p>
          </Callout>
        )}

        <FullCalendar
          ref={calendarRef}
          plugins={PLUGINS}
          locale={enGbLocale}
          timeZone={TIME_ZONE}
          initialView={initial.view}
          initialDate={initial.date}
          views={VIEW_OPTIONS}
          headerToolbar={HEADER_TOOLBAR}
          buttonText={buttonText}
          buttonHints={buttonHints}
          allDayText={t('admin:calendar.allDay')}
          firstDay={1}
          fixedWeekCount={false}
          height={fits ? '100%' : viewType === FULLCALENDAR_VIEW.month ? 'auto' : TIME_GRID_HEIGHT}
          expandRows={fits}
          dayMaxEvents={fits}
          scrollTime={SCROLL_TIME}
          navLinks
          eventDisplay="block"
          eventTimeFormat={TIME_FORMAT}
          slotLabelFormat={TIME_FORMAT}
          events={fetchEvents}
          eventSourceFailure={ignoreFailure}
          loading={setLoading}
          datesSet={onDatesSet}
          eventClick={onEventClick}
          eventContent={fits ? renderFittedEventContent : renderEventContent}
        />
      </div>
    </main>
  )
}

/** The failure is already shown above the calendar; FullCalendar need not log it. */
function ignoreFailure() {}

function renderEventContent(arg: EventContentArg) {
  return (
    <EventContent
      entry={arg.event.extendedProps.entry as CalendarEntry}
      timeText={arg.timeText}
      view={viewOf(arg.view.type)}
    />
  )
}

/**
 * Below `sm` a month cell is about 40px wide and a week column less, too
 * narrow for words: there an event keeps its status icon (and the month its
 * start time) and the words stay for assistive tech, not hidden from it. The
 * day view has the width, so it always shows everything.
 */
const PHONE_WORDS = 'max-sm:sr-only'
const PHONE_MONTH_TIME = 'max-sm:text-[0.6875rem] max-[22.5rem]:text-[0.625rem]'

/**
 * One booking or block (design-system/bookly/admin-console.md 6.9): the start
 * time in mono, the client's name, the status as its console icon and word
 * (never colour alone: the edge FullCalendar draws is the status colour too),
 * and, when a booking overlaps a block, a conflict marker (spec §6.4). Week
 * and day views have room for the service, package and reference, or the
 * block's private reason. The event box itself -- its fill, its 3px status
 * edge and the conflict outline -- is styled by the `.bookly-event` rules in
 * `index.css`.
 */
/**
 * A month event when the calendar fits the screen (item 4): one line -- the
 * status glyph, the start and the name -- so a day of a 1280x720 month holds
 * two before folding into "+N more". The status word and a conflict stay in
 * the accessible name; the week and day views keep their full events.
 */
function renderFittedEventContent(arg: EventContentArg) {
  if (viewOf(arg.view.type) !== 'month') return renderEventContent(arg)
  return <CompactEvent entry={arg.event.extendedProps.entry as CalendarEntry} timeText={arg.timeText} />
}

function CompactEvent({ entry, timeText }: { entry: CalendarEntry; timeText: string }) {
  const { t } = useTranslation()
  const status = entry.kind === 'booking' ? entry.booking.status : 'block'
  const time = timeText !== '' ? timeText : entry.kind === 'block' && entry.block.isAllDay ? t('admin:calendar.allDay') : ''
  return (
    <div className="flex min-w-0 items-center gap-1 overflow-hidden px-1 py-0.5 text-xs leading-4" data-kind={entry.kind} data-status={status}>
      {status !== 'block' && <StatusGlyph status={status} className="size-3.5" />}
      {time !== '' && <span className="shrink-0 font-mono tabular-nums">{time}</span>}
      <span className="min-w-0 truncate font-medium">
        {entry.kind === 'booking' ? entry.booking.contactName : t(`admin:calendar.status.${status}`)}
      </span>
      {entry.kind === 'booking' && <span className="sr-only">{t(`admin:calendar.status.${status}`)}</span>}
      {entry.kind === 'booking' && entry.booking.conflictsWithBlock && (
        <span className="text-destructive ml-auto inline-flex shrink-0">
          <TriangleAlert aria-hidden="true" className="size-3.5" />
          <span className="sr-only">{t('admin:calendar.conflict')}</span>
        </span>
      )}
    </div>
  )
}

function EventContent({ entry, timeText, view }: { entry: CalendarEntry; timeText: string; view: CalendarView }) {
  const { t } = useTranslation()
  const status = entry.kind === 'booking' ? entry.booking.status : 'block'
  const time = timeText !== '' ? timeText : entry.kind === 'block' && entry.block.isAllDay ? t('admin:calendar.allDay') : ''
  const detailed = view !== 'month'
  const words = view === 'day' ? undefined : PHONE_WORDS
  // In the hourly grids an event's place already says when it is. A phone's
  // month cell keeps the start time, a size smaller so "23:30" fits at 320px.
  const phoneTime = view === 'week' ? PHONE_WORDS : view === 'month' ? PHONE_MONTH_TIME : undefined

  return (
    <div
      // Lines keep their height and the event clips what does not fit, rather
      // than the name squeezing to nothing in a short hourly event. An hour is
      // 56px in the hourly grids: time, name and status fit it exactly.
      className={cn(
        'flex h-full min-w-0 flex-col overflow-hidden px-1.5 text-xs leading-4 *:shrink-0',
        detailed ? 'py-0.5 max-sm:px-1' : 'gap-0.5 py-1 max-sm:px-0.5',
      )}
      data-kind={entry.kind}
      data-status={status}
    >
      {time !== '' && <span className={cn('font-mono tabular-nums', phoneTime)}>{time}</span>}
      {entry.kind === 'booking' && (
        <span className={cn('truncate text-[0.8125rem] font-medium', words)}>{entry.booking.contactName}</span>
      )}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        <span className="inline-flex min-w-0 items-center gap-1">
          {status !== 'block' && <StatusGlyph status={status} className="size-3.5" />}
          <span className={cn('truncate', words)}>{t(`admin:calendar.status.${status}`)}</span>
        </span>
        {entry.kind === 'booking' && entry.booking.conflictsWithBlock && (
          <span className="bg-console-danger-tint text-destructive inline-flex min-w-0 items-start gap-1 px-1 font-medium whitespace-normal">
            <TriangleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span className={words}>{t('admin:calendar.conflict')}</span>
          </span>
        )}
      </span>
      {detailed && entry.kind === 'booking' && (
        <span className={cn('text-muted-foreground wrap-break-word', phoneTime)}>
          {entry.booking.serviceName} · {entry.booking.packageName} · <span className="font-mono">{entry.booking.reference}</span>
        </span>
      )}
      {detailed && entry.kind === 'block' && entry.block.reason !== null && (
        <span className={cn('wrap-break-word', phoneTime)}>{entry.block.reason}</span>
      )}
    </div>
  )
}
