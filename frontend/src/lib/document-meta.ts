import { useEffect } from 'react'
import { safeHttpsUrl } from '@/lib/safe-url'

/**
 * Per-route `<title>`, description and Open Graph tags (marketplace spec
 * R6.6) for a client-rendered app: crawlers that run scripts read them, and a
 * shared link previews the page it names. Server rendering is deferred.
 *
 * Each page calls `useDocumentMeta` with what it knows; on unmount the
 * defaults return, so a page that sets nothing (checkout, a booking) never
 * inherits the last profile's name. The tags `index.html` ships are updated
 * in place; one it lacks is added (marked `data-bookly-meta`), and an
 * optional one (`og:image`, `robots`) is removed when the page has none.
 */

export type DocumentMeta = {
  /** The full title, suffix included. */
  title: string
  description: string
  /** An `https://` image for link previews; anything else is left out. */
  image?: string | null
  /** `og:type`: `website` unless the page is a profile. */
  type?: 'website' | 'profile'
  /** Keep the page out of search results: not found, an unavailable photographer. */
  noindex?: boolean
}

/** What `index.html` ships, restored whenever a page that set its own goes. */
export const DEFAULT_META: DocumentMeta = {
  title: 'Bookly: find and book photographers across Rwanda',
  description:
    'Compare photographers across Rwanda by category, district, price and free dates, and book online with a booking fee paid by MoMo.',
  type: 'website',
}

/** How long a description may be before it is cut at a word, with an ellipsis. */
export const DESCRIPTION_MAX = 155

/** `text` on one line, cut at a word to at most `max` characters. */
export function excerpt(text: string, max: number = DESCRIPTION_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const cut = line.slice(0, max - 1)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > max / 2 ? cut.slice(0, atWord) : cut).replace(/[\s,.;:–-]+$/, '')}…`
}

/** Writes `meta` into `<head>`. Exported for tests; pages use the hook. */
export function applyDocumentMeta(meta: DocumentMeta) {
  document.title = meta.title
  setTag('name', 'description', meta.description)
  setTag('property', 'og:title', meta.title)
  setTag('property', 'og:description', meta.description)
  setTag('property', 'og:type', meta.type ?? 'website')
  setTag('property', 'og:site_name', 'Bookly')
  const image = safeHttpsUrl(meta.image)
  setTag('property', 'og:image', image)
  setTag('name', 'twitter:card', image === null ? 'summary' : 'summary_large_image')
  setTag('name', 'robots', meta.noindex === true ? 'noindex' : null)
}

/** Sets this page's meta while it is mounted, and puts the defaults back when it goes. */
export function useDocumentMeta(meta: DocumentMeta) {
  const { title, description, image, type, noindex } = meta
  useEffect(() => {
    applyDocumentMeta({ title, description, image, type, noindex })
  }, [title, description, image, type, noindex])
  useEffect(() => () => applyDocumentMeta(DEFAULT_META), [])
}

function setTag(attribute: 'name' | 'property', key: string, content: string | null) {
  const selector = `meta[${attribute}="${key}"]`
  const existing = document.head.querySelector<HTMLMetaElement>(selector)
  if (content === null) {
    existing?.remove()
    return
  }
  const tag = existing ?? document.createElement('meta')
  if (existing === null) {
    tag.setAttribute(attribute, key)
    tag.setAttribute('data-bookly-meta', '')
    document.head.append(tag)
  }
  tag.setAttribute('content', content)
}
