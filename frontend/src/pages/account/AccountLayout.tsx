import { LogOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet, useLocation } from 'react-router'
import { forgetAccountMe } from '@/auth/account'
import { useSignOut } from '@/auth/useSignOut'
import { cn } from '@/lib/utils'
import { container } from '@/pages/client/classes'

/**
 * The signed-in client's pages (marketplace-spec Phase 8): the account nav,
 * then the page. Inside the client shell, under the shell's header, and guarded
 * by the account session in `routes.tsx` (`design-system/bookly/pages/
 * client-shell.md`, "Account nav").
 *
 * The nav is a sibling of the page's own `main`, never a wrapper: each page
 * keeps its one landmark. Bookings, Payments and Profile are links (the
 * current one marked `aria-current="page"`); Sign out is the one button, and it
 * forgets only the account's session.
 */

const SECTIONS = [
  { key: 'bookings', to: '/account', matches: (path: string) => path === '/account' || path.startsWith('/account/bookings') },
  { key: 'payments', to: '/account/payments', matches: (path: string) => path.startsWith('/account/payments') },
  { key: 'profile', to: '/account/profile', matches: (path: string) => path.startsWith('/account/profile') },
] as const

export function AccountLayout() {
  return (
    <>
      <AccountNav />
      <Outlet />
    </>
  )
}

function AccountNav() {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const leave = useSignOut('account')
  const path = pathname.replace(/\/+$/, '') || '/'

  function signOut() {
    forgetAccountMe()
    leave('/')
  }

  return (
    <nav aria-label={t('account:nav.label')} data-account-nav="" className="border-b print:hidden">
      <div className={cn(container, 'flex items-center gap-2')}>
        <ul className="flex min-w-0 items-center gap-5 sm:gap-8">
          {SECTIONS.map((section) => {
            const current = section.matches(path)
            return (
              <li key={section.key} className="flex">
                <Link
                  to={section.to}
                  aria-current={current ? 'page' : undefined}
                  className={cn(
                    // The bar's own hairline is the track; the current section sits on it in the text colour.
                    '-mb-px inline-flex h-12 items-center rounded-xs border-b-2 text-[0.9375rem] motion-safe:transition-colors motion-safe:duration-150',
                    current
                      ? 'border-foreground text-foreground font-medium'
                      : 'text-subtle-foreground hover:text-console-link border-transparent',
                  )}
                >
                  {t(`account:nav.${section.key}`)}
                </Link>
              </li>
            )
          })}
        </ul>
        <button
          type="button"
          onClick={signOut}
          className="text-subtle-foreground hover:text-console-link ml-auto inline-flex h-12 shrink-0 cursor-pointer items-center gap-2 rounded-xs text-[0.9375rem] motion-safe:transition-colors motion-safe:duration-150 [&_svg]:size-4"
        >
          <LogOut aria-hidden="true" className="max-[25rem]:hidden" />
          {t('account:nav.signOut')}
        </button>
      </div>
    </nav>
  )
}
