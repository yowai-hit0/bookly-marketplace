import { render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_META, applyDocumentMeta, excerpt, useDocumentMeta, type DocumentMeta } from './document-meta'

/** Per-route title, description and Open Graph tags (R6.6), and the defaults coming back. */

function content(selector: string): string | null {
  return document.head.querySelector(selector)?.getAttribute('content') ?? null
}

function Page(meta: DocumentMeta) {
  useDocumentMeta(meta)
  return null
}

afterEach(() => {
  applyDocumentMeta(DEFAULT_META)
})

describe('document meta', () => {
  it('sets the title, description and Open Graph tags', () => {
    render(<Page title="Kigali Lens · Bookly" description="Portraits in natural light." type="profile" image="https://images.example.com/c.jpg" />)

    expect(document.title).toBe('Kigali Lens · Bookly')
    expect(content('meta[name="description"]')).toBe('Portraits in natural light.')
    expect(content('meta[property="og:title"]')).toBe('Kigali Lens · Bookly')
    expect(content('meta[property="og:description"]')).toBe('Portraits in natural light.')
    expect(content('meta[property="og:type"]')).toBe('profile')
    expect(content('meta[property="og:image"]')).toBe('https://images.example.com/c.jpg')
    expect(content('meta[name="twitter:card"]')).toBe('summary_large_image')
    expect(content('meta[name="robots"]')).toBeNull()
  })

  it('never puts an image that is not https in a preview', () => {
    for (const image of ['http://images.example.com/c.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'not a url']) {
      applyDocumentMeta({ title: 'T', description: 'D', image })
      expect(content('meta[property="og:image"]')).toBeNull()
      expect(content('meta[name="twitter:card"]')).toBe('summary')
    }
  })

  it('keeps a not-found page out of search results, and only while it is shown', () => {
    const { unmount } = render(<Page title="Page not found · Bookly" description="That page does not exist." noindex />)
    expect(content('meta[name="robots"]')).toBe('noindex')

    unmount()

    expect(content('meta[name="robots"]')).toBeNull()
  })

  it('puts the defaults back when the page goes, so the next page never inherits its name', () => {
    const { unmount } = render(<Page title="Kigali Lens · Bookly" description="Portraits." image="https://images.example.com/c.jpg" />)
    unmount()

    expect(document.title).toBe(DEFAULT_META.title)
    expect(content('meta[name="description"]')).toBe(DEFAULT_META.description)
    expect(content('meta[property="og:image"]')).toBeNull()
  })

  it('follows a change while mounted', () => {
    const { rerender } = render(<Page title="Photographers · Bookly" description="D" />)
    rerender(<Page title="Wedding photographers · Bookly" description="D" />)

    expect(document.title).toBe('Wedding photographers · Bookly')
  })

  it('updates one tag per key rather than adding another each time', () => {
    applyDocumentMeta({ title: 'A', description: 'a' })
    applyDocumentMeta({ title: 'B', description: 'b' })

    expect(document.head.querySelectorAll('meta[name="description"]')).toHaveLength(1)
    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1)
  })

  it('writes text as an attribute value, never as markup', () => {
    applyDocumentMeta({ title: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' })

    expect(document.title).toBe('<script>alert(1)</script>')
    expect(content('meta[name="description"]')).toBe('"><img src=x onerror=alert(1)>')
    expect(document.head.querySelector('img, script')).toBeNull()
  })
})

describe('excerpt', () => {
  it('keeps a short text whole, on one line', () => {
    expect(excerpt('Portraits\n\nand   weddings.')).toBe('Portraits and weddings.')
  })

  it('cuts a long text at a word, with an ellipsis, within the limit', () => {
    const text = 'word '.repeat(60)
    const cut = excerpt(text, 40)
    expect(cut.length).toBeLessThanOrEqual(40)
    expect(cut.endsWith('word…')).toBe(true)
  })

  it('cuts a single long word too', () => {
    expect(excerpt('x'.repeat(200), 20)).toBe(`${'x'.repeat(19)}…`)
  })
})
