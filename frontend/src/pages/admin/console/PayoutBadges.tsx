import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { PayoutItemState } from '@/admin/payouts'
import { Badge } from '@/components/ui/badge'
import { type StatusShape, StatusShapeGlyph } from '@/components/ui/status-badge'
import { cn } from '@/lib/utils'

/**
 * Payout lines and payouts in the console's four status shapes
 * (design-system/bookly/admin-console.md section 5): a filled check is paid,
 * an outlined check is earned and ready, a clock is waiting, a cross is void.
 * The word is always shown; in greyscale each stays apart by fill and edge.
 */

type Treatment = { shape: StatusShape; tone: 'success' | 'muted' | 'warning' | 'danger'; className: string }

const BADGE = 'h-auto gap-1.5 rounded-xs px-2 py-0.5 text-[0.8125rem] [&>svg]:size-3.5!'

const ITEM_STATES: Record<PayoutItemState, Treatment> = {
  // Earned, but a session fee waits for its shoot to end.
  pending: { shape: 'waiting', tone: 'muted', className: 'border-dashed border-input bg-transparent text-foreground' },
  // Earned and owed: the next payout takes it.
  payable: { shape: 'earlier', tone: 'success', className: 'border-transparent bg-console-chip text-foreground' },
  // In a payout being prepared.
  in_draft: { shape: 'waiting', tone: 'warning', className: 'border-border bg-transparent text-foreground' },
  paid: { shape: 'current', tone: 'success', className: 'border-transparent bg-console-success-tint text-console-success' },
  // Refunded before any payout: it no longer counts.
  voided: { shape: 'failed', tone: 'muted', className: 'border-dotted border-input bg-transparent text-muted-foreground' },
}

/** One payout line's state, worded `admin:earnings.states.<state>`. */
export function PayoutItemBadge({ state }: { state: PayoutItemState }) {
  const { t } = useTranslation()
  const { shape, tone, className } = ITEM_STATES[state]
  return (
    <Badge variant="outline" data-state={state} className={cn(BADGE, className)}>
      <StatusShapeGlyph shape={shape} tone={tone} />
      {t(`admin:earnings.states.${state}`)}
    </Badge>
  )
}

const PAYOUT_STATUSES: Record<'draft' | 'paid' | 'cancelled', Treatment> = {
  draft: { shape: 'waiting', tone: 'muted', className: 'border-dashed border-input bg-transparent text-foreground' },
  paid: { shape: 'current', tone: 'success', className: 'border-transparent bg-console-success-tint text-console-success' },
  cancelled: { shape: 'failed', tone: 'muted', className: 'border-border bg-transparent text-muted-foreground' },
}

/**
 * A payout's status. The words differ by console ("Being prepared" to the
 * photographer, "Draft" to the platform), so the caller passes its own.
 */
export function PayoutStatusBadge({ status, size = 'sm', children }: { status: 'draft' | 'paid' | 'cancelled'; size?: 'sm' | 'md'; children: ReactNode }) {
  const { shape, tone, className } = PAYOUT_STATUSES[status]
  return (
    <Badge
      variant="outline"
      data-status={status}
      className={cn(BADGE, size === 'md' && 'px-2.5 py-[5px] text-sm [&>svg]:size-4!', className)}
    >
      <StatusShapeGlyph shape={shape} tone={tone} />
      {children}
    </Badge>
  )
}
