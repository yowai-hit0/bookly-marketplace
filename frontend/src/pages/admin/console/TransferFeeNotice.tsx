import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Callout } from '@/components/ui/callout'

/**
 * The transfer-fee banner (marketplace spec R4.5): payouts are sent by hand,
 * the transfer fee comes out of what the photographer receives, so he may want
 * to price it in. Shown, always and without a way to dismiss it, on the
 * payout-method page and on the catalogue's package price form.
 */
export function TransferFeeNotice({ className }: { className?: string }) {
  const { t } = useTranslation()
  return (
    <Callout variant="console" tone="info" icon={Info} data-notice="transfer-fee" className={className}>
      <p>{t('admin:payoutMethod.transferFee')}</p>
    </Callout>
  )
}
