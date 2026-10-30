import { CircleAlert, CircleCheck, CircleX, Clock, PencilLine } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, UnauthenticatedError } from '@/auth/api'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  type Moderation,
  type PhotographerStatus,
  type PlatformPhotographer,
  awaitsSubmission,
  movesFor,
  normalisePhotographer,
  platformApi,
} from '@/platform/photographers'
import { AdminField } from '@/pages/admin/AdminField'
import { FormDialog } from '@/pages/admin/console/FormDialog'
import { TEXTAREA } from '@/pages/admin/console/classes'

/**
 * The moderation pieces the photographers list and one photographer's detail
 * page share (Phase 9: the detail page reuses the list's actions and
 * dialogs): the status badge, the buttons for the moves the API allows from a
 * status, and the confirmation dialog that makes the change.
 */

/** The API's cap on a suspension reason, trimmed. */
export const MAX_REASON = 500

export type PendingModeration = { photographer: PlatformPhotographer; action: Moderation }

/** The status in a console badge: its word, with an icon of its own shape, never colour alone. */
export function PhotographerStatusBadge({ status }: { status: PhotographerStatus }) {
  const { t } = useTranslation()
  const label = t(`platform:photographers.status.${status}`)
  if (status === 'approved') {
    return (
      <Badge variant="console-success" data-photographer-status={status}>
        <CircleCheck aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  if (status === 'suspended') {
    return (
      <Badge variant="console" className="bg-console-danger-tint text-destructive" data-photographer-status={status}>
        <CircleX aria-hidden="true" />
        {label}
      </Badge>
    )
  }
  return (
    <Badge variant="console" data-photographer-status={status}>
      <Clock aria-hidden="true" />
      {label}
    </Badge>
  )
}

/** The warning badge for a pending, submitted studio whose handle changed since. */
export function HandleChangedBadge() {
  const { t } = useTranslation()
  return (
    <Badge variant="console" className="bg-console-warning-tint text-console-warning">
      <PencilLine aria-hidden="true" />
      {t('platform:photographers.handleChanged')}
    </Badge>
  )
}

/**
 * The moves the API allows from the photographer's status, as outline
 * buttons named with whose they are. Approve is disabled for a pending studio
 * that has not submitted, with the reason beside it (a disabled button cannot
 * be focused, so the reason is visible text).
 */
export function ModerationButtons({
  photographer,
  onChoose,
  className,
  buttonsClassName,
  size = 'console-sm',
}: {
  photographer: PlatformPhotographer
  onChoose: (pending: PendingModeration) => void
  className?: string
  buttonsClassName?: string
  size?: 'console' | 'console-sm'
}) {
  const { t } = useTranslation()
  const blockedId = `${photographer.id}-not-submitted`
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className={cn('flex flex-wrap gap-2', buttonsClassName)}>
        {movesFor(photographer.status).map((action) => {
          const blocked = action === 'approve' && awaitsSubmission(photographer)
          return (
            <Button
              key={action}
              variant="console-outline"
              size={size}
              // Every row has the same verbs: the name says whose, and starts with the visible word.
              aria-label={`${t(`platform:photographers.${action}`)} ${photographer.displayName}`}
              disabled={blocked}
              aria-describedby={blocked ? blockedId : undefined}
              onClick={() => onChoose({ photographer, action })}
            >
              {t(`platform:photographers.${action}`)}
            </Button>
          )
        })}
      </div>
      {awaitsSubmission(photographer) && (
        <p id={blockedId} className="text-muted-foreground text-[0.8125rem]">
          {t('platform:photographers.approveNeedsSubmission')}
        </p>
      )}
    </div>
  )
}

/**
 * The confirmation step. A suspension asks for its reason (1 to 500
 * characters, trimmed); approve and reactivate only confirm. A refusal that
 * the dialog can fix (the reason) or retry (a failure) stays in it; a stale
 * or vanished row closes it and the page says why.
 */
export function ModerationDialog({
  pending,
  onClose,
  onDone,
  onStale,
  onNotSubmitted,
  onGone,
}: {
  pending: PendingModeration
  onClose: () => void
  onDone: (action: Moderation, photographer: PlatformPhotographer) => void
  onStale: (photographer: PlatformPhotographer) => void
  onNotSubmitted: (photographer: PlatformPhotographer) => void
  onGone: (id: string) => void
}) {
  const { t } = useTranslation()
  const { photographer, action } = pending
  const name = photographer.displayName
  const [busy, setBusy] = useState(false)
  const [reasonError, setReasonError] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
    if (action === 'suspend' && (reason === '' || reason.length > MAX_REASON)) {
      setReasonError(true)
      return
    }
    setReasonError(false)
    setFailed(false)
    setBusy(true)
    try {
      const answer =
        action === 'approve'
          ? await platformApi.approve(photographer.id)
          : action === 'suspend'
            ? await platformApi.suspend(photographer.id, reason)
            : await platformApi.reactivate(photographer.id)
      onDone(action, answer)
    } catch (error) {
      setBusy(false)
      if (error instanceof UnauthenticatedError) return
      if (error instanceof ApiError && error.status === 409) {
        const now = (error.body as { photographer?: PlatformPhotographer } | null)?.photographer
        if (now !== undefined && error.message === 'not_submitted') {
          onNotSubmitted(normalisePhotographer(now))
          return
        }
        if (now !== undefined) {
          onStale(normalisePhotographer(now))
          return
        }
      }
      if (error instanceof ApiError && error.status === 404) {
        onGone(photographer.id)
        return
      }
      if (error instanceof ApiError && error.status === 422) {
        setReasonError(true)
        return
      }
      setFailed(true)
    }
  }

  const title = t(`platform:photographers.confirm.${action}Title`, { name })
  const body = t(`platform:photographers.confirm.${action}Body`)

  return (
    <FormDialog open onClose={onClose} title={title} description={body}>
      <form className="flex flex-col gap-4" noValidate onSubmit={(event) => void onSubmit(event)}>
        {action === 'suspend' && (
          <AdminField
            label={t('platform:photographers.confirm.reason')}
            hint={t('platform:photographers.confirm.reasonHint')}
            error={reasonError ? t('platform:photographers.confirm.reasonRequired') : null}
          >
            {(props) => <Textarea {...props} name="reason" rows={3} maxLength={MAX_REASON} required className={TEXTAREA} />}
          </AdminField>
        )}
        {failed && (
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('platform:photographers.failed')}
          </p>
        )}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button type="button" variant="console-outline" size="console" onClick={onClose}>
            {t('platform:photographers.confirm.cancel')}
          </Button>
          <Button type="submit" variant={action === 'suspend' ? 'console-destructive-solid' : 'default'} size="console" disabled={busy}>
            {busy ? t('platform:photographers.confirm.working') : t(`platform:photographers.${action}`)}
          </Button>
        </div>
      </form>
    </FormDialog>
  )
}
