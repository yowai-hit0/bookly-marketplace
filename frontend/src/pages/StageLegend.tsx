import { Info } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BOOKING_STAGES } from '@/admin/bookings'
import { CLIENT_STAGES } from '@/catalogue/booking-access'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { StatusBadge } from '@/components/ui/status-badge'

/**
 * "What the statuses mean" (docs/prompts/client-access-and-admin-polish.md,
 * item 7): an info button beside a status, opening a list of every stage its
 * reader can meet, each as its badge and one sentence.
 *
 * A popover, not a hover tooltip: it opens on click, tap, Enter and Space as
 * well as a pointer, so it works on a phone and from the keyboard. The client
 * never sees `needs_review`, which is the photographer's reminder, not theirs.
 */
export function StageLegend({ audience }: { audience: 'client' | 'admin' }) {
  const { t } = useTranslation()
  const stages = audience === 'admin' ? BOOKING_STAGES : CLIENT_STAGES
  // `admin:bookings.stage.x` and `booking:stage.x`: the same keys under each reader's namespace.
  const key = (rest: string) => (audience === 'admin' ? `admin:bookings.${rest}` : `booking:${rest}`)

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t(key('stageLegend.label'))} className="text-muted-foreground">
          <Info aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent>
        <p className="mb-3 font-semibold">{t(key('stageLegend.title'))}</p>
        <ul className="flex flex-col gap-3">
          {stages.map((stage) => (
            <li key={stage} className="flex flex-col items-start gap-1">
              <StatusBadge status={stage}>{t(key(`stage.${stage}`))}</StatusBadge>
              <span className="text-muted-foreground text-pretty">{t(key(`stageHelp.${stage}`))}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
