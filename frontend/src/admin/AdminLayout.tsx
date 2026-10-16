import { CalendarCheck, LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { SkipLink } from '@/components/ui/skip-link'
import { StatusBadgeVariantContext } from '@/components/ui/status-badge-context'
import { cn } from '@/lib/utils'
import { BreadcrumbTailContext, useBreadcrumbTailState } from './breadcrumb-tail'
import { Breadcrumbs } from './breadcrumbs'
import { NAV_ITEMS } from './nav'
import { clearSession, readSession } from './session'
import { ThemeToggle } from './ThemeToggle'
import { useAdminTheme } from './theme'

/**
 * Every `/admin/*` page renders inside this. Without a live token it sends him
 * to sign in; this is a convenience, not the protection -- the API refuses the
 * data itself (spec §2.2: no permission is enforced by hiding UI alone).
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
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const { preference, setPreference } = useAdminTheme()
  const [tail, setTail] = useBreadcrumbTailState()

  if (readSession() === null) return <Navigate to="/admin/login" replace />

  function signOut() {
    clearSession()
    navigate('/admin/login', { replace: true })
  }

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
            {NAV_ITEMS.map(({ page, icon: Icon }) => (
              <NavLink
                key={page}
                to={`/admin/${page}`}
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
                {t(`admin:nav.${page}`)}
              </NavLink>
            ))}
          </nav>

          <div className="order-2 ml-auto lg:order-3 lg:mt-auto lg:ml-0 lg:border-t lg:pt-3">
            <Button
              variant="ghost"
              onClick={signOut}
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
        <BreadcrumbTailContext.Provider value={setTail}>
          {/* Every status badge in the admin takes the console look, the legend's popover included. */}
          <StatusBadgeVariantContext.Provider value="console">
            <Outlet />
          </StatusBadgeVariantContext.Provider>
        </BreadcrumbTailContext.Provider>
      </div>
    </div>
  )
}
