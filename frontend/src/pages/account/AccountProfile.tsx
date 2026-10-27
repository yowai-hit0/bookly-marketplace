import { CircleAlert, CircleCheck, Download, Info, MailCheck, Settings2 } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router'
import {
  type AccountProfile as Profile,
  changeAccountPassword,
  deleteAccount,
  downloadAccountExport,
  fetchAccountProfile,
  requestAccountEmailChange,
  setAccountPassword,
  updateAccountProfile,
} from '@/account/dashboard'
import { type AccountUser, forgetAccountMe, refreshAccountMe, useAccount } from '@/auth/account'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '@/auth/client'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { reportError } from '@/lib/report-error'
import { cn } from '@/lib/utils'
import { container, pageY, panel, panelTitle } from '@/pages/client/classes'
import { ClientField } from '@/pages/client/Field'
import type { DeletedLocationState } from './AccountDeletedPage'
import { LoadFailed, PageHead } from './parts'

/**
 * `/account/profile` (marketplace-spec R8.3; design-system/bookly/pages/
 * account-profile.md): the client's details (name and phone, which prefill
 * the booking form), their password, the email they sign in with, a download
 * of everything the account holds, and deleting the account.
 *
 * Which credential sections show follows `/me` (user decision 2, 2026-10-27):
 * a Google-only account (`hasPassword` false) may add a password; with one it
 * may change it and change the email, confirmed with it; without one the
 * email change is explained, not offered, and deleting is confirmed by typing
 * the address. A credential change answers a fresh token, which is kept
 * (`account/dashboard.ts`): every other token stops on its next request.
 */

/** Set by the email-change confirmation page when it lands here. */
export type ProfileLocationState = { emailChanged?: string } | null

export function AccountProfile() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const account = useAccount(attempt)
  const location = useLocation()
  const emailChanged = (location.state as ProfileLocationState)?.emailChanged ?? null

  return (
    <main className={cn(container, pageY, 'mx-auto flex max-w-3xl flex-col gap-8 text-pretty')}>
      <PageHead icon={Settings2} eyebrowText={t('auth:eyebrow.account')} title={t('account:profile.title')} lead={t('account:profile.lead')} />

      {emailChanged !== null && (
        <Callout variant="console" tone="success" icon={CircleCheck} role="status">
          <p className="wrap-anywhere">{t('account:profile.emailChanged', { email: emailChanged })}</p>
        </Callout>
      )}

      {account.state === 'failed' && <LoadFailed message={t('account:profile.loadFailed')} onRetry={() => setAttempt((n) => n + 1)} />}
      {(account.state === 'loading' || account.state === 'signedOut') && <SectionsLoading />}
      {account.state === 'ready' && (
        <>
          <DetailsSection />
          <PasswordSection user={account.user} />
          <EmailSection user={account.user} />
          <ExportSection />
          <DeleteSection user={account.user} />
        </>
      )}
    </main>
  )
}

function SectionsLoading() {
  const { t } = useTranslation()
  return (
    <div aria-busy="true" className="flex flex-col gap-6">
      <p className="sr-only" role="status">
        {t('account:profile.loading')}
      </p>
      {[0, 1, 2].map((index) => (
        <div key={index} aria-hidden="true" className={cn(panel, 'flex flex-col gap-4 p-5 sm:p-6')}>
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      ))}
    </div>
  )
}

/** One section of the page: a hairline panel with its `h2` and an optional intro. */
function Section({ title, intro, tone, children }: { title: string; intro?: ReactNode; tone?: 'danger'; children: ReactNode }) {
  return (
    <section className={cn(panel, 'flex flex-col gap-5 p-5 sm:p-6', tone === 'danger' && 'border-destructive/40')}>
      <div className="flex flex-col gap-1.5">
        <h2 className={panelTitle}>{title}</h2>
        {intro !== undefined && <div className="text-subtle-foreground text-sm">{intro}</div>}
      </div>
      {children}
    </section>
  )
}

/** A refusal or failure that belongs to no one field. */
function FormAlert({ children }: { children: ReactNode }) {
  return (
    <Callout variant="console" tone="destructive" icon={CircleAlert} role="alert">
      <p>{children}</p>
    </Callout>
  )
}

function Saved({ children }: { children: ReactNode }) {
  return (
    <Callout variant="console" tone="success" icon={CircleCheck} role="status">
      <p className="wrap-anywhere">{children}</p>
    </Callout>
  )
}

/** The form's submit: aria-disabled while busy, never `disabled`, so focus stays on it. */
function Submit({ busy, children, variant }: { busy: boolean; children: ReactNode; variant?: 'default' | 'destructive-solid' }) {
  return (
    <Button type="submit" variant={variant} className="self-start max-sm:w-full" aria-disabled={busy} aria-busy={busy}>
      {children}
    </Button>
  )
}

function isUnauthenticated(error: unknown): boolean {
  return error instanceof UnauthenticatedError
}

// --- Your details (name and phone) ----------------------------------------------------

type DetailsError = { fullName?: string; phone?: string; form?: string }

function DetailsSection() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetchAccountProfile(controller.signal).then(
      (answer) => !controller.signal.aborted && setProfile(answer),
      (error: unknown) => {
        if (controller.signal.aborted) return
        reportError(error, 'account_profile_load_failed')
        setFailed(true)
      },
    )
    return () => controller.abort()
  }, [attempt])

  return (
    <Section title={t('account:details.title')} intro={t('account:details.intro')}>
      {profile !== null ? (
        <DetailsForm profile={profile} onSaved={setProfile} />
      ) : failed ? (
        <LoadFailed
          message={t('account:profile.loadFailed')}
          onRetry={() => {
            setFailed(false)
            setAttempt((n) => n + 1)
          }}
        />
      ) : (
        <div aria-busy="true" className="flex flex-col gap-3">
          <p className="sr-only" role="status">
            {t('account:profile.loading')}
          </p>
          <Skeleton aria-hidden="true" className="h-11 w-full" />
          <Skeleton aria-hidden="true" className="h-11 w-full" />
        </div>
      )}
    </Section>
  )
}

function DetailsForm({ profile, onSaved }: { profile: Profile; onSaved: (profile: Profile) => void }) {
  const { t } = useTranslation()
  const [fullName, setFullName] = useState(profile.fullName ?? '')
  const [phone, setPhone] = useState(profile.phone ?? '')
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<DetailsError>({})
  const [saved, setSaved] = useState(false)
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setSaved(false)
    const name = fullName.trim()
    // A name is required text: blank is refused, except on an account that never had one, which simply keeps none.
    if (name === '' && profile.fullName !== null) {
      setErrors({ fullName: t('auth:signup.errors.fullName') })
      nameRef.current?.focus()
      return
    }
    const update: { fullName?: string; phone: string | null } = { phone: phone.trim() === '' ? null : phone.trim() }
    if (name !== '') update.fullName = name

    setErrors({})
    setBusy(true)
    try {
      const next = await updateAccountProfile(update)
      setFullName(next.fullName ?? '')
      setPhone(next.phone ?? '')
      onSaved(next)
      setSaved(true)
      // The header's name and the booking form's prefill follow.
      refreshAccountMe()
    } catch (error) {
      if (isUnauthenticated(error)) return
      if (error instanceof ApiError && error.status === 422 && error.fields.length > 0) {
        const next: DetailsError = {}
        if (error.fields.includes('fullName')) next.fullName = t('auth:signup.errors.fullName')
        if (error.fields.includes('phone')) next.phone = t('account:details.errors.phone')
        if (next.fullName === undefined && next.phone === undefined) next.form = t('auth:signup.errors.invalid')
        setErrors(next)
        if (next.fullName !== undefined) nameRef.current?.focus()
        else if (next.phone !== undefined) phoneRef.current?.focus()
      } else if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
        setErrors({ form: t('auth:signup.errors.invalid') })
      } else {
        setErrors({ form: t('account:details.errors.failed') })
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <ClientField label={t('account:details.fullName')} error={errors.fullName ?? null}>
          {(props) => (
            <Input
              {...props}
              ref={nameRef}
              name="fullName"
              autoComplete="name"
              maxLength={200}
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
            />
          )}
        </ClientField>
        <ClientField label={t('account:details.phone')} hint={t('account:details.phoneHint')} error={errors.phone ?? null}>
          {(props) => (
            <Input
              {...props}
              ref={phoneRef}
              name="phone"
              type="tel"
              autoComplete="tel"
              maxLength={40}
              className="font-mono"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
            />
          )}
        </ClientField>
      </div>
      {errors.form !== undefined && <FormAlert>{errors.form}</FormAlert>}
      {saved && <Saved>{t('account:details.saved')}</Saved>}
      <Submit busy={busy}>{busy ? t('account:details.saving') : t('account:details.save')}</Submit>
    </form>
  )
}

// --- Password -------------------------------------------------------------------------------

function newPasswordError(value: string): boolean {
  return value.length < MIN_PASSWORD_LENGTH || value.length > MAX_PASSWORD_LENGTH
}

/**
 * Change the password, or add a first one to a Google-only account. The
 * outcome message lives here, above both forms, so "Password added" stays on
 * screen as the section turns into the change form.
 */
function PasswordSection({ user }: { user: AccountUser }) {
  const { t } = useTranslation()
  const [done, setDone] = useState<'changed' | 'added' | null>(null)
  return (
    <Section title={t('account:password.title')} intro={user.hasPassword ? t('account:password.changeIntro') : t('account:password.addIntro')}>
      {done !== null && <Saved>{t(done === 'changed' ? 'account:password.changed' : 'account:password.added')}</Saved>}
      {user.hasPassword ? (
        <ChangePasswordForm key="change" onDone={() => setDone('changed')} onCleared={() => setDone(null)} />
      ) : (
        <AddPasswordForm key="add" onDone={() => setDone('added')} onCleared={() => setDone(null)} />
      )}
    </Section>
  )
}

type PasswordErrors = { current?: string; next?: string; form?: string }

function ChangePasswordForm({ onDone, onCleared }: { onDone: () => void; onCleared: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<PasswordErrors>({})
  const currentRef = useRef<HTMLInputElement>(null)
  const nextRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    onCleared()
    const form = event.currentTarget
    const current = String(new FormData(form).get('currentPassword') ?? '')
    const next = String(new FormData(form).get('newPassword') ?? '')
    const local: PasswordErrors = {}
    if (current === '') local.current = t('account:password.errors.required')
    if (newPasswordError(next)) local.next = t('auth:signup.errors.password')
    if (local.current !== undefined || local.next !== undefined) {
      setErrors(local)
      ;(local.current !== undefined ? currentRef : nextRef).current?.focus()
      return
    }

    setErrors({})
    setBusy(true)
    try {
      await changeAccountPassword(current, next)
      form.reset()
      onDone()
    } catch (error) {
      if (isUnauthenticated(error)) return
      const code = error instanceof ApiError ? error.message : null
      const status = error instanceof ApiError ? error.status : 0
      if (code === 'invalid_password') {
        setErrors({ current: t('account:password.errors.current') })
        currentRef.current?.focus()
      } else if (code === 'password_locked') setErrors({ form: t('account:password.errors.locked') })
      else if (code === 'credentials_changed') setErrors({ form: t('account:password.errors.changedElsewhere') })
      else if (code === 'no_password') {
        // The account has no password after all: `/me` says so, and the section becomes "add".
        refreshAccountMe()
        setErrors({ form: t('account:password.errors.noPassword') })
      } else if (status === 422) {
        setErrors({ next: t('auth:signup.errors.password') })
        nextRef.current?.focus()
      } else if (status === 429) setErrors({ form: t('auth:rateLimited') })
      else setErrors({ form: t('account:password.errors.failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <div className="grid gap-4 md:grid-cols-2">
        <ClientField label={t('account:password.current')} error={errors.current ?? null}>
          {(props) => <Input {...props} ref={currentRef} name="currentPassword" type="password" autoComplete="current-password" required />}
        </ClientField>
        <ClientField label={t('account:password.new')} hint={t('auth:signup.passwordHint')} error={errors.next ?? null}>
          {(props) => (
            <Input {...props} ref={nextRef} name="newPassword" type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} required />
          )}
        </ClientField>
      </div>
      {errors.form !== undefined && <FormAlert>{errors.form}</FormAlert>}
      <Submit busy={busy}>{busy ? t('account:password.changing') : t('account:password.change')}</Submit>
    </form>
  )
}

function AddPasswordForm({ onDone, onCleared }: { onDone: () => void; onCleared: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<PasswordErrors>({})
  const nextRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    onCleared()
    const form = event.currentTarget
    const next = String(new FormData(form).get('newPassword') ?? '')
    if (newPasswordError(next)) {
      setErrors({ next: t('auth:signup.errors.password') })
      nextRef.current?.focus()
      return
    }

    setErrors({})
    setBusy(true)
    try {
      await setAccountPassword(next)
      onDone()
    } catch (error) {
      if (isUnauthenticated(error)) return
      const code = error instanceof ApiError ? error.message : null
      const status = error instanceof ApiError ? error.status : 0
      if (code === 'password_exists') {
        refreshAccountMe()
        setErrors({ form: t('account:password.errors.exists') })
      } else if (status === 422) {
        setErrors({ next: t('auth:signup.errors.password') })
        nextRef.current?.focus()
      } else if (status === 429) setErrors({ form: t('auth:rateLimited') })
      else setErrors({ form: t('account:password.errors.failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      <ClientField label={t('account:password.new')} hint={t('auth:signup.passwordHint')} error={errors.next ?? null} className="md:max-w-[calc(50%-0.5rem)]">
        {(props) => (
          <Input {...props} ref={nextRef} name="newPassword" type="password" autoComplete="new-password" maxLength={MAX_PASSWORD_LENGTH} required />
        )}
      </ClientField>
      {errors.form !== undefined && <FormAlert>{errors.form}</FormAlert>}
      <Submit busy={busy}>{busy ? t('account:password.adding') : t('account:password.add')}</Submit>
    </form>
  )
}

// --- Email ------------------------------------------------------------------------------------

type EmailErrors = { email?: string; password?: string; form?: string }

/**
 * The address the client signs in with, and changing it (decisions 2 and 3):
 * only with a password, which confirms it; the link goes to the new inbox and
 * the change happens there. The answer is the same whether or not the address
 * can be used (no enumeration), so the page says "if".
 */
function EmailSection({ user }: { user: AccountUser }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<EmailErrors>({})
  const [sentTo, setSentTo] = useState<string | null>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const form = event.currentTarget
    const field = emailRef.current
    const email = String(new FormData(form).get('newEmail') ?? '').trim()
    const password = String(new FormData(form).get('password') ?? '')
    const local: EmailErrors = {}
    if (email === '' || field?.validity.typeMismatch === true) local.email = t('auth:signup.errors.email')
    else if (email.toLowerCase() === user.email.toLowerCase()) local.email = t('account:email.errors.same')
    if (password === '') local.password = t('account:email.errors.enterPassword')
    if (local.email !== undefined || local.password !== undefined) {
      setErrors(local)
      ;(local.email !== undefined ? emailRef : passwordRef).current?.focus()
      return
    }

    setErrors({})
    setSentTo(null)
    setBusy(true)
    try {
      await requestAccountEmailChange(email, password)
      form.reset()
      // The address just typed is the client's own, so it may be shown back.
      setSentTo(email)
      refreshAccountMe()
    } catch (error) {
      if (isUnauthenticated(error)) return
      const code = error instanceof ApiError ? error.message : null
      const status = error instanceof ApiError ? error.status : 0
      if (code === 'invalid_password') {
        setErrors({ password: t('account:email.errors.password') })
        passwordRef.current?.focus()
      } else if (code === 'password_locked') setErrors({ form: t('account:password.errors.locked') })
      else if (code === 'password_required') {
        refreshAccountMe()
        setErrors({ form: t('account:email.errors.passwordRequired') })
      } else if (status === 422) {
        setErrors({ email: t('account:email.errors.same') })
        emailRef.current?.focus()
      } else if (status === 400) {
        setErrors({ email: t('auth:signup.errors.email') })
        emailRef.current?.focus()
      } else if (status === 429) setErrors({ form: t('auth:rateLimited') })
      else setErrors({ form: t('account:email.errors.failed') })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section
      title={t('account:email.title')}
      intro={<p className="wrap-anywhere">{t('account:email.current', { email: user.email })}</p>}
    >
      {sentTo !== null ? (
        <Callout variant="console" tone="info" icon={MailCheck} role="status">
          <p className="wrap-anywhere">{t('account:email.sent', { email: sentTo })}</p>
        </Callout>
      ) : (
        user.pendingEmail !== null && (
          <Callout variant="console" tone="info" icon={MailCheck}>
            <p className="wrap-anywhere">{t('account:email.pending', { email: user.pendingEmail, current: user.email })}</p>
          </Callout>
        )
      )}

      {user.hasPassword ? (
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
          <p className="text-subtle-foreground text-sm">{t('account:email.intro')}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <ClientField label={t('account:email.newEmail')} error={errors.email ?? null}>
              {(props) => (
                <Input {...props} ref={emailRef} name="newEmail" type="email" inputMode="email" autoComplete="email" maxLength={320} required />
              )}
            </ClientField>
            <ClientField label={t('account:email.password')} error={errors.password ?? null}>
              {(props) => <Input {...props} ref={passwordRef} name="password" type="password" autoComplete="current-password" required />}
            </ClientField>
          </div>
          {errors.form !== undefined && <FormAlert>{errors.form}</FormAlert>}
          <Submit busy={busy}>{busy ? t('account:email.submitting') : t('account:email.submit')}</Submit>
        </form>
      ) : (
        <p className="text-sm">{t('account:email.googleOnly')}</p>
      )}
    </Section>
  )
}

// --- Export -------------------------------------------------------------------------------------

function ExportSection() {
  const { t } = useTranslation()
  const [status, setStatus] = useState<'idle' | 'busy' | 'done' | 'failed' | 'rateLimited'>('idle')

  async function download() {
    if (status === 'busy') return
    setStatus('busy')
    try {
      await downloadAccountExport()
      setStatus('done')
    } catch (error) {
      if (isUnauthenticated(error)) return
      reportError(error, 'account_export_failed')
      setStatus(error instanceof ApiError && error.status === 429 ? 'rateLimited' : 'failed')
    }
  }

  return (
    <Section title={t('account:export.title')} intro={t('account:export.intro')}>
      {status === 'done' && <Saved>{t('account:export.done')}</Saved>}
      {status === 'failed' && <FormAlert>{t('account:export.failed')}</FormAlert>}
      {status === 'rateLimited' && <FormAlert>{t('auth:rateLimited')}</FormAlert>}
      <Button
        variant="outline"
        className="self-start max-sm:w-full"
        onClick={() => void download()}
        aria-disabled={status === 'busy'}
        aria-busy={status === 'busy'}
      >
        <Download aria-hidden="true" />
        {status === 'busy' ? t('account:export.downloading') : t('account:export.download')}
      </Button>
    </Section>
  )
}

// --- Delete ---------------------------------------------------------------------------------------

/**
 * Deleting the account (decision 4): allowed with upcoming bookings, which
 * carry on through the guest links already emailed, and the dialog says so.
 * Confirmed with the password, or, for a Google-only account, by typing the
 * address. On success the session is forgotten and the page says the account
 * is gone (`/account/deleted`).
 */
function DeleteSection({ user }: { user: AccountUser }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <Section title={t('account:delete.title')} intro={t('account:delete.intro')} tone="danger">
      <Button variant="destructive" className="self-start max-sm:w-full" onClick={() => setOpen(true)}>
        {t('account:delete.open')}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        {open && <DeleteDialog user={user} />}
      </Dialog>
    </Section>
  )
}

function DeleteDialog({ user }: { user: AccountUser }) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ field?: string; form?: string }>({})
  const fieldRef = useRef<HTMLInputElement>(null)
  const byPassword = user.hasPassword

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const value = String(new FormData(event.currentTarget).get('confirmation') ?? '')
    if ((byPassword ? value : value.trim()) === '') {
      setError({ field: t('account:delete.errors.required') })
      fieldRef.current?.focus()
      return
    }
    // The API checks the address again; this only saves a request that cannot work.
    if (!byPassword && value.trim().toLowerCase() !== user.email.toLowerCase()) {
      setError({ field: t('account:delete.errors.email') })
      fieldRef.current?.focus()
      return
    }

    setError({})
    setBusy(true)
    try {
      await deleteAccount(byPassword ? { password: value } : { confirmEmail: value.trim() })
      forgetAccountMe()
      // The deleted page forgets the session once it is on screen: forgetting it
      // here would have this page's guard send the visitor to sign in first.
      void navigate('/account/deleted', { replace: true, state: { deleted: true } satisfies DeletedLocationState })
    } catch (failure) {
      setBusy(false)
      if (isUnauthenticated(failure)) return
      const code = failure instanceof ApiError ? failure.message : null
      const status = failure instanceof ApiError ? failure.status : 0
      if (code === 'invalid_password') setError({ field: t('account:delete.errors.password') })
      else if (code === 'invalid_confirmation') setError({ field: t('account:delete.errors.email') })
      else if (code === 'password_locked') setError({ form: t('account:password.errors.locked') })
      else if (status === 422 || status === 400) setError({ field: t('account:delete.errors.required') })
      else if (status === 429) setError({ form: t('auth:rateLimited') })
      else setError({ form: t('account:delete.errors.failed') })
      if (code === 'invalid_password' || code === 'invalid_confirmation' || status === 422 || status === 400) fieldRef.current?.focus()
    }
  }

  return (
    <DialogContent closeLabel={t('account:delete.close')} onOpenAutoFocus={(event) => {
      // The field, not the close button: it is what the dialog asks for.
      event.preventDefault()
      fieldRef.current?.focus()
    }}>
      <DialogHeader>
        <DialogTitle>{t('account:delete.dialogTitle')}</DialogTitle>
        <DialogDescription className="text-subtle-foreground text-[0.9375rem]">{t('account:delete.warning')}</DialogDescription>
      </DialogHeader>
      <DialogBody>
        <form noValidate onSubmit={(event) => void submit(event)} className="flex flex-col gap-5">
          <Callout variant="console" tone="info" icon={Info}>
            <p>{t('account:delete.upcoming')}</p>
            <p className="wrap-anywhere">{t('account:delete.emailNotice', { email: user.email })}</p>
          </Callout>
          {byPassword ? (
            <ClientField label={t('account:delete.passwordLabel')} error={error.field ?? null}>
              {(props) => <Input {...props} ref={fieldRef} name="confirmation" type="password" autoComplete="current-password" required />}
            </ClientField>
          ) : (
            <ClientField label={t('account:delete.emailLabel')} hint={t('account:delete.emailHint', { email: user.email })} error={error.field ?? null}>
              {(props) => (
                <Input {...props} ref={fieldRef} name="confirmation" type="email" inputMode="email" autoComplete="off" spellCheck={false} required />
              )}
            </ClientField>
          )}
          {error.form !== undefined && <FormAlert>{error.form}</FormAlert>}
          {/* Stacked and full width on a phone, like the booking page's cancel: equal targets. */}
          <div className="flex flex-col gap-2 sm:flex-row">
            <Submit busy={busy} variant="destructive-solid">
              {busy ? t('account:delete.deleting') : t('account:delete.confirm')}
            </Submit>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t('account:delete.keep')}
              </Button>
            </DialogClose>
          </div>
        </form>
      </DialogBody>
    </DialogContent>
  )
}
