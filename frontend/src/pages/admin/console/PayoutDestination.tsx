import { Landmark, Smartphone } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type PayoutMethod, formatMomoNumber } from '@/admin/payouts'
import { cn } from '@/lib/utils'
import { DATA, META } from './classes'

/**
 * Where a payout goes, said the same way in the studio and the platform: the
 * network or the bank, the number in mono (the one thing that must be read
 * exactly), and the name the account is registered to.
 */
export function PayoutDestination({ method, className }: { method: PayoutMethod; className?: string }) {
  const { t } = useTranslation()
  const momo = method.kind === 'momo'
  const Icon = momo ? Smartphone : Landmark
  const provider = momo
    ? method.momoNetwork === null
      ? t('admin:payoutMethod.kinds.momo')
      : t(`admin:payoutMethod.networks.${method.momoNetwork}`)
    : (method.bankName ?? t('admin:payoutMethod.kinds.bank'))
  const number = momo ? (method.momoNumber === null ? null : formatMomoNumber(method.momoNumber)) : method.bankAccountNumber

  return (
    <div data-slot="payout-destination" data-kind={method.kind} className={cn('flex min-w-0 flex-col gap-1', className)}>
      <span className="flex min-w-0 items-center gap-2">
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        <span className="min-w-0 wrap-anywhere">{provider}</span>
      </span>
      {number !== null && <span className={cn(DATA, 'wrap-anywhere')}>{number}</span>}
      <span className={cn(META, 'wrap-anywhere')}>{t('admin:payoutMethod.summary.accountName', { name: method.accountName })}</span>
    </div>
  )
}
