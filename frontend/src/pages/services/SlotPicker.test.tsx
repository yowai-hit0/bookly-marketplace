import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type RefObject, createRef, useCallback, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { DayAvailability } from '@/catalogue/availability'
import { SlotPicker, type SlotPickerHandle } from './SlotPicker'

/**
 * The public calendar and slot picker (plan.md Task 12; spec §3.1 steps 4-5,
 * §6.1, §6.5), rendered with `fetch` stubbed and the clock pinned.
 *
 * What is proven: the picker asks for the Kigali month of now, whatever the UTC
 * or browser month; a date is a button only when it has starts, and says how
 * many; the previous month is out of reach from the current one; a date lists
 * its starts in Kigali time; choosing a start asks the API again, so a start
 * taken since the page loaded ends in a focused "just taken" alert over a
 * refreshed calendar rather than a selection; a failed check selects nothing;
 * a failed load can be retried; a longer package re-queries the same month and
 * keeps the date; a response for a package or month no longer shown changes
 * nothing; a double click checks once; and the whole picker works by keyboard.
 *
 * The clock is 30 September 2026, 22:30 UTC: already Thursday 1 October,
 * 00:30, in Kigali.
 */

const NOW = new Date('2026-09-30T22:30:00Z')

const JUST_TAKEN = 'Sorry, that time was just taken. The calendar has been refreshed, so please choose another time.'
const CHECK_FAILED = 'Could not confirm that time is still free. Check your connection and try again.'
const LOAD_FAILED = 'Could not load available times.'
const CHECKING = 'Checking that time is still free…'
const LOADING = 'Loading available times…'

// --- Fixtures ---------------------------------------------------------------

/** A Kigali wall-clock time on `date`, as the ISO instant the API sends. */
function at(date: string, wallTime: string): string {
  return new Date(`${date}T${wallTime}:00+02:00`).toISOString()
}

/** Every date of `month`, with the given Kigali start times and none elsewhere. */
function monthDays(month: string, times: Record<string, string[]> = {}): DayAvailability[] {
  const [year, monthNumber] = month.split('-').map(Number) as [number, number]
  const length = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return Array.from({ length }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`
    return { date, starts: (times[date] ?? []).map((time) => at(date, time)) }
  })
}

/** The 60-minute package in October: four starts on Wednesday 7th, one on Thursday 8th. */
const OCTOBER_SHORT = monthDays('2026-10', {
  '2026-10-07': ['09:00', '09:30', '10:00', '14:00'],
  '2026-10-08': ['11:00'],
})

/** The 180-minute package in October: fewer starts on the same Wednesday, none on Thursday. */
const OCTOBER_LONG = monthDays('2026-10', { '2026-10-07': ['09:00', '14:00'] })

const NOVEMBER_SHORT = monthDays('2026-11', { '2026-11-02': ['10:00', '10:30'] })

const WEDNESDAY = 'Wednesday, 7 October 2026'
const THURSDAY = 'Thursday, 8 October 2026'

type Reply = DayAvailability[] | (() => Response | Promise<Response>)
type Sent = { path: string; packageId: string | null; month: string | null; cache: RequestCache | undefined }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A `fetch` for `/api/availability`. Each `packageId|month` answers its replies
 * in turn, repeating the last; a key with no replies is an empty month.
 */
function stubApi(replies: Record<string, Reply[]> = {}) {
  const sent: Sent[] = []
  const counts = new Map<string, number>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      const packageId = url.searchParams.get('packageId')
      const month = url.searchParams.get('month')
      sent.push({ path: url.pathname, packageId, month, cache: init?.cache })
      const key = `${packageId}|${month}`
      const queue = replies[key] ?? [monthDays(month ?? '2026-10')]
      const index = counts.get(key) ?? 0
      counts.set(key, index + 1)
      const reply = queue[Math.min(index, queue.length - 1)] ?? []
      return typeof reply === 'function' ? reply() : json({ days: reply })
    }),
  )
  return sent
}

/** A response the test answers when it chooses to. */
function deferred() {
  let resolve: (res: Response) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<Response>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type HarnessProps = {
  packageId: string
  durationMinutes: number
  initialValue?: string | null
  onChange: (start: string | null) => void
}

/** Holds the chosen start the way ServiceDetail does: a stable setter, fed back as `value`. */
function Harness({ packageId, durationMinutes, initialValue = null, onChange }: HarnessProps) {
  const [value, setValue] = useState<string | null>(initialValue)
  const handleChange = useCallback(
    (start: string | null) => {
      onChange(start)
      setValue(start)
    },
    [onChange],
  )
  return <SlotPicker packageId={packageId} durationMinutes={durationMinutes} value={value} onChange={handleChange} />
}

function renderPicker(props: Partial<Omit<HarnessProps, 'onChange'>> = {}) {
  const onChange = vi.fn<(start: string | null) => void>()
  const initial = { packageId: 'p1', durationMinutes: 60, ...props }
  const view = render(<Harness {...initial} onChange={onChange} />)
  return {
    onChange,
    rerender: (next: Partial<Omit<HarnessProps, 'onChange' | 'initialValue'>>) =>
      view.rerender(<Harness {...initial} {...next} onChange={onChange} />),
  }
}

function user() {
  return userEvent.setup({ delay: null })
}

function dayButton(name: string | RegExp): HTMLElement {
  return screen.getByRole('button', { name })
}

/** Waits for a month to finish loading, then returns its label. */
async function loadedMonth(label: string): Promise<HTMLElement> {
  const group = await screen.findByRole('group', { name: label })
  await waitFor(() => expect(group).toHaveAttribute('aria-busy', 'false'))
  return group
}

/** The start times listed for the shown date, as rendered. */
function listedTimes(): string[] {
  const list = screen.queryByRole('list')
  return list === null ? [] : within(list).getAllByRole('button').map((button) => button.textContent ?? '')
}

function selectedText(): string | null {
  return screen.queryByText(/^Selected:/)?.textContent ?? null
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// --- Which month -----------------------------------------------------------------------

describe('the month the picker opens on', () => {
  it('requests the Kigali month of now, not the UTC or the browser’s month', async () => {
    const original = process.env.TZ
    process.env.TZ = 'America/New_York'
    try {
      // Not vacuous: UTC and New York both still read September.
      expect([new Date().getUTCMonth(), new Date().getMonth()]).toEqual([8, 8])

      const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
      renderPicker()

      await loadedMonth('October 2026')
      expect(sent).toEqual([{ path: '/api/availability', packageId: 'p1', month: '2026-10', cache: 'no-store' }])
      expect(screen.getByRole('heading', { level: 3, name: 'October 2026' })).toBeInTheDocument()
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })

  it('opens on the month of a start already chosen, with that date and start shown', async () => {
    const sent = stubApi({ 'p1|2026-11': [NOVEMBER_SHORT] })
    renderPicker({ initialValue: at('2026-11-02', '10:30') })

    await loadedMonth('November 2026')

    expect(sent.map(({ month }) => month)).toEqual(['2026-11'])
    expect(dayButton(/^Monday, 2 November 2026/)).toHaveAttribute('aria-pressed', 'true')
    expect(listedTimes()).toEqual(['10:00', '10:30'])
    expect(screen.getByRole('button', { name: '10:30' })).toHaveAttribute('aria-pressed', 'true')
    expect(selectedText()).toBe('Selected: Monday, 2 November 2026, 10:30 to 11:30, Kigali time')
  })
})

// --- The calendar ---------------------------------------------------------------------------

describe('the calendar', () => {
  it('shows loading, then a button per date: enabled with its count where there are starts, disabled otherwise', async () => {
    let answer: (res: Response) => void = () => {}
    stubApi({ 'p1|2026-10': [() => new Promise<Response>((resolve) => (answer = resolve))] })
    renderPicker()

    expect(screen.getByRole('region', { name: 'Choose a date and time' })).toBeInTheDocument()
    expect(screen.getByText('All times are Kigali time (UTC+2).')).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(LOADING)
    const group = screen.getByRole('group', { name: 'October 2026' })
    expect(group).toHaveAttribute('aria-busy', 'true')
    // Nothing is offered before the API has spoken.
    expect(within(group).getAllByRole('button').every((button) => button.hasAttribute('disabled'))).toBe(true)

    answer(json({ days: OCTOBER_SHORT }))
    await loadedMonth('October 2026')

    expect(screen.queryByText(LOADING)).not.toBeInTheDocument()
    const days = within(group).getAllByRole('button')
    expect(days).toHaveLength(31)
    expect(days.map((button) => button.textContent)).toEqual(Array.from({ length: 31 }, (_, index) => String(index + 1)))
    expect(days.filter((button) => !button.hasAttribute('disabled')).map((button) => button.getAttribute('aria-label'))).toEqual([
      `${WEDNESDAY}, 4 times available`,
      `${THURSDAY}, 1 time available`,
    ])
    expect(dayButton('Friday, 9 October 2026, no times available')).toBeDisabled()
    expect(dayButton('Thursday, 1 October 2026, no times available')).toBeDisabled()
    for (const button of days) expect(button).toHaveAttribute('aria-pressed', 'false')
    // No date is chosen yet, so no times are listed.
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
  })

  it('heads the grid with Monday-first weekdays hidden from assistive technology, and pads before the 1st', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    renderPicker()
    const group = await loadedMonth('October 2026')

    const cells = Array.from(group.children)
    expect(cells.slice(0, 7).map((cell) => [cell.textContent, cell.getAttribute('aria-hidden')])).toEqual(
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((weekday) => [weekday, 'true']),
    )
    // 1 October 2026 is a Thursday: three blanks under Mon, Tue and Wed.
    expect(cells.slice(7, 10).map((cell) => [cell.tagName, cell.textContent, cell.getAttribute('aria-hidden')])).toEqual([
      ['SPAN', '', 'true'],
      ['SPAN', '', 'true'],
      ['SPAN', '', 'true'],
    ])
    expect(cells[10]).toHaveAccessibleName(/^Thursday, 1 October 2026/)
  })

  it('disables the previous month at the current month, and moves between months with a request each', async () => {
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p1|2026-11': [NOVEMBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled()

    await u.click(screen.getByRole('button', { name: 'Next month' }))

    await loadedMonth('November 2026')
    expect(dayButton('Monday, 2 November 2026, 2 times available')).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeEnabled()

    await u.click(screen.getByRole('button', { name: 'Previous month' }))

    await loadedMonth('October 2026')
    expect(screen.getByRole('button', { name: 'Previous month' })).toBeDisabled()
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toBeEnabled()
    // Nothing is remembered: October is asked for again.
    expect(sent.map(({ packageId, month }) => `${packageId}|${month}`)).toEqual(['p1|2026-10', 'p1|2026-11', 'p1|2026-10'])
    expect(sent.every(({ cache }) => cache === 'no-store')).toBe(true)
  })

  it('crosses a year end going forward', async () => {
    const sent = stubApi()
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    for (const label of ['November 2026', 'December 2026', 'January 2027']) {
      await u.click(screen.getByRole('button', { name: 'Next month' }))
      await loadedMonth(label)
    }

    expect(sent.map(({ month }) => month)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01'])
  })

  it('says so when the month has no times at all, and not once a month with times is shown', async () => {
    stubApi({ 'p1|2026-10': [monthDays('2026-10')], 'p1|2026-11': [NOVEMBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')

    expect(screen.getByText('No times are available in October 2026. Try the next month.')).toBeInTheDocument()

    await user().click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')

    expect(screen.queryByText(/No times are available in/)).not.toBeInTheDocument()
  })

  it('does not claim the month is empty while it is still loading or failed', async () => {
    stubApi({ 'p1|2026-10': [() => json({ error: 'internal_error' }, 500)] })
    renderPicker()

    expect(screen.queryByText(/No times are available in/)).not.toBeInTheDocument()
    await screen.findByRole('alert')
    expect(screen.queryByText(/No times are available in/)).not.toBeInTheDocument()
  })
})

// --- Loading failures ------------------------------------------------------------------------

describe('a failed load', () => {
  it.each<[string, () => Response | Promise<Response>]>([
    ['the API fails', () => json({ error: 'internal_error' }, 500)],
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows an alert when %s, offers no date, and loads again on "Try again"', async (_label, failure) => {
    const sent = stubApi({ 'p1|2026-10': [failure, OCTOBER_SHORT] })
    renderPicker()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(LOAD_FAILED)
    expect(within(screen.getByRole('group', { name: 'October 2026' })).getAllByRole('button').every((b) => b.hasAttribute('disabled'))).toBe(true)

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    await loadedMonth('October 2026')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toBeEnabled()
    expect(sent.map(({ month }) => month)).toEqual(['2026-10', '2026-10'])
  })
})

// --- Choosing a date and a start ---------------------------------------------------------------

describe('choosing a date', () => {
  it('lists the date’s starts in Kigali time and marks the date as shown', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    expect(screen.getByRole('heading', { level: 3, name: `Start times on ${WEDNESDAY}` })).toBeInTheDocument()
    expect(listedTimes()).toEqual(['09:00', '09:30', '10:00', '14:00'])
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toHaveAttribute('aria-pressed', 'true')
    for (const time of listedTimes()) expect(screen.getByRole('button', { name: time })).toHaveAttribute('aria-pressed', 'false')

    await u.click(dayButton(`${THURSDAY}, 1 time available`))

    expect(listedTimes()).toEqual(['11:00'])
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toHaveAttribute('aria-pressed', 'false')
    expect(dayButton(`${THURSDAY}, 1 time available`)).toHaveAttribute('aria-pressed', 'true')
  })

  it('does not act on a disabled date', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')

    await user().click(dayButton('Friday, 9 October 2026, no times available'))

    expect(screen.queryByRole('heading', { name: /^Start times on/ })).not.toBeInTheDocument()
  })

  it('hides the date’s times on another month, and shows them again on return', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p1|2026-11': [NOVEMBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')

    expect(screen.queryByRole('list')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Previous month' }))
    await loadedMonth('October 2026')

    expect(listedTimes()).toEqual(['09:00', '09:30', '10:00', '14:00'])
  })
})

describe('choosing a start that is still free', () => {
  it('asks the API again, then selects it and says its Kigali start and end', async () => {
    const check = deferred()
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => check.promise] })
    const { onChange } = renderPicker({ durationMinutes: 90 })
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: '09:30' }))

    // Not selected until the API confirms it.
    expect(screen.getByText(CHECKING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '09:30' })).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: '09:30' })).toBeEnabled()
    expect(onChange).not.toHaveBeenCalled()
    expect(sent.map(({ packageId, month, cache }) => [packageId, month, cache])).toEqual([
      ['p1', '2026-10', 'no-store'],
      ['p1', '2026-10', 'no-store'],
    ])

    await act(async () => check.resolve(json({ days: OCTOBER_SHORT })))

    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:30')]])
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:30 to 11:00, Kigali time`)
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '09:30' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '09:30' })).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('button', { name: '09:00' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the fresh calendar the check brought back, even when the start survived', async () => {
    const fresh = monthDays('2026-10', { '2026-10-07': ['09:30'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, fresh] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: '09:30' }))

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(at('2026-10-07', '09:30')))
    expect(listedTimes()).toEqual(['09:30'])
    expect(dayButton(`${WEDNESDAY}, 1 time available`)).toBeEnabled()
    expect(dayButton(`${THURSDAY}, no times available`)).toBeDisabled()
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:30 to 10:30, Kigali time`)
  })

  it('moves the selection when another start is chosen', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: '09:00' }))
    await waitFor(() => expect(selectedText()).toContain('09:00 to 10:00'))
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await waitFor(() => expect(selectedText()).toContain('14:00 to 15:00'))

    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:00')], [at('2026-10-07', '14:00')]])
    expect(screen.getByRole('button', { name: '09:00' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: '14:00' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps the chosen start while the visitor looks at another month', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p1|2026-11': [NOVEMBER_SHORT] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '10:00' }))
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))

    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')

    expect(onChange).toHaveBeenCalledTimes(1)
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 10:00 to 11:00, Kigali time`)
  })
})

// --- Just taken (spec §6.1, client half) ---------------------------------------------------------

describe('choosing a start taken since the calendar loaded', () => {
  it('selects nothing, says it was just taken with focus on the message, and shows the refreshed times', async () => {
    const taken = monthDays('2026-10', {
      '2026-10-07': ['09:00', '10:00', '14:00'],
      '2026-10-08': ['11:00'],
    })
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, taken] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: '09:30' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    // The taken start never reached the form, and nothing is selected.
    expect(onChange.mock.calls).toEqual([[null]])
    expect(selectedText()).toBeNull()
    // The calendar is the fresh one: 09:30 is gone and the count followed.
    expect(listedTimes()).toEqual(['09:00', '10:00', '14:00'])
    expect(dayButton(`${WEDNESDAY}, 3 times available`)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument()
    expect(sent).toHaveLength(2)
  })

  it('clears a start chosen earlier too, since the visitor was moving off it', async () => {
    const taken = monthDays('2026-10', { '2026-10-07': ['09:00', '10:00'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, OCTOBER_SHORT, taken] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:00' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())

    await u.click(screen.getByRole('button', { name: '14:00' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(JUST_TAKEN)
    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:00')], [null]])
    expect(selectedText()).toBeNull()
    expect(screen.getByRole('button', { name: '09:00' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('says no times are left when the taken start was the day’s last, and disables the day', async () => {
    const taken = monthDays('2026-10', { '2026-10-07': ['09:00', '09:30', '10:00', '14:00'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, taken] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${THURSDAY}, 1 time available`))

    await u.click(screen.getByRole('button', { name: '11:00' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(screen.getByText('No times are left on this day. Choose another date.')).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(dayButton(`${THURSDAY}, no times available`)).toBeDisabled()
    expect(onChange.mock.calls).toEqual([[null]])
  })

  it('clears the message once the visitor chooses another date or month', async () => {
    const taken = monthDays('2026-10', { '2026-10-07': ['09:00'], '2026-10-08': ['11:00'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, taken] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await screen.findByRole('alert')

    await u.click(dayButton(`${THURSDAY}, 1 time available`))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(listedTimes()).toEqual(['11:00'])
  })

  it('lets the visitor choose one of the refreshed times straight away', async () => {
    const taken = monthDays('2026-10', { '2026-10-07': ['09:00', '10:00'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, taken] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))
    await screen.findByRole('alert')

    await u.click(screen.getByRole('button', { name: '10:00' }))

    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 10:00 to 11:00, Kigali time`))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onChange.mock.calls).toEqual([[null], [at('2026-10-07', '10:00')]])
  })
})

describe('a check that cannot reach the API', () => {
  it.each<[string, () => Response | Promise<Response>]>([
    ['the network is down', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['the API fails', () => json({ error: 'internal_error' }, 500)],
  ])('selects nothing and says the time could not be confirmed when %s', async (_label, failure) => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, failure, OCTOBER_SHORT] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.click(screen.getByRole('button', { name: '09:30' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(CHECK_FAILED)
    expect(screen.queryByText(JUST_TAKEN)).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(selectedText()).toBeNull()
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument()
    // The calendar it had is still there to try again from.
    expect(listedTimes()).toEqual(['09:00', '09:30', '10:00', '14:00'])

    await u.click(screen.getByRole('button', { name: '09:30' }))

    await waitFor(() => expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:30')]]))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

describe('a double click while a check is running', () => {
  it('checks once and selects once', async () => {
    const check = deferred()
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => check.promise] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))

    await u.dblClick(screen.getByRole('button', { name: '09:30' }))
    // A different start during the check is not a second check either.
    await u.click(screen.getByRole('button', { name: '14:00' }))

    expect(sent).toHaveLength(2)

    await act(async () => check.resolve(json({ days: OCTOBER_SHORT })))

    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:30')]])
    expect(sent).toHaveLength(2)
  })
})

// --- Changing the package -------------------------------------------------------------------------

describe('changing the package', () => {
  it('re-queries the same month, keeps the date, lists fewer starts, and clears a start it does not offer', async () => {
    const sent = stubApi({
      'p1|2026-10': [OCTOBER_SHORT],
      'p1|2026-11': [NOVEMBER_SHORT],
      'p2|2026-11': [monthDays('2026-11', { '2026-11-02': ['10:00'] })],
    })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')
    await u.click(dayButton('Monday, 2 November 2026, 2 times available'))
    await u.click(screen.getByRole('button', { name: '10:30' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())

    rerender({ packageId: 'p2', durationMinutes: 180 })

    await waitFor(() => expect(sent.at(-1)).toMatchObject({ packageId: 'p2', month: '2026-11' }))
    await loadedMonth('November 2026')
    expect(screen.getByRole('heading', { level: 3, name: 'Start times on Monday, 2 November 2026' })).toBeInTheDocument()
    expect(dayButton('Monday, 2 November 2026, 1 time available')).toHaveAttribute('aria-pressed', 'true')
    expect(listedTimes()).toEqual(['10:00'])
    await waitFor(() => expect(onChange.mock.calls).toEqual([[at('2026-11-02', '10:30')], [null]]))
    expect(selectedText()).toBeNull()
    // Same month, not back to the current one.
    expect(sent.map(({ packageId, month }) => `${packageId}|${month}`)).toEqual([
      'p1|2026-10',
      'p1|2026-11',
      'p1|2026-11',
      'p2|2026-11',
    ])
  })

  it('keeps a start the new package still offers, and ends it at the new duration', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p2|2026-10': [OCTOBER_LONG] })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:00' }))
    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:00 to 10:00, Kigali time`))

    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '14:00']))

    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:00')]])
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:00 to 12:00, Kigali time`)
    expect(dayButton(`${THURSDAY}, no times available`)).toBeDisabled()
  })

  it('clears a start the new package does not offer even when the visitor is looking at another month', async () => {
    const sent = stubApi({
      'p1|2026-10': [OCTOBER_SHORT],
      'p1|2026-11': [NOVEMBER_SHORT],
      'p2|2026-10': [OCTOBER_LONG],
      'p2|2026-11': [NOVEMBER_SHORT],
    })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '10:00' }))
    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 10:00 to 11:00, Kigali time`))
    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')

    // The 180-minute package has no 10:00 on the 7th (OCTOBER_LONG).
    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ packageId: 'p2', month: '2026-11' })))
    await loadedMonth('November 2026')

    // A start the chosen package cannot have must not survive to the booking form.
    await waitFor(() => expect(onChange.mock.calls).toEqual([[at('2026-10-07', '10:00')], [null]]))
    expect(selectedText()).toBeNull()
    // Answered by asking about the start's own month for the new package, not by guessing.
    expect(sent).toContainEqual(expect.objectContaining({ packageId: 'p2', month: '2026-10' }))
  })

  it('keeps a start in another month that the new package still offers', async () => {
    const sent = stubApi({
      'p1|2026-10': [OCTOBER_SHORT],
      'p1|2026-11': [NOVEMBER_SHORT],
      'p3|2026-10': [OCTOBER_SHORT],
      'p3|2026-11': [NOVEMBER_SHORT],
    })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '10:00' }))
    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 10:00 to 11:00, Kigali time`))
    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')

    // Another 60-minute package whose October still has 10:00 on the 7th.
    rerender({ packageId: 'p3', durationMinutes: 60 })
    await waitFor(() => expect(sent).toContainEqual(expect.objectContaining({ packageId: 'p3', month: '2026-10' })))
    await loadedMonth('November 2026')

    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '10:00')]])
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 10:00 to 11:00, Kigali time`)
  })

  it('reports a check that never answers as failed once it times out, and frees the starts again', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    let requests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
        if (requests++ === 0) return json({ days: OCTOBER_SHORT })
        // The check: a stalled connection that only ends when the picker aborts it.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      }),
    )
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '10:00' }))
    await screen.findByText('Checking that time is still free…')

    const expire = timers.mock.calls.find(([, delay]) => delay === 15_000)?.[0]
    if (typeof expire !== 'function') throw new Error('The check armed no 15 s timeout')
    act(() => expire())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not confirm that time is still free')
    expect(screen.queryByText('Checking that time is still free…')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()

    // Not stuck: the next click issues a new check.
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await waitFor(() => expect(requests).toBe(3))
  })

  it('lets the visitor choose a start for the new package while a check for the old one is still running', async () => {
    const hungCheck = deferred()
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => hungCheck.promise], 'p2|2026-10': [OCTOBER_LONG] })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))

    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '14:00']))

    await u.click(screen.getByRole('button', { name: '14:00' }))

    // A slow network must not leave every start dead: the click checks 14:00 for p2.
    await waitFor(() => expect(sent.map(({ packageId }) => packageId)).toEqual(['p1', 'p1', 'p2', 'p2']))
    await waitFor(() => expect(onChange.mock.calls).toEqual([[at('2026-10-07', '14:00')]]))
    // And nothing says a check is running for a package no longer shown.
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument()
  })

  it('shows loading rather than the previous package’s starts while the new package loads', async () => {
    const longLoad = deferred()
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p2|2026-10': [() => longLoad.promise] })
    const { rerender } = renderPicker()
    await loadedMonth('October 2026')
    await user().click(dayButton(`${WEDNESDAY}, 4 times available`))

    rerender({ packageId: 'p2', durationMinutes: 180 })

    expect(await screen.findByText(LOADING)).toBeInTheDocument()
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.queryAllByRole('button', { name: /, \d+ times? available$/ })).toEqual([])

    await act(async () => longLoad.resolve(json({ days: OCTOBER_LONG })))

    expect(listedTimes()).toEqual(['09:00', '14:00'])
  })
})

// --- Stale responses -------------------------------------------------------------------------------

describe('a response for something no longer shown', () => {
  it('ignores a slow month the visitor has already moved away from', async () => {
    const slowNovember = deferred()
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p1|2026-11': [() => slowNovember.promise] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await u.click(screen.getByRole('button', { name: 'Previous month' }))
    await loadedMonth('October 2026')
    await act(async () => slowNovember.resolve(json({ days: NOVEMBER_SHORT })))

    expect(screen.getByRole('heading', { level: 3, name: 'October 2026' })).toBeInTheDocument()
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toBeEnabled()
    expect(screen.queryByRole('button', { name: /November/ })).not.toBeInTheDocument()
  })

  it('ignores a slow load for the previous package', async () => {
    const slowShort = deferred()
    stubApi({ 'p1|2026-10': [() => slowShort.promise], 'p2|2026-10': [OCTOBER_LONG] })
    const { rerender } = renderPicker()

    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(dayButton(`${WEDNESDAY}, 2 times available`)).toBeEnabled())
    await act(async () => slowShort.resolve(json({ days: OCTOBER_SHORT })))

    expect(dayButton(`${WEDNESDAY}, 2 times available`)).toBeEnabled()
    expect(dayButton(`${THURSDAY}, no times available`)).toBeDisabled()
  })

  it('ignores a slow failure for the previous package', async () => {
    const slowShort = deferred()
    stubApi({ 'p1|2026-10': [() => slowShort.promise], 'p2|2026-10': [OCTOBER_LONG] })
    const { rerender } = renderPicker()

    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(dayButton(`${WEDNESDAY}, 2 times available`)).toBeEnabled())
    await act(async () => slowShort.reject(new TypeError('Failed to fetch')))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(dayButton(`${WEDNESDAY}, 2 times available`)).toBeEnabled()
  })

  it('ignores a check that returns after the package changed: no alert, no selection, no calendar swap', async () => {
    const slowCheck = deferred()
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => slowCheck.promise], 'p2|2026-10': [OCTOBER_LONG] })
    const { onChange, rerender } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))

    rerender({ packageId: 'p2', durationMinutes: 180 })
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '14:00']))
    // The check comes back saying 09:30 is gone -- about a package no longer shown.
    await act(async () => slowCheck.resolve(json({ days: monthDays('2026-10') })))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
    expect(listedTimes()).toEqual(['09:00', '14:00'])
    expect(screen.queryByText(CHECKING)).not.toBeInTheDocument()
  })

  it('ignores a check that returns after the visitor moved to another month', async () => {
    const slowCheck = deferred()
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => slowCheck.promise], 'p1|2026-11': [NOVEMBER_SHORT] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))

    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')
    await act(async () => slowCheck.resolve(json({ days: OCTOBER_SHORT })))

    expect(onChange).not.toHaveBeenCalled()
    expect(selectedText()).toBeNull()
    expect(screen.getByRole('heading', { level: 3, name: 'November 2026' })).toBeInTheDocument()
    expect(dayButton('Monday, 2 November 2026, 2 times available')).toBeEnabled()
  })
})

// --- Keyboard (spec §7) ----------------------------------------------------------------------------

describe('the keyboard', () => {
  it('reaches next month, only the bookable dates, then the starts, and chooses with Enter and Space', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    const { onChange } = renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    // Previous month is disabled at the current month, so Tab skips it.
    await u.tab()
    expect(screen.getByRole('button', { name: 'Next month' })).toHaveFocus()
    // Then straight to the 7th: the thirty days with nothing bookable are skipped.
    await u.tab()
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toHaveFocus()
    await u.tab()
    expect(dayButton(`${THURSDAY}, 1 time available`)).toHaveFocus()

    await u.tab({ shift: true })
    await u.keyboard('{Enter}')
    expect(listedTimes()).toEqual(['09:00', '09:30', '10:00', '14:00'])
    expect(dayButton(`${WEDNESDAY}, 4 times available`)).toHaveFocus()

    // Past the 8th, into the starts in reading order.
    await u.tab()
    await u.tab()
    expect(screen.getByRole('button', { name: '09:00' })).toHaveFocus()
    await u.tab()
    expect(screen.getByRole('button', { name: '09:30' })).toHaveFocus()

    await u.keyboard(' ')

    await waitFor(() => expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:30')]]))
    expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:30 to 10:30, Kigali time`)
    // Focus stays on the start just chosen.
    expect(screen.getByRole('button', { name: '09:30' })).toHaveFocus()
  })

  it('moves months with Enter and Space on the month buttons', async () => {
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT], 'p1|2026-11': [NOVEMBER_SHORT] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()

    await u.tab()
    await u.keyboard('{Enter}')
    await loadedMonth('November 2026')

    screen.getByRole('button', { name: 'Previous month' }).focus()
    await u.keyboard(' ')
    await loadedMonth('October 2026')

    expect(sent.map(({ month }) => month)).toEqual(['2026-10', '2026-11', '2026-10'])
  })

  it('keeps focus on a start while it is being checked', async () => {
    const check = deferred()
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, () => check.promise] })
    renderPicker()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    screen.getByRole('button', { name: '10:00' }).focus()

    await u.keyboard('{Enter}')

    expect(screen.getByText(CHECKING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '10:00' })).toHaveFocus()

    await act(async () => check.resolve(json({ days: OCTOBER_SHORT })))

    expect(screen.getByRole('button', { name: '10:00' })).toHaveFocus()
  })
})

// --- Told by the page that a start was refused (plan.md Task 13) -------------------------------

describe('reportTaken, when the booking API refuses the chosen start', () => {
  type RefHarnessProps = {
    handle: RefObject<SlotPickerHandle | null>
    onChange: (start: string | null) => void
    initialValue?: string | null
  }

  /** The picker as ServiceDetail holds it: a stable setter fed back as `value`, and a ref to its handle. */
  function RefHarness({ handle, onChange, initialValue = null }: RefHarnessProps) {
    const [value, setValue] = useState<string | null>(initialValue)
    const handleChange = useCallback(
      (start: string | null) => {
        onChange(start)
        setValue(start)
      },
      [onChange],
    )
    return (
      <>
        <SlotPicker ref={handle} packageId="p1" durationMinutes={60} value={value} onChange={handleChange} />
        <button type="button">Elsewhere on the page</button>
      </>
    )
  }

  function renderWithHandle(initialValue: string | null = null) {
    const handle = createRef<SlotPickerHandle>()
    const onChange = vi.fn<(start: string | null) => void>()
    render(<RefHarness handle={handle} onChange={onChange} initialValue={initialValue} />)
    const reportTaken = (start: string) =>
      act(() => {
        if (handle.current === null) throw new Error('SlotPicker exposed no handle')
        handle.current.reportTaken(start)
      })
    return { onChange, reportTaken }
  }

  function requests(sent: Sent[]): string[] {
    return sent.map(({ packageId, month }) => `${packageId}|${month}`)
  }

  it('clears the start, focuses the "just taken" alert, and reloads the month on screen', async () => {
    const refreshed = monthDays('2026-10', { '2026-10-07': ['09:00', '10:00', '14:00'], '2026-10-08': ['11:00'] })
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, OCTOBER_SHORT, refreshed] })
    const { onChange, reportTaken } = renderWithHandle()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))
    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 09:30 to 10:30, Kigali time`))
    screen.getByRole('button', { name: 'Elsewhere on the page' }).focus()

    await reportTaken(at('2026-10-07', '09:30'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(onChange.mock.calls).toEqual([[at('2026-10-07', '09:30')], [null]])
    expect(selectedText()).toBeNull()
    // Asked again, and the fresh answer is what is shown.
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '10:00', '14:00']))
    expect(requests(sent)).toEqual(['p1|2026-10', 'p1|2026-10', 'p1|2026-10'])
    expect(sent.every(({ cache }) => cache === 'no-store')).toBe(true)
    expect(dayButton(`${WEDNESDAY}, 3 times available`)).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '10:00' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('goes back to the start’s own month and date when the visitor has browsed to another', async () => {
    const refreshed = monthDays('2026-10', { '2026-10-07': ['09:00', '14:00'] })
    const sent = stubApi({ 'p1|2026-10': [OCTOBER_SHORT, OCTOBER_SHORT, refreshed], 'p1|2026-11': [NOVEMBER_SHORT] })
    const { onChange, reportTaken } = renderWithHandle()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '10:00' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())
    await u.click(screen.getByRole('button', { name: 'Next month' }))
    await loadedMonth('November 2026')
    await u.click(dayButton('Monday, 2 November 2026, 2 times available'))

    await reportTaken(at('2026-10-07', '10:00'))

    await loadedMonth('October 2026')
    expect(screen.getByRole('heading', { level: 3, name: 'October 2026' })).toBeInTheDocument()
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '14:00']))
    expect(dayButton(`${WEDNESDAY}, 2 times available`)).toHaveAttribute('aria-pressed', 'true')
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(JUST_TAKEN)
    await waitFor(() => expect(alert).toHaveFocus())
    expect(onChange.mock.calls.at(-1)).toEqual([null])
    expect(selectedText()).toBeNull()
    expect(requests(sent)).toEqual(['p1|2026-10', 'p1|2026-10', 'p1|2026-11', 'p1|2026-10'])
  })

  it('opens the start’s month for a start chosen before the picker mounted', async () => {
    const sent = stubApi({ 'p1|2026-11': [NOVEMBER_SHORT, monthDays('2026-11', { '2026-11-02': ['10:00'] })] })
    const { reportTaken } = renderWithHandle(at('2026-11-02', '10:30'))
    await loadedMonth('November 2026')

    await reportTaken(at('2026-11-02', '10:30'))

    await waitFor(() => expect(listedTimes()).toEqual(['10:00']))
    expect(dayButton('Monday, 2 November 2026, 1 time available')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('alert')).toHaveTextContent(JUST_TAKEN)
    expect(selectedText()).toBeNull()
    expect(requests(sent)).toEqual(['p1|2026-11', 'p1|2026-11'])
  })

  it('moves focus to the alert again when a second start is refused', async () => {
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT] })
    const { reportTaken } = renderWithHandle()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:00' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())

    await reportTaken(at('2026-10-07', '09:00'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus())

    // The visitor picks again on the same date, then is refused again.
    await u.click(screen.getByRole('button', { name: '14:00' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())
    screen.getByRole('button', { name: 'Elsewhere on the page' }).focus()
    await reportTaken(at('2026-10-07', '14:00'))

    await waitFor(() => expect(screen.getByRole('alert')).toHaveFocus())
    expect(selectedText()).toBeNull()
  })

  it('lets the visitor choose a refreshed start straight away, which clears the alert', async () => {
    const refreshed = monthDays('2026-10', { '2026-10-07': ['09:00', '14:00'] })
    stubApi({ 'p1|2026-10': [OCTOBER_SHORT, OCTOBER_SHORT, refreshed] })
    const { onChange, reportTaken } = renderWithHandle()
    await loadedMonth('October 2026')
    const u = user()
    await u.click(dayButton(`${WEDNESDAY}, 4 times available`))
    await u.click(screen.getByRole('button', { name: '09:30' }))
    await waitFor(() => expect(selectedText()).not.toBeNull())
    await reportTaken(at('2026-10-07', '09:30'))
    await waitFor(() => expect(listedTimes()).toEqual(['09:00', '14:00']))

    await u.click(screen.getByRole('button', { name: '14:00' }))

    await waitFor(() => expect(selectedText()).toBe(`Selected: ${WEDNESDAY}, 14:00 to 15:00, Kigali time`))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(onChange.mock.calls.at(-1)).toEqual([at('2026-10-07', '14:00')])
  })
})
