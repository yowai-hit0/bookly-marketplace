import { CircleAlert, CircleCheck, Mail, Unlink } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { confirmEmailChange } from '@/catalogue/booking-access'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { StatusIcon } from '@/components/ui/status-icon'
import { cn } from '@/lib/utils'
import { container, eyebrow, pageTitle, pageY, statusTitle } from '@/pages/client/classes'

/**
 * `/email-confirm/:token`: where the link in a contact-email confirmation lands
 * (docs/prompts/client-access-and-admin-polish.md, item 6).
 *
 * Opening the page changes nothing: the change is made by the button. Mail
 * scanners open links, and some run scripts, so a change confirmed on load
 * could be confirmed by a machine. An unknown, expired, used or replaced link
 * is one "not valid" page, as a dead booking link is.
 *
 * Restyled to the narrow centred panel of client-front.md 8.5. The eyebrow
 * reuses `booking:contact.title` ("Your email"): the nearest existing string,
 * since a purpose-written one (e.g. "Email confirmation") is a new key this
 * group did not add -- see the report.
 */

type Status = 'idle' | 'confirming' | 'confirmed' | 'invalid' | 'failed'

export function EmailConfirmPage() {
  const { t } = useTranslation()
  const { token = '' } = useParams()
  const [status, setStatus] = useState<Status>('idle')

  async function confirm() {
    if (status === 'confirming') return
    setStatus('confirming')
    setStatus(await confirmEmailChange(token))
  }

  if (status === 'invalid') {
    return (
      <main className={cn(container, pageY, 'flex justify-center')}>
        <div className="flex w-full max-w-md flex-col gap-3 rounded-xs border p-6 text-pretty sm:p-8">
          <StatusIcon icon={Unlink} tone="neutral" />
          <h1 className={statusTitle}>{t('emailConfirm:invalid.title')}</h1>
          <p className="text-muted-foreground text-sm">{t('emailConfirm:invalid.body')}</p>
        </div>
      </main>
    )
  }

  return (
    <main className={cn(container, pageY, 'flex justify-center')}>
      <div className="w-full max-w-md rounded-xs border p-6 text-pretty sm:p-8">
        <p className={eyebrow}>
          <Mail aria-hidden="true" />
          {t('booking:contact.title')}
        </p>
        <h1 className={cn(pageTitle, 'mt-2')}>{t('emailConfirm:title')}</h1>

        {status === 'confirmed' ? (
          <Callout variant="console" tone="success" icon={CircleCheck} role="status" className="mt-6">
            <p>{t('emailConfirm:done')}</p>
          </Callout>
        ) : (
          <>
            <p className="text-subtle-foreground mt-2">{t('emailConfirm:intro')}</p>
            {status === 'failed' && (
              <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert" className="mt-6">
                <p>{t('emailConfirm:failed')}</p>
              </Callout>
            )}
            <Button
              className={cn('client:h-12 w-full', status === 'failed' ? 'mt-4' : 'mt-6')}
              aria-disabled={status === 'confirming'}
              onClick={() => void confirm()}
            >
              {status === 'confirming' ? t('emailConfirm:confirming') : t('emailConfirm:confirm')}
            </Button>
          </>
        )}
      </div>
    </main>
  )
}
