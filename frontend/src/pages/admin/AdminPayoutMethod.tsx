import { Check, CircleAlert, Wallet } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, UnauthenticatedError } from '@/admin/api'
import { useBreadcrumbTail } from '@/admin/breadcrumb-tail'
import {
  MOMO_NETWORKS,
  PAYOUT_METHOD_KINDS,
  type PayoutMethod,
  type PayoutMethodField,
  type PayoutMethodForm,
  isPayoutMethodField,
  payoutMethodFormValues,
  payoutsApi,
  validatePayoutMethod,
} from '@/admin/payouts'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { CHOICE, EYEBROW, FIELD, META, PAGE, SECTION_TITLE } from './console/classes'
import { FormDialog } from './console/FormDialog'
import { PageHeader } from './console/PageHeader'
import { PayoutDestination } from './console/PayoutDestination'
import { Line, LoadingRegion } from './console/Skeletons'
import { TransferFeeNotice } from './console/TransferFeeNotice'

type Loaded = { attempt: number; method: PayoutMethod | null } | { attempt: number; failed: true }

/**
 * `/studio/payout-method` (marketplace spec R4.1, R4.5): where the platform
 * sends what the photographer earns -- one MoMo number or one bank account.
 *
 * The transfer-fee banner is always on the page. A change needs the current
 * password (the API counts a wrong one toward the sign-in lockout) and sends a
 * security email, which the page says once it is saved. A method is never
 * edited in place: saving retires the old one, so payouts already built keep
 * the destination they were built for.
 *
 * The form opens in a dialog (admin console fixes, item 1), prefilled from the
 * current method so fixing one detail keeps the others; the password never is.
 */
export function AdminPayoutMethod() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [open, setOpen] = useState(false)
  const [saved, setSaved] = useState(false)

  useBreadcrumbTail(false, t('admin:payoutMethod.title'))

  useEffect(() => {
    let cancelled = false
    payoutsApi.payoutMethod().then(
      (method) => !cancelled && setLoaded({ attempt, method }),
      (error: unknown) => {
        if (cancelled || error instanceof UnauthenticatedError) return
        setLoaded({ attempt, failed: true })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const current = loaded !== null && loaded.attempt === attempt ? loaded : null
  const method = current !== null && 'method' in current ? current.method : undefined

  function onSaved(next: PayoutMethod) {
    setLoaded({ attempt, method: next })
    setOpen(false)
    setSaved(true)
  }

  return (
    <main className={cn(PAGE, 'max-w-3xl')}>
      <PageHeader eyebrow={t('admin:nav.earnings')} eyebrowIcon={Wallet} title={t('admin:payoutMethod.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:payoutMethod.intro')}</p>
      </PageHeader>

      {/* Persistent (R4.5): shown before, during and after a load, whatever it answers. */}
      <TransferFeeNotice />

      {saved && (
        <Callout variant="console" tone="success" icon={Check} role="status">
          <p>{t('admin:payoutMethod.saved')}</p>
        </Callout>
      )}

      {current === null && (
        <LoadingRegion label={t('admin:payoutMethod.loading')} className="flex flex-col gap-4 border-t pt-8">
          <Line w="w-48" className="h-6" />
          <Line w="w-32" />
          <Line w="w-40" />
          <Line w="w-56 max-w-full" className="h-3" />
          <Skeleton className="h-11 w-full rounded-xs sm:w-48 lg:h-10" />
        </LoadingRegion>
      )}

      {current !== null && 'failed' in current && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:payoutMethod.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:payoutMethod.retry')}
          </Button>
        </div>
      )}

      {method !== undefined && (
        <section className="flex flex-col gap-4 border-t pt-8">
          <h2 className={SECTION_TITLE}>{t('admin:payoutMethod.current')}</h2>
          {method === null ? (
            <Callout variant="console" tone="warning" icon={Wallet} data-notice="no-payout-method">
              <p>{t('admin:payoutMethod.none')}</p>
            </Callout>
          ) : (
            <div className="flex flex-col gap-2">
              <PayoutDestination method={method} />
              <p className={META}>{t('admin:payoutMethod.savedOn', { date: formatDateTime(method.createdAt) })}</p>
            </div>
          )}
          <Button
            size="console"
            variant={method === null ? 'default' : 'console-outline'}
            className="sm:self-start"
            onClick={() => {
              setSaved(false)
              setOpen(true)
            }}
          >
            {method === null ? t('admin:payoutMethod.add') : t('admin:payoutMethod.change')}
          </Button>
          <FormDialog
            open={open}
            onClose={() => setOpen(false)}
            title={method === null ? t('admin:payoutMethod.add') : t('admin:payoutMethod.change')}
          >
            {/* Keyed on the method, so each opening starts from what is saved now. */}
            <MethodForm key={method?.id ?? 'none'} current={method} onSaved={onSaved} onCancel={() => setOpen(false)} />
          </FormDialog>
        </section>
      )}
    </main>
  )
}

/** A refusal the form shows above its buttons, by the API's code. */
const FORM_ERRORS = new Set(['password_locked', 'rate_limited', 'invalid_request'])

function MethodForm({
  current,
  onSaved,
  onCancel,
}: {
  current: PayoutMethod | null
  onSaved: (method: PayoutMethod) => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [form, setForm] = useState<PayoutMethodForm>(() => payoutMethodFormValues(current))
  const [invalid, setInvalid] = useState<ReadonlySet<PayoutMethodField>>(new Set())
  const [wrongPassword, setWrongPassword] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  function set<K extends keyof PayoutMethodForm>(field: K, value: PayoutMethodForm[K]) {
    setForm((now) => ({ ...now, [field]: value }))
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    setFormError(null)
    setWrongPassword(false)
    const checked = validatePayoutMethod(form)
    if ('invalid' in checked) {
      setInvalid(new Set(checked.invalid))
      return
    }
    setInvalid(new Set())

    setSaving(true)
    try {
      onSaved(await payoutsApi.savePayoutMethod(checked.body))
    } catch (error) {
      setSaving(false)
      // A 401 has dropped the studio session; the layout's guard takes him to sign in.
      if (error instanceof UnauthenticatedError) return
      if (!(error instanceof ApiError)) {
        setFormError(t('admin:payoutMethod.errors.failed'))
        return
      }
      if (error.message === 'invalid_password') {
        // Typed again from nothing: the one that was refused is not kept.
        setWrongPassword(true)
        set('currentPassword', '')
        return
      }
      if (error.status === 422) {
        const named = error.fields.filter(isPayoutMethodField)
        if (named.length > 0) {
          setInvalid(new Set(named))
          return
        }
      }
      if (FORM_ERRORS.has(error.message)) {
        setFormError(t(`admin:payoutMethod.errors.${error.message}`))
        return
      }
      setFormError(error.status === 422 || error.status === 400 ? t('admin:payoutMethod.errors.invalid_request') : t('admin:payoutMethod.errors.failed'))
    }
  }

  const errorFor = (field: Exclude<PayoutMethodField, 'momoNumber' | 'currentPassword'>) =>
    invalid.has(field) ? t(`admin:payoutMethod.invalid.${field}`) : null

  return (
    <form className="flex flex-col gap-5" aria-label={t('admin:payoutMethod.title')} noValidate onSubmit={(event) => void onSubmit(event)}>
      <fieldset className="flex flex-col gap-2">
        <legend className={cn(EYEBROW, 'mb-1')}>{t('admin:payoutMethod.fields.kind')}</legend>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          {PAYOUT_METHOD_KINDS.map((kind) => (
            <Label key={kind} className="min-h-11 items-center gap-2.5 text-base font-normal lg:min-h-8 pointer-coarse:min-h-11">
              <input
                type="radio"
                name="kind"
                value={kind}
                checked={form.kind === kind}
                onChange={() => set('kind', kind)}
                className={CHOICE}
              />
              {t(`admin:payoutMethod.kinds.${kind}`)}
            </Label>
          ))}
        </div>
      </fieldset>

      {form.kind === 'momo' ? (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className={cn(EYEBROW, 'mb-1')}>{t('admin:payoutMethod.fields.momoNetwork')}</legend>
            <div className="flex flex-wrap gap-x-6 gap-y-1">
              {MOMO_NETWORKS.map((network) => (
                <Label key={network} className="min-h-11 items-center gap-2.5 text-base font-normal lg:min-h-8 pointer-coarse:min-h-11">
                  <input
                    type="radio"
                    name="momoNetwork"
                    value={network}
                    checked={form.momoNetwork === network}
                    onChange={() => set('momoNetwork', network)}
                    className={CHOICE}
                  />
                  {t(`admin:payoutMethod.networks.${network}`)}
                </Label>
              ))}
            </div>
          </fieldset>
          <AdminField
            label={t('admin:payoutMethod.fields.momoNumber')}
            // The hint follows the network: its own prefixes, never the other's.
            hint={t(`admin:payoutMethod.hints.momoNumber.${form.momoNetwork}`)}
            error={invalid.has('momoNumber') ? t(`admin:payoutMethod.invalid.momoNumber.${form.momoNetwork}`) : null}
          >
            {(props) => (
              <Input
                {...props}
                name="momoNumber"
                type="tel"
                inputMode="tel"
                autoComplete="off"
                value={form.momoNumber}
                onChange={(event) => set('momoNumber', event.target.value)}
                className={cn(FIELD, 'font-mono tabular-nums sm:w-64')}
              />
            )}
          </AdminField>
        </>
      ) : (
        <>
          <AdminField label={t('admin:payoutMethod.fields.bankName')} error={errorFor('bankName')}>
            {(props) => (
              <Input
                {...props}
                name="bankName"
                maxLength={100}
                value={form.bankName}
                onChange={(event) => set('bankName', event.target.value)}
                className={FIELD}
              />
            )}
          </AdminField>
          <AdminField
            label={t('admin:payoutMethod.fields.bankAccountNumber')}
            hint={t('admin:payoutMethod.hints.bankAccountNumber')}
            error={errorFor('bankAccountNumber')}
          >
            {(props) => (
              <Input
                {...props}
                name="bankAccountNumber"
                autoComplete="off"
                maxLength={40}
                value={form.bankAccountNumber}
                onChange={(event) => set('bankAccountNumber', event.target.value)}
                className={cn(FIELD, 'font-mono tabular-nums')}
              />
            )}
          </AdminField>
        </>
      )}

      <AdminField label={t('admin:payoutMethod.fields.accountName')} hint={t('admin:payoutMethod.hints.accountName')} error={errorFor('accountName')}>
        {(props) => (
          <Input
            {...props}
            name="accountName"
            maxLength={120}
            value={form.accountName}
            onChange={(event) => set('accountName', event.target.value)}
            className={FIELD}
          />
        )}
      </AdminField>

      <div className="flex flex-col gap-5 border-t pt-5">
        <AdminField
          label={t('admin:payoutMethod.fields.currentPassword')}
          hint={t('admin:payoutMethod.hints.currentPassword')}
          error={
            wrongPassword
              ? t('admin:payoutMethod.invalid.wrongPassword')
              : invalid.has('currentPassword')
                ? t('admin:payoutMethod.invalid.currentPassword')
                : null
          }
        >
          {(props) => (
            <Input
              {...props}
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              value={form.currentPassword}
              onChange={(event) => set('currentPassword', event.target.value)}
              className={cn(FIELD, 'sm:w-80')}
            />
          )}
        </AdminField>

        {formError !== null && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {formError}
          </p>
        )}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
            {t('admin:payoutMethod.cancel')}
          </Button>
          <Button type="submit" size="console" disabled={saving}>
            {saving ? t('admin:payoutMethod.saving') : t('admin:payoutMethod.save')}
          </Button>
        </div>
      </div>
    </form>
  )
}
