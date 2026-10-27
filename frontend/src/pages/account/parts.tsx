import { ArrowLeft, ArrowRight, CircleAlert, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { AccountPaymentStatus } from '@/account/dashboard'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { StatusShapeGlyph, type StatusShape } from '@/components/ui/status-badge'
import { cn } from '@/lib/utils'
import { eyebrow, pageTitle, panel, statusTitle } from '@/pages/client/classes'
import { IconTile } from '@/pages/client/FactGrid'

/**
 * Pieces every dashboard page draws the same way (design-system/bookly/pages/
 * account-dashboard.md): the page head, the loading, failure, empty and
 * not-found states, the pager, and a payment's status badge.
 */

/** Mono eyebrow with its icon, the page's one `h1`, and an optional lead. */
export function PageHead({
  icon: Icon,
  eyebrowText,
  title,
  lead,
  children,
}: {
  icon: LucideIcon
  eyebrowText: string
  title: ReactNode
  lead?: string
  /** An action beside the title (the receipt's Print). */
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      <p className={eyebrow}>
        <Icon aria-hidden="true" />
        {eyebrowText}
      </p>
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h1 className={cn(pageTitle, 'min-w-0 wrap-anywhere')}>{title}</h1>
        {children}
      </div>
      {lead !== undefined && <p className="text-subtle-foreground max-w-2xl text-base text-pretty">{lead}</p>}
    </div>
  )
}

/** Skeleton rows in the shape of the list they stand for, and the words for assistive tech. */
export function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <p className="sr-only" role="status">
        {label}
      </p>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} aria-hidden="true" className={cn(panel, 'flex flex-col gap-3 p-5 sm:p-6')}>
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-6 w-64 max-w-full" />
          <Skeleton className="h-4 w-48 max-w-full" />
        </div>
      ))}
    </div>
  )
}

/** A failed load, said, with the retry beside it. */
export function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <Callout
      variant="console"
      tone="destructive"
      icon={CircleAlert}
      role="alert"
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('account:home.retry')}
        </Button>
      }
    >
      <p>{message}</p>
    </Callout>
  )
}

/** Nothing to list: an icon tile, a title, one line and, when there is one, the way on. */
export function EmptyState({ icon, title, body, children }: { icon: LucideIcon; title: string; body: string; children?: ReactNode }) {
  return (
    <section className={cn(panel, 'flex flex-col items-start gap-4 p-6 text-pretty sm:p-8')}>
      <IconTile icon={icon} tone="neutral" />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-xl font-medium tracking-[-0.01em]">{title}</h2>
        <p className="text-subtle-foreground max-w-xl">{body}</p>
      </div>
      {children}
    </section>
  )
}

/** What a reference that is not the account's shows: the same for one that names nothing. */
export function MissingState({ icon, title, body, children }: { icon: LucideIcon; title: string; body: string; children?: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-4 text-pretty">
      <IconTile icon={icon} tone="neutral" size="lg" />
      <h1 className={statusTitle}>{title}</h1>
      <p className="text-subtle-foreground max-w-xl text-base">{body}</p>
      {children}
    </section>
  )
}

/**
 * Previous and next as links (the page number is in the URL, so the browser's
 * back button and a shared link both work), with "Page 2 of 3" between them.
 * Nothing renders for a single page; an end has no link rather than a dead one.
 */
export function Pagination({ page, pageCount, hrefFor }: { page: number; pageCount: number; hrefFor: (page: number) => string }) {
  const { t } = useTranslation()
  if (pageCount <= 1) return null
  return (
    <nav aria-label={t('account:pagination.label')} className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        {page > 1 && (
          <Button asChild variant="outline" size="sm">
            <Link to={hrefFor(page - 1)} rel="prev">
              <ArrowLeft aria-hidden="true" />
              {t('account:pagination.previous')}
            </Link>
          </Button>
        )}
      </div>
      <p className="text-muted-foreground font-mono text-sm tabular-nums">
        {t('account:pagination.status', { page, count: pageCount })}
      </p>
      <div className="flex min-w-0 flex-1 justify-end">
        {page < pageCount && (
          <Button asChild variant="outline" size="sm">
            <Link to={hrefFor(page + 1)} rel="next">
              {t('account:pagination.next')}
              <ArrowRight aria-hidden="true" />
            </Link>
          </Button>
        )}
      </div>
    </nav>
  )
}

/**
 * A payment's status in the console's language (admin-console.md §5): a filled
 * check for money in, a clock while it waits, a cross when it failed, an
 * outlined check once sent back. The word is always shown.
 */
const PAYMENT_TREATMENTS: Record<AccountPaymentStatus, { shape: StatusShape; tone: 'success' | 'muted' | 'warning' | 'danger'; className: string }> = {
  succeeded: { shape: 'current', tone: 'success', className: 'border-transparent bg-console-success-tint text-console-success' },
  initiated: { shape: 'waiting', tone: 'muted', className: 'border-dashed border-input bg-transparent text-foreground' },
  pending: { shape: 'waiting', tone: 'muted', className: 'border-dashed border-input bg-transparent text-foreground' },
  failed: { shape: 'failed', tone: 'danger', className: 'border-transparent bg-console-danger-tint text-destructive' },
  refund_due: { shape: 'waiting', tone: 'warning', className: 'border-transparent bg-console-warning-tint text-foreground' },
  refunded: { shape: 'earlier', tone: 'muted', className: 'border-border bg-transparent text-foreground' },
}

export function PaymentStatusBadge({ status }: { status: AccountPaymentStatus }) {
  const { t } = useTranslation()
  const treatment = PAYMENT_TREATMENTS[status] ?? PAYMENT_TREATMENTS.pending
  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn('h-auto shrink-0 gap-1.5 rounded-xs px-2 py-0.5 text-[0.8125rem] [&>svg]:size-3.5!', treatment.className)}
    >
      <StatusShapeGlyph shape={treatment.shape} tone={treatment.tone} />
      {t(`account:payments.status.${status}`)}
    </Badge>
  )
}
