import { Ban, CalendarClock, Images, type LucideIcon, MessageSquare, Receipt, Wallet, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { kigaliDateOf } from '@/admin/calendar-dates'
import type { ClientNotice } from '@/catalogue/booking-access'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { formatDate, formatDateTime, formatMoney, formatTime } from '@/lib/format'
import { dismissNotice, isNoticeShown, markNoticesSeen, readSeen } from '@/lib/seen-notices'

/**
 * What has happened to a booking, at the top of its page
 * (docs/prompts/client-access-and-admin-polish.md, item 8): moved, a fee asked
 * for, a payment received, the photos sent, cancelled by the photographer,
 * money still owed, and the photographer's own notes -- newest first, as the
 * API lists them.
 *
 * Each can be closed, and each stops showing a day after this device first
 * showed it, except money still owed, which only closing hides
 * (`lib/seen-notices.ts`). With nothing left to show, nothing renders.
 *
 * Restyled as console callouts (design-system/bookly/client-front.md §8.5,
 * 2026-09-27): a tone per kind's meaning, the dismiss button kept as the
 * callout's trailing ghost icon button.
 */

const ICONS: Record<ClientNotice['kind'], LucideIcon> = {
  reschedule: CalendarClock,
  session_fee_request: Wallet,
  payment_receipt: Receipt,
  photo_delivery: Images,
  cancelled_by_photographer: Ban,
  balance_due: Wallet,
  note: MessageSquare,
}

/** The tone each notice kind reads as: a positive outcome, a caution, or a plain update. */
const TONES: Record<ClientNotice['kind'], 'info' | 'success' | 'warning' | 'destructive'> = {
  reschedule: 'info',
  session_fee_request: 'warning',
  payment_receipt: 'success',
  photo_delivery: 'success',
  cancelled_by_photographer: 'destructive',
  balance_due: 'warning',
  note: 'info',
}

export function Notices({ reference, notices }: { reference: string; notices: ClientNotice[] }) {
  const { t } = useTranslation()
  // Read once per render from storage, so a close takes effect at once.
  const [, setVersion] = useState(0)
  const [now] = useState(() => Date.now())
  const seen = readSeen(reference)
  const shown = notices.filter((notice) => isNoticeShown(notice, seen, now))
  const shownIds = shown.map((notice) => notice.id).join('|')

  useEffect(() => {
    if (shownIds !== '') markNoticesSeen(reference, shownIds.split('|'), now)
  }, [reference, shownIds, now])

  if (shown.length === 0) return null

  return (
    <section aria-label={t('booking:notices.label')} className="flex flex-col gap-3">
      <ul className="flex flex-col gap-3">
        {shown.map((notice) => (
          // The dismiss button sits in the banner's top-right corner at every
          // width: the banner's action slot drops to a row of its own on a
          // phone, which suits a text link but strands a lone X.
          <li key={notice.id} className="relative">
            <Callout variant="console" tone={TONES[notice.kind]} icon={ICONS[notice.kind]} className="pr-14">
              <p className="wrap-anywhere">
                <NoticeText notice={notice} />
              </p>
              {/* Secondary, not muted: muted grey falls under 4.5:1 on the light tints. */}
              <p className="text-subtle-foreground font-mono text-xs">{formatDateTime(notice.at)}</p>
            </Callout>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('booking:notices.dismiss')}
              className="absolute top-1.5 right-1.5 hover:bg-black/5 dark:hover:bg-white/10"
              onClick={() => {
                dismissNotice(reference, notice.id, Date.now())
                setVersion((n) => n + 1)
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NoticeText({ notice }: { notice: ClientNotice }) {
  const { t } = useTranslation()
  switch (notice.kind) {
    case 'reschedule':
      return t('booking:notices.reschedule', {
        date: formatDate(kigaliDateOf(notice.data.startsAt)),
        start: formatTime(notice.data.startsAt),
        end: formatTime(notice.data.endsAt),
      })
    case 'session_fee_request':
      return t('booking:notices.sessionFeeRequest', { amount: formatMoney(notice.data.amountRwf) })
    case 'payment_receipt':
      return t('booking:notices.paymentReceipt', { amount: formatMoney(notice.data.amountRwf) })
    case 'photo_delivery':
      return t('booking:notices.photoDelivery')
    case 'cancelled_by_photographer':
      return t('booking:notices.cancelledByPhotographer')
    case 'balance_due':
      return (
        <>
          {t('booking:notices.balanceDue', { amount: formatMoney(notice.data.amountRwf) })}{' '}
          <a href="#pay" className="text-console-link hover:text-console-link-hover font-medium underline underline-offset-4">
            {t('booking:notices.payNow')}
          </a>
        </>
      )
    case 'note':
      return (
        <>
          <span className="font-medium">{t('booking:notices.fromPhotographer')}</span>{' '}
          {/* Plain text, as the photographer typed it: React escapes it, and line breaks stay. */}
          <span className="whitespace-pre-line">{notice.data.body}</span>
        </>
      )
  }
}
