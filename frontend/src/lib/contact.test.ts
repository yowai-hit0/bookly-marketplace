import { describe, expect, it } from 'vitest'
import { contactLinks } from './contact'

const NONE = { contactPhone: null, whatsappPhone: null, email: null }

describe('a photographer’s contact links (R6.2, R6.4)', () => {
  it('show nothing when every channel is unset', () => {
    expect(contactLinks(NONE)).toEqual([])
  })

  it('link only the channels that are set, in the order phone, WhatsApp, email', () => {
    expect(contactLinks({ contactPhone: '+250 788 000 000', whatsappPhone: '+250 788 111 222', email: null })).toEqual([
      { kind: 'phone', value: '+250 788 000 000', href: 'tel:+250788000000', external: false },
      { kind: 'whatsapp', value: '+250 788 111 222', href: 'https://wa.me/250788111222', external: true },
    ])
    expect(contactLinks({ ...NONE, email: 'hello@example.com' })).toEqual([
      { kind: 'email', value: 'hello@example.com', href: 'mailto:hello@example.com', external: false },
    ])
  })

  it('marks only WhatsApp as leaving the site', () => {
    const links = contactLinks({ contactPhone: '0788000000', whatsappPhone: '0788000000', email: 'a@b.rw' })
    expect(links.map((link) => [link.kind, link.external])).toEqual([
      ['phone', false],
      ['whatsapp', true],
      ['email', false],
    ])
  })

  it('writes a Rwandan national number in the international form WhatsApp needs', () => {
    const link = (whatsappPhone: string) => contactLinks({ ...NONE, whatsappPhone })[0]?.href
    expect(link('0788 123 456')).toBe('https://wa.me/250788123456')
    expect(link('+250 788 123 456')).toBe('https://wa.me/250788123456')
    expect(link('00250788123456')).toBe('https://wa.me/250788123456')
    expect(link('+44 7700 900123')).toBe('https://wa.me/447700900123')
  })

  it('keeps the number as the photographer wrote it for display', () => {
    expect(contactLinks({ ...NONE, whatsappPhone: '0788 123 456' })[0]?.value).toBe('0788 123 456')
  })

  it('treats blank values as unset', () => {
    expect(contactLinks({ contactPhone: '  ', whatsappPhone: '', email: ' ' })).toEqual([])
  })

  it('leaves out a number with no digits rather than linking to nothing', () => {
    expect(contactLinks({ ...NONE, contactPhone: 'call me', whatsappPhone: '+' })).toEqual([])
  })

  it('never builds a link from something that is not a phone number', () => {
    const [phone] = contactLinks({ ...NONE, contactPhone: 'javascript:alert(1) 0788' })
    expect(phone?.href).toBe('tel:10788')
    expect(phone?.href.startsWith('tel:')).toBe(true)
  })

  it('refuses an address that could add mailto: parameters', () => {
    expect(contactLinks({ ...NONE, email: 'a@b.rw?subject=x' })).toEqual([])
    expect(contactLinks({ ...NONE, email: 'not an address' })).toEqual([])
  })
})
