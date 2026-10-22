/**
 * How a client can reach a photographer (marketplace spec R6.2, R6.4): the
 * channels set on their public profile, each with the link that opens it.
 * Only the channels that are set are returned, and a channel whose value
 * yields no usable link (a phone with no digits) is left out rather than
 * linked to nothing. There are no placeholder details any more: on a
 * marketplace the contact shown is always a photographer's own.
 *
 * Values are the photographer's text, shown as plain text by the caller.
 */
export type ContactChannels = {
  contactPhone: string | null
  whatsappPhone: string | null
  email: string | null
}

export type ContactLink = {
  kind: 'phone' | 'whatsapp' | 'email'
  value: string
  href: string
  /** True for a link that leaves the site (WhatsApp): it opens in a new tab with `rel="noopener noreferrer"`. */
  external: boolean
}

/** The contact channels that are set, each with the link that opens it. */
export function contactLinks(contact: ContactChannels): ContactLink[] {
  const links: ContactLink[] = []
  const phone = contact.contactPhone?.trim() ?? ''
  const phoneDial = phone.replace(/[^\d+]/g, '')
  if (/\d/.test(phoneDial)) links.push({ kind: 'phone', value: phone, href: `tel:${phoneDial}`, external: false })
  const whatsapp = contact.whatsappPhone?.trim() ?? ''
  const whatsappDigits = internationalDigits(whatsapp)
  if (whatsappDigits !== '')
    links.push({ kind: 'whatsapp', value: whatsapp, href: `https://wa.me/${whatsappDigits}`, external: true })
  const email = contact.email?.trim() ?? ''
  // The API checks the format; this only refuses what could break out of a mailto: link.
  if (/^[^\s@?#&]+@[^\s@?#&]+$/.test(email)) links.push({ kind: 'email', value: email, href: `mailto:${email}`, external: false })
  return links
}

/**
 * A number's digits in the international form `wa.me` needs (no `+`, no
 * leading zeros). The marketplace is Rwanda only, so a national mobile number
 * (`0788 123 456`) gains the country code 250; `00` before a country code is
 * the international prefix and goes.
 */
function internationalDigits(value: string): string {
  const digits = value.replace(/\D/g, '')
  if (/^07\d{8}$/.test(digits)) return `250${digits.slice(1)}`
  return digits.replace(/^00/, '')
}
