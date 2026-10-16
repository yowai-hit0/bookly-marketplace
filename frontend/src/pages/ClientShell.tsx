import { ArrowRight, CalendarDays, Camera } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link, Outlet } from 'react-router'
import { bookingPath } from '@/catalogue/booking-access'
import { Button } from '@/components/ui/button'
import { SkipLink } from '@/components/ui/skip-link'
import { PHOTOGRAPHER_CONTACT, contactLinks } from '@/lib/contact'
import { useStoredBookingToken } from '@/lib/stored-booking'
import { type ThemePreference, useClientTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'
import { container, quietLink } from './client/classes'
import { ThemeButton } from './client/ThemeButton'

/**
 * The header and footer every client page wears (`design-system/bookly/pages/
 * client-shell.md`, restyled by `client-front.md` section 7). It also applies
 * the client's theme: `<html data-theme>` while any client page is mounted,
 * removed when the visitor leaves for the admin.
 *
 * The header and footer are **siblings of each page's own `main`**, never a
 * wrapper around it: two `main` elements would break `page.locator('main')` in
 * the e2e suite, and each page's landmark is its own. The container around the
 * outlet is a plain `div`, and it is the skip link's target.
 */

export function ClientShell() {
  const { t } = useTranslation()
  const theme = useClientTheme()

  return (
    <div className="flex min-h-svh flex-col">
      <SkipLink targetId="main-content">{t('shell:skipToContent')}</SkipLink>

      <ClientHeader themePreference={theme.preference} onThemeChange={theme.setPreference} />

      <div id="main-content" tabIndex={-1} className="flex-1 outline-none">
        <Outlet />
      </div>

      <ClientFooter />
    </div>
  )
}

/** The wordmark: a small inverted square with a camera, then the name. */
function Wordmark({ size = 'md' }: { size?: 'md' | 'sm' }) {
  const { t } = useTranslation()
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'bg-foreground text-background flex shrink-0 items-center justify-center',
          size === 'md' ? 'size-7 [&_svg]:size-4' : 'size-6 [&_svg]:size-3.5',
        )}
      >
        <Camera />
      </span>
      {t('common:appName')}
    </>
  )
}

/**
 * The client top bar: the wordmark home, the service list and how booking
 * works (from `md`), "My booking" (the booking this device last opened, else
 * `/my-booking`), the photographer's way into admin, the theme button, and the
 * one primary action.
 *
 * Nothing here is a radio or a `dl`, and the only button is the theme's: the
 * e2e suite counts radios page-wide and reads `dl dt` page-wide, and it looks
 * for buttons inside `main` only.
 */
export function ClientHeader({
  themePreference,
  onThemeChange,
}: {
  themePreference: ThemePreference
  onThemeChange: (preference: ThemePreference) => void
}) {
  const { t } = useTranslation()
  // The booking this device last opened, else the page that emails a new link (2026-09-25).
  const storedToken = useStoredBookingToken()
  const myBooking = storedToken === null ? '/my-booking' : bookingPath(storedToken)

  return (
    // Static, not sticky: a bar that follows the page can obscure focus over
    // the slot picker and the payment form.
    <header className="bg-background border-b">
      <nav aria-label={t('shell:nav.label')} className={cn(container, 'flex h-16 items-center gap-2 md:h-18 md:gap-10')}>
        <Link
          to="/"
          className="flex min-h-11 shrink-0 items-center gap-2.5 rounded-xs text-xl font-semibold tracking-[-0.02em]"
        >
          <Wordmark />
        </Link>

        {/* Below `md`, "Book now" and the Home page cover these two. */}
        <ul className="hidden flex-1 items-center gap-8 text-[0.9375rem] md:flex">
          <li>
            <Link to="/services" className={cn(quietLink, 'text-foreground')}>
              {t('services:title')}
            </Link>
          </li>
          <li>
            <Link to={{ pathname: '/', hash: '#how' }} className={cn(quietLink, 'text-foreground')}>
              {t('landing:how.title')}
            </Link>
          </li>
        </ul>

        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          {/* Below `sm` the icon alone, its words kept as the name: the bar
              has 343px at 375, and this is what makes room for the theme button. */}
          <Link
            to={myBooking}
            className={cn(
              quietLink,
              'text-foreground justify-center text-[0.9375rem] max-sm:size-11 max-sm:min-h-11 [&_svg]:size-4',
            )}
          >
            <CalendarDays aria-hidden="true" />
            <span className="max-sm:sr-only">{t('shell:nav.myBooking')}</span>
          </Link>
          {/* Clients rarely need it: below `sm` it moves to the footer (2026-09-25). */}
          <Link to="/admin/login" className={cn(quietLink, 'text-muted-foreground hidden text-sm sm:inline-flex')}>
            {t('shell:nav.adminLogin')}
          </Link>
          <ThemeButton preference={themePreference} onChange={onThemeChange} />
          <Button asChild className="ml-1 sm:ml-0">
            <Link to="/services">
              {t('shell:nav.bookNow')}
              <ArrowRight aria-hidden="true" className="max-sm:hidden" />
            </Link>
          </Button>
        </div>
      </nav>
    </header>
  )
}

const footerLabel = 'font-mono text-xs font-medium tracking-[0.1em] uppercase text-foreground'

/**
 * Three columns from `md`: the wordmark, the note and the photographer's
 * contact details (only those that exist, `lib/contact.ts`); BOOK; ABOUT.
 * No Privacy notice link: no privacy page exists yet. No buttons, no `dl`.
 */
function ClientFooter() {
  const { t } = useTranslation()
  const storedToken = useStoredBookingToken()
  const myBooking = storedToken === null ? '/my-booking' : bookingPath(storedToken)
  const contact = contactLinks()
  const name = PHOTOGRAPHER_CONTACT.name

  return (
    <footer className="bg-background mt-auto border-t">
      <div className={cn(container, 'grid gap-10 py-12 md:grid-cols-[minmax(0,1fr)_auto_auto] md:gap-18 md:py-14')}>
        <div className="flex max-w-sm flex-col gap-3.5">
          <span className="flex items-center gap-2.5 text-lg font-semibold tracking-[-0.02em]">
            <Wordmark size="sm" />
          </span>
          {/* No year, no rights reserved: there is no name to assert them for. */}
          <p className="text-subtle-foreground text-[0.9375rem] text-pretty">{t('shell:footer.note')}</p>
          {(name !== null || contact.length > 0) && (
            <div className="text-subtle-foreground flex flex-col gap-1 text-[0.9375rem]">
              {name !== null && <p className="text-foreground">{name}</p>}
              {contact.length > 0 && (
                <ul aria-label={t('shell:contact.label')} className="flex flex-col">
                  {contact.map((entry) => (
                    <li key={entry.kind} className="flex flex-wrap items-center gap-x-2">
                      <span>{t(`shell:contact.${entry.kind}`)}</span>
                      <a href={entry.href} className={cn(quietLink, 'text-foreground')}>
                        {entry.value}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>

        <nav aria-label={t('shell:footer.label')} className="grid grid-cols-2 gap-10 md:contents">
          <div className="flex flex-col gap-3">
            <p id="footer-book" className={footerLabel}>
              {t('shell:footer.book')}
            </p>
            <ul aria-labelledby="footer-book" className="flex flex-col gap-1 text-[0.9375rem] md:gap-2">
              <li>
                {/* Never named "All services": three e2e specs match that name page-wide. */}
                <Link to="/services" className={quietLink}>
                  {t('shell:footer.services')}
                </Link>
              </li>
              <li>
                <Link to={myBooking} className={quietLink}>
                  {t('shell:nav.myBooking')}
                </Link>
              </li>
            </ul>
          </div>
          <div className="flex flex-col gap-3">
            <p id="footer-about" className={footerLabel}>
              {t('shell:footer.about')}
            </p>
            <ul aria-labelledby="footer-about" className="flex flex-col gap-1 text-[0.9375rem] md:gap-2">
              <li>
                <Link to="/" className={quietLink}>
                  {t('shell:footer.home')}
                </Link>
              </li>
              {/* Only where the top bar has no room for it (below `sm`). */}
              <li className="sm:hidden">
                <Link to="/admin/login" className={quietLink}>
                  {t('shell:nav.adminLogin')}
                </Link>
              </li>
            </ul>
          </div>
        </nav>
      </div>
    </footer>
  )
}
