import { describe, expect, it } from 'vitest'
import { PHOTOGRAPHER_CONTACT, contactLinks } from './contact'

describe('the photographer’s contact details', () => {
  it('show nothing when every field is empty', () => {
    expect(contactLinks({ name: null, phone: null, whatsapp: null, email: null })).toEqual([])
  })

  it('ship as placeholders until the photographer’s real details replace them (2026-09-27)', () => {
    expect(contactLinks(PHOTOGRAPHER_CONTACT).map((link) => link.kind)).toEqual(['phone', 'whatsapp', 'email'])
  })

  it('link only the channels that are set', () => {
    expect(contactLinks({ name: null, phone: '+250 788 000 000', whatsapp: '+250 788 111 222', email: null })).toEqual([
      { kind: 'phone', value: '+250 788 000 000', href: 'tel:+250788000000' },
      { kind: 'whatsapp', value: '+250 788 111 222', href: 'https://wa.me/250788111222' },
    ])
    expect(contactLinks({ name: 'Studio', phone: null, whatsapp: null, email: 'hello@example.com' })).toEqual([
      { kind: 'email', value: 'hello@example.com', href: 'mailto:hello@example.com' },
    ])
  })
})
