/**
 * How a client can reach the photographer (design-system/bookly/client-front.md
 * section 5.8). The footer's contact block and the price summary's "Questions?"
 * line show only the fields that are set, and nothing at all while every field
 * is `null`. Labels live in `en.json` (`shell:contact.*`); values live here only.
 *
 * PLACEHOLDERS (user decision, 2026-09-27): ship with dummy values, to be
 * replaced with the photographer's real details before launch. Set a field to
 * `null` to hide it.
 */
export type PhotographerContact = {
  /** The photographer's or the studio's name, as it should appear. */
  name: string | null
  /** A phone number to call, as written for people (`+250 788 000 000`). */
  phone: string | null
  /** A WhatsApp number, as written for people; the link keeps its digits only. */
  whatsapp: string | null
  email: string | null
}

export const PHOTOGRAPHER_CONTACT: PhotographerContact = {
  name: 'demo studio name',
  phone: '+250 700 000 000',
  whatsapp: '+250 700 000 000',
  email: 'hello@example.com',
}

export type ContactLink = { kind: 'phone' | 'whatsapp' | 'email'; value: string; href: string }

/** The contact channels that are set, each with the link that opens it. */
export function contactLinks(contact: PhotographerContact = PHOTOGRAPHER_CONTACT): ContactLink[] {
  const links: ContactLink[] = []
  if (contact.phone !== null) links.push({ kind: 'phone', value: contact.phone, href: `tel:${contact.phone.replace(/[^\d+]/g, '')}` })
  if (contact.whatsapp !== null)
    links.push({ kind: 'whatsapp', value: contact.whatsapp, href: `https://wa.me/${contact.whatsapp.replace(/\D/g, '')}` })
  if (contact.email !== null) links.push({ kind: 'email', value: contact.email, href: `mailto:${contact.email}` })
  return links
}
