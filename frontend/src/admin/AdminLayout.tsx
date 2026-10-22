import { CalendarCheck, CircleX, Clock, LogOut, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useLocation } from 'react-router'
import { RequireSession } from '@/auth/RequireSession'
import { useSignOut } from '@/auth/useSignOut'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { SkipLink } from '@/components/ui/skip-link'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BreadcrumbTailContext, useBreadcrumbTailState } from './breadcrumb-tail'
import { Breadcrumbs } from './breadcrumbs'
import { NAV_ITEMS, navItemFor } from './nav'
import { adminFetch } from './api'
import { type StudioSubscription, subscriptionApi, subscriptionBanner } from './subscription'
import { SubscriptionRefreshContext } from './subscription-refresh'
import { ThemeToggle } from './ThemeToggle'
import { useAdminTheme } from './theme'

/**
 * Every `/studio/*` page renders inside this. Without a live studio token it
 * sends him to the studio's sign in, carrying where he was going
 * (`RequireSession`); this is a convenience, not the protection -- the API
 * refuses the data itself (spec §2.2: no permission is enforced by hiding UI
 * alone).
 *
 * Above every page sits the studio's status from `GET /api/studio/me`
 * (marketplace spec R2.2): a pending photographer can sign in and set up, but
 * is not listed or bookable until approved, and a suspended one is hidden.
 * Once `/me` says approved, the subscription is read too (Phase 5, R5.5), and
 * a second banner says when it is past due or expired, or when the trial or
 * the paid period ends within seven days, each linking to the subscription
 * page (which says it all itself, so the banner is not repeated there).
 *
 * Layout (`design-system/bookly/admin-console.md` section 6.1, on top of
 * `pages/admin-shell.md`): a 56px top bar of bordered cells (the mark, the
 * breadcrumb, the theme toggle) across a 260px sidebar from `lg`. The sidebar's
 * one navigation element reflows to a top bar below `lg` rather than becoming a
 * drawer, which would need open/close state. DOM order is skip link -> top bar
 * -> wordmark -> links -> sign-out -> content, and the eye reads it in that
 * order at every width, so tab order and reading order agree.
 */
export function AdminLayout() {
  return (
    <RequireSession area="studio">
      <StudioShell />
    </RequireSession>
  )
}

function StudioShell() {
  const { t } = useTranslation()
  const signOut = useSignOut('studio')
  const { pathname } = useLocation()
  const { preference, setPreference } = useAdminTheme()
  const [tail, setTail] = useBreadcrumbTailState()
  const current = navItemFor(pathname)?.page ?? null
  const status = useStudioStatus()
  const [subscriptionRead, setSubscriptionRead] = useState(0)
  const refreshSubscription = useCallback(() => setSubscriptionRead((n) => n + 1), [])
  const subscription = useBannerSubscription(status === 'approved', subscriptionRead)

  return (
    <div className="bg-background text-foreground min-h-svh lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-[3.5rem_1fr]">
      <SkipLink targetId="admin-content">{t('admin:skipToContent')}</SkipLink>

      <header className="bg-background flex min-h-11 items-stretch border-b lg:sticky lg:top-0 lg:z-30 lg:col-span-2 lg:h-14">
        {/* The mark: decoration, and never a second "Bookly" text node (the
            wordmark below is found by that text). */}
        <div aria-hidden="true" className="hidden w-14 shrink-0 items-center justify-center border-r lg:flex">
          <span className="bg-foreground text-background flex size-6 items-center justify-center rounded-xs font-mono text-sm font-semibold">
            B
          </span>
        </div>
        <Breadcrumbs pathname={pathname} tail={tail} className="flex flex-1 items-center px-4 lg:px-6" />
        <div className="flex shrink-0 items-center border-l px-2 lg:px-3">
          <ThemeToggle preference={preference} onChange={setPreference} />
        </div>
      </header>

      {/* The aside carries the surface and the edge down the whole page; the
          column inside it is what sticks below the top bar. */}
      <aside className="bg-sidebar border-b lg:border-r lg:border-b-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:sticky lg:top-14 lg:h-[calc(100svh-3.5rem)] lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-1 lg:overflow-y-auto lg:px-3 lg:py-6">
          <span className="text-sidebar-foreground order-1 flex items-center gap-2.5 px-1 text-xl font-medium lg:px-2.5 lg:pb-4">
            <CalendarCheck aria-hidden="true" className="size-5 shrink-0" />
            {t('common:appName')}
          </span>

          <nav
            aria-label={t('admin:nav.label')}
            className="order-3 flex w-full basis-full flex-wrap gap-1 lg:order-2 lg:w-auto lg:flex-1 lg:basis-auto lg:flex-col lg:flex-nowrap"
          >
            {NAV_ITEMS.map(({ page, icon: Icon }) => {
              // The section the path is in, so a page with no link of its own
              // (one payout, the payout method) still marks Earnings current.
              const isActive = current === page
              return (
                <Link
                  key={page}
                  to={`/studio/${page}`}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex min-h-11 items-center gap-3 rounded-xs px-3.5 text-base motion-safe:transition-colors motion-safe:duration-150',
                    isActive
                      ? 'bg-sidebar-primary text-sidebar-primary-foreground font-medium'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4.5 shrink-0" />
                  {t(`admin:nav.${page}`)}
                </Link>
              )
            })}
          </nav>

          <div className="order-2 ml-auto lg:order-3 lg:mt-auto lg:ml-0 lg:border-t lg:pt-3">
            <Button
              variant="ghost"
              onClick={() => signOut()}
              // Red text and a red hover tint mark it as leaving (2026-09-25);
              // ghost weight, not a solid fill: it is not a destructive confirmation.
              className="text-destructive hover:bg-destructive/10 hover:text-destructive h-11 gap-3 rounded-xs px-3.5 text-base font-normal active:not-aria-[haspopup]:translate-y-0 lg:w-full lg:justify-start [&_svg:not([class*='size-'])]:size-4.5"
            >
              <LogOut aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{t('admin:nav.signOut')}</span>
            </Button>
          </div>
        </div>
      </aside>

      <div id="admin-content" tabIndex={-1} className="min-w-0 outline-none">
        <StatusBanner status={status} />
        {current !== 'subscription' && <SubscriptionBanner subscription={subscription} />}
        <BreadcrumbTailContext.Provider value={setTail}>
          <SubscriptionRefreshContext.Provider value={refreshSubscription}>
            {/* Every status badge in the admin takes the console look, the legend's popover included. */}
            <StatusBadgeVariantContext.Provider value="console">
              <Outlet />
            </StatusBadgeVariantContext.Provider>
          </SubscriptionRefreshContext.Provider>
        </BreadcrumbTailContext.Provider>
      </div>
    </div>
  )
}

type StudioStatus = 'pending' | 'approved' | 'suspended'

/**
 * The studio's moderation status, once `/api/studio/me` has answered; null
 * until then and on any failure (no banner is better than a wrong one). A 401
 * drops the session in `apiFetch`, and the guard above takes him to sign in.
 */
function useStudioStatus(): StudioStatus | null {
  const [status, setStatus] = useState<StudioStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    adminFetch<{ photographer?: { status?: unknown } }>('/studio/me').then(
      (body) => {
        const value = body?.photographer?.status
        if (!cancelled && (value === 'pending' || value === 'approved' || value === 'suspended')) setStatus(value)
      },
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [])
  return status
}

/** Pending or suspended, said above every studio page; nothing once approved. */
function StatusBanner({ status }: { status: StudioStatus | null }) {
  const { t } = useTranslation()
  if (status !== 'pending' && status !== 'suspended') return null
  return (
    <div className="px-4 pt-4 lg:px-12 lg:pt-6">
      <Callout
        variant="console"
        tone={status === 'pending' ? 'info' : 'destructive'}
        icon={status === 'pending' ? Clock : CircleX}
        data-studio-status={status}
      >
        <p>{t(`studio:banner.${status}`)}</p>
      </Callout>
    </div>
  )
}

type BannerSubscription = Pick<StudioSubscription, 'status' | 'currentPeriodEndsAt' | 'graceEndsAt'>

/**
 * The subscription, for the banner: asked only once `/me` says approved (a
 * pending or suspended photographer cannot pay, so a banner asking him to
 * would mislead), and again whenever `read` changes (the subscription page
 * bumps it when a payment settles). Null until then, for a photographer never
 * approved, and on any failure: no banner is better than a wrong one.
 */
function useBannerSubscription(enabled: boolean, read: number): BannerSubscription | null {
  const [subscription, setSubscription] = useState<BannerSubscription | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    subscriptionApi.load().then(
      (page) => !cancelled && setSubscription(page.subscription),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [enabled, read])
  return enabled ? subscription : null
}

const SUBSCRIPTION_BANNER_LOOK = {
  past_due: { tone: 'warning', icon: TriangleAlert },
  expired: { tone: 'destructive', icon: CircleX },
  trial_ending: { tone: 'info', icon: Clock },
  period_ending: { tone: 'info', icon: Clock },
} as const

/** Past due, expired, or ending within seven days; each links to the subscription page. */
function SubscriptionBanner({ subscription }: { subscription: BannerSubscription | null }) {
  const { t } = useTranslation()
  const kind = subscriptionBanner(subscription, new Date())
  if (subscription === null || kind === null) return null
  const look = SUBSCRIPTION_BANNER_LOOK[kind]
  return (
    <div className="px-4 pt-4 lg:px-12 lg:pt-6">
      <Callout
        variant="console"
        tone={look.tone}
        icon={look.icon}
        data-subscription-banner={kind}
        action={
          // Underlined at rest: a link inside a banner (admin-console.md section 3).
          <Link to="/studio/subscription" className="rounded-xs font-medium underline underline-offset-4">
            {t('studio:banner.subscription.link')}
          </Link>
        }
      >
        <p>
          {t(`studio:banner.subscription.${kind}`, {
            date: formatDateTime(subscription.currentPeriodEndsAt),
            graceEndsAt: formatDateTime(subscription.graceEndsAt),
          })}
        </p>
      </Callout>
    </div>
  )
}
