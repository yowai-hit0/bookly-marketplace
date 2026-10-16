import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { container, pageY, statusTitle } from '@/pages/client/classes'

/**
 * The `*` route, and also what `ServiceDetail` renders in place when the API
 * 404s a slug (unknown or deactivated service). It renders its own `main`, so
 * it stays self-contained and never assumes it is a top-level route.
 *
 * Restyled by client-front.md 8.5: a large mono "404" eyebrow replaces the
 * icon, and a Home / Browse services pair of links replaces the old "All
 * services" back link -- so nothing on the page is named "All services"
 * except the service page's own back link (2026-09-27).
 */
export function NotFound() {
  const { t } = useTranslation()

  return (
    <main className={cn(container, pageY, 'flex min-h-112 flex-col items-center justify-center text-center')}>
      <p className="font-mono text-6xl font-semibold tracking-[-0.02em] text-muted-foreground select-none md:text-7xl">
        {t('notFound:code')}
      </p>
      <h1 className={cn(statusTitle, 'mt-4')}>{t('notFound:title')}</h1>
      <p className="text-subtle-foreground mt-2 max-w-md text-pretty">{t('notFound:body')}</p>
      <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
        <Button asChild>
          <Link to="/">{t('shell:footer.home')}</Link>
        </Button>
        <Button asChild variant="outline">
          <Link to="/services">{t('shell:footer.services')}</Link>
        </Button>
      </div>
    </main>
  )
}
