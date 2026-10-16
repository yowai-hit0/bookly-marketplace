import { ChevronRight, House } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { cn } from '@/lib/utils'
import type { BreadcrumbTail } from './breadcrumb-tail'
import { navItemFor } from './nav'

/**
 * The admin's breadcrumb (design-system/bookly/admin-console.md section 6.2):
 * Admin > the section > on a booking, its reference.
 *
 * The section comes from the path; the last crumb, when a page has one, is
 * reported by that page (`breadcrumb-tail.ts`).
 */

const CRUMB = 'inline-flex min-w-0 items-center gap-2'
const LINK = 'rounded-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline max-lg:min-h-11 pointer-coarse:min-h-11'

/**
 * Below `lg` only the last two crumbs show, and the last truncates rather than
 * wrapping; the first is still one tap away in the nav below.
 */
export function Breadcrumbs({ pathname, tail, className }: { pathname: string; tail: BreadcrumbTail | null; className?: string }) {
  const { t } = useTranslation()
  const section = navItemFor(pathname)

  type Crumb = { key: string; content: ReactNode; to: string | null; mono?: boolean; className?: string }
  const crumbs: Crumb[] = [
    {
      key: 'admin',
      to: '/admin',
      // Icon-only below `sm`, so it needs its own width to be a 44px target.
      className: 'max-sm:min-w-11 max-sm:justify-center',
      content: (
        <>
          <House aria-hidden="true" className="size-4 shrink-0" />
          {/* On the narrowest phones the house alone says "Admin"; the name stays for assistive tech. */}
          <span className="max-sm:sr-only">{t('admin:nav.label')}</span>
        </>
      ),
    },
  ]
  if (section !== null) {
    const Icon = section.icon
    crumbs.push({
      key: section.page,
      to: `/admin/${section.page}`,
      content: (
        <>
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{t(`admin:nav.${section.page}`)}</span>
        </>
      ),
    })
  }
  if (tail !== null) {
    crumbs.push({
      key: 'tail',
      to: null,
      mono: true,
      content:
        tail.state === 'loading' ? (
          <span aria-hidden="true" data-slot="breadcrumb-skeleton" className="bg-muted block h-4 w-24 rounded-xs" />
        ) : (
          <span className="truncate">{tail.label}</span>
        ),
    })
  }

  // The last crumb is the page itself: plain text, `aria-current`. A loading
  // placeholder is not a page name, so the section stays current until it resolves.
  const currentIndex = tail?.state === 'loading' ? crumbs.length - 2 : crumbs.length - 1

  return (
    <nav aria-label={t('admin:breadcrumb.label')} className={cn('min-w-0', className)}>
      <ol className="flex min-w-0 items-center gap-2 text-sm">
        {crumbs.map((crumb, index) => {
          const hiddenWhenCompact = index < crumbs.length - 2
          const current = index === currentIndex
          return (
            <li
              key={crumb.key}
              className={cn(
                'flex min-w-0 items-center gap-2',
                // Below `lg` only the last two crumbs fit; the first is still one tap away in the nav.
                hiddenWhenCompact && 'max-lg:hidden',
                index === crumbs.length - 1 ? 'shrink' : 'shrink-0',
              )}
            >
              {index > 0 && (
                <ChevronRight
                  aria-hidden="true"
                  className={cn('text-muted-foreground size-4 shrink-0', index === crumbs.length - 2 && crumbs.length > 2 && 'max-lg:hidden')}
                />
              )}
              {current || crumb.to === null ? (
                <span
                  aria-current={current ? 'page' : undefined}
                  className={cn(CRUMB, 'text-foreground', crumb.mono === true && 'font-mono tabular-nums')}
                >
                  {crumb.content}
                </span>
              ) : (
                <Link to={crumb.to} className={cn(CRUMB, LINK, crumb.className)}>
                  {crumb.content}
                </Link>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
