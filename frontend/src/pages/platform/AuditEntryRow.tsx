import { Banknote, History, SlidersHorizontal, Tags, Undo2, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type AuditEntry, areaOf, describeEntry } from '@/platform/audit'
import { DATA, LINK, META } from '@/pages/admin/console/classes'

/**
 * One audit entry (Phase 9, R9.4) as the Activity page and a photographer's
 * recent activity show it: the area's icon, the plain-language sentence, any
 * lines under it (a suspension's reason, one per setting), then who did it,
 * when (Kigali), and the photographer it concerns as a link to their page.
 * Every value is plain text.
 */

/** The area's icon: who, money out, money back, settings or categories. */
function AreaIcon({ action }: { action: string }) {
  const area = areaOf(action)
  const props = { className: 'size-4' }
  if (area === 'photographers') return <Users {...props} />
  if (area === 'money') return action === 'refund_recorded' ? <Undo2 {...props} /> : <Banknote {...props} />
  if (area === 'settings') return <SlidersHorizontal {...props} />
  if (area === 'categories') return <Tags {...props} />
  return <History {...props} />
}

export function AuditEntryRow({ entry, showPhotographer = true }: { entry: AuditEntry; showPhotographer?: boolean }) {
  const { t } = useTranslation()
  const { sentence, lines } = describeEntry(t, entry)
  return (
    <li data-audit-entry={entry.id} data-action={entry.action} className="flex gap-4 border-b p-4 last:border-b-0 sm:px-6">
      <div aria-hidden="true" className="bg-console-chip flex size-8 shrink-0 items-center justify-center rounded-xs">
        <AreaIcon action={entry.action} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-base wrap-anywhere">{sentence}</p>
        {lines.length > 0 && (
          <ul className={cn(META, 'flex flex-col gap-1')}>
            {lines.map((line, index) => (
              <li key={index} className="whitespace-pre-line wrap-anywhere">
                {line}
              </li>
            ))}
          </ul>
        )}
        <p className={cn(META, 'flex flex-wrap items-center gap-x-2 gap-y-1')}>
          {entry.actor.email !== '' && (
            <>
              <span className="wrap-anywhere">{t('platform:activity.by', { email: entry.actor.email })}</span>
              <span aria-hidden="true">·</span>
            </>
          )}
          <time dateTime={entry.createdAt} className={cn(DATA, 'text-sm')}>
            {formatDateTime(entry.createdAt)}
          </time>
          {showPhotographer && entry.photographer !== null && (
            <>
              <span aria-hidden="true">·</span>
              <Link
                to={`/platform/photographers/${encodeURIComponent(entry.photographer.id)}`}
                className={cn(LINK, 'wrap-anywhere inline-flex items-center max-lg:min-h-11 pointer-coarse:min-h-11')}
              >
                {entry.photographer.displayName}
              </Link>
            </>
          )}
        </p>
      </div>
    </li>
  )
}
