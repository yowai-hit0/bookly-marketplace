import { Ban, Banknote, CalendarDays, CircleAlert, CircleCheck, CircleX, TriangleAlert } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { BackLink } from '@/components/ui/back-link'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type PlatformPayoutDetail as Payout, payoutFromRefusal, platformPayoutsApi, userName } from '@/platform/payouts'
import { AdminField } from '@/pages/admin/AdminField'
import { DATA, FIELD, META, PAGE, SECTION_TITLE, TEXTAREA } from '@/pages/admin/console/classes'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { MetaItem, PageHeader } from '@/pages/admin/console/PageHeader'
import { PayoutStatusBadge } from '@/pages/admin/console/PayoutBadges'
import { PayoutDestination } from '@/pages/admin/console/PayoutDestination'
import { PayoutItems } from '@/pages/admin/console/PayoutItems'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'

/** The API's caps, trimmed (CHECKs payout_transfer_reference_length, payout_note_length). */
const MAX_REFERENCE = 100
const MAX_NOTE = 500

type State = { id: string; attempt: number } & ({ kind: 'ready'; payout: Payout } | { kind: 'missing' } | { kind: 'failed' })
type Notice = { tone: 'success' | 'warning'; text: string }
type OpenDialog = 'paid' | 'cancel' | null

/**
 * `/platform/payouts/:id` (marketplace spec R4.1, R4.4, T4.3): one payout --
 * its lines, the destination it was built for, and, while it is a draft, the
 * two ways it ends: marked paid with the transfer's reference (required, and
 * used once across every payout; the photographer is emailed), or cancelled,
 * which gives its lines back to the balance.
 *
 * Before money moves the page says what could make it go astray: a draft whose
 * destination the photographer has since replaced, and a destination saved
 * within the last 72 hours. A change another admin made first comes back as a
 * 409 `not_draft` carrying the payout as it stands; the page shows that and
 * says why.
 */
export function PlatformPayoutDetail() {
  const { t } = useTranslation()
  const { id = '' } = useParams()
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<State | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<OpenDialog>(null)

  useEffect(() => {
    let cancelled = false
    platformPayoutsApi.get(id).then(
      (payout) => !cancelled && setState({ id, attempt, kind: 'ready', payout }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (cancelled || error instanceof UnauthenticatedError) return
        const missing = error instanceof ApiError && (error.status === 404 || error.status === 400)
        setState({ id, attempt, kind: missing ? 'missing' : 'failed' })
      },
    )
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  const current = state !== null && state.id === id && state.attempt === attempt ? state : null
  const payout = current?.kind === 'ready' ? current.payout : null

  function show(next: Payout) {
    setState({ id, attempt, kind: 'ready', payout: next })
  }

  function onDone(next: Payout, done: 'paid' | 'cancelled') {
    setDialog(null)
    show(next)
    setNotice({ tone: 'success', text: t(`platform:payout.done.${done}`) })
  }

  /** Not a draft any more: show it as it stands (from the refusal, or read again), and say so. */
  async function onStale(carried: Payout | null) {
    setDialog(null)
    const now = carried ?? (await platformPayoutsApi.get(id).catch(() => null))
    if (now !== null) show(now)
    const status = now === null ? null : t(`platform:payouts.status.${now.status}`).toLowerCase()
    // The API always carries it; read again only as a fallback, and say so if that fails too.
    setNotice({ tone: 'warning', text: status === null ? t('platform:payout.loadFailed') : t('platform:payout.stale', { status }) })
  }

  function onGone() {
    setDialog(null)
    setNotice({ tone: 'warning', text: t('platform:payout.gone') })
    setState({ id, attempt, kind: 'missing' })
  }

  const back = <BackLink to="/platform/payouts">{t('platform:payout.back')}</BackLink>

  if (current === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <LoadingRegion label={t('platform:payout.loading')} className="flex flex-col gap-8 lg:gap-12">
          <div className="flex flex-col gap-3.5">
            <Line w="w-24" className="h-3" />
            <div className="flex flex-wrap items-center gap-3.5">
              <Skeleton className="h-9 w-72 max-w-full rounded-xs" />
              <Skeleton className="h-6 w-20 rounded-xs" />
            </div>
            <Line w="w-80 max-w-full" />
          </div>
          {[0, 1].map((section) => (
            <div key={section} className="flex flex-col gap-4 border-t pt-8">
              <Line w="w-28" className="h-6" />
              {[0, 1].map((row) => (
                <div key={row} className="flex justify-between gap-6">
                  <Line w="w-40" />
                  <Line w="w-24" />
                </div>
              ))}
            </div>
          ))}
        </LoadingRegion>
      </main>
    )
  }

  if (current.kind === 'failed') {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:payout.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('platform:payout.retry')}
          </Button>
        </div>
      </main>
    )
  }

  if (current.kind === 'missing' || payout === null) {
    return (
      <main className={cn(PAGE, 'max-w-5xl')}>
        {back}
        <PageHeader eyebrow={t('platform:nav.payouts')} eyebrowIcon={Banknote} title={t('platform:payout.missing')} />
        {notice !== null && (
          <Callout variant="console" tone={notice.tone} icon={CircleAlert} role="alert">
            <p>{notice.text}</p>
          </Callout>
        )}
      </main>
    )
  }

  const someone = t('platform:payouts.someone')
  const draft = payout.status === 'draft'

  return (
    <main className={cn(PAGE, 'max-w-5xl')}>
      {back}
      <PageHeader
        eyebrow={t('platform:nav.payouts')}
        eyebrowIcon={Banknote}
        title={t('platform:payout.title', { name: payout.photographer.displayName })}
        badges={
          <PayoutStatusBadge status={payout.status} size="md">
            {t(`platform:payouts.status.${payout.status}`)}
          </PayoutStatusBadge>
        }
        meta={
          <>
            <span className={cn(DATA, 'text-foreground')}>{formatMoney(payout.amountRwf)}</span>
            <span>{t('platform:payouts.lines', { count: payout.itemCount })}</span>
            <MetaItem icon={CalendarDays}>
              {t('platform:payout.created', { date: formatDateTime(payout.createdAt), name: userName(payout.createdBy) ?? someone })}
            </MetaItem>
            {payout.paidAt !== null && (
              <MetaItem icon={CircleCheck}>
                {t('platform:payout.paid', { date: formatDateTime(payout.paidAt), name: userName(payout.paidBy) ?? someone })}
              </MetaItem>
            )}
            {payout.cancelledAt !== null && (
              <MetaItem icon={Ban}>
                {t('platform:payout.cancelled', { date: formatDateTime(payout.cancelledAt), name: userName(payout.cancelledBy) ?? someone })}
              </MetaItem>
            )}
          </>
        }
        actions={
          draft ? (
            <>
              <Button
                size="console"
                onClick={() => {
                  setNotice(null)
                  setDialog('paid')
                }}
              >
                {t('platform:payout.markPaid')}
              </Button>
              <Button
                variant="destructive"
                size="console"
                onClick={() => {
                  setNotice(null)
                  setDialog('cancel')
                }}
              >
                {t('platform:payout.cancelDraft')}
              </Button>
            </>
          ) : undefined
        }
      />

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

      {/* Only a draft is still to be sent, so only there do these stop money going astray. */}
      {draft && !payout.payoutMethodIsCurrent && (
        <Callout variant="console" tone="destructive" icon={CircleX} data-warning="not-current">
          <p>{t('platform:payout.notCurrent')}</p>
        </Callout>
      )}
      {draft && payout.methodChangedRecently && (
        <Callout variant="console" tone="warning" icon={TriangleAlert} data-warning="changed-recently">
          <p>{t('platform:payout.changedRecently')}</p>
        </Callout>
      )}

      <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
        <h2 className={SECTION_TITLE}>{t('platform:payout.destination')}</h2>
        <PayoutDestination method={payout.payoutMethod} />
        {!draft && !payout.payoutMethodIsCurrent && <p className={META}>{t('platform:payout.replaced')}</p>}
      </section>

      {payout.status === 'paid' && (
        <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
          <h2 className={SECTION_TITLE}>{t('platform:payout.reference')}</h2>
          <p className={cn(DATA, 'wrap-anywhere')}>{payout.transferReference}</p>
          {payout.note !== null && (
            <div className="flex flex-col gap-1">
              <h3 className="text-base font-medium">{t('platform:payout.note')}</h3>
              <p className={cn(META, 'whitespace-pre-line wrap-anywhere')}>{payout.note}</p>
            </div>
          )}
        </section>
      )}

      <section className="flex flex-col gap-4 border-t pt-8 lg:pt-12">
        <h2 className={SECTION_TITLE}>{t('platform:payout.items')}</h2>
        {payout.items.length === 0 ? (
          <p className={META}>{t('platform:payout.noItems')}</p>
        ) : (
          <PayoutItems items={payout.items} caption={t('platform:payout.items')} />
        )}
      </section>

      {dialog === 'paid' && (
        <MarkPaidDialog payout={payout} onClose={() => setDialog(null)} onDone={onDone} onStale={(now) => void onStale(now)} onGone={onGone} />
      )}
      {dialog === 'cancel' && (
        <CancelDialog payout={payout} onClose={() => setDialog(null)} onDone={onDone} onStale={(now) => void onStale(now)} onGone={onGone} />
      )}
    </main>
  )
}

type DialogProps = {
  payout: Payout
  onClose: () => void
  onDone: (payout: Payout, done: 'paid' | 'cancelled') => void
  onStale: (payout: Payout | null) => void
  onGone: () => void
}

/**
 * Mark paid: the transfer reference (required, trimmed, at most 100
 * characters, never one already recorded) and an optional note only platform
 * admins see. A refusal it can fix stays in it, beside the field.
 */
function MarkPaidDialog({ payout, onClose, onDone, onStale, onGone }: DialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [referenceError, setReferenceError] = useState<'invalid' | 'duplicate' | null>(null)
  const [noteError, setNoteError] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const data = new FormData(event.currentTarget)
    const reference = String(data.get('transferReference') ?? '').trim()
    const note = String(data.get('note') ?? '').trim()
    setFormError(null)
    const badReference = reference === '' || reference.length > MAX_REFERENCE
    const badNote = note.length > MAX_NOTE
    setReferenceError(badReference ? 'invalid' : null)
    setNoteError(badNote)
    if (badReference || badNote) return

    setBusy(true)
    try {
      onDone(await platformPayoutsApi.markPaid(payout.id, reference, note === '' ? null : note), 'paid')
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      if (!(error instanceof ApiError)) {
        setFormError(t('platform:payout.failed'))
        return
      }
      if (error.status === 409 && error.message === 'duplicate_transfer_reference') {
        setReferenceError('duplicate')
        return
      }
      if (error.status === 409 && error.message === 'not_draft') {
        onStale(payoutFromRefusal(error))
        return
      }
      if (error.status === 404) {
        onGone()
        return
      }
      if (error.status === 422 && (error.fields.includes('transferReference') || error.fields.includes('note'))) {
        setReferenceError(error.fields.includes('transferReference') ? 'invalid' : null)
        setNoteError(error.fields.includes('note'))
        return
      }
      setFormError(error.status === 400 || error.status === 422 ? t('platform:payout.invalidRequest') : t('platform:payout.failed'))
    }
  }

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform:payout.markPaidDialog.title')}
      description={t('platform:payout.markPaidDialog.body', { amount: formatMoney(payout.amountRwf) })}
    >
      <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
        <div className="flex flex-col gap-1">
          <PayoutDestination method={payout.payoutMethod} />
        </div>
        <AdminField
          label={t('platform:payout.markPaidDialog.reference')}
          hint={t('platform:payout.markPaidDialog.referenceHint')}
          error={
            referenceError === 'duplicate'
              ? t('platform:payout.invalid.duplicate')
              : referenceError === 'invalid'
                ? t('platform:payout.invalid.transferReference')
                : null
          }
        >
          {(props) => (
            <Input {...props} name="transferReference" required maxLength={MAX_REFERENCE} autoComplete="off" className={cn(FIELD, 'font-mono')} />
          )}
        </AdminField>
        <AdminField
          label={t('platform:payout.markPaidDialog.note')}
          hint={t('platform:payout.markPaidDialog.noteHint')}
          error={noteError ? t('platform:payout.invalid.note') : null}
        >
          {(props) => <Textarea {...props} name="note" rows={3} maxLength={MAX_NOTE} className={TEXTAREA} />}
        </AdminField>
        {formError !== null && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {formError}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:payout.markPaidDialog.cancel')}
          </Button>
          <Button type="submit" size="console" disabled={busy}>
            {busy ? t('platform:payout.markPaidDialog.working') : t('platform:payout.markPaidDialog.submit')}
          </Button>
        </div>
      </form>
    </FormDialog>
  )
}

/** Cancel the draft, confirmed first: its lines go back to the balance. */
function CancelDialog({ payout, onClose, onDone, onStale, onGone }: DialogProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function confirm() {
    if (busy) return
    setBusy(true)
    setFailed(false)
    try {
      onDone(await platformPayoutsApi.cancel(payout.id), 'cancelled')
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      if (error instanceof ApiError && error.status === 409) {
        onStale(payoutFromRefusal(error))
        return
      }
      if (error instanceof ApiError && error.status === 404) {
        onGone()
        return
      }
      setFailed(true)
    }
  }

  return (
    <FormDialog open onClose={onClose} title={t('platform:payout.cancelDialog.title')} description={t('platform:payout.cancelDialog.body')}>
      <div className="flex flex-col gap-5">
        {failed && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:payout.failed')}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:payout.cancelDialog.keep')}
          </Button>
          <Button type="button" variant="console-destructive-solid" size="console" disabled={busy} onClick={() => void confirm()}>
            {busy ? t('platform:payout.cancelDialog.working') : t('platform:payout.cancelDialog.submit')}
          </Button>
        </div>
      </div>
    </FormDialog>
  )
}
