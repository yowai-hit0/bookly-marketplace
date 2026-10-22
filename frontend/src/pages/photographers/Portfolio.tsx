import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { type KeyboardEvent, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PortfolioImage } from '@/catalogue/api'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { safeHttpsUrl } from '@/lib/safe-url'
import { cn } from '@/lib/utils'

/**
 * A photographer's portfolio (`pages/photographer-profile.md`, "The
 * lightbox"; R6.2, R6.5): a grid of thumbnails, each a button opening that
 * image large.
 *
 * Only `https://` images are shown (the API filters, and `safeHttpsUrl` checks
 * again at the sink), never with a Referer, all lazy. Captions are the
 * photographer's text, rendered as text.
 *
 * The lightbox is the shared Radix dialog: focus is trapped inside it, Escape,
 * the × and the scrim close it, the arrow keys and the two buttons move
 * between images (wrapping at the ends), and on close focus returns to the
 * thumbnail of the image last shown. Nothing slides: the image swaps.
 */

type Shown = { url: string; caption: string | null }

export function Portfolio({ images, name, headingId }: { images: readonly PortfolioImage[]; name: string; headingId: string }) {
  const { t } = useTranslation()
  const shown: Shown[] = images.flatMap((image) => {
    const url = safeHttpsUrl(image.url)
    return url === null ? [] : [{ url, caption: image.caption?.trim() ? image.caption : null }]
  })
  const [open, setOpen] = useState<number | null>(null)
  const thumbnails = useRef<(HTMLButtonElement | null)[]>([])
  /** The image last shown: where focus returns when the lightbox closes. */
  const lastShown = useRef<number | null>(null)
  const total = shown.length
  if (total === 0) return null

  const current = open === null ? undefined : shown[open]

  function show(index: number) {
    lastShown.current = index
    setOpen(index)
  }

  function step(by: number) {
    if (open !== null) show((open + by + total) % total)
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (total < 2) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      step(-1)
    }
  }

  return (
    <>
      <ul className="grid grid-cols-2 gap-3 md:grid-cols-3" aria-labelledby={headingId}>
        {shown.map((image, index) => (
          <li key={`${index}-${image.url}`}>
            <figure className="flex flex-col gap-2">
              <button
                type="button"
                ref={(element) => {
                  thumbnails.current[index] = element
                }}
                onClick={() => show(index)}
                aria-label={t('profile:openPhoto', { index: index + 1, total })}
                className="group/photo bg-muted hover:border-ring block w-full cursor-zoom-in overflow-hidden rounded-xs border motion-safe:transition-[border-color] motion-safe:duration-150"
              >
                <img
                  src={image.url}
                  alt=""
                  referrerPolicy="no-referrer"
                  loading="lazy"
                  decoding="async"
                  className="aspect-4/3 w-full object-cover motion-safe:transition-opacity motion-safe:duration-200 motion-safe:group-hover/photo:opacity-90"
                />
              </button>
              {image.caption !== null && (
                <figcaption className="text-subtle-foreground line-clamp-2 text-[0.8125rem] leading-snug wrap-anywhere">
                  {image.caption}
                </figcaption>
              )}
            </figure>
          </li>
        ))}
      </ul>

      <Dialog open={open !== null} onOpenChange={(next) => !next && setOpen(null)}>
        <DialogContent
          closeLabel={t('profile:closePhoto')}
          aria-describedby={undefined}
          onKeyDown={onKeyDown}
          onCloseAutoFocus={(event) => {
            // Back to the thumbnail of the image last shown, not the one first opened.
            const target = lastShown.current === null ? null : thumbnails.current[lastShown.current]
            if (target) {
              event.preventDefault()
              target.focus()
            }
          }}
          className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-5xl gap-0 p-0"
          data-lightbox=""
        >
          {current !== undefined && open !== null && (
            <LightboxBody image={current} index={open} total={total} name={name} onStep={step} />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

function LightboxBody({
  image,
  index,
  total,
  name,
  onStep,
}: {
  image: Shown
  index: number
  total: number
  name: string
  onStep: (by: number) => void
}) {
  const { t } = useTranslation()
  const alt = image.caption ?? t('profile:photoAlt', { index: index + 1, name })

  return (
    <div className="flex min-h-0 flex-col">
      <DialogPrimitive.Title className="sr-only">{t('profile:openPhoto', { index: index + 1, total })}</DialogPrimitive.Title>
      <div className="flex min-h-0 items-center justify-center bg-black px-2 pt-14 pb-2 sm:px-14 sm:pt-12">
        <img
          key={image.url}
          src={image.url}
          alt={alt}
          referrerPolicy="no-referrer"
          className="max-h-[70dvh] w-auto max-w-full object-contain"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 sm:px-5">
        <p className="text-muted-foreground font-mono text-xs tracking-[0.1em] tabular-nums uppercase" aria-live="polite">
          {t('profile:counter', { index: index + 1, total })}
        </p>
        {image.caption !== null && <p className="min-w-0 flex-1 basis-48 text-[0.9375rem] wrap-anywhere">{image.caption}</p>}
        {total > 1 && (
          <div className={cn('flex gap-2', image.caption === null && 'ml-auto')}>
            <button
              type="button"
              onClick={() => onStep(-1)}
              aria-label={t('profile:previousPhoto')}
              className="hover:bg-muted flex size-11 items-center justify-center rounded-xs border motion-safe:transition-colors"
            >
              <ChevronLeft aria-hidden="true" className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => onStep(1)}
              aria-label={t('profile:nextPhoto')}
              className="hover:bg-muted flex size-11 items-center justify-center rounded-xs border motion-safe:transition-colors"
            >
              <ChevronRight aria-hidden="true" className="size-5" />
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
