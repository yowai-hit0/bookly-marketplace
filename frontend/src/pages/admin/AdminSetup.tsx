import { ArrowRight, Check, Circle, CircleAlert, CircleCheck, CircleX, Clock, ListChecks, Send } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { UnauthenticatedError } from '@/admin/api'
import { SETUP_ITEMS, SETUP_LINKS, type Setup, type SetupItem, setupApi } from '@/admin/setup'
import { useStudioRefresh } from '@/admin/studio-refresh'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { EYEBROW, META, PAGE, SECTION_TITLE } from './console/classes'
import { PageHeader } from './console/PageHeader'
import { Line, LoadingRegion } from './console/Skeletons'

type Loaded = { attempt: number; setup: Setup } | { attempt: number; failed: true }
type Notice = { tone: 'success' | 'warning'; text: string }

/**
 * `/studio/setup` (marketplace spec R7.3, T7.1): the six things a studio needs
 * before the Bookly team can review it, each judged by the API from the studio
 * as it is now and linking to the page that fixes it, then the one submission.
 *
 * Submit is enabled only when the API says `canSubmit`. Should the studio
 * change between the read and the press (an item undone in another tab), the
 * API refuses with the items still missing, which the page lists, and the
 * checklist is read again. Once submitted the page says it is waiting for
 * review; approved and suspended say so instead of offering the button. The
 * items stay live throughout: an edit after submitting keeps the submission.
 */
export function AdminSetup() {
  const { t } = useTranslation()
  const refreshLayout = useStudioRefresh()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [missing, setMissing] = useState<SetupItem[] | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [submitFailed, setSubmitFailed] = useState(false)
  const hintId = useId()

  useEffect(() => {
    let cancelled = false
    setupApi.load().then(
      (setup) => !cancelled && setLoaded({ attempt, setup }),
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
  const setup = current !== null && 'setup' in current ? current.setup : null

  async function submit() {
    if (submitting || setup === null || !setup.canSubmit) return
    setSubmitting(true)
    setMissing(null)
    setNotice(null)
    setSubmitFailed(false)
    try {
      const result = await setupApi.submit()
      if (result.status === 'submitted') {
        setLoaded({ attempt, setup: result.setup })
        setNotice({ tone: 'success', text: t('admin:setup.submitted') })
        // The banner moves from "finish your setup" to "waiting for review".
        refreshLayout()
      } else if (result.status === 'incomplete') {
        setMissing(result.missing)
        setAttempt((n) => n + 1)
      } else if (result.status === 'not_pending') {
        setNotice({ tone: 'warning', text: t('admin:setup.notPending') })
        setAttempt((n) => n + 1)
        refreshLayout()
      } else {
        setSubmitFailed(true)
      }
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setSubmitFailed(true)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className={cn(PAGE, 'max-w-3xl')}>
      <PageHeader eyebrow={t('studio:nav.label')} eyebrowIcon={ListChecks} title={t('admin:setup.title')}>
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:setup.intro')}</p>
      </PageHeader>

      {notice !== null && (
        <Callout
          variant="console"
          tone={notice.tone}
          icon={notice.tone === 'success' ? Check : CircleAlert}
          role={notice.tone === 'success' ? 'status' : 'alert'}
        >
          <p>{notice.text}</p>
        </Callout>
      )}

      {current === null && (
        <LoadingRegion label={t('admin:setup.loading')} className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <Line w="w-32" />
            <Skeleton className="h-1.5 w-full rounded-xs" />
          </div>
          <div className="flex flex-col rounded-xs border">
            {SETUP_ITEMS.map((key) => (
              <div key={key} className="flex items-center gap-4 border-b px-4 py-4 last:border-b-0 sm:px-6">
                <Skeleton className="size-5 shrink-0 rounded-full" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Line w="w-40" />
                  <Line w="w-64 max-w-full" className="h-3" />
                </div>
                <Skeleton className="hidden h-8 w-36 rounded-xs sm:block" />
              </div>
            ))}
          </div>
        </LoadingRegion>
      )}

      {current !== null && 'failed' in current && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:setup.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:setup.retry')}
          </Button>
        </div>
      )}

      {setup !== null && (
        <>
          <StateNotice setup={setup} />
          <Checklist setup={setup} />

          {setup.status === 'pending' && setup.submittedAt === null && (
            <section className="flex flex-col gap-4 border-t pt-8">
              {missing !== null && missing.length > 0 && (
                <Callout variant="console" tone="warning" icon={CircleAlert} role="alert" data-setup-missing="">
                  <p>{t('admin:setup.incomplete')}</p>
                  <ul className="mt-2 flex list-disc flex-col pl-5 lg:gap-1">
                    {missing.map((key) => (
                      <li key={key}>
                        <Link
                          to={SETUP_LINKS[key]}
                          className="inline-flex items-center rounded-xs font-medium underline underline-offset-4 max-lg:min-h-11 pointer-coarse:min-h-11"
                        >
                          {t(`admin:setup.items.${key}.title`)}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Callout>
              )}
              {submitFailed && (
                <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
                  <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                  {t('admin:setup.submitFailed')}
                </p>
              )}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                <Button
                  size="console"
                  className="sm:min-w-44 sm:self-start"
                  disabled={!setup.canSubmit || submitting}
                  aria-describedby={setup.canSubmit ? undefined : hintId}
                  onClick={() => void submit()}
                >
                  <Send aria-hidden="true" />
                  {submitting ? t('admin:setup.submitting') : t('admin:setup.submit')}
                </Button>
                {!setup.canSubmit && (
                  <p id={hintId} className={META}>
                    {t('admin:setup.submitHint')}
                  </p>
                )}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  )
}

/** Where the studio stands, when it is past setting up: waiting for review, approved, or suspended. */
function StateNotice({ setup }: { setup: Setup }) {
  const { t } = useTranslation()
  if (setup.status === 'approved') {
    return (
      <Callout variant="console" tone="success" icon={CircleCheck} data-setup-state="approved">
        <p>{t('admin:setup.approved')}</p>
      </Callout>
    )
  }
  if (setup.status === 'suspended') {
    return (
      <Callout variant="console" tone="destructive" icon={CircleX} data-setup-state="suspended">
        <p>{t('admin:setup.suspended')}</p>
      </Callout>
    )
  }
  if (setup.submittedAt !== null) {
    return (
      <Callout variant="console" tone="info" icon={Clock} data-setup-state="awaiting_review">
        <p>{t('admin:setup.awaiting', { date: formatDateTime(setup.submittedAt) })}</p>
      </Callout>
    )
  }
  return null
}

/** The progress line and the six items, each with its state in words and the page that fixes it. */
function Checklist({ setup }: { setup: Setup }) {
  const { t } = useTranslation()
  const done = setup.items.filter((item) => item.done).length
  const total = setup.items.length
  const progressId = useId()

  return (
    <section aria-labelledby={progressId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2.5">
        <h2 id={progressId} className={cn(SECTION_TITLE, 'tabular-nums')}>
          {t('admin:setup.progress', { done, total })}
        </h2>
        {/* The words above carry it; the bar repeats them for the eye. */}
        <div aria-hidden="true" className="bg-console-chip h-1.5 w-full overflow-hidden rounded-xs">
          <div
            className="bg-console-success h-full motion-safe:transition-[width] motion-safe:duration-300"
            style={{ width: `${total === 0 ? 0 : (done / total) * 100}%` }}
          />
        </div>
      </div>

      <ol className="flex flex-col rounded-xs border">
        {setup.items.map(({ key, done: isDone }) => (
          <li
            key={key}
            data-setup-item={key}
            data-done={isDone}
            className="flex flex-col gap-3 border-b px-4 py-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-4 sm:px-6"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              {isDone ? (
                <CircleCheck aria-hidden="true" className="text-console-success mt-0.5 size-4.5 shrink-0" />
              ) : (
                <Circle aria-hidden="true" className="text-muted-foreground mt-0.5 size-4.5 shrink-0" />
              )}
              <div className="flex min-w-0 flex-col gap-1">
                <h3 className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-base font-medium">
                  {t(`admin:setup.items.${key}.title`)}{' '}
                  <span className={cn(EYEBROW, isDone && 'text-console-success')}>
                    {isDone ? t('admin:setup.done') : t('admin:setup.todo')}
                  </span>
                </h3>
                <p className={META}>{t(`admin:setup.items.${key}.body`)}</p>
              </div>
            </div>
            <Button asChild variant="console-outline" size="console-sm" className="max-sm:ml-7.5 max-sm:self-start sm:shrink-0">
              <Link to={SETUP_LINKS[key]}>
                {t(`admin:setup.items.${key}.action`)}
                <ArrowRight aria-hidden="true" />
              </Link>
            </Button>
          </li>
        ))}
      </ol>
    </section>
  )
}
