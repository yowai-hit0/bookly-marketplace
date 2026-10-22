import { CircleCheck, CircleX, Clock, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SubscriptionStatus } from '@/admin/subscription'
import { cn } from '@/lib/utils'

/**
 * A subscription's status in the console (admin-console.md section 5's four
 * shapes, for the subscription's own words): a trial is the chip with a clock,
 * active is the success tint with a filled check, past due is the warning tint
 * with a clock, expired is a dotted edge and a muted cross. The word is always
 * shown, so the shape is never the only signal. Used by the studio's page and
 * the platform's list alike.
 */

const LOOK: Record<SubscriptionStatus, { icon: LucideIcon; className: string }> = {
  trialing: { icon: Clock, className: 'bg-console-chip text-foreground' },
  active: { icon: CircleCheck, className: 'bg-console-success-tint text-console-success' },
  past_due: { icon: Clock, className: 'bg-console-warning-tint text-console-warning' },
  expired: { icon: CircleX, className: 'border border-dotted border-input text-muted-foreground' },
}

export function SubscriptionStatusBadge({ status, className }: { status: SubscriptionStatus; className?: string }) {
  const { t } = useTranslation()
  const look = LOOK[status]
  const Icon = look.icon
  return (
    <span
      data-subscription-status={status}
      className={cn('inline-flex w-fit shrink-0 items-center gap-1.5 rounded-xs px-2.5 py-[5px] text-sm font-medium whitespace-nowrap', look.className, className)}
    >
      <Icon aria-hidden="true" className="size-3.5 shrink-0" />
      {t(`admin:subscription.status.${status}`)}
    </span>
  )
}
