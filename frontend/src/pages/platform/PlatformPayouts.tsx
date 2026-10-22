import { Banknote, CircleAlert, CircleX, TriangleAlert } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatDateTime, formatMoney } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type PayoutDue,
  type PayoutStatus,
  type PlatformPayout,
  balanceFromRefusal,
  draftFromRefusal,
  isPayoutStatus,
  platformPayoutsApi,
  userName,
} from '@/platform/payouts'
import { DATA, EYEBROW, LINK, META, PAGE, TD, TH, TR } from '@/pages/admin/console/classes'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { PageHeader } from '@/pages/admin/console/PageHeader'
import { PayoutDestination } from '@/pages/admin/console/PayoutDestination'
import { Line, LoadingRegion } from '@/pages/admin/console/Skeletons'

const VIEWS = ['due', 'draft', 'paid', 'cancelled'] as const

type View = (typeof VIEWS)[number]

/**
 * `/platform/payouts` (marketplace spec R4.1, R4.4): payouts are made by
 * hand. "Due" lists every photographer owed money, with the balance and
 * where it would go; a draft is built from there, through a confirmation that
 * shows the destination. The other views list the drafts, the paid and the
 * cancelled payouts, each opening on its own page to be marked paid or
 * cancelled.
 *
 * A payout method saved in the last 72 hours is flagged everywhere it shows,
 * because redirecting payouts is what an account takeover aims for (R4.1).
 * The view is in the address (`?view=`), so a reload or a shared link keeps it.
 */
export function PlatformPayouts() {
  const { t } = useTranslation()
  const [params, setParams] = useSearchParams()
  const raw = params.get('view')
  const view: View = raw !== null && isPayoutStatus(raw) ? raw : 'due'

  function choose(next: string) {
    setParams(next === 'due' ? new URLSearchParams() : new URLSearchParams({ view: next }), { replace: true })
  }

  return (
    <main className={cn(PAGE, 'max-w-6xl')}>
      <PageHeader eyebrow={t('platform:nav.label')} eyebrowIcon={Banknote} title={t('platform:payouts.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('platform:payouts.intro')}</p>
      </PageHeader>

      <Tabs value={view} onValueChange={choose} className="gap-6">
        {/* A segmented control, as the calendar's view switch: the active segment is the inverted-neutral fill. */}
        <TabsList
          aria-label={t('platform:payouts.views.label')}
          className="border-input h-auto! w-full flex-wrap justify-start gap-0 rounded-xs border bg-transparent p-0 sm:w-fit"
        >
          {VIEWS.map((value) => (
            <TabsTrigger
              key={value}
              value={value}
              className="text-foreground data-active:bg-primary data-active:text-primary-foreground h-11 flex-none rounded-none border-0 px-4 text-[0.9375rem] shadow-none! after:hidden lg:h-10 pointer-coarse:h-11"
            >
              {t(`platform:payouts.views.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
        {VIEWS.map((value) => (
          <TabsContent key={value} value={value} className="text-base">
            {value === 'due' ? <DueView /> : <PayoutList status={value} />}
          </TabsContent>
        ))}
      </Tabs>
    </main>
  )
}

/** A failed load: the words, and a way to try again. */
function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
        <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        {t('platform:payouts.loadFailed')}
      </p>
      <Button variant="console-outline" size="console-sm" onClick={onRetry}>
        {t('platform:payouts.retry')}
      </Button>
    </div>
  )
}

function RowsSkeleton() {
  const { t } = useTranslation()
  return (
    <LoadingRegion label={t('platform:payouts.loading')} className="flex flex-col">
      {Array.from({ length: 4 }, (_, row) => (
        <div key={row} className="flex items-center gap-6 border-b py-4 last:border-b-0">
          <div className="flex flex-1 flex-col gap-2">
            <Line w="w-44 max-w-full" />
            <Line w="w-28" className="h-3" />
          </div>
          <Line w="w-24 max-sm:hidden" />
          <Line w="w-36 max-sm:hidden" />
          <Line w="w-24" />
        </div>
      ))}
    </LoadingRegion>
  )
}

/** A warning beside a destination: compact, but in the console's warning or danger tint so it is not missed. */
function MethodWarning({ tone, kind, children }: { tone: 'warning' | 'destructive'; kind: string; children: ReactNode }) {
  return (
    <Callout
      variant="console"
      tone={tone}
      icon={tone === 'warning' ? TriangleAlert : CircleX}
      data-warning={kind}
      className="px-3 py-2.5 text-sm"
    >
      <p>{children}</p>
    </Callout>
  )
}

/** The photographer cell: display name, public handle and login email. */
function PhotographerCell({ photographer }: { photographer: PayoutDue['photographer'] }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="wrap-anywhere">{photographer.displayName}</span>
      <span className={cn(META, 'font-mono')}>/p/{photographer.handle}</span>
      <span className={cn(META, 'wrap-anywhere')}>{photographer.email}</span>
    </div>
  )
}

const STACKED_ROW = '@max-[52rem]:flex @max-[52rem]:flex-col @max-[52rem]:gap-2 @max-[52rem]:py-4'
const STACKED_CELL = '@max-[52rem]:p-0'

// --- Due -------------------------------------------------------------------------------------

function DueView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [attempt, setAttempt] = useState(0)
  const [rows, setRows] = useState<{ attempt: number; list: PayoutDue[] | null } | null>(null)
  const [pending, setPending] = useState<PayoutDue | null>(null)

  const load = useCallback((forAttempt: number, isCancelled: () => boolean) => {
    platformPayoutsApi.due().then(
      (list) => !isCancelled() && setRows({ attempt: forAttempt, list }),
      (error: unknown) => {
        // A 401 has dropped the platform session; the route's guard sends him to sign in.
        if (isCancelled() || error instanceof UnauthenticatedError) return
        setRows({ attempt: forAttempt, list: null })
      },
    )
  }, [])

  useEffect(() => {
    let cancelled = false
    load(attempt, () => cancelled)
    return () => {
      cancelled = true
    }
  }, [attempt, load])

  const current = rows !== null && rows.attempt === attempt ? rows : null

  /** After a refusal the list is stale: read it again, keeping the rows on screen until it answers. */
  function refresh() {
    platformPayoutsApi.due().then(
      (list) => setRows({ attempt, list }),
      () => {},
    )
  }

  if (current === null) return <RowsSkeleton />
  if (current.list === null) return <LoadFailed onRetry={() => setAttempt((n) => n + 1)} />
  if (current.list.length === 0) return <p className={META}>{t('platform:payouts.empty.due')}</p>

  return (
    <>
      <div className="@container">
        <table role="table" className="w-full border-collapse text-[0.9375rem]">
          <caption className="sr-only">{t('platform:payouts.views.due')}</caption>
          <thead role="rowgroup" className="@max-[52rem]:sr-only">
            <tr role="row" className="border-b">
              {(['photographer', 'balance', 'method', 'actions'] as const).map((column) => (
                <th key={column} role="columnheader" scope="col" className={cn(TH, (column === 'balance' || column === 'actions') && 'text-right')}>
                  {t(`platform:payouts.columns.${column}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className="@max-[52rem]:block">
            {current.list.map((due) => {
              const name = due.photographer.displayName
              return (
                <tr key={due.photographer.id} role="row" data-photographer={due.photographer.id} className={cn(TR, STACKED_ROW)}>
                  <td role="cell" className={cn(TD, STACKED_CELL)}>
                    <PhotographerCell photographer={due.photographer} />
                  </td>
                  <td role="cell" className={cn(TD, 'text-right @max-[52rem]:text-left', STACKED_CELL)}>
                    <div className="flex flex-col gap-1 @min-[52rem]:items-end">
                      <span className={cn(DATA, 'whitespace-nowrap')}>{formatMoney(due.payableRwf)}</span>
                      <span className={META}>{t('platform:payouts.lines', { count: due.itemCount })}</span>
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, 'max-w-sm', STACKED_CELL)}>
                    <div className="flex flex-col gap-2">
                      {due.payoutMethod === null ? (
                        <MethodWarning tone="destructive" kind="no-method">
                          {t('platform:payouts.noMethod')}
                        </MethodWarning>
                      ) : (
                        <PayoutDestination method={due.payoutMethod} />
                      )}
                      {due.methodChangedRecently && (
                        <MethodWarning tone="warning" kind="changed-recently">
                          {t('platform:payouts.changedRecently')}
                        </MethodWarning>
                      )}
                    </div>
                  </td>
                  <td role="cell" className={cn(TD, STACKED_CELL)}>
                    <div className="flex flex-wrap gap-2 @min-[52rem]:justify-end">
                      {due.draftPayoutId !== null ? (
                        <Button asChild variant="console-outline" size="console-sm">
                          <Link to={`/platform/payouts/${due.draftPayoutId}`} aria-label={t('platform:payouts.openDraftNamed', { name })}>
                            {t('platform:payouts.openDraft')}
                          </Link>
                        </Button>
                      ) : (
                        due.payoutMethod !== null && (
                          <Button
                            variant="console-outline"
                            size="console-sm"
                            aria-label={t('platform:payouts.createNamed', { name })}
                            onClick={() => setPending(due)}
                          >
                            {t('platform:payouts.create')}
                          </Button>
                        )
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {pending !== null && (
        <CreateDialog
          key={pending.photographer.id}
          due={pending}
          onClose={() => setPending(null)}
          onCreated={(id) => void navigate(`/platform/payouts/${id}`)}
          onRefused={refresh}
        />
      )}
    </>
  )
}

type Refusal =
  | { code: 'draft_exists'; payoutId: string | null }
  | { code: 'nothing_payable'; payableRwf: number }
  | { code: 'no_payout_method' | 'not_found' | 'failed' }

/**
 * The confirmation before a draft is built: the amount, the destination it
 * will name, and the 72-hour warning when the destination is new. A refusal
 * stays in the dialog, in words; a draft that already exists is one link away.
 */
function CreateDialog({
  due,
  onClose,
  onCreated,
  onRefused,
}: {
  due: PayoutDue
  onClose: () => void
  onCreated: (id: string) => void
  onRefused: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const name = due.photographer.displayName

  async function create() {
    if (busy) return
    setBusy(true)
    setRefusal(null)
    try {
      const payout = await platformPayoutsApi.build(due.photographer.id)
      onCreated(payout.id)
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      const next = refusalOf(error)
      setRefusal(next)
      // The due list said something the API no longer agrees with: read it again.
      if (next.code !== 'failed') onRefused()
    }
  }

  const final = refusal !== null && refusal.code !== 'failed'

  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('platform:payouts.confirm.title', { name })}
      description={t('platform:payouts.confirm.body', {
        amount: formatMoney(due.payableRwf),
        lines: t('platform:payouts.lines', { count: due.itemCount }),
      })}
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col gap-2">
          <p className={EYEBROW}>{t('platform:payouts.confirm.destination')}</p>
          {due.payoutMethod === null ? (
            <MethodWarning tone="destructive" kind="no-method">
              {t('platform:payouts.noMethod')}
            </MethodWarning>
          ) : (
            <PayoutDestination method={due.payoutMethod} />
          )}
        </div>
        {due.methodChangedRecently && (
          <Callout variant="console" tone="warning" icon={TriangleAlert} data-warning="changed-recently">
            <p>{t('platform:payouts.confirm.changedRecently')}</p>
          </Callout>
        )}
        {refusal !== null && (
          <Callout
            variant="console"
            tone="destructive"
            icon={CircleAlert}
            role="alert"
            action={
              refusal.code === 'draft_exists' && refusal.payoutId !== null ? (
                <Link to={`/platform/payouts/${refusal.payoutId}`} className={cn(LINK, 'underline')}>
                  {t('platform:payouts.openDraft')}
                </Link>
              ) : undefined
            }
          >
            <p>
              {refusal.code === 'nothing_payable'
                ? t('platform:payouts.errors.nothing_payable', { amount: formatMoney(refusal.payableRwf) })
                : t(`platform:payouts.errors.${refusal.code}`)}
            </p>
          </Callout>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:payouts.confirm.cancel')}
          </Button>
          {!final && (
            <Button type="button" size="console" disabled={busy} onClick={() => void create()}>
              {busy ? t('platform:payouts.confirm.working') : t('platform:payouts.confirm.submit')}
            </Button>
          )}
        </div>
      </div>
    </FormDialog>
  )
}

function refusalOf(error: unknown): Refusal {
  if (!(error instanceof ApiError)) return { code: 'failed' }
  if (error.status === 404) return { code: 'not_found' }
  if (error.status !== 409) return { code: 'failed' }
  if (error.message === 'draft_exists') return { code: 'draft_exists', payoutId: draftFromRefusal(error) }
  if (error.message === 'nothing_payable') return { code: 'nothing_payable', payableRwf: balanceFromRefusal(error) ?? 0 }
  if (error.message === 'no_payout_method') return { code: 'no_payout_method' }
  return { code: 'failed' }
}

// --- Drafts, paid, cancelled -------------------------------------------------------------------

function PayoutList({ status }: { status: PayoutStatus }) {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [rows, setRows] = useState<{ attempt: number; list: PlatformPayout[] | null } | null>(null)

  useEffect(() => {
    let cancelled = false
    platformPayoutsApi.list(status).then(
      (list) => !cancelled && setRows({ attempt, list }),
      (error: unknown) => {
        if (cancelled || error instanceof UnauthenticatedError) return
        setRows({ attempt, list: null })
      },
    )
    return () => {
      cancelled = true
    }
  }, [status, attempt])

  const current = rows !== null && rows.attempt === attempt ? rows : null
  if (current === null) return <RowsSkeleton />
  if (current.list === null) return <LoadFailed onRetry={() => setAttempt((n) => n + 1)} />
  if (current.list.length === 0) return <p className={META}>{t(`platform:payouts.empty.${status}`)}</p>

  const columns = ['photographer', 'amount', 'method', 'created', ...(status === 'draft' ? [] : [status]), 'actions'] as const

  return (
    <div className="@container">
      <table role="table" className="w-full border-collapse text-[0.9375rem]">
        <caption className="sr-only">{t(`platform:payouts.views.${status}`)}</caption>
        <thead role="rowgroup" className="@max-[52rem]:sr-only">
          <tr role="row" className="border-b">
            {columns.map((column) => (
              <th key={column} role="columnheader" scope="col" className={cn(TH, (column === 'amount' || column === 'actions') && 'text-right')}>
                {t(`platform:payouts.columns.${column}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody role="rowgroup" className="@max-[52rem]:block">
          {current.list.map((payout) => {
            const by = (user: PlatformPayout['createdBy'] | null) => t('platform:payouts.by', { name: userName(user) ?? t('platform:payouts.someone') })
            return (
              <tr key={payout.id} role="row" data-payout={payout.id} className={cn(TR, STACKED_ROW)}>
                <td role="cell" className={cn(TD, STACKED_CELL)}>
                  <PhotographerCell photographer={payout.photographer} />
                </td>
                <td role="cell" className={cn(TD, 'text-right @max-[52rem]:text-left', STACKED_CELL)}>
                  <div className="flex flex-col gap-1 @min-[52rem]:items-end">
                    <span className={cn(DATA, 'whitespace-nowrap')}>{formatMoney(payout.amountRwf)}</span>
                    <span className={META}>{t('platform:payouts.lines', { count: payout.itemCount })}</span>
                  </div>
                </td>
                <td role="cell" className={cn(TD, 'max-w-sm', STACKED_CELL)}>
                  <div className="flex flex-col gap-2">
                    <PayoutDestination method={payout.payoutMethod} />
                    {/* Only a draft is still to be sent: there, a stale or a new destination is a warning. */}
                    {status === 'draft' && !payout.payoutMethodIsCurrent && (
                      <MethodWarning tone="destructive" kind="not-current">
                        {t('platform:payouts.notCurrent')}
                      </MethodWarning>
                    )}
                    {status === 'draft' && payout.methodChangedRecently && (
                      <MethodWarning tone="warning" kind="changed-recently">
                        {t('platform:payouts.changedRecently')}
                      </MethodWarning>
                    )}
                  </div>
                </td>
                <td role="cell" className={cn(TD, STACKED_CELL)}>
                  <div className="flex flex-col gap-1">
                    <span className="tabular-nums">{formatDateTime(payout.createdAt)}</span>
                    <span className={META}>{by(payout.createdBy)}</span>
                  </div>
                </td>
                {status === 'paid' && (
                  <td role="cell" className={cn(TD, STACKED_CELL)}>
                    <div className="flex flex-col gap-1">
                      {payout.paidAt !== null && <span className="tabular-nums">{formatDateTime(payout.paidAt)}</span>}
                      <span className={META}>{by(payout.paidBy)}</span>
                      {payout.transferReference !== null && <span className={cn(DATA, 'wrap-anywhere')}>{payout.transferReference}</span>}
                    </div>
                  </td>
                )}
                {status === 'cancelled' && (
                  <td role="cell" className={cn(TD, STACKED_CELL)}>
                    <div className="flex flex-col gap-1">
                      {payout.cancelledAt !== null && <span className="tabular-nums">{formatDateTime(payout.cancelledAt)}</span>}
                      <span className={META}>{by(payout.cancelledBy)}</span>
                    </div>
                  </td>
                )}
                <td role="cell" className={cn(TD, STACKED_CELL)}>
                  <div className="flex flex-wrap gap-2 @min-[52rem]:justify-end">
                    <Button asChild variant="console-outline" size="console-sm">
                      <Link
                        to={`/platform/payouts/${payout.id}`}
                        aria-label={t('platform:payouts.openNamed', { name: payout.photographer.displayName, amount: formatMoney(payout.amountRwf) })}
                      >
                        {t('platform:payouts.open')}
                      </Link>
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
