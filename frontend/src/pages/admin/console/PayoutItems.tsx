import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import type { PayoutItem } from '@/admin/payouts'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { DATA, META, REF_LINK, TD, TH, TR } from './classes'
import { PayoutItemBadge } from './PayoutBadges'

const COLUMNS = ['booking', 'line', 'state', 'amount', 'date'] as const

/**
 * Payout lines as a table (marketplace spec R4.5): the booking each is for,
 * what it is, its state in words, its amount, and when it was added. A
 * reversal is shown as the negative it is. In the studio each booking
 * reference links to the booking (`linkBookings`); the platform has no booking
 * page, so there it is plain text. Below a 44rem container each row stacks
 * into one block (admin-console.md 6.5).
 */
export function PayoutItems({ items, caption, linkBookings = false }: { items: PayoutItem[]; caption: string; linkBookings?: boolean }) {
  const { t } = useTranslation()

  return (
    <div className="@container">
      <table role="table" className="w-full border-collapse text-[0.9375rem]">
        <caption className="sr-only">{caption}</caption>
        <thead role="rowgroup" className="@max-[44rem]:sr-only">
          <tr role="row" className="border-b">
            {COLUMNS.map((column) => (
              <th key={column} role="columnheader" scope="col" className={cn(TH, column === 'amount' && 'text-right')}>
                {t(`admin:earnings.items.columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="@max-[44rem]:block">
          {items.map((item) => {
            const kind = t(`admin:booking.paymentKinds.${item.payment.kind}`, { defaultValue: item.payment.kind })
            return (
              <tr
                key={item.id}
                role="row"
                data-item={item.id}
                data-kind={item.kind}
                className={cn(TR, '@max-[44rem]:flex @max-[44rem]:flex-col @max-[44rem]:gap-2 @max-[44rem]:py-4')}
              >
                <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                  <div className="flex flex-col gap-1">
                    {linkBookings ? (
                      <Link to={`/studio/bookings/${item.booking.id}`} className={cn(REF_LINK, 'self-start')}>
                        {item.booking.reference}
                      </Link>
                    ) : (
                      <span className={DATA}>{item.booking.reference}</span>
                    )}
                    <span className={META}>{t('admin:earnings.items.shoot', { date: formatDateTime(item.booking.startsAt) })}</span>
                  </div>
                </td>
                <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                  {item.kind === 'reversal' ? t('admin:earnings.items.reversal', { kind: kind.toLowerCase() }) : kind}
                </td>
                <td role="cell" className={cn(TD, '@max-[44rem]:p-0')}>
                  <PayoutItemBadge state={item.state} />
                </td>
                <td
                  role="cell"
                  className={cn(
                    TD,
                    DATA,
                    'text-right whitespace-nowrap',
                    item.kind === 'reversal' && 'text-destructive',
                    item.state === 'voided' && 'text-muted-foreground',
                    '@max-[44rem]:p-0 @max-[44rem]:text-left',
                  )}
                >
                  {formatMoney(item.amountRwf)}
                </td>
                <td role="cell" className={cn(TD, META, 'tabular-nums', '@max-[44rem]:p-0')}>
                  {formatDateTime(item.createdAt)}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
