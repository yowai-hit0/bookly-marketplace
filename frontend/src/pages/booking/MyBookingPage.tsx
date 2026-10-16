import { CalendarDays, CircleAlert, MailCheck } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { requestBookingLinks } from '@/catalogue/booking-links'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import { container, eyebrow, pageTitle, pageY } from '@/pages/client/classes'

/**
 * `/my-booking`: a client who lost their link types their email and gets a
 * fresh one for each current booking (docs/prompts/client-access-and-admin-polish.md,
 * item 4). The header's "My booking" leads here when this device holds no link.
 *
 * Whatever the address, the page says the same thing afterwards -- "if we
 * found a booking, it is in your inbox" -- because the API cannot and does not
 * say more: this page must not tell anyone who books.
 *
 * Restyled to the narrow centred panel of client-front.md 8.5.
 */

type Status = 'idle' | 'sending' | 'sent' | 'invalid' | 'failed'

export function MyBookingPage() {
  const { t } = useTranslation()
  const fieldId = useId()
  const fieldRef = useRef<HTMLInputElement>(null)
  const [status, setStatus] = useState<Status>('idle')

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'sending') return
    const form = event.currentTarget
    const email = String(new FormData(form).get('email') ?? '').trim()
    // The browser's own email rule first; the API checks again.
    if (email === '' || !form.checkValidity()) {
      setStatus('invalid')
      fieldRef.current?.focus()
      return
    }
    setStatus('sending')
    const result = await requestBookingLinks(email)
    setStatus(result)
    if (result === 'invalid') fieldRef.current?.focus()
  }

  return (
    <main className={cn(container, pageY, 'flex justify-center')}>
      <div className="w-full max-w-md rounded-xs border p-6 text-pretty sm:p-8">
        <p className={eyebrow}>
          <CalendarDays aria-hidden="true" />
          {t('shell:nav.myBooking')}
        </p>
        <h1 className={cn(pageTitle, 'mt-2')}>{t('myBooking:title')}</h1>
        <p className="text-subtle-foreground mt-2">{t('myBooking:intro')}</p>

        {status === 'sent' ? (
          <div className="mt-6 flex flex-col items-start gap-4">
            {/* Info, not success: the message deliberately does not say whether a booking was found. */}
            <Callout variant="console" tone="info" icon={MailCheck} role="status">
              <p className="font-medium">{t('myBooking:sent.title')}</p>
              <p>{t('myBooking:sent.body')}</p>
            </Callout>
            <Button variant="outline" size="sm" onClick={() => setStatus('idle')}>
              {t('myBooking:sent.again')}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} noValidate className="mt-6 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={fieldId}>{t('myBooking:email')}</Label>
              <Input
                ref={fieldRef}
                id={fieldId}
                name="email"
                type="email"
                autoComplete="email"
                inputMode="email"
                required
                aria-invalid={status === 'invalid' || undefined}
                aria-describedby={`${fieldId}-hint${status === 'invalid' ? ` ${fieldId}-error` : ''}`}
              />
              <p id={`${fieldId}-hint`} className="text-muted-foreground text-[0.8125rem]">
                {t('myBooking:hint')}
              </p>
              {status === 'invalid' && (
                <p id={`${fieldId}-error`} className="text-destructive flex items-center gap-1.5 text-[0.8125rem]">
                  <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
                  {t('myBooking:invalid')}
                </p>
              )}
            </div>
            {status === 'failed' && (
              <p className="text-destructive text-sm" role="alert">
                {t('myBooking:failed')}
              </p>
            )}
            <Button type="submit" className="client:h-12 w-full" aria-disabled={status === 'sending'}>
              {status === 'sending' ? t('myBooking:sending') : t('myBooking:submit')}
            </Button>
          </form>
        )}
      </div>
    </main>
  )
}
