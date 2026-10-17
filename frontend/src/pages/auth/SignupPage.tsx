import { Check, Circle } from 'lucide-react'
import { type FormEvent, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError } from '@/auth/api'
import { AREA_PATHS } from '@/auth/areas'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, resendVerification, signUpClient, signUpPhotographer } from '@/auth/client'
import { handleRules, isValidHandle, normaliseHandle } from '@/auth/handle'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { AdminField } from '@/pages/admin/AdminField'
import { AuthFrame, AuthInput, AuthLink, FormAlert, SentNotice, SubmitButton } from './kit'
import { lookOf } from './look'

type SignupArea = 'studio' | 'account'
type Field = 'email' | 'password' | 'displayName' | 'handle' | 'fullName'
type Status = 'idle' | 'submitting' | 'sent' | 'invalid' | 'rateLimited' | 'failed'
type ResendStatus = 'idle' | 'submitting' | 'sent' | 'rateLimited' | 'failed'

const FIELDS: Record<SignupArea, readonly Field[]> = {
  studio: ['email', 'password', 'displayName', 'handle'],
  account: ['email', 'password', 'fullName'],
}

const MAX_DISPLAY_NAME = 80
const MAX_FULL_NAME = 200
/** Enough to catch a typo; the API checks the address properly. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/

/**
 * `/studio/signup` and `/account/signup` (marketplace spec R2.2, R2.3, R2.1c).
 *
 * The API answers `202` whether or not the address already has an account, so
 * the page says the same thing for every address: "if an account needs it,
 * we've sent an email". The only refusals it words are the form's own (a
 * value the API does not accept) and, for a studio, a handle that is taken or
 * reserved: handles are public, so saying so leaks nothing.
 *
 * The handle shows its rule as it is typed (`auth/handle.ts`, the API's
 * pattern), and what the profile address will be.
 */
export function SignupPage({ area }: { area: SignupArea }) {
  const { t } = useTranslation()
  const look = lookOf(area)
  const formRef = useRef<HTMLFormElement>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [handle, setHandle] = useState('')
  const [sentTo, setSentTo] = useState('')

  function focusFirst(failing: Partial<Record<Field, string>>) {
    const first = FIELDS[area].find((field) => failing[field] !== undefined)
    if (first === undefined) return
    formRef.current?.querySelector<HTMLInputElement>(`[name="${first}"]`)?.focus()
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (status === 'submitting') return
    const data = new FormData(event.currentTarget)
    const value = (field: Field) => String(data.get(field) ?? '')

    const email = value('email').trim()
    const password = value('password')
    const found: Partial<Record<Field, string>> = {}
    if (!EMAIL_SHAPE.test(email)) found.email = t('auth:signup.errors.email')
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) found.password = t('auth:signup.errors.password')
    if (area === 'studio') {
      const name = value('displayName').trim()
      if (name === '' || name.length > MAX_DISPLAY_NAME) found.displayName = t('auth:signup.errors.displayName')
      if (!isValidHandle(value('handle'))) found.handle = t('auth:signup.errors.handle')
    } else {
      const name = value('fullName').trim()
      if (name === '' || name.length > MAX_FULL_NAME) found.fullName = t('auth:signup.errors.fullName')
    }

    setErrors(found)
    if (Object.keys(found).length > 0) {
      setStatus('idle')
      focusFirst(found)
      return
    }

    setStatus('submitting')
    try {
      if (area === 'studio') {
        await signUpPhotographer({ email, password, displayName: value('displayName').trim(), handle: normaliseHandle(value('handle')) })
      } else {
        await signUpClient({ email, password, fullName: value('fullName').trim() })
      }
      setSentTo(email)
      setStatus('sent')
    } catch (error) {
      if (!(error instanceof ApiError)) {
        setStatus('failed')
        return
      }
      if (error.status === 409 && area === 'studio') {
        const taken = { handle: t('auth:signup.errors.handleTaken') }
        setErrors(taken)
        setStatus('idle')
        focusFirst(taken)
        return
      }
      if (error.status === 422) {
        const named: Partial<Record<Field, string>> = {}
        for (const field of error.fields) {
          if ((FIELDS[area] as readonly string[]).includes(field)) named[field as Field] = t(`auth:signup.errors.${field as Field}`)
        }
        setErrors(named)
        setStatus(Object.keys(named).length > 0 ? 'idle' : 'invalid')
        focusFirst(named)
        return
      }
      if (error.status === 400) setStatus('invalid')
      else if (error.status === 429) setStatus('rateLimited')
      else setStatus('failed')
    }
  }

  const title = area === 'studio' ? t('auth:signup.studioTitle') : t('auth:signup.accountTitle')

  if (status === 'sent') {
    return (
      <AuthFrame area={area} title={title}>
        <div className="flex flex-col gap-4">
          <SentNotice look={look} title={t('auth:signup.sentTitle')}>
            {t('auth:signup.sentBody')}
          </SentNotice>
          <ResendLink area={area} email={sentTo} />
          <AuthLink look={look} to={AREA_PATHS[area].login}>
            {t('auth:backToSignIn')}
          </AuthLink>
        </div>
      </AuthFrame>
    )
  }

  const message =
    status === 'invalid'
      ? t('auth:signup.errors.invalid')
      : status === 'rateLimited'
        ? t('auth:rateLimited')
        : status === 'failed'
          ? t('auth:signup.errors.failed')
          : null

  return (
    <AuthFrame area={area} title={title} intro={area === 'studio' ? t('auth:signup.studioIntro') : t('auth:signup.accountIntro')}>
      <div className="flex flex-col gap-4">
        <form ref={formRef} className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
          <AdminField label={t('auth:signup.email')} error={errors.email ?? null}>
            {(props) => <AuthInput look={look} {...props} name="email" type="email" autoComplete="email" inputMode="email" required />}
          </AdminField>
          <AdminField label={t('auth:signup.password')} hint={t('auth:signup.passwordHint')} error={errors.password ?? null}>
            {(props) => (
              <AuthInput look={look} {...props} name="password" type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} required />
            )}
          </AdminField>
          {area === 'studio' ? (
            <>
              <AdminField label={t('auth:signup.displayName')} hint={t('auth:signup.displayNameHint')} error={errors.displayName ?? null}>
                {(props) => <AuthInput look={look} {...props} name="displayName" autoComplete="organization" maxLength={MAX_DISPLAY_NAME} required />}
              </AdminField>
              <HandleField look={look} value={handle} onChange={setHandle} error={errors.handle ?? null} />
            </>
          ) : (
            <AdminField label={t('auth:signup.fullName')} error={errors.fullName ?? null}>
              {(props) => <AuthInput look={look} {...props} name="fullName" autoComplete="name" maxLength={MAX_FULL_NAME} required />}
            </AdminField>
          )}
          {message !== null && <FormAlert>{message}</FormAlert>}
          <SubmitButton look={look} busy={status === 'submitting'}>
            {status === 'submitting' ? t('auth:signup.submitting') : area === 'studio' ? t('auth:signup.studioSubmit') : t('auth:signup.accountSubmit')}
          </SubmitButton>
        </form>
        <AuthLink look={look} to={AREA_PATHS[area].login}>
          {t('auth:signup.haveAccount')}
        </AuthLink>
      </div>
    </AuthFrame>
  )
}

/**
 * The handle, with its rule shown part by part as it is typed and the profile
 * address it makes. The rule list describes the field, so a screen reader
 * hears it with the label; each part says in words whether it is met, not by
 * the icon alone.
 */
function HandleField({
  look,
  value,
  onChange,
  error,
}: {
  look: 'console' | 'client'
  value: string
  onChange: (value: string) => void
  error: string | null
}) {
  const { t } = useTranslation()
  const rulesId = useId()
  const rules = handleRules(value)
  const normalised = normaliseHandle(value)

  return (
    <AdminField label={t('auth:signup.handle')} error={error}>
      {(props) => (
        <>
          <AuthInput
            look={look}
            {...props}
            aria-describedby={[rulesId, props['aria-describedby']].filter(Boolean).join(' ')}
            name="handle"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={60}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            required
            className="font-mono"
          />
          <div id={rulesId} className="text-muted-foreground flex flex-col gap-1.5 text-[0.8125rem] leading-snug">
            {normalised !== '' && (
              <p className="wrap-anywhere">{t('auth:signup.handlePreview', { path: `/p/${normalised}` })}</p>
            )}
            <p className="sr-only">{t('auth:signup.handleRules.label')}</p>
            <ul className="flex flex-col gap-1">
              {(['length', 'chars', 'edges'] as const).map((rule) => (
                <li key={rule} data-rule={rule} data-met={rules[rule]} className={cn('flex items-start gap-1.5', rules[rule] && 'text-foreground')}>
                  {rules[rule] ? (
                    <Check aria-hidden="true" className="text-console-success mt-px size-3.5 shrink-0" />
                  ) : (
                    <Circle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                  )}
                  <span>
                    <span className="sr-only">{rules[rule] ? t('auth:signup.ruleMet') : t('auth:signup.ruleUnmet')} </span>
                    {t(`auth:signup.handleRules.${rule}`)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </AdminField>
  )
}

/** "Send the link again" after signing up: the same words afterwards whatever the address. */
function ResendLink({ area, email }: { area: SignupArea; email: string }) {
  const { t } = useTranslation()
  const look = lookOf(area)
  const [status, setStatus] = useState<ResendStatus>('idle')

  async function resend() {
    setStatus('submitting')
    try {
      await resendVerification(area, email)
      setStatus('sent')
    } catch (error) {
      setStatus(error instanceof ApiError && error.status === 429 ? 'rateLimited' : 'failed')
    }
  }

  if (status === 'sent') return <SentNotice look={look}>{t('auth:signup.resent')}</SentNotice>

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant={look === 'console' ? 'console-outline' : 'outline'}
        size={look === 'console' ? 'console' : 'default'}
        className="self-start"
        disabled={status === 'submitting'}
        onClick={() => void resend()}
      >
        {status === 'submitting' ? t('auth:signup.resending') : t('auth:signup.resend')}
      </Button>
      {status === 'failed' && <FormAlert>{t('auth:signup.resendFailed')}</FormAlert>}
      {status === 'rateLimited' && <FormAlert>{t('auth:rateLimited')}</FormAlert>}
    </div>
  )
}
