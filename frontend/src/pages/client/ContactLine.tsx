import { useTranslation } from 'react-i18next'
import { contactLinks, PHOTOGRAPHER_CONTACT } from '@/lib/contact'
import { cn } from '@/lib/utils'

/**
 * "Questions?" and the photographer's contact channels that exist
 * (`lib/contact.ts`; client-front.md 5.8), for the price summary: the label,
 * then one channel per line, so a 360px column never strands a separator.
 * Renders nothing while no channel is set. Links, never buttons, and no `dl`:
 * the e2e suite counts the summary's buttons and reads `dl dt` page-wide.
 */
export function ContactLine({ className }: { className?: string }) {
  const { t } = useTranslation()
  const links = contactLinks(PHOTOGRAPHER_CONTACT)
  if (links.length === 0) return null

  return (
    <div className={cn('text-muted-foreground flex flex-col gap-0.5 text-[0.8125rem]', className)}>
      <p>{t('shell:contact.questions')}</p>
      {/* Plain lines, not a list: the page's tests find the times list by role. */}
      <div className="flex flex-col">
        {links.map((link) => (
          <p key={link.kind} className="flex flex-wrap items-center gap-x-2">
            <span>{t(`shell:contact.${link.kind}`)}</span>
            <a
              href={link.href}
              className="text-console-link hover:text-console-link-hover inline-flex min-h-6 items-center rounded-xs underline-offset-4 hover:underline pointer-coarse:min-h-11"
            >
              {link.value}
            </a>
          </p>
        ))}
      </div>
    </div>
  )
}
