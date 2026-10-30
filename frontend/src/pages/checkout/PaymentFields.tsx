import { Check, LockKeyhole } from 'lucide-react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { type PaymentMethod, needsPhoneFor } from '@/catalogue/payments'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SelectableCard } from '@/components/ui/selectable-card'
import { cn } from '@/lib/utils'
import { eyebrow } from '@/pages/client/classes'

/**
 * Choosing how to pay, and the number to prompt (plan.md Tasks 16 and 18,
 * spec §6.19). One definition, so the booking fee at checkout and the session
 * fee on a client's own booking page offer exactly the same thing.
 *
 * `methods` is the API's answer and nothing else: a method not routed to a
 * configured provider (marketplace-spec.md R3.1) is absent from the page, not
 * disabled. MTN MoMo and Airtel Money are both paid from a phone, so either
 * one asks for the same number, with the same hint and the same check.
 *
 * Restyled per design-system/bookly/client-front.md §8.4: each method is a
 * `SelectableCard` with its native radio visually hidden (`data-focus-ring`
 * hands its outline to the card) and a text chip carrying the method's
 * existing name -- no logo artwork, no MTN yellow.
 *
 * A card (Flutterwave v3 Inline, 2026-10-30) asks for nothing here: the
 * details go into Flutterwave's own window, which the pay page opens, and one
 * line under the options says so. No fee line: the platform absorbs the card
 * fee, so the client pays the amount on the button.
 */

type Props = {
  methods: PaymentMethod[]
  method: PaymentMethod | null
  onMethod: (method: PaymentMethod) => void
  phoneId: string
  phoneRef: RefObject<HTMLInputElement | null>
  phoneInvalid: boolean
}

export function PaymentFields({ methods, method, onMethod, phoneId, phoneRef, phoneInvalid }: Props) {
  const { t } = useTranslation()

  const cardHintId = `${phoneId}-card-hint`

  return (
    <>
      <fieldset className="flex flex-col gap-2.5">
        <legend className={cn(eyebrow, 'mb-1')}>{t('checkout:methods.legend')}</legend>
        {methods.map((option) => {
          const checked = method === option
          return (
            <SelectableCard key={option} className="items-center gap-4 p-4">
              <input
                type="radio"
                name="method"
                value={option}
                checked={checked}
                onChange={() => onMethod(option)}
                // The line under the options says where the card is entered; a screen reader hears it with the choice.
                aria-describedby={option === 'card' && checked ? cardHintId : undefined}
                data-focus-ring="parent"
                className="sr-only"
              />
              <span
                className={cn(
                  // `pointer-events-none`: the input is `sr-only` (a near-zero-size
                  // target), so a click must fall through to the label beneath it
                  // rather than land on this visible chip.
                  'pointer-events-none inline-flex items-center rounded-xs border px-2.5 py-1.5 font-mono text-xs font-medium tracking-[0.05em] uppercase',
                  checked ? 'border-selected-edge text-foreground' : 'border-input text-subtle-foreground',
                )}
              >
                {t(`checkout:methods.${option}`)}
              </span>
              <span
                aria-hidden="true"
                className={cn(
                  'bg-brand text-brand-foreground pointer-events-none ml-auto flex size-6 shrink-0 items-center justify-center rounded-xs motion-safe:transition-[opacity,scale] motion-safe:duration-250',
                  checked ? 'scale-100 opacity-100 motion-safe:animate-tick' : 'scale-40 opacity-0',
                )}
              >
                <Check className="size-3.5" strokeWidth={2.6} />
              </span>
            </SelectableCard>
          )
        })}
      </fieldset>

      {method === 'card' && (
        <p id={cardHintId} className="text-muted-foreground flex items-start gap-2 text-sm" data-card-hint="">
          <LockKeyhole aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t('checkout:card.hint')}
        </p>
      )}

      {needsPhoneFor(method) && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={phoneId}>{t('checkout:phone.label')}</Label>
          <Input
            ref={phoneRef}
            id={phoneId}
            name="phone"
            type="tel"
            autoComplete="tel"
            required
            className="font-mono"
            aria-invalid={phoneInvalid || undefined}
            aria-describedby={[`${phoneId}-hint`, phoneInvalid ? `${phoneId}-error` : null].filter(Boolean).join(' ')}
          />
          <p id={`${phoneId}-hint`} className="text-muted-foreground text-sm">
            {t('checkout:phone.hint')}
          </p>
          {phoneInvalid && (
            <p id={`${phoneId}-error`} className="text-destructive text-sm">
              {t('checkout:phone.invalid')}
            </p>
          )}
        </div>
      )}
    </>
  )
}
