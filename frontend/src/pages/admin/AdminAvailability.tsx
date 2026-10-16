import { CalendarClock, CircleAlert, CircleSlash, Plus, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router'
import { UnauthenticatedError } from '@/admin/api'
import {
  type AdminBlock,
  type AdminWorkingHours,
  availabilityApi,
  blockFormValues,
  formatMinuteOfDay,
  kigaliWallTime,
  workingHoursFormValues,
} from '@/admin/availability'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate, formatTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BlockForm } from './BlockForm'
import { META, PAGE, SECTION_TITLE } from './console/classes'
import { FormDialog } from './console/FormDialog'
import { LoadingRegion, PanelSkeleton } from './console/Skeletons'
import { PageHeader } from './console/PageHeader'
import { WorkingHoursForm } from './WorkingHoursForm'

/**
 * Working hours and blocks on one page (plan.md Task 8, spec §3.3, §6.3,
 * §6.4). They are one screen because they answer one question between them --
 * when can a client book? -- and reading either alone gives the wrong answer.
 *
 * One form is open at a time. After any save both lists are fetched again (a
 * few dozen rows), so what is shown is always what is stored.
 */

type Data = { workingHours: AdminWorkingHours[]; blocks: AdminBlock[] }

/** Which form is open: `hours:new`, `hours:<id>`, `block:new`, `block:<id>`. */
type Editing = string | null

/**
 * Both lists: the list cancels its panel's side padding and each row puts it
 * back, so the hairlines run edge to edge across the panel, as the console's
 * table rows do (design-system/bookly/admin-console.md 6.5).
 */
const LIST = '-mx-(--card-spacing) border-y'

/**
 * One row: the words on the left, Edit and Delete on the right from `sm`.
 * Below `sm` the pair drops under the words, and the console sizes keep each
 * button 44px tall to a thumb (32px from `lg`).
 */
const ROW =
  'flex flex-col gap-3 border-b px-(--card-spacing) py-4 last:border-b-0 sm:flex-row sm:items-center sm:justify-between sm:gap-6 lg:py-3.5'


/** The two lines of a row's words: the name, then its qualifiers. */
const ROW_TEXT = 'flex min-w-0 flex-col gap-1'

const ROW_ACTIONS = 'flex shrink-0 flex-wrap gap-2'

export function AdminAvailability() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [version, setVersion] = useState(0)
  /** The latest load; `data` is null when it failed. Kept across reloads, so a
   *  save does not blank the page while the fresh copy arrives. */
  const [loaded, setLoaded] = useState<{ data: Data | null } | null>(null)
  const [editing, setEditing] = useState<Editing>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([availabilityApi.loadWorkingHours(), availabilityApi.loadBlocks()])
      .then(([hours, blocks]) => {
        if (!cancelled) setLoaded({ data: { workingHours: hours.workingHours, blocks: blocks.blocks } })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          navigate('/admin/login', { replace: true })
          return
        }
        setLoaded({ data: null })
      })
    return () => {
      cancelled = true
    }
  }, [version, navigate])

  const reload = () => setVersion((n) => n + 1)

  /** A save from an open form: close it and refetch. Errors stay in the form. */
  async function saved(action: Promise<unknown>) {
    await action
    setEditing(null)
    reload()
  }

  /** A one-click action, today only delete. */
  async function act(action: () => Promise<unknown>) {
    setActionError(null)
    try {
      await action()
      reload()
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        navigate('/admin/login', { replace: true })
        return
      }
      setActionError(t('admin:availability.actionFailed'))
    }
  }

  function remove(question: string, action: () => Promise<unknown>) {
    if (window.confirm(question)) void act(action)
  }

  /** What a row is called in a button's accessible name and its delete question. */
  function nameOfHours(row: AdminWorkingHours): string {
    return row.weekday === null
      ? formatDate(row.effectiveDate ?? '')
      : t(`admin:availability.weekdays.${row.weekday}`)
  }

  function nameOfBlock(block: AdminBlock): string {
    return formatDate(kigaliWallTime(block.startsAt).date)
  }

  function describeBlock(block: AdminBlock): string {
    const from = kigaliWallTime(block.startsAt).date
    if (!block.isAllDay) {
      return t('admin:availability.blocks.timeRange', {
        date: formatDate(from),
        start: formatTime(block.startsAt),
        end: formatTime(block.endsAt),
      })
    }
    // An all-day block ends at the midnight after its last day, so the inclusive
    // last day is the day before that boundary.
    const to = kigaliWallTime(new Date(Date.parse(block.endsAt) - 1).toISOString()).date
    return from === to
      ? t('admin:availability.blocks.allDayOne', { date: formatDate(from) })
      : t('admin:availability.blocks.allDayRange', { from: formatDate(from), to: formatDate(to) })
  }

  function hoursRow(row: AdminWorkingHours) {
    const key = `hours:${row.id}`
    const name = nameOfHours(row)

    const isClosed = !(row.isOpen && row.opensMinute !== null && row.closesMinute !== null)

    return (
      <li key={row.id} className={ROW}>
        <div className={ROW_TEXT}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="min-w-0 font-medium wrap-break-word">
              {row.weekday === null ? name : t('admin:availability.hours.everyDay', { day: name })}
            </span>
            {/* The row-sized chip (13px, as the spec's small status badge), so
                it sits on the name's line without outweighing it. */}
            <Badge variant="console" className="px-2 py-0.5 text-[0.8125rem]">
              {t(row.weekday === null ? 'admin:availability.hours.datedBadge' : 'admin:availability.hours.weeklyBadge')}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {/* A closed day is a different state, not a lesser one: an icon and
                the word mark it in the text colour, never colour or opacity
                alone, and the row itself is not dimmed (`pages/availability.md`). */}
            {isClosed ? (
              <span className="text-foreground inline-flex items-center gap-1.5 text-sm font-medium">
                <CircleSlash aria-hidden="true" className="size-4 shrink-0" />
                {t('admin:availability.hours.closed')}
              </span>
            ) : (
              <span className={cn(META, 'font-mono tabular-nums')}>
                {t('admin:availability.hours.window', {
                  opens: formatMinuteOfDay(row.opensMinute ?? 0),
                  closes: formatMinuteOfDay(row.closesMinute ?? 0),
                })}
              </span>
            )}
            {row.note !== null && <span className={cn(META, 'min-w-0 wrap-break-word')}>· {row.note}</span>}
          </div>
        </div>
        <div className={ROW_ACTIONS}>
          <Button
            size="console-sm"
            variant="console-outline"
            aria-label={t('admin:availability.hours.editNamed', { name })}
            onClick={() => setEditing(key)}
          >
            {t('admin:availability.edit')}
          </Button>
          <Button
            size="console-sm"
            variant="destructive"
            aria-label={t('admin:availability.hours.deleteNamed', { name })}
            onClick={() =>
              remove(
                t(
                  row.weekday === null
                    ? 'admin:availability.hours.confirmDeleteDated'
                    : 'admin:availability.hours.confirmDeleteWeekly',
                  { name },
                ),
                () => availabilityApi.deleteWorkingHours(row.id),
              )
            }
          >
            {t('admin:availability.delete')}
          </Button>
        </div>
        <FormDialog open={editing === key} onClose={() => setEditing(null)} title={t('admin:availability.hours.editTitle')} wide>
          <WorkingHoursForm
            title={t('admin:availability.hours.editTitle')}
            submitLabel={t('admin:availability.save')}
            values={workingHoursFormValues(row)}
            onSave={(payload) => saved(availabilityApi.updateWorkingHours(row.id, payload))}
            onCancel={() => setEditing(null)}
          />
        </FormDialog>
      </li>
    )
  }

  function blockRow(block: AdminBlock) {
    const key = `block:${block.id}`
    const name = nameOfBlock(block)

    return (
      <li key={block.id} className={ROW}>
        <div className={ROW_TEXT}>
          <span className="min-w-0 font-medium tabular-nums wrap-break-word">{describeBlock(block)}</span>
          <span className={cn(META, 'min-w-0 wrap-break-word')}>
            {block.reason ?? t('admin:availability.blocks.noReason')}
          </span>
        </div>
        <div className={ROW_ACTIONS}>
          <Button
            size="console-sm"
            variant="console-outline"
            aria-label={t('admin:availability.blocks.editNamed', { name })}
            onClick={() => setEditing(key)}
          >
            {t('admin:availability.edit')}
          </Button>
          <Button
            size="console-sm"
            variant="destructive"
            aria-label={t('admin:availability.blocks.deleteNamed', { name })}
            onClick={() =>
              remove(t('admin:availability.blocks.confirmDelete', { name }), () =>
                availabilityApi.deleteBlock(block.id),
              )
            }
          >
            {t('admin:availability.delete')}
          </Button>
        </div>
        <FormDialog open={editing === key} onClose={() => setEditing(null)} title={t('admin:availability.blocks.editTitle')} wide>
          <BlockForm
            title={t('admin:availability.blocks.editTitle')}
            submitLabel={t('admin:availability.save')}
            values={blockFormValues(block)}
            onSave={(payload) => saved(availabilityApi.updateBlock(block.id, payload))}
            onCancel={() => setEditing(null)}
          />
        </FormDialog>
      </li>
    )
  }

  const data = loaded?.data ?? null

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      <PageHeader eyebrow={t('admin:nav.label')} eyebrowIcon={CalendarClock} title={t('admin:availability.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:availability.intro')}</p>
      </PageHeader>

      {actionError !== null && (
        <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {actionError}
        </p>
      )}

      {loaded === null && (
        <LoadingRegion label={t('admin:availability.loading')} className="flex flex-col gap-8 lg:gap-12">
          <PanelSkeleton rows={5} />
          <PanelSkeleton rows={2} />
        </LoadingRegion>
      )}
      {loaded !== null && data === null && (
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4" role="alert">
          <p className="text-destructive flex items-start gap-2 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:availability.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={reload}>
            {t('admin:availability.retry')}
          </Button>
        </div>
      )}

      {data !== null && (
        <>
          <Card variant="console">
            <CardHeader className="gap-1.5">
              <CardTitle>
                <h2 className={SECTION_TITLE}>{t('admin:availability.hours.title')}</h2>
              </CardTitle>
              <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:availability.hours.intro')}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {data.workingHours.length === 0 ? (
                // With no hours nothing can ever be booked, so the one sentence
                // this list has for itself is a warning, not a quiet line.
                <Callout variant="console" tone="warning" icon={TriangleAlert}>
                  {t('admin:availability.hours.empty')}
                </Callout>
              ) : (
                <ul className={LIST}>{data.workingHours.map(hoursRow)}</ul>
              )}
              <Button
                size="console"
                variant="console-outline"
                className="sm:self-start"
                onClick={() => setEditing('hours:new')}
              >
                <Plus aria-hidden="true" />
                {t('admin:availability.hours.add')}
              </Button>
              <FormDialog open={editing === 'hours:new'} onClose={() => setEditing(null)} title={t('admin:availability.hours.new')} wide>
                <WorkingHoursForm
                  title={t('admin:availability.hours.new')}
                  submitLabel={t('admin:availability.create')}
                  values={workingHoursFormValues()}
                  onSave={(payload) => saved(availabilityApi.createWorkingHours(payload))}
                  onCancel={() => setEditing(null)}
                />
              </FormDialog>
            </CardContent>
          </Card>

          <Card variant="console">
            <CardHeader className="gap-1.5">
              <CardTitle>
                <h2 className={SECTION_TITLE}>{t('admin:availability.blocks.title')}</h2>
              </CardTitle>
              <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:availability.blocks.intro')}</p>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {data.blocks.length === 0 ? (
                <p className={META}>{t('admin:availability.blocks.empty')}</p>
              ) : (
                <ul className={LIST}>{data.blocks.map(blockRow)}</ul>
              )}
              {/* "Add block" stays inline, the one exception to the modals (2026-09-27). */}
              {editing === 'block:new' ? (
                <BlockForm
                  title={t('admin:availability.blocks.new')}
                  submitLabel={t('admin:availability.create')}
                  values={blockFormValues(undefined, kigaliWallTime(new Date().toISOString()).date)}
                  onSave={(payload) => saved(availabilityApi.createBlock(payload))}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <Button
                  size="console"
                  variant="console-outline"
                  className="sm:self-start"
                  onClick={() => setEditing('block:new')}
                >
                  <Plus aria-hidden="true" />
                  {t('admin:availability.blocks.add')}
                </Button>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </main>
  )
}
