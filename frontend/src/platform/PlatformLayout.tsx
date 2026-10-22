import { Banknote, LogOut, ShieldCheck, Undo2, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Outlet } from 'react-router'
import { useAdminTheme } from '@/admin/theme'
import { ThemeToggle } from '@/admin/ThemeToggle'
import { useSignOut } from '@/auth/useSignOut'
import { Button } from '@/components/ui/button'
import { SkipLink } from '@/components/ui/skip-link'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { cn } from '@/lib/utils'
import { EYEBROW } from '@/pages/admin/console/classes'

/**
 * The platform admin's console (Phase 2 brief decision 7, minimal until
 * Phase 9): the studio console's shell (`design-system/bookly/admin-console.md`
 * 6.1) with its sections: photographers (Phase 2), then payouts and refunds
 * (Phase 4, R4.4, R4.6). The guard is the route's (`RequireSession`, the
 * platform session); the API refuses the data itself.
 *
 * DOM order is skip link -> top bar -> wordmark -> links -> sign-out ->
 * content, as in the studio, so tab order and reading order agree.
 */

const NAV = [
  { page: 'photographers', icon: Users },
  { page: 'payouts', icon: Banknote },
  { page: 'refunds', icon: Undo2 },
] as const

export function PlatformLayout() {
  const { t } = useTranslation()
  const signOut = useSignOut('platform')
  const { preference, setPreference } = useAdminTheme()

  return (
    <div className="bg-background text-foreground min-h-svh lg:grid lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-[3.5rem_1fr]">
      <SkipLink targetId="platform-content">{t('platform:skipToContent')}</SkipLink>

      <header className="bg-background flex min-h-11 items-stretch border-b lg:sticky lg:top-0 lg:z-30 lg:col-span-2 lg:h-14">
        <div aria-hidden="true" className="hidden w-14 shrink-0 items-center justify-center border-r lg:flex">
          <span className="bg-foreground text-background flex size-6 items-center justify-center rounded-xs font-mono text-sm font-semibold">
            B
          </span>
        </div>
        <p className={cn(EYEBROW, 'flex flex-1 items-center gap-2 px-4 lg:px-6')}>
          <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
          {t('platform:nav.label')}
        </p>
        <div className="flex shrink-0 items-center border-l px-2 lg:px-3">
          <ThemeToggle preference={preference} onChange={setPreference} />
        </div>
      </header>

      <aside className="bg-sidebar border-b lg:border-r lg:border-b-0">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 lg:sticky lg:top-14 lg:h-[calc(100svh-3.5rem)] lg:flex-col lg:flex-nowrap lg:items-stretch lg:gap-1 lg:overflow-y-auto lg:px-3 lg:py-6">
          <span className="text-sidebar-foreground order-1 flex items-center gap-2.5 px-1 text-xl font-medium lg:px-2.5 lg:pb-4">
            <ShieldCheck aria-hidden="true" className="size-5 shrink-0" />
            {t('common:appName')}
          </span>

          <nav
            aria-label={t('platform:nav.label')}
            className="order-3 flex w-full basis-full flex-wrap gap-1 lg:order-2 lg:w-auto lg:flex-1 lg:basis-auto lg:flex-col lg:flex-nowrap"
          >
            {NAV.map(({ page, icon: Icon }) => (
              <NavLink
                key={page}
                to={`/platform/${page}`}
                className={({ isActive }) =>
                  cn(
                    'flex min-h-11 items-center gap-3 rounded-xs px-3.5 text-base motion-safe:transition-colors motion-safe:duration-150',
                    isActive
                      ? 'bg-sidebar-primary text-sidebar-primary-foreground font-medium'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
                  )
                }
              >
                <Icon aria-hidden="true" className="size-4.5 shrink-0" />
                {t(`platform:nav.${page}`)}
              </NavLink>
            ))}
          </nav>

          <div className="order-2 ml-auto lg:order-3 lg:mt-auto lg:ml-0 lg:border-t lg:pt-3">
            <Button
              variant="ghost"
              onClick={() => signOut()}
              className="text-destructive hover:bg-destructive/10 hover:text-destructive h-11 gap-3 rounded-xs px-3.5 text-base font-normal active:not-aria-[haspopup]:translate-y-0 lg:w-full lg:justify-start [&_svg:not([class*='size-'])]:size-4.5"
            >
              <LogOut aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{t('platform:nav.signOut')}</span>
            </Button>
          </div>
        </div>
      </aside>

      <div id="platform-content" tabIndex={-1} className="min-w-0 outline-none">
        <StatusBadgeVariantContext.Provider value="console">
          <Outlet />
        </StatusBadgeVariantContext.Provider>
      </div>
    </div>
  )
}
