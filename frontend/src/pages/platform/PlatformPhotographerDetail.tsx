import {
  Banknote,
  CalendarClock,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleX,
  ExternalLink,
  ImageOff,
  Landmark,
  type LucideIcon,
  Mail,
  PencilLine,
  Send,
  Smartphone,
  TriangleAlert,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useLocation, useParams } from 'react-router'
import { BOOKING_STATUSES } from '@/admin/bookings'
import type { SubscriptionPeriod } from '@/admin/subscription'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatMoney } from '@/lib/format'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'
import {
  type Moderation,
  type PlatformPhotographer,
  type PlatformPhotographerDetail as Detail,
  handleChangedSinceSubmission,
  isPhotographerStatus,
  isReviewFilter,
  platformApi,
} from '@/platform/photographers'
import { DATA, EYEBROW, LINK, META, PAGE, SECTION_TITLE, TD, TH, TR } from '@/pages/admin/console/classes'
import { MetaItem, PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'
import { StatGrid, StatTile } from '@/pages/admin/console/StatGrid'
import { SubscriptionStatusBadge } from '@/pages/admin/console/SubscriptionStatusBadge'
import { AuditEntryRow } from './AuditEntryRow'
import type { ActivityLinkState } from './PlatformActivity'
import type { PhotographersListState } from './PlatformPhotographers'
import { HandleChangedBadge, ModerationButtons, ModerationDialog, type PendingModeration, PhotographerStatusBadge } from './PhotographerModeration'

type State = { id: string; attempt: number } & ({ kind: 'ready'; detail: Detail } | { kind: 'missing' } | { kind: 'failed' })
type Notice = { tone: 'success' | 'warning'; text: string }

const SECTION = 'flex flex-col gap-5 border-t pt-8 lg:pt-12'

/**
 * Where Back returns: the list's own view (`?review=` or `?status=`) when the
 * list linked here, else the plain list. Only the two filters the list reads
 * are carried, so router state can never steer the link elsewhere.
 */
function backTo(state: unknown): string {
  const search = (state as Partial<PhotographersListState> | null)?.listSearch
  if (typeof search !== 'string') return '/platform/photographers'
  const from = new URLSearchParams(search)
  const review = from.get('review')
  const status = from.get('status')
  const kept = new URLSearchParams()
  if (isReviewFilter(review)) kept.set('review', review)
  else if (isPhotographerStatus(status)) kept.set('status', status)
  const query = kept.toString()
  return query === '' ? '/platform/photographers' : `/platform/photographers?${query}`
}

/**
 * `/platform/photographers/:id` (marketplace spec R9.1, R9.4; Phase 9): one
 * photographer in full, from one read -- the moderation timeline, the
 * profile, the setup checklist, the subscription and its periods, the payout
 * method MASKED (user decision 4: the full number stays on the payouts
 * screen, where money is sent) with the 72-hour warning, bookings by status,
 * earnings (a negative payable shown as such), and the latest activity.
 *
 * Approve, suspend and reactivate are the list's own buttons and dialog; the
 * API's `409 not_submitted` is handled the same way. After any of them the
 * page reads the photographer again, quietly, so every section agrees.
 */
export function PlatformPhotographerDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const location = useLocation()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [pending, setPending] = useState<PendingModeration | null>(null)

  useEffect(() => {
    let cancelled = false
    platformApi.get(id).then(
      (detail) => !cancelled && setState({ id, attempt, kind: 'ready', detail }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        const missing = error instanceof ApiError && (error.status === 404 || error.status === 400)
        setState({ id, attempt, kind: missing ? 'missing' : 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const current = state !== null && state.id === id && state.attempt === attempt ? state : null
  const detail = current?.kind === 'ready' ? current.detail : null

  /** Shows the moderated row at once, then reads everything again; the page stays as it is until that lands. */
  function refresh(photographer?: PlatformPhotographer) {
    if (photographer !== undefined) {
      setState((now) =>
        now?.kind === 'ready' ? { ...now, detail: { ...now.detail, photographer: { ...now.detail.photographer, ...photographer } } } : now,
      )
    }
    platformApi.get(id).then(
      (next) => setState((now) => (now?.id === id ? { id, attempt: now.attempt, kind: 'ready', detail: next } : now)),
      (error: unknown) => {
        if (error instanceof ApiError && error.status === 404) setState((now) => (now?.id === id ? { id, attempt: now.attempt, kind: 'missing' } : now))
        // Otherwise the page keeps what it shows: the action's own answer is already in place.
      },
    )
  }

  function onDone(action: Moderation, photographer: PlatformPhotographer) {
    setPending(null)
    const done = action === 'approve' ? 'approved' : action === 'suspend' ? 'suspended' : 'reactivated'
    setNotice({ tone: 'success', text: t(`platform:photographers.done.${done}`, { name: photographer.displayName }) })
    refresh(photographer)
  }

  function onStale(photographer: PlatformPhotographer) {
    setPending(null)
    setNotice({
      tone: 'warning',
      text: t('platform:photographers.stale', {
        name: photographer.displayName,
        status: t(`platform:photographers.status.${photographer.status}`).toLowerCase(),
      }),
    })
    refresh(photographer)
  }

  function onNotSubmitted(photographer: PlatformPhotographer) {
    setPending(null)
    setNotice({ tone: 'warning', text: t('platform:photographers.notSubmittedError', { name: photographer.displayName }) })
    refresh(photographer)
  }

  function onGone() {
    setPending(null)
    setNotice({ tone: 'warning', text: t('platform:photographers.notFound') })
    setState((now) => (now === null ? now : { id, attempt: now.attempt, kind: 'missing' }))
  }

  const back = <BackLink to={backTo(location.state)}>{t('platform:photographer.back')}</BackLink>
  const eyebrow = t('platform:nav.photographers')

  if (current === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <LoadingRegion label={t('platform:photographer.loading')} className="flex flex-col gap-8 lg:gap-12">
          <div className="flex flex-col gap-3.5">
            <Line w="w-28" className="h-3" />
            <div className="flex flex-wrap items-center gap-3.5">
              <Skeleton className="h-9 w-64 max-w-full rounded-xs" />
              <Skeleton className="h-7 w-24 rounded-xs" />
            </div>
            <Line w="w-80 max-w-full" />
          </div>
          {[0, 1, 2].map((section) => (
            <div key={section} className="flex flex-col gap-4 border-t pt-8">
              <Line w="w-36" className="h-6" />
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex justify-between gap-6">
                  <Line w="w-48 max-w-full" />
                  <Line w="w-28" />
                </div>
              ))}
            </div>
          ))}
        </LoadingRegion>
      </main>
    )
  }

  if (current.kind === 'failed') {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:photographer.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:photographer.retry')}
          </Button>
        </div>
      </main>
    )
  }

  if (current.kind === 'missing' || detail === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <PageHeader eyebrow={eyebrow} eyebrowIcon={Users} title={t('platform:photographer.missing')}>
          <p className={META}>{t('platform:photographer.missingBody')}</p>
        </PageHeader>
        {notice !== null && (
          <Callout variant="console" tone={notice.tone} icon={CircleAlert} role="alert">
            <p>{notice.text}</p>
          </Callout>
        )}
      </main>
    )
  }

  const { photographer } = detail

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      {back}
      <PageHeader
        eyebrow={eyebrow}
        eyebrowIcon={Users}
        title={photographer.displayName}
        badges={
          <>
            <PhotographerStatusBadge status={photographer.status} />
            {handleChangedSinceSubmission(photographer) && <HandleChangedBadge />}
          </>
        }
        meta={
          <>
            <span className="font-mono wrap-anywhere">/p/{photographer.handle}</span>
            <MetaItem icon={Mail}>{photographer.email}</MetaItem>
            {photographer.status === 'approved' && (
              <a
                href={`/p/${encodeURIComponent(photographer.handle)}`}
                target="_blank"
                rel="noreferrer"
                className={cn(LINK, 'inline-flex items-center gap-1.5 max-lg:min-h-11 pointer-coarse:min-h-11')}
              >
                {t('platform:photographer.publicProfile')}
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </>
        }
        actions={
          <ModerationButtons
            photographer={photographer}
            size="console"
            className="lg:items-end"
            buttonsClassName="max-sm:flex-col max-sm:[&>*]:w-full"
            onChoose={(next) => {
              setNotice(null)
              setPending(next)
            }}
          />
        }
      />

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

      {detail.methodChangedRecently && (
        <Callout variant="console" tone="warning" icon={TriangleAlert} data-warning="changed-recently">
          <p>{t('platform:payout.changedRecently')}</p>
        </Callout>
      )}

      <Timeline detail={detail} />
      <ProfileSection detail={detail} />
      <SetupSection detail={detail} />
      <SubscriptionSection detail={detail} />
      <PayoutMethodSection detail={detail} />
      <CountsSection detail={detail} />
      <EarningsSection detail={detail} />
      <ActivitySection detail={detail} />

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

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className={SECTION} aria-labelledby={id} data-section={id}>
      <h2 id={id} className={SECTION_TITLE}>
        {title}
      </h2>
      {children}
    </section>
  )
}

type Event = { key: string; at: string; icon: LucideIcon; text: string; tone?: 'success' | 'danger'; extra?: string }

/** The moderation record, oldest first: only the events that happened. */
function Timeline({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const p = detail.photographer
  const events: Event[] = [{ key: 'signedUp', at: p.createdAt, icon: UserPlus, text: t('platform:photographer.timeline.signedUp') }]
  if (p.submittedAt !== null) events.push({ key: 'submitted', at: p.submittedAt, icon: Send, text: t('platform:photographer.timeline.submitted') })
  if (p.handleChangedAt !== null) {
    events.push({ key: 'handleChanged', at: p.handleChangedAt, icon: PencilLine, text: t('platform:photographer.timeline.handleChanged', { handle: p.handle }) })
  }
  if (p.approvedAt !== null) {
    events.push({
      key: 'approved',
      at: p.approvedAt,
      icon: CircleCheck,
      tone: 'success',
      text: p.approvedBy === null ? t('platform:photographer.timeline.approvedUnknown') : t('platform:photographer.timeline.approved', { email: p.approvedBy.email }),
    })
  }
  if (p.suspendedAt !== null) {
    events.push({
      key: 'suspended',
      at: p.suspendedAt,
      icon: CircleX,
      tone: 'danger',
      text: t('platform:photographer.timeline.suspended'),
      ...(p.suspensionReason === null ? {} : { extra: t('platform:photographers.suspendedReason', { reason: p.suspensionReason }) }),
    })
  }
  events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  return (
    <Section id="photographer-timeline" title={t('platform:photographer.timeline.title')}>
      <ol className="flex flex-col gap-4">
        {events.map((event) => {
          const Icon = event.icon
          return (
            <li key={event.key} data-event={event.key} className="flex gap-3">
              <Icon
                aria-hidden="true"
                className={cn(
                  'mt-0.5 size-4 shrink-0',
                  event.tone === 'success' ? 'text-console-success' : event.tone === 'danger' ? 'text-destructive' : 'text-muted-foreground',
                )}
              />
              <div className="flex min-w-0 flex-col gap-1">
                <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="wrap-anywhere">{event.text}</span>
                  <time dateTime={event.at} className={cn(DATA, 'text-muted-foreground text-sm')}>
                    {formatDateTime(event.at)}
                  </time>
                </p>
                {event.extra !== undefined && <p className={cn(META, 'whitespace-pre-line wrap-anywhere')}>{event.extra}</p>}
              </div>
            </li>
          )
        })}
        {p.submittedAt === null && p.status === 'pending' && (
          <li data-event="notSubmitted" className={cn(META, 'flex gap-3')}>
            <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:photographer.timeline.notSubmitted')}
          </li>
        )}
      </ol>
    </Section>
  )
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'md:col-span-2')}>
      <dt className={EYEBROW}>{label}</dt>
      <dd className="min-w-0 text-[0.9375rem] wrap-anywhere">{children}</dd>
    </div>
  )
}

function Missing({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

function ProfileSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { profile } = detail
  const notGiven = <Missing>{t('platform:photographer.profile.notGiven')}</Missing>
  const hasHidden = profile.categories.some((category) => !category.isActive)
  return (
    <Section id="photographer-profile" title={t('platform:photographer.profile.title')}>
      <dl className="grid gap-x-8 gap-y-5 md:grid-cols-2">
        <Field label={t('platform:photographer.profile.bio')} wide>
          {profile.bio === null || profile.bio.trim() === '' ? (
            <Missing>{t('platform:photographer.profile.noBio')}</Missing>
          ) : (
            <span className="max-w-prose whitespace-pre-line">{profile.bio}</span>
          )}
        </Field>
        <Field label={t('platform:photographer.profile.contactPhone')}>
          {profile.contactPhone === null ? notGiven : <span className={DATA}>{profile.contactPhone}</span>}
        </Field>
        <Field label={t('platform:photographer.profile.whatsappPhone')}>
          {profile.whatsappPhone === null ? notGiven : <span className={DATA}>{profile.whatsappPhone}</span>}
        </Field>
        <Field label={t('platform:photographer.profile.contactEmail')}>{profile.contactEmail ?? notGiven}</Field>
        <Field label={t('platform:photographer.profile.districts')}>
          {profile.districts.length === 0 ? (
            <Missing>{t('platform:photographer.profile.noDistricts')}</Missing>
          ) : (
            profile.districts.map((district) => district.name).join(', ')
          )}
        </Field>
        <Field label={t('platform:photographer.profile.categories')} wide>
          {profile.categories.length === 0 ? (
            <Missing>{t('platform:photographer.profile.noCategories')}</Missing>
          ) : (
            <span className="flex flex-col gap-2">
              <span className="flex flex-wrap gap-2">
                {profile.categories.map((category) =>
                  category.isActive ? (
                    <Badge key={category.slug} variant="console" data-category={category.slug}>
                      {category.name}
                    </Badge>
                  ) : (
                    <Badge
                      key={category.slug}
                      variant="console"
                      data-category={category.slug}
                      data-inactive=""
                      className="border-input text-muted-foreground border border-dotted bg-transparent"
                    >
                      {category.name}
                      <span>({t('platform:photographer.profile.hidden')})</span>
                    </Badge>
                  ),
                )}
              </span>
              {hasHidden && <span className={cn(META, 'text-[0.8125rem]')}>{t('platform:photographer.profile.hiddenHint')}</span>}
            </span>
          )}
        </Field>
        <Field label={t('platform:photographer.profile.cover')} wide>
          {profile.coverImageUrl === null ? (
            <Missing>{t('platform:photographer.profile.noCover')}</Missing>
          ) : (
            <Cover url={profile.coverImageUrl} alt={t('platform:photographer.profile.coverAlt', { name: detail.photographer.displayName })} />
          )}
        </Field>
      </dl>
    </Section>
  )
}

/** The cover at thumbnail size: https only, no referrer, and a plain notice when it will not load. */
function Cover({ url, alt }: { url: string; alt: string }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  const src = safeHttpsUrl(url)
  const box = 'aspect-[4/3] w-48 max-w-full rounded-xs border sm:w-64'
  if (src === null || broken) {
    return (
      <span className={cn(box, 'bg-console-surface text-muted-foreground flex flex-col items-center justify-center gap-1 p-2 text-center text-xs')}>
        <ImageOff aria-hidden="true" className="size-4" />
        {t('admin:portfolio.broken')}
      </span>
    )
  }
  return <img src={src} alt={alt} loading="lazy" referrerPolicy="no-referrer" className={cn(box, 'bg-console-surface block object-cover')} onError={() => setBroken(true)} />
}

function SetupSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { items } = detail.setup
  const done = items.filter((item) => item.done).length
  return (
    <Section id="photographer-setup" title={t('platform:photographer.setup.title')}>
      <h3 className="text-base font-medium tabular-nums">{t('admin:setup.progress', { done, total: items.length })}</h3>
      <ol className="flex flex-col rounded-xs border">
        {items.map((item) => (
          <li key={item.key} data-setup-item={item.key} data-done={item.done} className="flex items-center gap-3 border-b px-4 py-3 last:border-b-0">
            {item.done ? (
              <CircleCheck aria-hidden="true" className="text-console-success size-4 shrink-0" />
            ) : (
              <Circle aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
            )}
            <span className="min-w-0 flex-1">{t(`admin:setup.items.${item.key}.title`)}</span>
            <span className={cn(EYEBROW, item.done && 'text-console-success')}>{item.done ? t('admin:setup.done') : t('admin:setup.todo')}</span>
          </li>
        ))}
      </ol>
    </Section>
  )
}

const STACKED_ROW = '@max-[40rem]:flex @max-[40rem]:flex-col @max-[40rem]:gap-1.5 @max-[40rem]:py-4'
const STACKED_CELL = '@max-[40rem]:p-0'

function SubscriptionSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { subscription } = detail
  return (
    <Section id="photographer-subscription" title={t('platform:photographer.subscription.title')}>
      {subscription === null ? (
        <p className={META}>{t('platform:photographer.subscription.none')}</p>
      ) : (
        <>
          <StatGrid>
            <StatTile icon={CircleCheck} label={t('platform:photographer.subscription.status')}>
              <SubscriptionStatusBadge status={subscription.status} />
            </StatTile>
            <StatTile icon={CalendarClock} label={t('platform:photographer.subscription.takingBookings')}>
              {subscription.takingBookings ? t('platform:photographer.subscription.yes') : t('platform:photographer.subscription.no')}
            </StatTile>
            <StatTile icon={CalendarClock} label={t('platform:photographer.subscription.periodEnd')} mono>
              {formatDateTime(subscription.currentPeriodEndsAt)}
            </StatTile>
            <StatTile icon={CalendarClock} label={t('platform:photographer.subscription.graceEnd')} mono>
              {formatDateTime(subscription.graceEndsAt)}
            </StatTile>
          </StatGrid>
          <h3 className="text-base font-medium">{t('platform:photographer.subscription.periods')}</h3>
          {subscription.periods.length === 0 ? (
            <p className={META}>{t('admin:subscription.history.empty')}</p>
          ) : (
            <div className="@container">
              <table role="table" className="w-full border-collapse text-[0.9375rem]">
                <caption className="sr-only">{t('platform:photographer.subscription.periods')}</caption>
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
                    <PeriodRow key={period.id} period={period} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  )
}

function PeriodRow({ period }: { period: SubscriptionPeriod }) {
  const { t } = useTranslation()
  const name = period.kind === 'trial' ? t('admin:subscription.history.trial') : t(`admin:subscription.history.${period.planInterval ?? 'monthly'}`)
  return (
    <tr role="row" data-period={period.id} className={cn(TR, STACKED_ROW)}>
      <td role="cell" className={cn(TD, STACKED_CELL)}>
        {name}
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', STACKED_CELL)}>
        {t('admin:subscription.history.dates', { start: formatDateTime(period.startsAt), end: formatDateTime(period.endsAt) })}
      </td>
      <td role="cell" className={cn(TD, 'text-right @max-[40rem]:text-left', STACKED_CELL)}>
        <span className={cn(DATA, 'whitespace-nowrap')}>{period.kind === 'trial' ? t('admin:subscription.history.free') : formatMoney(period.priceRwf)}</span>
      </td>
      <td role="cell" className={cn(TD, 'tabular-nums', STACKED_CELL, period.kind === 'trial' && '@max-[40rem]:hidden')}>
        {period.kind === 'trial' ? null : (
          <>
            {/* Stacked on a narrow screen, the header row is hidden: the cell names itself. */}
            <span className="text-muted-foreground @min-[40rem]:hidden">{t('admin:subscription.history.columns.paid')}: </span>
            {period.paidAt !== null ? formatDateTime(period.paidAt) : t('admin:subscription.history.notPaid')}
          </>
        )}
      </td>
    </tr>
  )
}

/** The current destination, masked (user decision 4): who, which network or bank, and the last four digits. */
function PayoutMethodSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const method = detail.payoutMethod
  return (
    <Section id="photographer-payout-method" title={t('platform:photographer.payoutMethod.title')}>
      {method === null ? (
        <p className={META}>{t('platform:photographer.payoutMethod.none')}</p>
      ) : (
        <div data-slot="masked-payout-method" data-kind={method.kind} className="flex min-w-0 flex-col gap-1.5">
          <span className="flex min-w-0 items-center gap-2">
            {method.kind === 'momo' ? <Smartphone aria-hidden="true" className="size-4 shrink-0" /> : <Landmark aria-hidden="true" className="size-4 shrink-0" />}
            <span className="min-w-0 wrap-anywhere">
              {method.kind === 'momo'
                ? method.provider === 'mtn' || method.provider === 'airtel'
                  ? t(`admin:payoutMethod.networks.${method.provider}`)
                  : t('admin:payoutMethod.kinds.momo')
                : method.provider === ''
                  ? t('admin:payoutMethod.kinds.bank')
                  : method.provider}
            </span>
          </span>
          {method.last4 !== '' && (
            <span className={DATA} data-last4={method.last4}>
              <span aria-hidden="true">•••• {method.last4}</span>
              <span className="sr-only">{t('platform:photographer.payoutMethod.endingIn', { last4: method.last4 })}</span>
            </span>
          )}
          <span className={cn(META, 'wrap-anywhere')}>{t('admin:payoutMethod.summary.accountName', { name: method.accountName })}</span>
          <span className={cn(META, 'tabular-nums')}>{t('platform:photographer.payoutMethod.savedOn', { date: formatDateTime(method.createdAt) })}</span>
          <p className={cn(META, 'mt-2 max-w-prose text-[0.8125rem]')}>{t('platform:photographer.payoutMethod.fullNumber')}</p>
        </div>
      )}
    </Section>
  )
}

function CountsSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { bookings, services } = detail.counts
  return (
    <Section id="photographer-counts" title={t('platform:photographer.bookings.title')}>
      <dl aria-label={t('platform:photographer.bookings.label')} className="grid grid-cols-2 gap-px overflow-hidden rounded-xs border bg-border md:grid-cols-4">
        {BOOKING_STATUSES.map((status) => (
          <div key={status} data-booking-count={status} className="bg-background flex min-w-0 flex-col gap-1.5 p-4">
            <dt className="text-muted-foreground text-[0.8125rem] wrap-anywhere">{t(`platform:photographer.bookings.status.${status}`)}</dt>
            <dd className={cn(DATA, 'text-xl', bookings[status] === 0 && 'text-muted-foreground')}>{bookings[status]}</dd>
          </div>
        ))}
      </dl>
      <p data-services="" className="text-[0.9375rem]">
        {services.total === 0 ? t('platform:photographer.bookings.noServices') : t('platform:photographer.bookings.services', { count: services.total, active: services.active })}
      </p>
    </Section>
  )
}

function EarningsSection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { payableRwf, inDraftRwf, paidOutRwf } = detail.earnings
  const negative = payableRwf < 0
  return (
    <Section id="photographer-earnings" title={t('platform:photographer.earnings.title')}>
      <StatGrid className="lg:grid-cols-3">
        <StatTile icon={Wallet} label={t('platform:photographer.earnings.payable')} mono tone={negative ? 'danger' : 'neutral'}>
          <span data-payable={payableRwf} className={cn(negative && 'text-destructive font-medium')}>
            {formatMoney(payableRwf)}
          </span>
        </StatTile>
        <StatTile icon={Banknote} label={t('platform:photographer.earnings.inDraft')} mono>
          {formatMoney(inDraftRwf)}
        </StatTile>
        <StatTile icon={CircleCheck} label={t('platform:photographer.earnings.paidOut')} mono>
          {formatMoney(paidOutRwf)}
        </StatTile>
      </StatGrid>
      {negative && (
        <p className="text-destructive flex items-start gap-2 text-sm" data-negative-payable="">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('platform:photographer.earnings.negative')}
        </p>
      )}
    </Section>
  )
}

function ActivitySection({ detail }: { detail: Detail }) {
  const { t } = useTranslation()
  const { photographer, activity } = detail
  const state: ActivityLinkState = { photographerId: photographer.id, photographerName: photographer.displayName }
  return (
    <Section id="photographer-activity" title={t('platform:photographer.activity.title')}>
      {activity.length === 0 ? (
        <p className={META}>{t('platform:photographer.activity.empty')}</p>
      ) : (
        <ol aria-label={t('platform:photographer.activity.title')} className="flex flex-col rounded-xs border">
          {activity.map((entry) => (
            <AuditEntryRow key={entry.id} entry={entry} showPhotographer={false} />
          ))}
        </ol>
      )}
      <Link
        to={`/platform/activity?photographerId=${encodeURIComponent(photographer.id)}`}
        state={state}
        className={cn(LINK, 'self-start text-[0.9375rem] inline-flex items-center max-lg:min-h-11 pointer-coarse:min-h-11')}
      >
        {t('platform:photographer.activity.all')}
      </Link>
    </Section>
  )
}
