import { ArrowDown, ArrowUp, Check, CircleAlert, ImageOff, ImagePlus, Images, Pencil, Trash2 } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { UnauthenticatedError } from '@/admin/api'
import { isHttpsLink } from '@/admin/profile'
import { CAPTION_MAX, type Portfolio, type PortfolioImage, invalidImageFields, moved, portfolioApi } from '@/admin/portfolio'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'
import { AdminField } from './AdminField'
import { EYEBROW, FIELD, META, PAGE, TEXTAREA } from './console/classes'
import { FormDialog } from './console/FormDialog'
import { PageHeader } from './console/PageHeader'
import { Line, LoadingRegion } from './console/Skeletons'

type Loaded = { attempt: number; portfolio: Portfolio } | { attempt: number; failed: true }
type Notice = { tone: 'success' | 'warning' | 'destructive'; text: string }
type Dialog = { kind: 'add' } | { kind: 'caption'; image: PortfolioImage; position: number } | { kind: 'remove'; image: PortfolioImage; position: number }

/** How long typing must pause before the preview follows the link. */
const PREVIEW_DELAY_MS = 400

/**
 * `/studio/portfolio` (marketplace spec R7.2): up to 24 photos, each a pasted
 * https link with an optional caption, in the order the public profile shows.
 *
 * Adding, editing a caption and removing each open a dialog (admin console
 * 6.11); at the limit the add button is disabled and says why. Reordering is
 * one place at a time with Move up / Move down (keyboard-first; there is no
 * drag), saved at once with the whole order; focus stays on the moved photo's
 * button and the new place is announced. The API takes an order only when it
 * is exactly this studio's set, so a list changed elsewhere is reloaded.
 */
export function AdminPortfolio() {
  const { t } = useTranslation()
  const [attempt, setAttempt] = useState(0)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [ordering, setOrdering] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const focusAfterMove = useRef<{ id: string; by: -1 | 1 } | null>(null)

  useEffect(() => {
    let cancelled = false
    portfolioApi.load().then(
      (portfolio) => !cancelled && setLoaded({ attempt, portfolio }),
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
  const portfolio = current !== null && 'portfolio' in current ? current.portfolio : null
  const images = portfolio?.images ?? []
  const full = portfolio !== null && images.length >= portfolio.limit

  // A moved photo keeps focus on the button that moved it; at an end, where
  // that button is now disabled, on the other one.
  useEffect(() => {
    const target = focusAfterMove.current
    if (target === null) return
    focusAfterMove.current = null
    const same = document.getElementById(moveButtonId(target.id, target.by)) as HTMLButtonElement | null
    const other = document.getElementById(moveButtonId(target.id, target.by === -1 ? 1 : -1)) as HTMLButtonElement | null
    ;(same !== null && !same.disabled ? same : other)?.focus()
  }, [portfolio])

  function setImages(next: PortfolioImage[]) {
    setLoaded((now) => (now === null || !('portfolio' in now) ? now : { ...now, portfolio: { ...now.portfolio, images: next } }))
  }

  function reload(text: string, tone: Notice['tone'] = 'warning') {
    setNotice({ tone, text })
    setAttempt((n) => n + 1)
  }

  async function move(index: number, by: -1 | 1) {
    if (ordering || portfolio === null) return
    const before = images
    const image = before[index]
    if (image === undefined || index + by < 0 || index + by >= before.length) return
    const next = moved(before, index, by)
    setNotice(null)
    setOrdering(true)
    // Shown at once; put back if the API refuses.
    setImages(next)
    focusAfterMove.current = { id: image.id, by }
    try {
      const result = await portfolioApi.order(next.map((each) => each.id))
      if (result.status === 'saved') {
        setImages(result.images)
        const position = result.images.findIndex((each) => each.id === image.id) + 1
        setAnnouncement(t('admin:portfolio.moved', { position, count: result.images.length }))
      } else if (result.status === 'changed') {
        reload(t('admin:portfolio.orderChanged'))
      } else {
        setImages(before)
        setNotice({ tone: 'destructive', text: t('admin:portfolio.orderFailed') })
      }
    } catch (error) {
      if (error instanceof UnauthenticatedError) return
      setImages(before)
      setNotice({ tone: 'destructive', text: t('admin:portfolio.orderFailed') })
    } finally {
      setOrdering(false)
    }
  }

  return (
    <main className={cn(PAGE, 'max-w-4xl')}>
      <PageHeader
        eyebrow={t('studio:nav.label')}
        eyebrowIcon={Images}
        title={t('admin:portfolio.title')}
        badges={
          portfolio !== null && (
            <Badge variant="console-count" data-portfolio-count="">
              {t('admin:portfolio.count', { count: images.length, limit: portfolio.limit })}
            </Badge>
          )
        }
        actions={
          portfolio !== null && (
            <Button
              size="console"
              disabled={full}
              aria-describedby={full ? 'portfolio-full' : undefined}
              onClick={() => {
                setNotice(null)
                setDialog({ kind: 'add' })
              }}
            >
              <ImagePlus aria-hidden="true" />
              {t('admin:portfolio.add')}
            </Button>
          )
        }
      >
        <p className={cn(META, 'max-w-prose text-pretty')}>{t('admin:portfolio.intro')}</p>
      </PageHeader>

      {/* The move announcements: polite, and only words. */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {full && (
        <Callout variant="console" tone="info" icon={Images} id="portfolio-full" data-notice="portfolio-full">
          <p>{t('admin:portfolio.full')}</p>
        </Callout>
      )}

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
        <LoadingRegion label={t('admin:portfolio.loading')} className="flex flex-col rounded-xs border">
          {Array.from({ length: 3 }, (_, row) => (
            <div key={row} className="flex items-center gap-4 border-b p-4 last:border-b-0">
              <Skeleton className="aspect-[4/3] w-24 shrink-0 rounded-xs sm:w-32" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Line w="w-20" className="h-3" />
                <Line w="w-56 max-w-full" />
              </div>
            </div>
          ))}
        </LoadingRegion>
      )}

      {current !== null && 'failed' in current && (
        <div className="flex flex-col items-start gap-3">
          <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
            <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            {t('admin:portfolio.loadFailed')}
          </p>
          <Button variant="console-outline" size="console-sm" onClick={() => setAttempt((n) => n + 1)}>
            {t('admin:portfolio.retry')}
          </Button>
        </div>
      )}

      {portfolio !== null && images.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-start gap-2 rounded-xs border border-dashed p-6">
          <Images aria-hidden="true" className="size-5" />
          <p className="text-sm">{t('admin:portfolio.empty')}</p>
        </div>
      )}

      {portfolio !== null && images.length > 0 && (
        <ol className="flex flex-col rounded-xs border" aria-label={t('admin:portfolio.title')}>
          {images.map((image, index) => {
            const position = index + 1
            return (
              <li
                key={image.id}
                data-portfolio-image={image.id}
                className="flex flex-col gap-4 border-b p-4 last:border-b-0 sm:flex-row sm:items-center sm:gap-5"
              >
                <div className="flex min-w-0 flex-1 items-start gap-4">
                  <Thumbnail url={image.url} alt={image.caption ?? t('admin:portfolio.photo', { position })} />
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <p className={cn(EYEBROW, 'tabular-nums')}>{t('admin:portfolio.photo', { position })}</p>
                    {image.caption === null ? (
                      <p className="text-muted-foreground text-sm italic">{t('admin:portfolio.noCaption')}</p>
                    ) : (
                      <p className="line-clamp-3 text-[0.9375rem] wrap-anywhere">{image.caption}</p>
                    )}
                  </div>
                </div>
                {/* Two groups: the moves, then the caption and removal, which take a row of their own on a phone. */}
                <div className="flex flex-wrap gap-2 sm:shrink-0 sm:justify-end">
                  <div className="flex gap-2">
                    <Button
                      id={moveButtonId(image.id, -1)}
                      variant="console-outline"
                      size="console-icon"
                      aria-label={t('admin:portfolio.moveUpLabel', { position })}
                      title={t('admin:portfolio.moveUp')}
                      disabled={index === 0}
                      aria-disabled={ordering || undefined}
                      onClick={() => void move(index, -1)}
                    >
                      <ArrowUp aria-hidden="true" />
                    </Button>
                    <Button
                      id={moveButtonId(image.id, 1)}
                      variant="console-outline"
                      size="console-icon"
                      aria-label={t('admin:portfolio.moveDownLabel', { position })}
                      title={t('admin:portfolio.moveDown')}
                      disabled={index === images.length - 1}
                      aria-disabled={ordering || undefined}
                      onClick={() => void move(index, 1)}
                    >
                      <ArrowDown aria-hidden="true" />
                    </Button>
                  </div>
                  <div className="flex gap-2 max-sm:basis-full [&>*]:max-sm:flex-1">
                    <Button
                      variant="console-outline"
                      size="console"
                      aria-label={t('admin:portfolio.editCaptionLabel', { position })}
                      onClick={() => {
                        setNotice(null)
                        setDialog({ kind: 'caption', image, position })
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      {t('admin:portfolio.editCaption')}
                    </Button>
                    <Button
                      variant="console-outline"
                      size="console"
                      className="text-destructive hover:text-destructive"
                      aria-label={t('admin:portfolio.removeLabel', { position })}
                      onClick={() => {
                        setNotice(null)
                        setDialog({ kind: 'remove', image, position })
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      {t('admin:portfolio.remove')}
                    </Button>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

      <FormDialog open={dialog?.kind === 'add'} onClose={() => setDialog(null)} title={t('admin:portfolio.add')}>
        <AddForm
          onCancel={() => setDialog(null)}
          onAdded={(image) => {
            setDialog(null)
            setImages([...images, image])
            setNotice({ tone: 'success', text: t('admin:portfolio.added') })
          }}
          onFull={() => {
            setDialog(null)
            reload(t('admin:portfolio.fullNow'))
          }}
        />
      </FormDialog>

      <FormDialog open={dialog?.kind === 'caption'} onClose={() => setDialog(null)} title={t('admin:portfolio.editTitle')}>
        {dialog?.kind === 'caption' && (
          <CaptionForm
            key={dialog.image.id}
            image={dialog.image}
            onCancel={() => setDialog(null)}
            onSaved={(image) => {
              setDialog(null)
              setImages(images.map((each) => (each.id === image.id ? image : each)))
              setNotice({ tone: 'success', text: t('admin:portfolio.captionSaved') })
            }}
            onGone={() => {
              setDialog(null)
              reload(t('admin:portfolio.gone'))
            }}
          />
        )}
      </FormDialog>

      <FormDialog
        open={dialog?.kind === 'remove'}
        onClose={() => setDialog(null)}
        title={t('admin:portfolio.removeTitle')}
        description={t('admin:portfolio.removeBody')}
      >
        {dialog?.kind === 'remove' && (
          <RemoveForm
            key={dialog.image.id}
            image={dialog.image}
            onCancel={() => setDialog(null)}
            onRemoved={() => {
              setDialog(null)
              setImages(images.filter((each) => each.id !== dialog.image.id))
              setNotice({ tone: 'success', text: t('admin:portfolio.removed') })
            }}
            onGone={() => {
              setDialog(null)
              reload(t('admin:portfolio.gone'))
            }}
          />
        )}
      </FormDialog>
    </main>
  )
}

function moveButtonId(id: string, by: -1 | 1): string {
  return `portfolio-${by === -1 ? 'up' : 'down'}-${id}`
}

/** A photo at thumbnail size: https only, no referrer, and a plain notice when it will not load. */
function Thumbnail({ url, alt, className }: { url: string; alt: string; className?: string }) {
  const { t } = useTranslation()
  const [broken, setBroken] = useState(false)
  const src = safeHttpsUrl(url)
  const box = cn('aspect-[4/3] w-24 shrink-0 rounded-xs border sm:w-32', className)
  if (src === null || broken) {
    return (
      <div className={cn(box, 'bg-console-surface text-muted-foreground flex flex-col items-center justify-center gap-1 p-2 text-center text-xs')}>
        <ImageOff aria-hidden="true" className="size-4" />
        <span>{t('admin:portfolio.broken')}</span>
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      className={cn(box, 'bg-console-surface object-cover')}
      onError={() => setBroken(true)}
    />
  )
}

/** The buttons under each dialog's form: cancel first in the DOM, the action last. */
function DialogActions({ busy, label, busyLabel, onCancel, destructive = false }: { busy: boolean; label: string; busyLabel: string; onCancel: () => void; destructive?: boolean }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
      <Button type="button" variant="console-outline" size="console" onClick={onCancel}>
        {t('admin:portfolio.cancel')}
      </Button>
      <Button type="submit" size="console" variant={destructive ? 'console-destructive-solid' : 'default'} disabled={busy}>
        {busy ? busyLabel : label}
      </Button>
    </div>
  )
}

function FailedLine({ text }: { text: string }) {
  return (
    <p className="text-destructive flex items-start gap-2 text-sm" role="alert">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      {text}
    </p>
  )
}

/** A new photo by its link, previewed once typing pauses, with an optional caption. */
function AddForm({ onCancel, onAdded, onFull }: { onCancel: () => void; onAdded: (image: PortfolioImage) => void; onFull: () => void }) {
  const { t } = useTranslation()
  const [url, setUrl] = useState('')
  const [caption, setCaption] = useState('')
  const [shown, setShown] = useState('')
  const [invalid, setInvalid] = useState<ReadonlySet<'url' | 'caption'>>(new Set())
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (url === shown) return
    const timer = setTimeout(() => setShown(url), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [url, shown])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    const wrong = invalidImageFields(url, caption)
    setInvalid(new Set(wrong))
    if (wrong.length > 0) return
    setBusy(true)
    try {
      const result = await portfolioApi.add(url, caption)
      if (result.status === 'added') onAdded(result.image)
      else if (result.status === 'full') onFull()
      else if (result.status === 'invalid') setInvalid(new Set(result.fields))
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      <AdminField label={t('admin:portfolio.fields.url')} hint={t('admin:portfolio.hints.url')} error={invalid.has('url') ? t('admin:portfolio.errors.url') : null}>
        {(props) => (
          <Input
            {...props}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            className={cn(FIELD, 'font-mono')}
          />
        )}
      </AdminField>
      {isHttpsLink(shown) && (
        <figure className="flex flex-col gap-2">
          <figcaption className={EYEBROW}>{t('admin:portfolio.preview')}</figcaption>
          <Thumbnail key={shown.trim()} url={shown.trim()} alt={t('admin:portfolio.preview')} className="w-full sm:w-full" />
        </figure>
      )}
      <CaptionField value={caption} onChange={setCaption} invalid={invalid.has('caption')} />
      {failed && <FailedLine text={t('admin:portfolio.failed')} />}
      <DialogActions busy={busy} label={t('admin:portfolio.addSubmit')} busyLabel={t('admin:portfolio.adding')} onCancel={onCancel} />
    </form>
  )
}

function CaptionField({ value, onChange, invalid }: { value: string; onChange: (value: string) => void; invalid: boolean }) {
  const { t } = useTranslation()
  return (
    <AdminField label={t('admin:portfolio.fields.caption')} hint={t('admin:portfolio.hints.caption')} error={invalid ? t('admin:portfolio.errors.caption') : null}>
      {(props) => (
        <Textarea
          {...props}
          name="caption"
          rows={3}
          // A little room past the cap, so a paste is not cut silently; the count is checked on save.
          maxLength={CAPTION_MAX * 2}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={TEXTAREA}
        />
      )}
    </AdminField>
  )
}

/** A photo's caption; a blank one clears it. */
function CaptionForm({
  image,
  onCancel,
  onSaved,
  onGone,
}: {
  image: PortfolioImage
  onCancel: () => void
  onSaved: (image: PortfolioImage) => void
  onGone: () => void
}) {
  const { t } = useTranslation()
  const [caption, setCaption] = useState(image.caption ?? '')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    const wrong = invalidImageFields(image.url, caption).includes('caption')
    setInvalid(wrong)
    if (wrong) return
    setBusy(true)
    try {
      const result = await portfolioApi.caption(image.id, caption)
      if (result.status === 'saved') onSaved(result.image)
      else if (result.status === 'gone') onGone()
      else if (result.status === 'invalid') setInvalid(true)
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      <Thumbnail url={image.url} alt={image.caption ?? ''} />
      <CaptionField value={caption} onChange={setCaption} invalid={invalid} />
      {failed && <FailedLine text={t('admin:portfolio.failed')} />}
      <DialogActions busy={busy} label={t('admin:portfolio.saveCaption')} busyLabel={t('admin:portfolio.saving')} onCancel={onCancel} />
    </form>
  )
}

/** The confirmation before a photo leaves the portfolio. */
function RemoveForm({ image, onCancel, onRemoved, onGone }: { image: PortfolioImage; onCancel: () => void; onRemoved: () => void; onGone: () => void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy) return
    setFailed(false)
    setBusy(true)
    try {
      const result = await portfolioApi.remove(image.id)
      if (result.status === 'removed') onRemoved()
      else if (result.status === 'gone') onGone()
      else setFailed(true)
    } catch (error) {
      if (!(error instanceof UnauthenticatedError)) setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" noValidate onSubmit={(event) => void onSubmit(event)}>
      <Thumbnail url={image.url} alt={image.caption ?? ''} />
      {failed && <FailedLine text={t('admin:portfolio.failed')} />}
      <DialogActions
        busy={busy}
        destructive
        label={t('admin:portfolio.removeConfirm')}
        busyLabel={t('admin:portfolio.removing')}
        onCancel={onCancel}
      />
    </form>
  )
}

