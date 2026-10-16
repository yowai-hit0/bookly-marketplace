import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import { EYEBROW, META, TITLE } from './classes'

/**
 * The frame sign in and reset password share (design-system/bookly/
 * admin-console.md 6.8): a centred 400px console panel on the canvas, with the
 * Bookly mark, a mono `ADMIN` eyebrow, the page's only `h1` and an optional
 * intro, then the page's own content. One component, so the two pages cannot
 * drift apart: a photographer arriving at reset password from here must land
 * somewhere that visibly matches, not something phishing-shaped.
 *
 * There is no header and so no skip link: the mark is the first stop, and the
 * form follows it directly.
 */
export function AdminAuthFrame({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation()

  return (
    <main id="main-content" className="flex min-h-svh flex-col items-center justify-center px-4 py-8 sm:py-12">
      <div className="flex w-full max-w-100 flex-col gap-6 rounded-xs border p-6 sm:p-8">
        {/* With the client header gone this is the only way out, so it is a
            real link home, named by the word beside the decorative monogram. */}
        <Link
          to="/"
          className="group/mark text-foreground inline-flex items-center gap-2.5 self-start rounded-xs text-base font-medium max-lg:min-h-11 pointer-coarse:min-h-11"
        >
          <span
            aria-hidden="true"
            className="bg-foreground text-background flex size-6 shrink-0 items-center justify-center rounded-xs font-mono text-sm font-semibold"
          >
            B
          </span>
          <span className="underline-offset-4 group-hover/mark:underline">{t('common:appName')}</span>
        </Link>
        <div className="flex flex-col gap-3">
          <p className={EYEBROW}>{t('admin:nav.label')}</p>
          <h1 className={cn(TITLE, 'text-2xl wrap-break-word')}>{title}</h1>
          {intro !== undefined && <p className={META}>{intro}</p>}
        </div>
        {children}
      </div>
    </main>
  )
}
