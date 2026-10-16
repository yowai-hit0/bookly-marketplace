import {
  CalendarClock,
  CalendarSync,
  Camera,
  CircleAlert,
  ClipboardList,
  Hash,
  HandCoins,
  History,
  type LucideIcon,
  MapPin,
  MessageSquareText,
  MessageSquareX,
  Plus,
  Timer,
  TriangleAlert,
  Users,
} from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import { useBreadcrumbTail } from '@/admin/breadcrumb-tail'
import { type AdminBooking, type AdminPayment, bookingFromRefusal, bookingsApi } from '@/admin/bookings'
import { type AdminAddon, catalogueApi } from '@/admin/catalogue'
import { kigaliDateOf } from '@/admin/calendar-dates'
import { BackLink } from '@/components/ui/back-link'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { StatusBadge, type StatusShape, StatusShapeGlyph } from '@/components/ui/status-badge'
import { Textarea } from '@/components/ui/textarea'
import { formatDate, formatDateTime, formatMoney, formatTime } from '@/lib/format'
import { SELECT_CLASS } from './AdminField'
import { FormDialog } from './console/FormDialog'
import { cn } from '@/lib/utils'
import { StageLegend } from '@/pages/StageLegend'
import { CHECKBOX, DATA, FIELD, META, PAGE, SECTION_TITLE, SUBPANEL, TEXTAREA } from './console/classes'
import { Skeleton } from '@/components/ui/skeleton'
import { LoadingRegion, Line as SkeletonLine } from './console/Skeletons'
import { MetaItem, PageHeader } from './console/PageHeader'
import { StatGrid, StatTile } from './console/StatGrid'

/**
 * One booking, and everything the photographer does to it (plan.md Task 19;
 * spec §3.6, §6.11, §6.12, §6.16, §6.21).
 *
 * Every action answers with the booking as it now stands, and so does every
 * refusal: a slot taken while he was choosing, or a booking cancelled in
 * another tab, replaces what is on screen instead of leaving him to guess. The
 * buttons follow the API's own `actions` flags, which the API enforces again.
 *
 * Laid out as the admin console (design-system/bookly/admin-console.md 6.3,
 * 6.6, 6.7): a page header and a status band, then flat sections divided by
 * full-bleed hairlines, in the order the page has always had.
 */

/** Kigali is UTC+2 with no DST (spec §6.5), so a fixed offset is exact. */
const KIGALI_OFFSET = '+02:00'

type Failure = { code: string } | null

/**
 * Which form is open in a dialog (admin console fixes, item 1, 2026-09-27):
 * every create and edit form on this page opens in one, and one at a time.
 */
type OpenForm = 'addon' | 'reschedule' | 'cancel' | 'delivery' | 'cash' | null

/** Help text under a field or a group of buttons: 13px, muted. */
const HINT = 'text-muted-foreground text-[0.8125rem] leading-snug'

/** A history line (message log, payment references): mono 13px. */
const LOG = 'font-mono text-[0.8125rem] tabular-nums'

/** A row of buttons: stacked full width on a phone, side by side from `sm`. */
const BUTTONS = 'flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center'

/** A button in such a row. */
const BUTTON_WIDTH = 'w-full sm:w-auto'

/** A field above its own label: the console's label-above layout. */
const FIELD_GROUP = 'flex min-w-0 flex-col gap-2'

export function AdminBookingDetail() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { id = '' } = useParams()
  const [booking, setBooking] = useState<AdminBooking | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'failed'>('loading')
  const [failure, setFailure] = useState<Failure>(null)
  const [busy, setBusy] = useState(false)
  const [openForm, setOpenForm] = useState<OpenForm>(null)
  // Set when an add-on goes on, until the session fee is asked for: the page
  // then points at "Request session fee" (2026-09-27).
  const [feeDue, setFeeDue] = useState(false)
  const requestFeeRef = useRef<HTMLButtonElement>(null)
  const owedHintId = useId()

  useEffect(() => {
    let cancelled = false
    bookingsApi
      .get(id)
      .then((answer) => {
        if (cancelled) return
        setBooking(answer.booking)
        setState('ready')
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (error instanceof UnauthenticatedError) {
          void navigate('/admin/login', { replace: true })
          return
        }
        setState(error instanceof ApiError && error.status === 404 ? 'missing' : 'failed')
      })
    return () => {
      cancelled = true
    }
  }, [id, navigate])

  // The breadcrumb's last crumb is this booking's reference, from this page's
  // own fetch (admin-console.md 6.2): a placeholder while it loads, and none
  // once a load has failed or found nothing.
  useBreadcrumbTail(state === 'loading', state === 'ready' && booking !== null ? booking.reference : null)

  /** Runs an action, then shows whatever the API says the booking now is. */
  async function act(action: () => Promise<{ booking: AdminBooking }>): Promise<void> {
    await attempt(action)
  }

  /** `act`, answering whether it worked, for a form that clears only on success. */
  async function attempt(action: () => Promise<{ booking: AdminBooking }>): Promise<boolean> {
    if (busy) return false
    setBusy(true)
    setFailure(null)
    try {
      setBooking((await action()).booking)
      return true
    } catch (error) {
      if (error instanceof UnauthenticatedError) {
        void navigate('/admin/login', { replace: true })
        return false
      }
      setFailure({ code: error instanceof ApiError ? error.message : 'failed' })
      // A refusal carries the booking it refused: that is how the screen
      // catches up with whatever changed underneath, without asking again.
      if (error instanceof ApiError && error.status === 409) {
        const carried = bookingFromRefusal(error)
        if (carried !== null) setBooking(carried)
        else {
          const fresh = await bookingsApi.get(id).catch(() => null)
          if (fresh !== null) setBooking(fresh.booking)
        }
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  if (state === 'loading') {
    return (
      <Shell head={null}>
        <LoadingRegion label={t('admin:booking.loading')} className="flex flex-col gap-8 lg:gap-12">
          {/* The header: eyebrow, the reference and its badge. */}
          <div className="flex flex-col gap-3.5">
            <SkeletonLine w="w-24" className="h-3" />
            <div className="flex flex-wrap items-center gap-3.5">
              <Skeleton className="h-9 w-64 max-w-full rounded-xs" />
              <Skeleton className="h-7 w-28 rounded-xs" />
            </div>
          </div>
          {/* The status band, full width like the real one. */}
          <Skeleton className="-mx-4 h-14 rounded-none lg:-mx-12" />
          {/* The shoot's tiles, then the sections below it. */}
          <div className="flex flex-col gap-6">
            <SkeletonLine w="w-32" className="h-6" />
            <div className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
              {[0, 1, 2, 3].map((tile) => (
                <div key={tile} className="flex items-center gap-4 sm:gap-5">
                  <Skeleton className="size-12 shrink-0 rounded-xs sm:size-16" />
                  <div className="flex flex-1 flex-col gap-2">
                    <SkeletonLine w="w-20" className="h-3" />
                    <SkeletonLine w="w-40 max-w-full" />
                  </div>
                </div>
              ))}
            </div>
          </div>
          {[0, 1].map((section) => (
            <div key={section} className="flex flex-col gap-4 border-t pt-8">
              <SkeletonLine w="w-28" className="h-6" />
              {[0, 1, 2].map((line) => (
                <div key={line} className="flex justify-between gap-6">
                  <SkeletonLine w="w-28" />
                  <SkeletonLine w="w-32" />
                </div>
              ))}
            </div>
          ))}
        </LoadingRegion>
      </Shell>
    )
  }
  // A load that failed leaves no booking either, so it is answered first:
  // only a 404 means the booking is really gone.
  if (state === 'failed') {
    return (
      <Shell
        head={
          <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
            {t('admin:booking.loadFailed')}
          </Callout>
        }
      />
    )
  }
  if (state === 'missing' || booking === null) {
    return (
      <Shell head={<PageHeader eyebrow={t('admin:nav.bookings')} eyebrowIcon={ClipboardList} title={t('admin:booking.missing')} />} />
    )
  }

  const { schedule, money, actions } = booking
  // Confirmed and the shoot has begun, but money is owed: "completed" means
  // paid (2026-09-27), so the button shows, disabled, with what is owed.
  const completeOwed = actions.canMarkNoShow && !actions.canComplete && money.totals.outstandingRwf > 0

  // A refused action shows where the eye is: inside the open dialog, or at the
  // top of the page when none is open. Never both, so there is one alert.
  const failureNote =
    failure === null ? null : (
      <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
        {t(`admin:booking.errors.${failure.code}`, { defaultValue: t('admin:booking.errors.failed') })}
      </Callout>
    )

  /** Runs a dialog's action, and closes the dialog only when it worked. */
  async function submitFrom(action: () => Promise<{ booking: AdminBooking }>): Promise<void> {
    if (await attempt(action)) setOpenForm(null)
  }

  function formDialog(form: Exclude<OpenForm, null>, title: string, body: ReactNode) {
    return (
      <FormDialog open={openForm === form} onClose={() => setOpenForm(null)} title={title}>
        <div className="flex flex-col gap-5">
          {failureNote}
          {body}
        </div>
      </FormDialog>
    )
  }

  return (
    <Shell
      head={
        <PageHeader
          eyebrow={t('admin:nav.bookings')}
          eyebrowIcon={ClipboardList}
          title={booking.reference}
          titleClassName="font-mono"
          badges={
            // The display stage (2026-09-25): the stored status read with the clock.
            <span className="inline-flex items-center gap-1">
              <StatusBadge status={booking.stage} size="md">
                {t(`admin:bookings.stage.${booking.stage}`)}
              </StatusBadge>
              <StageLegend audience="admin" />
            </span>
          }
        />
      }
    >
      <StatusBand booking={booking} />

      {openForm === null && failureNote}

      <div className="flex flex-col">
        <Section title={t('admin:booking.sections.shoot')}>
          <StatGrid>
            <StatTile icon={CalendarClock} label={t('admin:booking.labels.when')} mono className="sm:col-span-2">
              {formatDate(kigaliDateOf(schedule.startsAt))},{' '}
              <span className="whitespace-nowrap">
                {formatTime(schedule.startsAt)} – {formatTime(schedule.endsAt)}
              </span>
            </StatTile>
            <StatTile icon={Camera} label={t('admin:booking.labels.service')}>
              {booking.service.name}, {booking.package.name}
            </StatTile>
            <StatTile icon={MapPin} label={t('admin:booking.labels.location')}>
              {booking.details.locationText}
            </StatTile>
            {booking.details.partySize !== null && (
              <StatTile icon={Users} label={t('admin:booking.labels.people')} mono>
                {booking.details.partySize}
              </StatTile>
            )}
            {booking.details.specialRequests !== null && (
              // Free text of any length: the full width, its icon beside the first line.
              <StatTile icon={MessageSquareText} label={t('admin:booking.labels.requests')} className="items-start sm:col-span-2">
                <span className="whitespace-pre-line">{booking.details.specialRequests}</span>
              </StatTile>
            )}
            {schedule.originalStartsAt !== null && (
              <StatTile icon={History} label={t('admin:booking.labels.originally')} mono>
                {formatDateTime(schedule.originalStartsAt)}
              </StatTile>
            )}
            {schedule.rescheduledAt !== null && (
              <StatTile icon={CalendarSync} label={t('admin:booking.labels.movedAt')} mono>
                {formatDateTime(schedule.rescheduledAt)}
              </StatTile>
            )}
            {booking.lifecycle.cancellationReason !== null && (
              <StatTile
                icon={MessageSquareX}
                label={t('admin:booking.labels.cancellationReason')}
                className="items-start sm:col-span-2"
              >
                {booking.lifecycle.cancellationReason}
              </StatTile>
            )}
          </StatGrid>
        </Section>

        <Section title={t('admin:booking.sections.client')}>
          <div className="flex flex-col gap-4 sm:gap-3">
            <Fact term={t('admin:booking.labels.name')}>{booking.contact.name}</Fact>
            <Fact term={t('admin:booking.labels.email')}>{breakableEmail(booking.contact.email)}</Fact>
            <Fact term={t('admin:booking.labels.phone')} mono>
              {booking.contact.phone}
            </Fact>
            <Fact term={t('admin:booking.labels.link')}>
              {booking.access.hasLink
                ? t('admin:booking.linkLive', { date: formatDateTime(booking.access.expiresAt ?? schedule.startsAt) })
                : t('admin:booking.linkNone')}
            </Fact>
          </div>
        </Section>

        <Section title={t('admin:booking.sections.money')}>
          <div className="flex flex-col gap-3">
            <Line term={booking.package.name}>{formatMoney(booking.package.priceRwf)}</Line>
            {booking.addons.map((addon) => (
              <Line
                key={addon.id}
                term={`${addon.name}${addon.quantity > 1 ? ` × ${addon.quantity}` : ''}${
                  addon.stage === 'post_shoot' ? ` (${t('admin:booking.postShoot')})` : ''
                }`}
                extra={
                  addon.canRemove && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="console-sm"
                      className="text-destructive hover:bg-console-danger-tint hover:text-destructive"
                      aria-disabled={busy}
                      onClick={() => void act(() => bookingsApi.removeAddon(booking.id, addon.id))}
                    >
                      {t('admin:booking.addons.remove')}
                    </Button>
                  )
                }
              >
                {formatMoney(addon.amountRwf)}
              </Line>
            ))}
            <Line term={t('admin:booking.labels.total')} tone="strong" className="mt-1 border-t pt-4">
              {formatMoney(money.totals.grandTotalRwf)}
            </Line>
            <Line term={t('admin:booking.labels.collected')}>{formatMoney(money.totals.collectedRwf)}</Line>
            {/* Still to pay is the number that needs action, so it is a step heavier while it is above zero. */}
            <Line term={t('admin:booking.labels.outstanding')} tone={money.totals.outstandingRwf > 0 ? 'strong' : 'plain'}>
              {formatMoney(money.totals.outstandingRwf)}
            </Line>
            {money.totals.refundDueRwf > 0 && (
              // Owed back: red, heavier, and an icon, beside the words that say so.
              <Line term={t('admin:booking.labels.refundDue')} tone="danger" icon={TriangleAlert}>
                {formatMoney(money.totals.refundDueRwf)}
              </Line>
            )}
          </div>
          {actions.canEditAddons && (
            <div className="flex flex-col gap-2">
              <Button
                variant="console-outline"
                size="console"
                className={cn(BUTTON_WIDTH, 'sm:self-start')}
                onClick={() => setOpenForm('addon')}
              >
                <Plus aria-hidden="true" />
                {t('admin:booking.addons.open')}
              </Button>
              <p className={HINT}>{t('admin:booking.addons.note')}</p>
            </div>
          )}
          {feeDue && actions.canRequestSessionFee && (
            <Callout
              variant="console"
              tone="info"
              icon={HandCoins}
              role="status"
              action={
                <Button
                  variant="console-outline"
                  size="console-sm"
                  // Focusing it scrolls it into view as well.
                  onClick={() => requestFeeRef.current?.focus()}
                >
                  {t('admin:booking.addons.toSessionFee')}
                </Button>
              }
            >
              <p>{t('admin:booking.addons.added', { amount: formatMoney(money.totals.outstandingRwf) })}</p>
            </Callout>
          )}
          {actions.canEditAddons &&
            formDialog(
              'addon',
              t('admin:booking.addons.title'),
              <>
                <AddonForm
                  serviceId={booking.service.id}
                  busy={busy}
                  onAdd={async (addonId, quantity) => {
                    if (await attempt(() => bookingsApi.addAddon(booking.id, addonId, quantity))) {
                      setOpenForm(null)
                      setFeeDue(true)
                    }
                  }}
                />
                <p className={HINT}>{t('admin:booking.addons.note')}</p>
              </>,
            )}
        </Section>

        <Payments
          booking={booking}
          busy={busy}
          onRefund={(paymentId, reference) => act(() => bookingsApi.recordRefund(paymentId, reference))}
        />

        {actions.canEditDelivery || booking.delivery.url !== null ? (
          <DeliveryForm
            booking={booking}
            busy={busy}
            editing={openForm === 'delivery'}
            onEdit={() => setOpenForm('delivery')}
            onCloseEdit={() => setOpenForm(null)}
            failureNote={failureNote}
            onSave={(body) => submitFrom(() => bookingsApi.saveDelivery(booking.id, body))}
            onSend={(recipient) => act(() => bookingsApi.sendDelivery(booking.id, recipient))}
          />
        ) : (
          // Where the form will be, once the shoot has begun: the photographer
          // otherwise has no way to know it exists (2026-09-25). `canMarkNoShow`
          // is the API's "confirmed and the shoot has begun", on its clock;
          // `canComplete` now also needs nothing owed (2026-09-27).
          actions.canMarkNoShow && (
            <Section title={t('admin:booking.sections.delivery')}>
              <p className={META}>{t('admin:booking.delivery.opensWhenPaid')}</p>
            </Section>
          )
        )}

        <Section title={t('admin:booking.sections.actions')}>
          <div className="flex flex-col gap-6">
            {actions.canReschedule && (
              <div className="flex flex-col gap-2">
                <Button
                  variant="console-outline"
                  size="console"
                  className={cn(BUTTON_WIDTH, 'sm:self-start')}
                  onClick={() => setOpenForm('reschedule')}
                >
                  {t('admin:booking.reschedule.move')}
                </Button>
                <p className={HINT}>{t('admin:booking.reschedule.note')}</p>
              </div>
            )}
            {actions.canReschedule &&
              formDialog(
                'reschedule',
                t('admin:booking.reschedule.move'),
                <RescheduleForm
                  booking={booking}
                  busy={busy}
                  onSubmit={(startsAt) => submitFrom(() => bookingsApi.reschedule(booking.id, startsAt))}
                />,
              )}
            {actions.canCancel && (
              // Set off from the routine actions by a hairline above and below
              // (admin-booking-detail.md); the dialog is the second step.
              <div className="border-y py-6">
                <Button variant="destructive" size="console" className={BUTTON_WIDTH} onClick={() => setOpenForm('cancel')}>
                  {t('admin:booking.cancel.start')}
                </Button>
              </div>
            )}
            {actions.canCancel &&
              formDialog(
                'cancel',
                t('admin:booking.cancel.start'),
                <CancelForm
                  busy={busy}
                  onKeep={() => setOpenForm(null)}
                  onSubmit={(reason) => submitFrom(() => bookingsApi.cancel(booking.id, reason))}
                />,
              )}
            {actions.canRequestSessionFee && (
              <div className="flex flex-col gap-2">
                {/* The page's one main action: the inverted neutral button. */}
                <Button
                  ref={requestFeeRef}
                  size="console"
                  className={cn(BUTTON_WIDTH, 'sm:self-start')}
                  aria-disabled={busy}
                  onClick={async () => {
                    if (await attempt(() => bookingsApi.requestSessionFee(booking.id))) setFeeDue(false)
                  }}
                >
                  {t('admin:booking.sessionFee.request', { amount: formatMoney(money.totals.outstandingRwf) })}
                </Button>
                <p className={HINT}>{t('admin:booking.sessionFee.note')}</p>
              </div>
            )}
            {/* Cash he was handed (item 7): the same rule as asking for it. */}
            {actions.canRequestSessionFee && (
              <Button
                variant="console-outline"
                size="console"
                className={cn(BUTTON_WIDTH, 'sm:self-start')}
                onClick={() => setOpenForm('cash')}
              >
                <HandCoins aria-hidden="true" />
                {t('admin:booking.cash.open')}
              </Button>
            )}
            {actions.canRequestSessionFee &&
              formDialog(
                'cash',
                t('admin:booking.cash.title'),
                <CashForm
                  outstandingRwf={money.totals.outstandingRwf}
                  busy={busy}
                  onSubmit={async (amountRwf, note) => {
                    if (await attempt(() => bookingsApi.recordCash(booking.id, amountRwf, note))) {
                      setOpenForm(null)
                      setFeeDue(false)
                    }
                  }}
                />,
              )}
            <div className="flex flex-col gap-2">
              {/* Hidden while no routine action is open, so it leaves no gap behind. */}
              <div className={cn(BUTTONS, 'empty:hidden')}>
                {actions.canComplete && (
                  <Button
                    variant="console-outline"
                    size="console"
                    className={BUTTON_WIDTH}
                    aria-disabled={busy}
                    onClick={() => void act(() => bookingsApi.complete(booking.id))}
                  >
                    {t('admin:booking.complete')}
                  </Button>
                )}
                {completeOwed && (
                  // Focusable, so a screen reader hears why it does nothing.
                  <Button
                    variant="console-outline"
                    size="console"
                    className={BUTTON_WIDTH}
                    aria-disabled="true"
                    aria-describedby={owedHintId}
                  >
                    {t('admin:booking.complete')}
                  </Button>
                )}
                {actions.canMarkNoShow && (
                  <Button
                    variant="console-outline"
                    size="console"
                    className={BUTTON_WIDTH}
                    aria-disabled={busy}
                    onClick={() => void act(() => bookingsApi.markNoShow(booking.id))}
                  >
                    {t('admin:booking.noShow')}
                  </Button>
                )}
                {actions.canResendLink && (
                  <Button
                    variant="console-outline"
                    size="console"
                    className={BUTTON_WIDTH}
                    aria-disabled={busy}
                    onClick={() => void act(() => bookingsApi.resendLink(booking.id))}
                  >
                    {t('admin:booking.resendLink')}
                  </Button>
                )}
              </div>
              {completeOwed && (
                <p id={owedHintId} className={HINT}>
                  {t('admin:booking.completeOwed', { amount: formatMoney(money.totals.outstandingRwf) })}
                </p>
              )}
              <p className={HINT}>{t('admin:booking.resendNote')}</p>
            </div>
          </div>
        </Section>

        {/* Once a client has a page to read them on (2026-09-25). */}
        {booking.lifecycle.confirmedAt !== null && (
          <Notes
            booking={booking}
            busy={busy}
            onAdd={(note) => attempt(() => bookingsApi.addNote(booking.id, note))}
            onDelete={(noteId) => act(() => bookingsApi.deleteNote(booking.id, noteId))}
          />
        )}

        <Section title={t('admin:booking.sections.messages')}>
          {booking.messages.length === 0 ? (
            <p className={META}>{t('admin:booking.noMessages')}</p>
          ) : (
            // A log: one mono line per message, the shape and the word on the right.
            <ul className={cn(LOG, 'flex flex-col')}>
              {booking.messages.map((message) => (
                <li
                  key={message.id}
                  className="flex flex-wrap items-start justify-between gap-x-6 gap-y-1 border-b py-3 first:pt-0 last:border-b-0 last:pb-0"
                >
                  <span className="min-w-0 wrap-anywhere">
                    {t(`admin:booking.templates.${message.template ?? message.kind}`, {
                      defaultValue: message.template ?? message.kind,
                    })}
                    <span className="text-muted-foreground"> · {formatDateTime(message.createdAt)}</span>
                    {/* Named only when it went elsewhere than the booking's own address (a one-off delivery recipient). */}
                    {message.recipient !== null && message.recipient !== booking.contact.email && (
                      <span className="text-muted-foreground"> · {t('admin:booking.messageTo', { recipient: message.recipient })}</span>
                    )}
                  </span>
                  <span
                    className={cn(
                      'flex min-w-0 items-start gap-2 sm:ml-auto',
                      message.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                    )}
                  >
                    <Glyph shape={MESSAGE_SHAPES[message.status]} className="mt-px" />
                    <span className="min-w-0 wrap-anywhere">
                      {t(`admin:booking.messageStatus.${message.status}`, { defaultValue: message.status })}
                      {message.lastError !== null && ` · ${message.lastError}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </Shell>
  )
}

/**
 * The page column: the back link and whatever heads the page (`head`), close
 * together; then the rest of the page, a section's gap below.
 */
function Shell({ head, children }: { head: ReactNode; children?: ReactNode }) {
  const { t } = useTranslation()
  return (
    <main className={cn(PAGE, 'max-w-3xl')}>
      <div className="flex flex-col gap-4 lg:gap-6">
        <BackLink to="/admin/bookings" className="max-lg:min-h-11">
          {t('admin:booking.back')}
        </BackLink>
        {head}
      </div>
      {children}
    </main>
  )
}

/**
 * The booking at a glance, under the header (admin-console.md 6.3): its
 * reference as a chip, when it starts and how long it runs, in mono. Only what
 * the page already has, in strings that already exist. The status is not
 * repeated here: its badge, with the legend beside it, is in the header just
 * above, and a second copy of the word would be read out twice.
 */
function StatusBand({ booking }: { booking: AdminBooking }) {
  const { t } = useTranslation()
  const { startsAt, endsAt } = booking.schedule
  const minutes = Math.round((Date.parse(endsAt) - Date.parse(startsAt)) / 60_000)
  return (
    <div className="bg-console-surface text-muted-foreground -mx-4 flex min-h-14 flex-wrap items-center gap-x-6 gap-y-2 border-y px-4 py-3 text-sm lg:-mx-12 lg:px-12">
      <Badge variant="console" className="font-mono text-[0.8125rem] tabular-nums">
        <Hash aria-hidden="true" />
        {booking.reference}
      </Badge>
      <MetaItem icon={CalendarClock}>
        <span className={cn(DATA, 'whitespace-nowrap')}>{formatDateTime(startsAt)}</span>
      </MetaItem>
      <MetaItem icon={Timer}>
        <span className={cn(DATA, 'whitespace-nowrap')}>{t('admin:catalogue.duration', { minutes })}</span>
      </MetaItem>
    </div>
  )
}

/**
 * Notes to the client (docs/prompts/client-access-and-admin-polish.md, item 8):
 * shown on their booking page as "From your photographer", and emailed unless
 * the box is unticked (it starts ticked: user decision, 2026-09-25). Plain
 * text, up to 1000 characters. Deleting takes one from the client's page; an
 * email already sent stays sent, and the confirm step says so.
 */
function Notes({
  booking,
  busy,
  onAdd,
  onDelete,
}: {
  booking: AdminBooking
  busy: boolean
  /** True when the note was saved: only then is the form cleared, so a failure keeps what was typed. */
  onAdd: (note: { body: string; email: boolean }) => Promise<boolean>
  onDelete: (noteId: string) => Promise<unknown>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [body, setBody] = useState('')
  const [email, setEmail] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const text = body.trim()
    if (text === '' || busy) return
    if (!(await onAdd({ body: text, email }))) return
    setBody('')
    setEmail(true)
  }

  return (
    <Section title={t('admin:booking.notes.title')}>
      <p className={cn(META, '-mt-2')}>{t('admin:booking.notes.intro')}</p>
      {booking.notes.length === 0 ? (
        <p className={META}>{t('admin:booking.notes.none')}</p>
      ) : (
        <ul className="flex flex-col">
          {booking.notes.map((note) => (
            <li key={note.id} className="flex flex-col gap-1.5 border-b py-4 first:pt-0 last:border-b-0">
              <p className="whitespace-pre-line wrap-anywhere">{note.body}</p>
              <p className={HINT}>
                <span className="font-mono tabular-nums">{formatDateTime(note.createdAt)}</span> ·{' '}
                {t(note.emailed ? 'admin:booking.notes.emailed' : 'admin:booking.notes.pageOnly')}
              </p>
              {deleting === note.id ? (
                <div className="flex flex-col gap-3 pt-2">
                  <p className="text-sm font-medium">{t('admin:booking.notes.deleteConfirm')}</p>
                  <div className={BUTTONS}>
                    <Button
                      variant="destructive"
                      size="console-sm"
                      className={BUTTON_WIDTH}
                      aria-disabled={busy}
                      onClick={() => {
                        setDeleting(null)
                        void onDelete(note.id)
                      }}
                    >
                      {t('admin:booking.notes.deleteYes')}
                    </Button>
                    <Button variant="console-outline" size="console-sm" className={BUTTON_WIDTH} onClick={() => setDeleting(null)}>
                      {t('admin:booking.notes.keep')}
                    </Button>
                  </div>
                </div>
              ) : (
                <Button
                  variant="ghost"
                  size="console-sm"
                  className="text-destructive hover:bg-console-danger-tint hover:text-destructive -ml-3 self-start"
                  onClick={() => setDeleting(note.id)}
                >
                  {t('admin:booking.notes.delete')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} className={SUBPANEL}>
        <div className={FIELD_GROUP}>
          <Label htmlFor={`${fieldId}body`}>{t('admin:booking.notes.label')}</Label>
          <Textarea
            id={`${fieldId}body`}
            rows={3}
            maxLength={1000}
            value={body}
            aria-describedby={`${fieldId}count`}
            onChange={(event) => setBody(event.target.value)}
            className={TEXTAREA}
          />
          <p id={`${fieldId}count`} className={cn(HINT, 'self-end font-mono tabular-nums')}>
            {t('admin:booking.notes.count', { count: body.length })}
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          {/* The label is the 44px target on a phone; the box's own hit area reaches 46px around it. */}
          <Checkbox
            id={`${fieldId}email`}
            checked={email}
            onCheckedChange={(value) => setEmail(value === true)}
            className={cn(CHECKBOX, 'after:-inset-3.5')}
          />
          <Label htmlFor={`${fieldId}email`} className="min-h-11 flex-1 text-base font-normal lg:min-h-8 pointer-coarse:min-h-11">
            {t('admin:booking.notes.email')}
          </Label>
        </div>
        <Button type="submit" variant="console-outline" size="console" className={cn(BUTTON_WIDTH, 'sm:self-start')} aria-disabled={busy || body.trim() === ''}>
          {t('admin:booking.notes.add')}
        </Button>
      </form>
    </Section>
  )
}

/**
 * A section of the page: flat, its `h2`, and a full-bleed hairline above it
 * (none above the first, which the status band already closes off).
 */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="-mx-4 flex flex-col gap-6 border-t px-4 py-8 first:border-t-0 first:pt-0 last:pb-0 lg:-mx-12 lg:px-12 lg:py-10">
      <h2 className={SECTION_TITLE}>{title}</h2>
      {children}
    </section>
  )
}

/** A labelled fact: the label beside the value from `sm`, above it on a phone. */
function Fact({ term, children, mono = false }: { term: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-6">
      <span className="text-muted-foreground text-sm sm:w-40 sm:shrink-0">{term}</span>
      <span className={cn('min-w-0 wrap-break-word', mono && DATA)}>{children}</span>
    </div>
  )
}

const LINE_TONES = {
  plain: { term: 'text-muted-foreground', value: '' },
  strong: { term: 'text-foreground font-semibold', value: 'font-semibold' },
  danger: { term: 'text-destructive font-semibold', value: 'text-destructive font-semibold' },
} as const

/**
 * A line of the money: the words on the left (they wrap), the amount on the
 * right in mono with tabular figures (it never wraps), then anything that acts
 * on the line.
 */
function Line({
  term,
  children,
  extra,
  icon: Icon,
  tone = 'plain',
  className,
}: {
  term: string
  children: ReactNode
  extra?: ReactNode
  icon?: LucideIcon
  tone?: keyof typeof LINE_TONES
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-x-4 gap-y-1', className)}>
      <span className={cn('flex min-w-0 flex-1 basis-24 items-center gap-2 wrap-break-word', LINE_TONES[tone].term)}>
        {Icon !== undefined && <Icon aria-hidden="true" className="size-4 shrink-0" />}
        {term}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-3">
        <span className={cn(DATA, 'text-right whitespace-nowrap', LINE_TONES[tone].value)}>{children}</span>
        {extra}
      </span>
    </div>
  )
}

/**
 * Payments and messages speak the booking badges' four shapes (admin-console.md
 * section 5): a filled check is done, an outlined check an earlier success, a
 * clock is waiting, a cross failed; `lapsed` is a muted cross, for something
 * that ended without failing.
 */
type Shape = StatusShape | 'lapsed'

const PAYMENT_SHAPES: Record<string, Shape | undefined> = {
  succeeded: 'current',
  refunded: 'earlier',
  initiated: 'waiting',
  pending: 'waiting',
  // Waiting on him: the money is to go back.
  refund_due: 'waiting',
  failed: 'failed',
}

const MESSAGE_SHAPES: Record<string, Shape | undefined> = {
  done: 'current',
  sent: 'current',
  pending: 'waiting',
  queued: 'waiting',
  processing: 'waiting',
  failed: 'failed',
  cancelled: 'lapsed',
}

/** The shape beside a payment's or a message's word; a status with no shape shows the word alone. */
function Glyph({ shape, className }: { shape: Shape | undefined; className?: string }) {
  if (shape === undefined) return null
  if (shape === 'lapsed') return <StatusShapeGlyph shape="failed" tone="muted" className={className} />
  return <StatusShapeGlyph shape={shape} className={className} />
}

/**
 * A "·"-separated history line that wraps between its pairs ("our ref a1b2c3d4")
 * rather than inside one. A pair wider than the column still breaks, so nothing
 * overflows. The text is unchanged.
 */
function wholePairs(line: string) {
  const parts = line.split(' · ')
  return parts.map((part, index) => (
    <span key={index}>
      <span className="inline-block max-w-full wrap-anywhere">{part}</span>
      {index < parts.length - 1 && ' · '}
    </span>
  ))
}

function Payments({
  booking,
  busy,
  onRefund,
}: {
  booking: AdminBooking
  busy: boolean
  onRefund: (paymentId: string, reference: string) => Promise<void>
}) {
  const { t } = useTranslation()
  return (
    <Section title={t('admin:booking.sections.payments')}>
      {booking.payments.length === 0 ? (
        <p className={META}>{t('admin:booking.noPayments')}</p>
      ) : (
        <ul className="flex flex-col">
          {booking.payments.map((payment) => {
            const cash = payment.provider === 'cash'
            // An online request that recorded cash voided (item 7): nothing failed.
            const replaced = payment.status === 'failed' && payment.failureReason === SUPERSEDED_BY_CASH
            const owing = (payment.status === 'failed' && !replaced) || payment.status === 'refund_due'
            return (
              <li key={payment.id} className="flex flex-col gap-2 border-b py-4 first:pt-0 last:border-b-0 last:pb-0">
                <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
                  <span className="min-w-0">
                    {cash
                      ? t('admin:booking.cash.label')
                      : t(`admin:booking.paymentKinds.${payment.kind}`, { defaultValue: payment.kind })}{' '}
                    ·{' '}
                    <span className={cn(DATA, 'whitespace-nowrap')}>{formatMoney(payment.amountRwf)}</span>
                  </span>
                  <span className={cn('flex min-w-0 items-center gap-2 text-sm sm:ml-auto', owing ? 'text-destructive' : 'text-muted-foreground')}>
                    <Glyph
                      shape={replaced ? 'lapsed' : PAYMENT_SHAPES[payment.status]}
                      className={payment.status === 'refund_due' ? 'text-destructive' : undefined}
                    />
                    <span className="min-w-0">
                      <span className={owing ? 'font-medium' : undefined}>
                        {replaced
                          ? t('admin:booking.cash.replaced')
                          : t(`admin:booking.paymentStatus.${payment.status}`, { defaultValue: payment.status })}
                      </span>
                      {payment.settledAt !== null && (
                        <span className={cn(LOG, 'text-muted-foreground whitespace-nowrap')}> · {formatDateTime(payment.settledAt)}</span>
                      )}
                    </span>
                  </span>
                </div>
                <p className={cn(LOG, 'text-muted-foreground')}>
                  {wholePairs(
                    `${
                      cash
                        ? t('admin:booking.cash.refs', { ourRef: payment.ourRef })
                        : t('admin:booking.paymentRefs', {
                            provider: payment.provider,
                            ourRef: payment.ourRef,
                            providerRef: payment.providerRef ?? '—',
                          })
                    }${payment.refundReference !== null ? ` · ${t('admin:booking.refundReference', { reference: payment.refundReference })}` : ''}`,
                  )}
                </p>
                {payment.note !== null && <p className={cn(META, 'whitespace-pre-line wrap-anywhere')}>{payment.note}</p>}
                {payment.canRecordRefund && <RefundForm payment={payment} busy={busy} onSubmit={onRefund} />}
              </li>
            )
          })}
        </ul>
      )}
    </Section>
  )
}

/** The `failureReason` of an online request that recorded cash voided (backend payments/cash.ts). */
const SUPERSEDED_BY_CASH = 'superseded_by_cash'

/** Cash the client handed over (item 7): at most what is owed, and prefilled with it. */
function CashForm({
  outstandingRwf,
  busy,
  onSubmit,
}: {
  outstandingRwf: number
  busy: boolean
  onSubmit: (amountRwf: number, note: string | null) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [amount, setAmount] = useState(String(outstandingRwf))
  const [note, setNote] = useState('')
  const value = Number(amount)
  const valid = amount.trim() !== '' && Number.isInteger(value) && value >= 1 && value <= outstandingRwf

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!valid) return
    const trimmed = note.trim()
    void onSubmit(value, trimmed === '' ? null : trimmed)
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <div className={FIELD_GROUP}>
        <Label htmlFor={`${fieldId}amount`}>{t('admin:booking.cash.amount')}</Label>
        <Input
          id={`${fieldId}amount`}
          type="number"
          inputMode="numeric"
          min={1}
          max={outstandingRwf}
          step={1}
          required
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          aria-invalid={valid ? undefined : true}
          aria-describedby={`${fieldId}amountHint`}
          className={cn(FIELD, 'font-mono tabular-nums sm:w-48')}
        />
        <p id={`${fieldId}amountHint`} className={cn(HINT, !valid && 'text-destructive')}>
          {t('admin:booking.cash.amountHint', { amount: formatMoney(outstandingRwf) })}
        </p>
      </div>
      <div className={FIELD_GROUP}>
        <Label htmlFor={`${fieldId}note`}>{t('admin:booking.cash.note')}</Label>
        <Textarea
          id={`${fieldId}note`}
          rows={2}
          maxLength={500}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          className={TEXTAREA}
        />
      </div>
      <p className={HINT}>{t('admin:booking.cash.explain')}</p>
      <Button type="submit" size="console" className={cn(BUTTON_WIDTH, 'sm:self-start')} aria-disabled={busy || !valid}>
        {t('admin:booking.cash.submit')}
      </Button>
    </form>
  )
}

function RefundForm({
  payment,
  busy,
  onSubmit,
}: {
  payment: AdminPayment
  busy: boolean
  onSubmit: (paymentId: string, reference: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reference = String(new FormData(event.currentTarget).get('reference') ?? '').trim()
    if (reference === '') return
    void onSubmit(payment.id, reference)
  }

  return (
    <form onSubmit={submit} className={cn(SUBPANEL, 'mt-2')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className={FIELD_GROUP}>
          <Label htmlFor={fieldId}>{t('admin:booking.refund.reference')}</Label>
          <Input id={fieldId} name="reference" required className={cn(FIELD, 'font-mono sm:w-56')} />
        </div>
        <Button type="submit" variant="console-outline" size="console" className={BUTTON_WIDTH} aria-disabled={busy}>
          {t('admin:booking.refund.record', { amount: formatMoney(payment.amountRwf) })}
        </Button>
      </div>
      <p className={HINT}>{t('admin:booking.refund.note')}</p>
    </form>
  )
}

/**
 * The photos, once the shoot is done (plan.md Task 21; spec §3.5 steps 5-7,
 * §6.20): the link on his own host, the day it stops working, and the email
 * that hands the client both.
 *
 * Saving is not sending. He pastes the link, checks it opens, and sends when
 * he is ready -- and can send again whenever a link is replaced or an email
 * goes astray. The date is left blank to take the default the API dates it
 * with (today plus 90 days, spec A-8).
 */
function DeliveryForm({
  booking,
  busy,
  editing,
  onEdit,
  onCloseEdit,
  failureNote,
  onSave,
  onSend,
}: {
  booking: AdminBooking
  busy: boolean
  /** The link form is open in its dialog. */
  editing: boolean
  onEdit: () => void
  onCloseEdit: () => void
  failureNote: ReactNode
  onSave: (body: { url: string; expiresOn?: string; note?: string | null }) => Promise<void>
  /** `recipient` only when the photographer changed the address. */
  onSend: (recipient?: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const { delivery, actions } = booking
  const [confirming, setConfirming] = useState(false)
  const [url, setUrl] = useState(delivery.url ?? '')
  const [expiresOn, setExpiresOn] = useState(delivery.expiresOn ?? '')
  const [note, setNote] = useState(delivery.note ?? '')

  // Closing the dialog without saving discards the edit: each opening starts
  // from what is stored.
  function openEdit() {
    setUrl(delivery.url ?? '')
    setExpiresOn(delivery.expiresOn ?? '')
    setNote(delivery.note ?? '')
    onEdit()
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (url.trim() === '') return
    void onSave({
      url: url.trim(),
      ...(expiresOn === '' ? {} : { expiresOn }),
      note: note.trim() === '' ? null : note.trim(),
    })
  }

  return (
    <Section title={t('admin:booking.sections.delivery')}>
      {delivery.sentAt === null ? (
        <p className={META}>{t('admin:booking.delivery.unsent')}</p>
      ) : (
        <Fact term={t('admin:booking.delivery.sent')} mono>
          {formatDateTime(delivery.sentAt)}
        </Fact>
      )}

      {delivery.url !== null && (
        <div className="flex flex-col gap-4 sm:gap-3">
          <Fact term={t('admin:booking.delivery.url')}>
            <span className="wrap-anywhere">{delivery.url}</span>
          </Fact>
          {delivery.expiresOn !== null && <Fact term={t('admin:booking.delivery.expires')}>{formatDate(delivery.expiresOn)}</Fact>}
        </div>
      )}

      {actions.canEditDelivery && (
        <div className="flex flex-col gap-2">
          <div className={BUTTONS}>
            <Button variant="console-outline" size="console" className={BUTTON_WIDTH} onClick={openEdit}>
              {t(delivery.url === null ? 'admin:booking.delivery.addLink' : 'admin:booking.delivery.changeLink')}
            </Button>
            {/* Only opens the confirm step below; "Send now" there is what sends. */}
            {actions.canSendDelivery && !confirming && (
              <Button
                type="button"
                variant="console-outline"
                size="console"
                className={BUTTON_WIDTH}
                aria-disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t(delivery.sentAt === null ? 'admin:booking.delivery.send' : 'admin:booking.delivery.sendAgain')}
              </Button>
            )}
          </div>
          <p className={HINT}>{t('admin:booking.delivery.note_hint')}</p>
        </div>
      )}

      {actions.canEditDelivery && (
        <FormDialog open={editing} onClose={onCloseEdit} title={t('admin:booking.sections.delivery')}>
          <div className="flex flex-col gap-5">
            {failureNote}
            <form onSubmit={submit} className="flex flex-col gap-5">
              <div className={FIELD_GROUP}>
                <Label htmlFor={`${fieldId}url`}>{t('admin:booking.delivery.url')}</Label>
                <Input
                  id={`${fieldId}url`}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  className={FIELD}
                />
              </div>
              <div className={FIELD_GROUP}>
                <Label htmlFor={`${fieldId}expires`}>{t('admin:booking.delivery.expires')}</Label>
                <Input
                  id={`${fieldId}expires`}
                  type="date"
                  value={expiresOn}
                  onChange={(event) => setExpiresOn(event.target.value)}
                  className={cn(FIELD, 'tabular-nums sm:w-44')}
                />
                <p className={HINT}>{t('admin:booking.delivery.expiresHint')}</p>
              </div>
              <div className={FIELD_GROUP}>
                <Label htmlFor={`${fieldId}note`}>{t('admin:booking.delivery.note')}</Label>
                <Textarea id={`${fieldId}note`} rows={2} value={note} onChange={(event) => setNote(event.target.value)} className={TEXTAREA} />
              </div>
              <div className="flex flex-col gap-2">
                <div className={BUTTONS}>
                  <Button type="submit" size="console" className={BUTTON_WIDTH} aria-disabled={busy}>
                    {t('admin:booking.delivery.save')}
                  </Button>
                  <Button type="button" variant="console-outline" size="console" className={BUTTON_WIDTH} onClick={onCloseEdit}>
                    {t('admin:catalogue.cancel')}
                  </Button>
                </div>
                <p className={HINT}>{t('admin:booking.delivery.note_hint')}</p>
              </div>
            </form>
          </div>
        </FormDialog>
      )}

      {actions.canEditDelivery && actions.canSendDelivery && confirming && (
        <ConfirmRecipient
          contactEmail={booking.contact.email}
          busy={busy}
          onBack={() => setConfirming(false)}
          onConfirm={async (recipient) => {
            await onSend(recipient === booking.contact.email ? undefined : recipient)
            setConfirming(false)
          }}
        />
      )}

    </Section>
  )
}

/**
 * The step between "Send" and the email: who it goes to, prefilled with the
 * booking's address and editable for when the client asked for another. A
 * changed address is for this email only (decided 2026-09-25). Its own form,
 * so Enter in the field confirms rather than saving the link above.
 */
function ConfirmRecipient({
  contactEmail,
  busy,
  onBack,
  onConfirm,
}: {
  contactEmail: string
  busy: boolean
  onBack: () => void
  onConfirm: (recipient: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [recipient, setRecipient] = useState(contactEmail)
  const [invalid, setInvalid] = useState(false)

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmed = recipient.trim()
    // The browser's own email rule, the same one the input shows; the API checks again.
    if (!event.currentTarget.checkValidity() || trimmed === '') {
      setInvalid(true)
      return
    }
    setInvalid(false)
    void onConfirm(trimmed)
  }

  return (
    <form onSubmit={submit} noValidate className={SUBPANEL}>
      <p className="text-base font-medium">{t('admin:booking.delivery.confirmTitle')}</p>
      <div className={FIELD_GROUP}>
        <Label htmlFor={fieldId}>{t('admin:booking.delivery.recipient')}</Label>
        <Input
          id={fieldId}
          type="email"
          autoComplete="off"
          required
          value={recipient}
          aria-invalid={invalid || undefined}
          aria-describedby={`${fieldId}-hint${invalid ? ` ${fieldId}-error` : ''}`}
          onChange={(event) => setRecipient(event.target.value)}
          className={FIELD}
        />
        <p id={`${fieldId}-hint`} className={HINT}>
          {t('admin:booking.delivery.recipientHint', { email: contactEmail })}
        </p>
        {invalid && (
          // The icon repeats the words, so the error is not told by colour alone.
          <p id={`${fieldId}-error`} className="text-destructive flex items-start gap-1.5 text-[0.8125rem] leading-snug">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 shrink-0" />
            <span>{t('admin:booking.delivery.recipientInvalid')}</span>
          </p>
        )}
      </div>
      <div className={BUTTONS}>
        {/* The step's commit: the inverted main button while the step is open. */}
        <Button type="submit" size="console" className={BUTTON_WIDTH} aria-disabled={busy}>
          {t('admin:booking.delivery.confirmSend')}
        </Button>
        <Button type="button" variant="console-outline" size="console" className={BUTTON_WIDTH} onClick={onBack}>
          {t('admin:booking.delivery.back')}
        </Button>
      </div>
    </form>
  )
}

/**
 * The post-shoot add-on picker: what he sells for this service, priced by the
 * catalogue. The API prices it again from the same rows -- a quantity and an id
 * are all that travel, so no amount typed here can decide what a client owes.
 */
function AddonForm({
  serviceId,
  busy,
  onAdd,
}: {
  serviceId: string
  busy: boolean
  onAdd: (addonId: string, quantity: number) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [choices, setChoices] = useState<AdminAddon[] | 'failed' | null>(null)
  const [addonId, setAddonId] = useState('')
  const [quantity, setQuantity] = useState('1')

  useEffect(() => {
    let cancelled = false
    catalogueApi
      .load()
      .then((catalogue) => {
        if (cancelled) return
        // This service's own add-ons, then the ones sold with everything.
        const own = catalogue.services.find((service) => service.id === serviceId)?.addons ?? []
        setChoices([...own, ...catalogue.sharedAddons].filter((addon) => addon.isActive))
      })
      .catch(() => {
        if (!cancelled) setChoices('failed')
      })
    return () => {
      cancelled = true
    }
  }, [serviceId])

  if (choices === null) {
    return (
      <p className={META} role="status">
        {t('admin:booking.addons.loading')}
      </p>
    )
  }
  // A list that would not load is not a list of nothing: saying he sells no
  // add-ons when the request failed would be a plain untruth.
  if (choices === 'failed') {
    return (
      <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t('admin:booking.addons.loadFailed')}
      </p>
    )
  }
  if (choices.length === 0) return <p className={META}>{t('admin:booking.addons.none')}</p>

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (addonId === '') return
    void onAdd(addonId, Number(quantity) || 1)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4 sm:flex-row sm:items-end sm:gap-3">
      <div className={cn(FIELD_GROUP, 'sm:flex-1')}>
        <Label htmlFor={`${fieldId}addon`}>{t('admin:booking.addons.addon')}</Label>
        <select id={`${fieldId}addon`} value={addonId} onChange={(event) => setAddonId(event.target.value)} className={SELECT_CLASS}>
          <option value="">{t('admin:booking.addons.choose')}</option>
          {choices.map((addon) => (
            <option key={addon.id} value={addon.id}>
              {addon.nameEn} · {formatMoney(addon.priceRwf)}
            </option>
          ))}
        </select>
      </div>
      <div className={FIELD_GROUP}>
        <Label htmlFor={`${fieldId}quantity`}>{t('admin:booking.addons.quantity')}</Label>
        <Input
          id={`${fieldId}quantity`}
          type="number"
          min={1}
          max={99}
          value={quantity}
          onChange={(event) => setQuantity(event.target.value)}
          className={cn(FIELD, 'font-mono tabular-nums sm:w-24')}
        />
      </div>
      <Button type="submit" variant="console-outline" size="console" className={BUTTON_WIDTH} aria-disabled={busy}>
        {t('admin:booking.addons.add')}
      </Button>
    </form>
  )
}

function RescheduleForm({
  booking,
  busy,
  onSubmit,
}: {
  booking: AdminBooking
  busy: boolean
  onSubmit: (startsAt: string) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()
  const [value, setValue] = useState(() => kigaliInputValue(booking.schedule.startsAt))

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (value === '') return
    // The field is Kigali wall time whatever zone the browser is in (spec §6.5).
    void onSubmit(`${value}:00${KIGALI_OFFSET}`)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <div className={FIELD_GROUP}>
        <Label htmlFor={fieldId}>{t('admin:booking.reschedule.newStart')}</Label>
        <Input
          id={fieldId}
          type="datetime-local"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          className={cn(FIELD, 'tabular-nums sm:w-60')}
        />
        <p className={HINT}>{t('admin:booking.reschedule.note')}</p>
      </div>
      <Button type="submit" size="console" className={cn(BUTTON_WIDTH, 'sm:self-start')} aria-disabled={busy}>
        {t('admin:booking.reschedule.move')}
      </Button>
    </form>
  )
}

/**
 * Cancelling asks twice: the red-tinted opener on the page, then this form in
 * its dialog, whose confirm, which cannot be undone, is the solid red.
 */
function CancelForm({
  busy,
  onKeep,
  onSubmit,
}: {
  busy: boolean
  onKeep: () => void
  onSubmit: (reason: string | null) => Promise<void>
}) {
  const { t } = useTranslation()
  const fieldId = useId()

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    void onSubmit(reason === '' ? null : reason)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5">
      <Callout variant="console" tone="destructive" icon={TriangleAlert}>
        <p className="font-medium">{t('admin:booking.cancel.warning')}</p>
      </Callout>
      <div className={FIELD_GROUP}>
        <Label htmlFor={fieldId}>{t('admin:booking.cancel.reason')}</Label>
        <Textarea id={fieldId} name="reason" rows={2} className={TEXTAREA} />
      </div>
      <div className={BUTTONS}>
        {/* Irreversible: the console's solid red (never `destructive-solid`, whose dark fill is a text colour). */}
        <Button type="submit" variant="console-destructive-solid" size="console" className={BUTTON_WIDTH} aria-disabled={busy}>
          {t('admin:booking.cancel.confirm')}
        </Button>
        <Button type="button" variant="console-outline" size="console" className={BUTTON_WIDTH} onClick={onKeep}>
          {t('admin:booking.cancel.keep')}
        </Button>
      </div>
    </form>
  )
}

/**
 * An email that wraps at its `@` in a narrow column rather than mid-word. The
 * `<wbr>` adds a break opportunity without changing the text.
 */
function breakableEmail(email: string) {
  const at = email.indexOf('@')
  if (at <= 0) return email
  return (
    <>
      {email.slice(0, at)}
      <wbr />
      {email.slice(at)}
    </>
  )
}

/** An instant as `datetime-local` wants it, in Kigali wall time: `2026-10-09T11:00`. */
function kigaliInputValue(instant: string): string {
  const date = kigaliDateOf(instant)
  return `${date}T${formatTime(instant)}`
}
