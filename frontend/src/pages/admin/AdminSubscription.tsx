import { CircleAlert, CircleCheck, CircleX, Clock, Info, LoaderCircle, Repeat, Smartphone } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UnauthenticatedError } from '@/admin/api'
import { useSubscriptionRefresh } from '@/admin/subscription-refresh'
import {
  PLAN_INTERVALS,
  type PlanInterval,
  type StudioSubscription,
  type SubscriptionMethod,
  type SubscriptionPage,
  type SubscriptionPaymentProgress,
  type SubscriptionPeriod,
  paymentOutcome,
  subscriptionApi,
  yearlySaving,
} from '@/admin/subscription'
import { isPlausiblePhone } from '@/catalogue/bookings'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { CHOICE, DATA, EYEBROW, FIELD, META, PAGE, SECTION_TITLE, TD, TH, TR } from './console/classes'
import { PageHeader } from './console/PageHeader'
import { Line, LoadingRegion } from './console/Skeletons'
import { SubscriptionStatusBadge } from './console/SubscriptionStatusBadge'

/**
 * `/studio/subscription` (marketplace spec Phase 5: R5.2, R5.3, R5.5): where
 * the photographer sees the subscription's status and pays for a month or a
 * year by Mobile Money.
 *
 * - The status card says what the status means: a trial's end, the date paid
 *   until, a lapsed subscription's end and when the profile is hidden, or that
 *   it is hidden. The status is the API's, computed at its clock.
 * - Paying early never loses time: the new period starts where the current one
 *   ends (R5.3), and the page says so before he pays.
 * - The amount is the platform's price for the plan, shown here and charged by
 *   the server; the request names only the plan (T5.3).
 * - Only one payment at a time (R5.2): a payment still waiting on the phone,
 *   found on load or named by a `409 payment_in_progress`, is followed rather
 *   than a second one started. Following polls the payment until it settles,
 *   and says "received" only once the API reports it succeeded -- with the new
 *   end date the API answered, never one worked out here.
 * - With no payment provider configured the methods are empty, and the page
 *   says online payment is unavailable instead of offering a form.
 */

/** How often a waiting payment is asked about. */
export const POLL_INTERVAL_MS = 3_000
/** Past this the page stops asking on its own; he can ask again. */
export const POLL_GIVE_UP_MS = 10 * 60_000
/** Consecutive failed checks before the page admits it cannot check. */
const TROUBLE_AFTER_FAILURES = 3

type Loaded = { attempt: number; page: SubscriptionPage | null }

/** The payment being followed. `amountRwf` is unknown for one a 409 named, until its first answer. */
type Following = { ourRef: string; amountRwf: number | null; resumed: boolean }

type Outcome =
  | { kind: 'succeeded'; paidUntil: string }
  | { kind: 'failed'; failure: 'declined' | 'unavailable' }
  | { kind: 'missing' }

export function AdminSubscription() {
  const { t } = useTranslation()
  const refreshLayout = useSubscriptionRefresh()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [following, setFollowing] = useState<Following | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)

  /** Takes a fresh page; a payment it says is still waiting is followed, unless one already is. */
  const accept = useCallback((forAttempt: number, page: SubscriptionPage) => {
    setLoaded({ attempt: forAttempt, page })
    const waiting = page.subscription?.paymentInProgress ?? null
    if (waiting !== null && paymentOutcome(waiting.status) === 'waiting') {
      setFollowing((current) => current ?? { ourRef: waiting.ourRef, amountRwf: waiting.amountRwf, resumed: true })
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    subscriptionApi.load().then(
      (page) => !cancelled && accept(attempt, page),
      (error: unknown) => {
        // A 401 has dropped the studio session; the layout's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, page: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt, accept])

  /** After a payment settles: read the page again, keeping what is on screen until it answers. */
  function reloadQuietly() {
    subscriptionApi.load().then(
      (page) => accept(attempt, page),
      () => {},
    )
    refreshLayout()
  }

  function settled(progress: SubscriptionPaymentProgress) {
    setFollowing(null)
    const result = paymentOutcome(progress.payment.status)
    if (result === 'succeeded') setOutcome({ kind: 'succeeded', paidUntil: progress.subscription.currentPeriodEndsAt })
    else if (result === 'failed') setOutcome({ kind: 'failed', failure: progress.payment.failure ?? 'declined' })
    else setOutcome(null)
    reloadQuietly()
  }

  function missing() {
    setFollowing(null)
    setOutcome({ kind: 'missing' })
    reloadQuietly()
  }

  function follow(next: Following) {
    setOutcome(null)
    setFollowing(next)
  }

  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const page = current?.page ?? null

  return (
    <main className={cn(PAGE, 'max-w-4xl')}>
      <PageHeader eyebrow={t('studio:nav.label')} eyebrowIcon={Repeat} title={t('admin:subscription.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:subscription.intro')}</p>
      </PageHeader>

      {current === null && <PageSkeleton />}
      {current !== null && page === null && (
        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:gap-4" role="alert">
          <p className="text-destructive flex items-start gap-2 text-sm">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:subscription.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:subscription.retry')}
          </Button>
        </div>
      )}

      {page !== null && page.subscription === null && (
        <Callout variant="console" tone="info" icon={Info} data-subscription="none">
          <p>{t('admin:subscription.none')}</p>
        </Callout>
      )}

      {page !== null && page.subscription !== null && (
        <>
          <StatusCard subscription={page.subscription} />

          <section className="flex flex-col gap-5 border-t pt-8 lg:pt-12" aria-labelledby="subscription-pay">
            <h2 id="subscription-pay" className={SECTION_TITLE}>
              {t('admin:subscription.pay.title')}
            </h2>

            {outcome !== null && <OutcomeNotice outcome={outcome} />}

            {following !== null ? (
              <PaymentFollow
                key={following.ourRef}
                following={following}
                onSettled={settled}
                onMissing={missing}
              />
            ) : page.methods.length === 0 ? (
              <Callout variant="console" tone="warning" icon={CircleAlert} role="alert" data-subscription="no-methods">
                <p>{t('admin:subscription.pay.noMethods')}</p>
              </Callout>
            ) : (
              <PayForm
                subscription={page.subscription}
                prices={page.prices}
                methods={page.methods}
                onFollow={follow}
              />
            )}
          </section>

          <History subscription={page.subscription} />
        </>
      )}
    </main>
  )
}

function PageSkeleton() {
  const { t } = useTranslation()
  return (
    <LoadingRegion label={t('admin:subscription.loading')} className="flex flex-col gap-8">
      <div className="flex flex-col gap-3 rounded-xs border p-4 sm:p-6">
        <Line w="w-24" className="h-6" />
        <Line w="w-80 max-w-full" />
      </div>
      <div className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
        <Line w="w-56" className="h-6" />
        <div className="grid gap-3 sm:grid-cols-2">
          <Line w="w-full" className="h-20" />
          <Line w="w-full" className="h-20" />
        </div>
        <Line w="w-full max-w-sm" className="h-11 lg:h-10" />
      </div>
    </LoadingRegion>
  )
}

/** The status, and in one sentence what it means for his bookings and his profile. */
function StatusCard({ subscription }: { subscription: StudioSubscription }) {
  const { t } = useTranslation()
  const date = formatDateTime(subscription.currentPeriodEndsAt)
  const graceEndsAt = formatDateTime(subscription.graceEndsAt)
  const tone = subscription.status === 'expired' ? 'border-destructive/40' : subscription.status === 'past_due' ? 'border-console-warning/50' : ''

  return (
    <section
      aria-label={t('admin:subscription.status.label')}
      data-subscription-card={subscription.status}
      className={cn('flex flex-col gap-3 rounded-xs border p-4 sm:p-6', tone)}
    >
      <p className={EYEBROW}>{t('admin:subscription.status.label')}</p>
      <SubscriptionStatusBadge status={subscription.status} />
      <p className="text-base text-pretty">{t(`admin:subscription.summary.${subscription.status}`, { date, graceEndsAt })}</p>
    </section>
  )
}

type PayError =
  | 'invalid_request'
  | 'photographer_not_approved'
  | 'no_subscription'
  | 'method'
  | 'rate_limited'
  | 'rejected'
  | 'unavailable'
  | 'failed'

function PayForm({
  subscription,
  prices,
  methods,
  onFollow,
}: {
  subscription: StudioSubscription
  prices: SubscriptionPage['prices']
  methods: SubscriptionMethod[]
  onFollow: (following: Following) => void
}) {
  const { t } = useTranslation()
  const [plan, setPlan] = useState<PlanInterval>('monthly')
  const [method, setMethod] = useState<SubscriptionMethod | null>(methods[0] ?? null)
  const [phoneInvalid, setPhoneInvalid] = useState(false)
  const [errors, setErrors] = useState<PayError[]>([])
  const [submitting, setSubmitting] = useState(false)
  const phoneRef = useRef<HTMLInputElement>(null)

  // A method the page no longer offers (a reload dropped it) is not a choice.
  const chosen = method !== null && methods.includes(method) ? method : (methods[0] ?? null)
  const saving = yearlySaving(prices)
  const amount = formatMoney(prices[plan])
  // The API's status is at its clock: trialing or active means the current period is still running.
  const runningUntil = subscription.status === 'trialing' || subscription.status === 'active'

  function markPhone() {
    setPhoneInvalid(true)
    phoneRef.current?.focus()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (submitting || chosen === null) return
    setErrors([])

    const phone = String(new FormData(event.currentTarget).get('phone') ?? '').trim()
    if (!isPlausiblePhone(phone)) {
      markPhone()
      return
    }
    setPhoneInvalid(false)

    setSubmitting(true)
    let result
    try {
      result = await subscriptionApi.pay({ planInterval: plan, method: chosen, phone })
    } catch (error) {
      setSubmitting(false)
      // A 401 has dropped the session; the guard takes him to sign in.
      if (!(error instanceof UnauthenticatedError)) setErrors(['failed'])
      return
    }
    setSubmitting(false)

    switch (result.status) {
      case 'started':
        onFollow({ ourRef: result.ourRef, amountRwf: result.amountRwf, resumed: false })
        return
      case 'in_progress':
        onFollow({ ourRef: result.ourRef, amountRwf: null, resumed: true })
        return
      case 'not_approved':
        setErrors(['photographer_not_approved'])
        return
      case 'no_subscription':
        setErrors(['no_subscription'])
        return
      case 'invalid': {
        const next: PayError[] = []
        if (result.fields.includes('method')) next.push('method')
        if (result.fields.includes('phone')) markPhone()
        // A field the page has no control for must still be said.
        if (next.length === 0 && !result.fields.includes('phone')) next.push('failed')
        setErrors(next)
        return
      }
      case 'bad_request':
        setErrors(['invalid_request'])
        return
      case 'rate_limited':
        setErrors(['rate_limited'])
        return
      case 'not_started':
        setErrors([result.reason])
        return
      case 'failed':
        setErrors(['failed'])
        return
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-6" aria-label={t('admin:subscription.pay.title')}>
      <fieldset className="flex flex-col gap-2">
        <legend className={cn(EYEBROW, 'mb-2')}>{t('admin:subscription.plan.legend')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {PLAN_INTERVALS.map((interval) => (
            <Label
              key={interval}
              className={cn(
                'flex min-h-11 cursor-pointer flex-col items-start gap-1.5 rounded-xs border p-4 text-base font-normal motion-safe:transition-colors motion-safe:duration-150',
                plan === interval ? 'border-console-link bg-console-surface' : 'hover:bg-accent',
              )}
            >
              <span className="flex items-center gap-2.5 font-medium">
                <input
                  type="radio"
                  name="planInterval"
                  value={interval}
                  checked={plan === interval}
                  onChange={() => setPlan(interval)}
                  className={CHOICE}
                />
                {t(`admin:subscription.plan.${interval}`)}
              </span>
              <span className={DATA}>
                {t(`admin:subscription.plan.${interval === 'monthly' ? 'monthlyPrice' : 'yearlyPrice'}`, { price: formatMoney(prices[interval]) })}
              </span>
              {interval === 'yearly' && saving !== null && (
                <span className="text-console-success text-sm" data-yearly-saving="">
                  {t('admin:subscription.plan.saving', { amount: formatMoney(saving) })}
                </span>
              )}
            </Label>
          ))}
        </div>
      </fieldset>

      <Callout variant="console" tone="info" icon={Clock} data-subscription="on-top">
        <p>
          {runningUntil
            ? t('admin:subscription.pay.onTop', { date: formatDateTime(subscription.currentPeriodEndsAt) })
            : t('admin:subscription.pay.startsNow')}
        </p>
      </Callout>

      <fieldset className="flex flex-col gap-2">
        <legend className={cn(EYEBROW, 'mb-1')}>{t('checkout:methods.legend')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {methods.map((option) => (
            <Label key={option} className="min-h-11 items-center gap-2.5 text-base font-normal lg:min-h-8 pointer-coarse:min-h-11">
              <input
                type="radio"
                name="method"
                value={option}
                checked={chosen === option}
                onChange={() => setMethod(option)}
                className={CHOICE}
              />
              {t(`checkout:methods.${option}`)}
            </Label>
          ))}
        </div>
      </fieldset>

      <AdminField
        label={t('checkout:phone.label')}
        hint={t('checkout:phone.hint')}
        error={phoneInvalid ? t('checkout:phone.invalid') : null}
        className="max-w-sm"
      >
        {(props) => (
          <Input
            {...props}
            ref={phoneRef}
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            className={cn(FIELD, 'font-mono')}
          />
        )}
      </AdminField>

      <div className="flex flex-col gap-4 border-t pt-6">
        {errors.map((error) => (
          <p key={error} className="text-destructive flex items-start gap-2 text-sm" role="alert" data-pay-error={error}>
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t(`admin:subscription.errors.${error}`)}
          </p>
        ))}
        <Button
          type="submit"
          size="console"
          className="sm:min-w-40 sm:self-start"
          // Not `disabled`: that would drop keyboard focus mid-submit; a second press is ignored.
          aria-disabled={submitting}
          aria-busy={submitting}
        >
          {submitting ? t('admin:subscription.pay.submitting') : t('admin:subscription.pay.submit', { amount })}
        </Button>
      </div>
    </form>
  )
}

/**
 * Follows one payment until it settles: polls every 3 seconds, says so after
 * three failed checks in a row, and stops after 10 minutes with "Check again".
 * Hands the settled answer up; never decides an outcome itself.
 */
function PaymentFollow({
  following,
  onSettled,
  onMissing,
}: {
  following: Following
  onSettled: (progress: SubscriptionPaymentProgress) => void
  onMissing: () => void
}) {
  const { t } = useTranslation()
  const [amountRwf, setAmountRwf] = useState<number | null>(following.amountRwf)
  const [failures, setFailures] = useState(0)
  const [gaveUp, setGaveUp] = useState(false)
  const [round, setRound] = useState(0)
  // The callbacks change identity on every render of the page; the poll must not restart for that.
  const handlers = useRef({ onSettled, onMissing })
  useEffect(() => {
    handlers.current = { onSettled, onMissing }
  })

  useEffect(() => {
    let stopped = false
    const startedAt = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined

    const poll = async () => {
      try {
        const progress = await subscriptionApi.payment(following.ourRef)
        if (stopped) return
        setFailures(0)
        if (progress === null) {
          handlers.current.onMissing()
          return
        }
        setAmountRwf(progress.payment.amountRwf)
        if (paymentOutcome(progress.payment.status) !== 'waiting') {
          handlers.current.onSettled(progress)
          return
        }
      } catch (error) {
        if (stopped || error instanceof UnauthenticatedError) return
        setFailures((n) => n + 1)
      }
      if (Date.now() - startedAt >= POLL_GIVE_UP_MS) {
        setGaveUp(true)
        return
      }
      timer = setTimeout(() => void poll(), POLL_INTERVAL_MS)
    }
    void poll()

    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [following.ourRef, round])

  return (
    <div className="flex flex-col gap-4 rounded-xs border p-4 sm:p-6" data-following={following.ourRef}>
      <div className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="flex items-center gap-2.5 text-lg font-medium">
          {/* The one moving thing on the page; a still phone under reduced motion. */}
          <LoaderCircle aria-hidden="true" className="size-5 shrink-0 motion-safe:animate-spin motion-reduce:hidden" />
          <Smartphone aria-hidden="true" className="hidden size-5 shrink-0 motion-reduce:block" />
          {t('admin:subscription.progress.waitingTitle')}
        </p>
        {following.resumed && <p className="text-sm">{t('admin:subscription.progress.resumed')}</p>}
        {amountRwf !== null && <p className="text-sm">{t('admin:subscription.progress.waitingBody', { amount: formatMoney(amountRwf) })}</p>}
        <p className={META}>{t('admin:subscription.progress.waitingWait')}</p>
        {failures >= TROUBLE_AFTER_FAILURES && !gaveUp && <p className={META}>{t('admin:subscription.progress.connectionTrouble')}</p>}
      </div>
      {gaveUp && (
        <div className="flex flex-col items-start gap-2">
          <p className="text-sm">{t('admin:subscription.progress.stillWaiting')}</p>
          <Button
            variant="console-outline"
            size="console-sm"
            onClick={() => {
              setGaveUp(false)
              setRound((n) => n + 1)
            }}
          >
            {t('admin:subscription.progress.checkAgain')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** What the last payment came to. Focus moves to it, because it is news. */
function OutcomeNotice({ outcome }: { outcome: Outcome }) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.focus()
  }, [outcome])

  return (
    <div ref={ref} tabIndex={-1} className="outline-none" data-outcome={outcome.kind}>
      {outcome.kind === 'succeeded' && (
        <Callout variant="console" tone="success" icon={CircleCheck} role="status">
          <p className="font-medium">{t('admin:subscription.progress.succeededTitle')}</p>
          <p>{t('admin:subscription.progress.succeededBody', { date: formatDateTime(outcome.paidUntil) })}</p>
        </Callout>
      )}
      {outcome.kind === 'failed' && (
        <Callout variant="console" tone="destructive" icon={CircleX} role="alert">
          <p className="font-medium">{t('admin:subscription.progress.failedTitle')}</p>
          <p>
            {outcome.failure === 'unavailable'
              ? t('admin:subscription.progress.failedUnavailable')
              : t('admin:subscription.progress.failedDeclined')}
          </p>
        </Callout>
      )}
      {outcome.kind === 'missing' && (
        <Callout variant="console" tone="warning" icon={CircleAlert} role="alert">
          <p>{t('admin:subscription.progress.missing')}</p>
        </Callout>
      )}
    </div>
  )
}

/** Every period, newest first: the trial, then each month or year paid. */
function History({ subscription }: { subscription: StudioSubscription }) {
  const { t } = useTranslation()
  const currentId = subscription.currentPeriod?.id ?? null

  return (
    <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12" aria-labelledby="subscription-history">
      <h2 id="subscription-history" className={SECTION_TITLE}>
        {t('admin:subscription.history.title')}
      </h2>
      {subscription.periods.length === 0 ? (
        <p className={META}>{t('admin:subscription.history.empty')}</p>
      ) : (
        <div className="@container">
          <table role="table" className="w-full border-collapse text-[0.9375rem]">
            <caption className="sr-only">{t('admin:subscription.history.title')}</caption>
            <thead role="rowgroup" className="@max-[40rem]:sr-only">
              <tr role="row" className="border-b">
                {(['period', 'dates', 'price', 'paid'] as const).map((column) => (
                  <th key={column} role="columnheader" scope="col" className={cn(TH, column === 'price' && 'text-right')}>
                    {t(`admin:subscription.history.columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[40rem]:block">
              {subscription.periods.map((period) => (
                <PeriodRow key={period.id} period={period} current={period.id === currentId} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

const STACKED_ROW = '@max-[40rem]:flex @max-[40rem]:flex-col @max-[40rem]:gap-1.5 @max-[40rem]:py-4'
const STACKED_CELL = '@max-[40rem]:p-0'

function PeriodRow({ period, current }: { period: SubscriptionPeriod; current: boolean }) {
  const { t } = useTranslation()
  const name = period.kind === 'trial' ? t('admin:subscription.history.trial') : t(`admin:subscription.history.${period.planInterval ?? 'monthly'}`)

  return (
    <tr role="row" data-period={period.id} className={cn(TR, STACKED_ROW)}>
      <td role="cell" className={cn(TD, STACKED_CELL)}>
        <span className="flex flex-wrap items-center gap-2">
          {name}
          {current && <Badge variant="console-success">{t('admin:subscription.history.current')}</Badge>}
        </span>
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', STACKED_CELL)}>
        {t('admin:subscription.history.dates', { start: formatDateTime(period.startsAt), end: formatDateTime(period.endsAt) })}
      </td>
      <td role="cell" className={cn(TD, 'text-right @max-[40rem]:text-left', STACKED_CELL)}>
        <span className={cn(DATA, 'whitespace-nowrap')}>
          {period.kind === 'trial' ? t('admin:subscription.history.free') : formatMoney(period.priceRwf)}
        </span>
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', STACKED_CELL)}>
        {period.kind === 'trial' ? null : period.paidAt !== null ? formatDateTime(period.paidAt) : t('admin:subscription.history.notPaid')}
      </td>
    </tr>
  )
}
