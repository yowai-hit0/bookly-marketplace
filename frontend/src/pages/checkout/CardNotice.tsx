import { CircleAlert, Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Callout } from '@/components/ui/callout'
import type { CardPhase } from '@/lib/use-card-checkout'

/**
 * What the card modal came to when it handed the pay page back (`useCardCheckout`):
 * closed with no callback -- nothing was charged for an unfinished payment, and
 * honest that a finished one may still be confirming -- or a script that would
 * not load. Shared by the checkout, both booking pages and the studio
 * subscription.
 *
 * Closed is information, not an error (the payer chose to close it), and a
 * live status; the load failure is an alert.
 */
export function CardNotice({ phase }: { phase: CardPhase }) {
  const { t } = useTranslation()
  if (phase === 'closed') {
    return (
      <Callout variant="console" tone="info" icon={Info} role="status" data-card-notice="closed">
        <p>{t('checkout:card.closed')}</p>
      </Callout>
    )
  }
  if (phase === 'loadFailed') {
    return (
      <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert" data-card-notice="load-failed">
        <p>{t('checkout:card.loadFailed')}</p>
      </Callout>
    )
  }
  return null
}
