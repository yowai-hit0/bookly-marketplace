import { CircleAlert, CircleCheck, Undo2 } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type RefundDue, type RefundKind, kigaliInstant, pendingFromRefusal, platformRefundsApi } from '@/platform/refunds'
import { AdminField } from '@/pages/admin/AdminField'
import { DATA, FIELD, META, PAGE, TD, TH, TR } from '@/pages/admin/console/classes'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'

/** The API's cap on a refund reference, trimmed. */
const MAX_REFERENCE = 100

type Notice = { tone: 'success' | 'warning'; text: string }

const COLUMNS = ['booking', 'client', 'photographer', 'kind', 'toSend', 'payment', 'actions'] as const

/**
 * `/platform/refunds` (marketplace spec R4.6, Phase 4 refund decision): every
 * payment made online that is owed back, oldest first. The money is in the
 * platform's account, so an admin refunds it from there, by hand, and records
 * it here with the reference it went out with. Cash is the photographer's to
 * refund and is never listed.
 *
 * Each row is a full refund or the return of an overpayment (Phase 4
 * overpayment decision): the amount to send is the one shown large, the
 * payment's own amount beside it for context, and the kind is recorded with
 * the refund so a row that changed meanwhile is refused, not misrecorded.
 *
 * A recorded refund leaves the list. One someone else recorded first (or that
 * no longer exists) also leaves it, and the page says why; one whose kind
 * changed is read again.
 */
export function PlatformRefunds() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [rows, setRows] = useState<{ attempt: number; list: RefundDue[] | null } | null>(null)
  const [pending, setPending] = useState<RefundDue | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)

  useEffect(() => {
    let cancelled = false
    platformRefundsApi.list().then(
      (list) => !cancelled && setRows({ attempt, list }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        setRows({ attempt, list: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const current = rows !== null && rows.attempt === attempt ? rows : null

  function drop(paymentId: string) {
    setRows((now) => (now === null || now.list === null ? now : { ...now, list: now.list.filter((row) => row.paymentId !== paymentId) }))
  }

  function onRecorded(refund: RefundDue) {
    setPending(null)
    drop(refund.paymentId)
    setNotice({ tone: 'success', text: t('platform:refunds.done', { amount: formatMoney(refund.refundAmountRwf), reference: refund.booking.reference }) })
  }

  /**
   * What is owed back changed since the list was read (a booking cancelled, so
   * the whole payment is now due): read the list again, keeping the rows on
   * screen until it answers, and say what is pending now.
   */
  function onKindChanged(now: RefundKind | null) {
    setPending(null)
    setNotice({
      tone: 'warning',
      text: now === null ? t('platform:refunds.errors.refund_kind_changed') : t(`platform:refunds.errors.refund_kind_mismatch.${now}`),
    })
    platformRefundsApi.list().then(
      (list) => setRows({ attempt, list }),
      () => {},
    )
  }

  /** Not owed back any more, or gone: the row is stale, so it leaves, and the page says why. */
  function onStale(refund: RefundDue, code: 'not_refundable' | 'not_found') {
    setPending(null)
    drop(refund.paymentId)
    setNotice({ tone: 'warning', text: t(`platform:refunds.errors.${code}`) })
  }

  return (
    <main className={cn(PAGE, 'max-w-6xl')}>
      <PageHeader eyebrow={t('platform:nav.label')} eyebrowIcon={Undo2} title={t('platform:refunds.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:refunds.intro')}</p>
      </PageHeader>

      {notice !== null && (
        <Callout
          variant="console"
          tone={notice.tone}
          icon={notice.tone === 'success' ? CircleCheck : CircleAlert}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          <p>{notice.text}</p>
        </Callout>
      )}

      {current === null && (
        <LoadingRegion label={t('platform:refunds.loading')} className="flex flex-col">
          {Array.from({ length: 4 }, (_, row) => (
            <div key={row} className="flex items-center gap-6 border-b py-4 last:border-b-0">
              <div className="flex flex-1 flex-col gap-2">
                <Line w="w-36 max-w-full" />
                <Line w="w-28" className="h-3" />
              </div>
              <Line w="w-40 max-sm:hidden" />
              <Line w="w-32 max-sm:hidden" />
              <Line w="w-24" />
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && current.list === null && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:refunds.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:refunds.retry')}
          </Button>
        </div>
      )}

      {current?.list?.length === 0 && <p className={META}>{t('platform:refunds.empty')}</p>}

      {current !== null && current.list !== null && current.list.length > 0 && (
        <div className="@container">
          <table role="table" className="w-full border-collapse text-[0.9375rem]">
            <caption className="sr-only">{t('platform:refunds.title')}</caption>
            <thead role="rowgroup" className="@max-[60rem]:sr-only">
              <tr role="row" className="border-b">
                {COLUMNS.map((column) => (
                  <th key={column} role="columnheader" scope="col" className={cn(TH, (column === 'toSend' || column === 'actions') && 'text-right')}>
                    {t(`platform:refunds.columns.${column}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody role="rowgroup" className="@max-[60rem]:block">
              {current.list.map((refund) => (
                <tr
                  key={refund.paymentId}
                  role="row"
                  data-payment={refund.paymentId}
                  className={cn(TR, '@max-[60rem]:flex @max-[60rem]:flex-col @max-[60rem]:gap-2 @max-[60rem]:py-4')}
                >
                  <td role="cell" className={cn(TD, '@max-[60rem]:p-0')}>
                    <div className="flex flex-col gap-1">
                      <span className={DATA}>{refund.booking.reference}</span>
                      <span className={META}>{t('platform:refunds.shoot', { date: formatDateTime(refund.booking.startsAt) })}</span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, '@max-[60rem]:p-0')}>
                    <div className="flex flex-col gap-1">
                      <span className="wrap-anywhere">{refund.booking.contactName}</span>
                      <span className={cn(META, 'wrap-anywhere')}>{refund.booking.contactEmail}</span>
                      <span className={cn(META, 'font-mono tabular-nums')}>{refund.booking.contactPhone}</span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, '@max-[60rem]:p-0')}>
                    <div className="flex flex-col gap-1">
                      <span className="wrap-anywhere">{refund.photographer.displayName}</span>
                      <span className={cn(META, 'font-mono')}>/p/{refund.photographer.handle}</span>
                    </div>
                  </td>
                  <td role="cell" data-cell="kind" className={cn(TD, 'max-w-xs @max-[60rem]:p-0')}>
                    <RefundKindCell refund={refund} />
                  </td>
                  <td role="cell" data-cell="to-send" className={cn(TD, 'text-right @max-[60rem]:p-0 @max-[60rem]:text-left')}>
                    <div className="flex flex-col gap-1 @min-[60rem]:items-end">
                      {/* What to send is the figure that matters; the payment is context. */}
                      <span className={cn(DATA, 'text-base font-medium whitespace-nowrap')}>{formatMoney(refund.refundAmountRwf)}</span>
                      <span className={cn(META, 'whitespace-nowrap')}>{t('platform:refunds.paidOf', { amount: formatMoney(refund.amountRwf) })}</span>
                      <span className={META}>{t(`admin:booking.paymentKinds.${refund.kind}`, { defaultValue: refund.kind })}</span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, '@max-[60rem]:p-0')}>
                    <div className="flex flex-col gap-1">
                      <span>{t(`platform:refunds.providers.${refund.provider}`, { defaultValue: refund.provider })}</span>
                      <span className={cn(META, 'font-mono wrap-anywhere')}>
                        {t('platform:refunds.refs', { providerRef: refund.providerRef ?? '—', ourRef: refund.ourRef })}
                      </span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, '@max-[60rem]:p-0')}>
                    <div className="flex flex-wrap gap-2 @min-[60rem]:justify-end">
                      <Button
                        variant="console-outline"
                        size="console-sm"
                        aria-label={t('platform:refunds.recordNamed', { reference: refund.booking.reference })}
                        onClick={() => {
                          setNotice(null)
                          setPending(refund)
                        }}
                      >
                        {t('platform:refunds.record')}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending !== null && (
        <RecordDialog
          key={pending.paymentId}
          refund={pending}
          onClose={() => setPending(null)}
          onRecorded={onRecorded}
          onStale={onStale}
          onKindChanged={onKindChanged}
        />
      )}
    </main>
  )
}

/**
 * The kind of refund in words, and why: an overpayment returns only the
 * extra; a full refund after an overpayment was already returned sends less
 * than was paid. An overpaid payment owed back whole before its extra went
 * back sends the whole amount, so it carries no such note.
 */
function RefundKindCell({ refund }: { refund: RefundDue }) {
  const { t } = useTranslation()
  const note =
    refund.refundKind === 'overpayment'
      ? t('platform:refunds.overpaymentNote', { overpaid: formatMoney(refund.overpaidRwf) })
      : // `overpaidRwf` counts the extra returned or not; only one already returned makes the amount less than was paid.
        refund.overpaidRwf > 0 && refund.refundAmountRwf < refund.amountRwf
        ? t('platform:refunds.reducedNote', { overpaid: formatMoney(refund.overpaidRwf) })
        : null
  return (
    <div className="flex flex-col gap-1" data-refund-kind={refund.refundKind}>
      <span>{t(`platform:refunds.kinds.${refund.refundKind}`)}</span>
      {note !== null && <span className={cn(META, 'text-pretty')}>{note}</span>}
    </div>
  )
}

/**
 * Record a refund already sent: the reference it went out with (required),
 * and when, in Kigali time, if not just now. A refusal it can fix stays in
 * it, beside the field.
 */
function RecordDialog({
  refund,
  onClose,
  onRecorded,
  onStale,
  onKindChanged,
}: {
  refund: RefundDue
  onClose: () => void
  onRecorded: (refund: RefundDue) => void
  onStale: (refund: RefundDue, code: 'not_refundable' | 'not_found') => void
  onKindChanged: (pending: RefundKind | null) => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [invalid, setInvalid] = useState<ReadonlySet<'reference' | 'refundedAt'>>(new Set())
  const [duplicate, setDuplicate] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const reference = String(data.get('reference') ?? '').trim()
    const typedAt = String(data.get('refundedAt') ?? '').trim()
    setFormError(null)
    setDuplicate(false)

    const bad = new Set<'reference' | 'refundedAt'>()
    if (reference === '' || reference.length > MAX_REFERENCE) bad.add('reference')
    const refundedAt = typedAt === '' ? null : kigaliInstant(typedAt)
    // A refund is recorded after it was sent, so a time to come is a typo.
    if (typedAt !== '' && (refundedAt === null || new Date(refundedAt).getTime() > Date.now())) bad.add('refundedAt')
    setInvalid(bad)
    if (bad.size > 0) return

    setBusy(true)
    try {
      // Always the row's kind: a row that changed meanwhile is refused, not recorded as the other kind.
      await platformRefundsApi.record(refund.paymentId, refund.refundKind, reference, refundedAt)
      onRecorded(refund)
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      if (!(error instanceof ApiError)) {
        setFormError(t('platform:refunds.errors.failed'))
        return
      }
      if (error.status === 409 && error.message === 'not_refundable') {
        onStale(refund, 'not_refundable')
        return
      }
      if (error.status === 404) {
        onStale(refund, 'not_found')
        return
      }
      if (error.status === 409 && error.message === 'duplicate_refund_reference') {
        setDuplicate(true)
        return
      }
      if (error.status === 409 && error.message === 'refund_kind_mismatch') {
        onKindChanged(pendingFromRefusal(error))
        return
      }
      if (error.status === 409 && error.message === 'cash_payment') {
        setFormError(t('platform:refunds.errors.cash_payment'))
        return
      }
      if (error.status === 422) {
        const named = error.fields.filter((field): field is 'reference' | 'refundedAt' => field === 'reference' || field === 'refundedAt')
        if (named.length > 0) {
          setInvalid(new Set(named))
          return
        }
      }
      setFormError(error.status === 400 || error.status === 422 ? t('platform:refunds.errors.invalid_request') : t('platform:refunds.errors.failed'))
    }
  }

  const provider = t(`platform:refunds.providers.${refund.provider}`, { defaultValue: refund.provider })

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform:refunds.dialog.title', { reference: refund.booking.reference })}
      description={t(refund.refundKind === 'overpayment' ? 'platform:refunds.dialog.bodyOverpayment' : 'platform:refunds.dialog.body', {
        amount: formatMoney(refund.refundAmountRwf),
        name: refund.booking.contactName,
        provider,
      })}
    >
      <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
        <AdminField
          label={t('platform:refunds.dialog.reference')}
          hint={t('platform:refunds.dialog.referenceHint')}
          error={
            duplicate ? t('platform:refunds.invalid.duplicateReference') : invalid.has('reference') ? t('platform:refunds.invalid.reference') : null
          }
        >
          {(props) => <Input {...props} name="reference" required maxLength={MAX_REFERENCE} autoComplete="off" className={cn(FIELD, 'font-mono')} />}
        </AdminField>
        <AdminField
          label={t('platform:refunds.dialog.refundedAt')}
          hint={t('platform:refunds.dialog.refundedAtHint')}
          error={invalid.has('refundedAt') ? t('platform:refunds.invalid.refundedAt') : null}
        >
          {(props) => <Input {...props} name="refundedAt" type="datetime-local" className={cn(FIELD, 'sm:w-64')} />}
        </AdminField>
        {formError !== null && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {formError}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:refunds.dialog.cancel')}
          </Button>
          <Button type="submit" size="console" disabled={busy}>
            {busy ? t('platform:refunds.dialog.working') : t('platform:refunds.dialog.submit')}
          </Button>
        </div>
      </form>
    </FormDialog>
  )
}
