import { Mail, MessageCircle, Phone, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { type ContactChannels, type ContactLink, contactLinks } from '@/lib/contact'
import { cn } from '@/lib/utils'

/**
 * A photographer's contact channels, only those set on their profile
 * (marketplace spec R6.2, R6.4): phone `tel:`, WhatsApp `wa.me` in a new tab
 * with `rel="noopener noreferrer"`, email `mailto:`. Each row is a label and
 * the value as a link, the value the photographer's own text. Renders nothing
 * when none is set: there are no placeholder details.
 *
 * Plain rows, not a `ul` with `dl`: the service page's tests read `dl dt` and
 * the slot picker's list page-wide.
 */

const ICONS: Record<ContactLink['kind'], LucideIcon> = { phone: Phone, whatsapp: MessageCircle, email: Mail }

export function ContactList({ contact, className }: { contact: ContactChannels; className?: string }) {
  const { t } = useTranslation()
  const links = contactLinks(contact)
  if (links.length === 0) return null

  return (
    <div className={cn('flex flex-col gap-1', className)} data-contact="">
      {links.map((link) => {
        const Icon = ICONS[link.kind]
        return (
          <p key={link.kind} className="flex min-w-0 flex-wrap items-center gap-x-2.5 text-[0.9375rem]">
            <Icon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
            <span className="text-subtle-foreground">{t(`shell:contact.${link.kind}`)}</span>
            <a
              href={link.href}
              {...(link.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              className="text-console-link hover:text-console-link-hover inline-flex min-h-6 min-w-0 items-center rounded-xs wrap-anywhere underline-offset-4 hover:underline pointer-coarse:min-h-11"
            >
              {link.value}
            </a>
          </p>
        )
      })}
    </div>
  )
}
