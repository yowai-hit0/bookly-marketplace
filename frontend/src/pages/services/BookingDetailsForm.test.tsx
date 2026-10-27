import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { FormEvent } from 'react'
import { describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { DetailField } from '@/catalogue/bookings'
import { type BookingPrefill, BookingDetailsForm } from './BookingDetailsForm'

/**
 * The booking form (plan.md Task 13, spec §3.1 step 6, A-13): exactly the
 * fixed set of fields, each labelled, with its hint and -- when marked -- its
 * error tied to it for assistive technology; uncontrolled, so what was typed
 * survives the form being marked; submitted by a control outside it through
 * the `form` attribute.
 */

const FORM_ID = 'booking-form'
const CONSENT = 'I agree that Bookly may use these details to arrange and deliver my booking.'

const ERRORS: Record<DetailField, string> = {
  fullName: 'Enter your full name.',
  email: 'Enter a valid email address.',
  phone: 'Enter a phone number we can reach you on.',
  location: 'Tell us where the shoot will take place.',
  partySize: 'Enter a whole number of people, at least 1, or leave it blank.',
  specialRequests: 'Keep special requests under 2,000 characters.',
  consent: 'Tick the box to agree before you book.',
}

function renderForm(invalid: DetailField[] = [], onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => event.preventDefault())) {
  const ui = (fields: DetailField[]) => (
    <>
      <BookingDetailsForm id={FORM_ID} invalid={new Set(fields)} onSubmit={onSubmit} />
      <button type="submit" form={FORM_ID}>
        Confirm booking
      </button>
    </>
  )
  const view = render(ui(invalid))
  return { onSubmit, rerender: (fields: DetailField[]) => view.rerender(ui(fields)) }
}

function fields() {
  return {
    fullName: screen.getByRole('textbox', { name: 'Full name' }),
    email: screen.getByRole('textbox', { name: 'Email' }),
    phone: screen.getByRole('textbox', { name: 'Phone number' }),
    location: screen.getByRole('textbox', { name: 'Shoot location' }),
    partySize: screen.getByRole('textbox', { name: 'Number of people' }),
    specialRequests: screen.getByRole('textbox', { name: 'Special requests' }),
    consent: screen.getByRole('checkbox', { name: CONSENT }),
  }
}

describe('the booking form', () => {
  it('is a form named by its heading, with the intro, and validation left to the page', () => {
    renderForm()

    const form = screen.getByRole('form', { name: 'Your details' })
    expect(form).toHaveAttribute('id', FORM_ID)
    expect(form).toHaveAttribute('novalidate')
    expect(within(form).getByRole('heading', { level: 2, name: 'Your details' })).toBeInTheDocument()
    expect(within(form).getByText('We use these to arrange your shoot and to send your confirmation.')).toBeInTheDocument()
  })

  it('has exactly the fixed field set, in order, each labelled and named for FormData', () => {
    renderForm()
    const form = screen.getByRole('form', { name: 'Your details' })

    const named = Array.from(form.querySelectorAll('input, textarea, select')).map((element) => element.getAttribute('name'))
    expect(named).toEqual(['fullName', 'email', 'phone', 'location', 'partySize', 'specialRequests', 'consent'])

    const f = fields()
    expect(f.fullName).toHaveAttribute('autocomplete', 'name')
    expect(f.email).toHaveAttribute('type', 'email')
    expect(f.email).toHaveAttribute('autocomplete', 'email')
    expect(f.phone).toHaveAttribute('type', 'tel')
    expect(f.phone).toHaveAttribute('autocomplete', 'tel')
    expect(f.partySize).toHaveAttribute('inputmode', 'numeric')
    expect(f.specialRequests.tagName).toBe('TEXTAREA')
    expect(f.consent).not.toBeChecked()
    // No field asks for a payment detail or anything past the fixed set (A-13).
    expect(within(form).queryByLabelText(/card|pin|password|date of birth|address line/i)).not.toBeInTheDocument()
  })

  it('describes the optional and format-sensitive fields with their hints', () => {
    renderForm()
    const f = fields()

    expect(f.phone).toHaveAccessibleDescription('Include your country code if your number is not Rwandan.')
    expect(f.partySize).toHaveAccessibleDescription('Leave blank for a product shoot.')
    expect(f.specialRequests).toHaveAccessibleDescription('Optional.')
    expect(f.fullName).not.toHaveAttribute('aria-describedby')
    expect(f.consent).not.toHaveAttribute('aria-describedby')
  })

  it('marks nothing and shows no error when nothing is invalid', () => {
    renderForm()

    for (const field of Object.values(fields())) expect(field).not.toHaveAttribute('aria-invalid')
    for (const message of Object.values(ERRORS)) expect(screen.queryByText(message)).not.toBeInTheDocument()
  })

  it.each(Object.keys(ERRORS) as DetailField[])('marks %s alone, with its message tied to it', (name) => {
    renderForm([name])
    const all = fields()

    const field = all[name]
    expect(field).toHaveAttribute('aria-invalid', 'true')
    expect(field).toHaveAccessibleDescription(expect.stringContaining(ERRORS[name]))
    expect(screen.getByText(ERRORS[name])).toBeVisible()
    for (const [other, element] of Object.entries(all)) {
      if (other !== name) expect(element).not.toHaveAttribute('aria-invalid')
    }
    expect(Object.values(ERRORS).filter((message) => screen.queryByText(message) !== null)).toEqual([ERRORS[name]])
  })

  it('keeps a field’s hint in its description beside the error', () => {
    renderForm(['phone', 'partySize'])
    const f = fields()

    expect(f.phone).toHaveAccessibleDescription('Include your country code if your number is not Rwandan. Enter a phone number we can reach you on.')
    expect(f.partySize).toHaveAccessibleDescription('Leave blank for a product shoot. Enter a whole number of people, at least 1, or leave it blank.')
  })

  it('marks every field at once', () => {
    renderForm(Object.keys(ERRORS) as DetailField[])

    for (const field of Object.values(fields())) expect(field).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps what was typed when the marks change', async () => {
    const { rerender } = renderForm()
    const u = userEvent.setup({ delay: null })
    await u.type(fields().fullName, 'Aline Uwase')
    await u.type(fields().email, 'aline@')
    await u.type(fields().specialRequests, 'Golden hour')
    await u.click(fields().consent)

    rerender(['email'])
    rerender([])

    expect(fields().fullName).toHaveValue('Aline Uwase')
    expect(fields().email).toHaveValue('aline@')
    expect(fields().specialRequests).toHaveValue('Golden hour')
    expect(fields().consent).toBeChecked()
  })

  it('is submitted by a control outside it through the form attribute, carrying what was typed', async () => {
    const seen: [string, FormDataEntryValue][][] = []
    const onSubmit = vi.fn((event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      seen.push(Array.from(new FormData(event.currentTarget).entries()))
    })
    renderForm([], onSubmit)
    const u = userEvent.setup({ delay: null })
    await u.type(fields().fullName, 'Aline')
    await u.click(fields().consent)

    await u.click(screen.getByRole('button', { name: 'Confirm booking' }))

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(seen[0]).toEqual([
      ['fullName', 'Aline'],
      ['email', ''],
      ['phone', ''],
      ['location', ''],
      ['partySize', ''],
      ['specialRequests', ''],
      ['consent', 'on'],
    ])
  })

  it('toggles consent from its label text and by keyboard', async () => {
    renderForm()
    const u = userEvent.setup({ delay: null })

    await u.click(screen.getByText(CONSENT))
    expect(fields().consent).toBeChecked()

    fields().consent.focus()
    await u.keyboard(' ')
    expect(fields().consent).not.toBeChecked()
  })

  it('gives every field a unique id, so two forms on a page do not collide', () => {
    render(
      <>
        <BookingDetailsForm id="one" invalid={new Set(['email'])} onSubmit={() => {}} />
        <BookingDetailsForm id="two" invalid={new Set(['email'])} onSubmit={() => {}} />
      </>,
    )

    const ids = Array.from(document.querySelectorAll('[id]')).map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const email of screen.getAllByRole('textbox', { name: 'Email' })) {
      expect(email).toHaveAccessibleDescription('Enter a valid email address.')
    }
  })
})

/**
 * A signed-in client's own details fill the empty name, email and phone
 * (marketplace-spec Phase 8, decision 1): editable, never over what was
 * typed, once per account, and nothing at all for a guest.
 */
describe('the prefill', () => {
  const PREFILL: BookingPrefill = { key: 'c1', fullName: 'Aline Uwase', email: 'aline@example.com', phone: '+250788123456' }

  function renderWith(prefill: BookingPrefill | null) {
    const ui = (value: BookingPrefill | null) => <BookingDetailsForm id={FORM_ID} invalid={new Set()} onSubmit={vi.fn()} prefill={value} />
    const view = render(ui(prefill))
    return { rerender: (value: BookingPrefill | null) => view.rerender(ui(value)) }
  }

  it('fills the name, email and phone, and leaves the rest empty', () => {
    renderWith(PREFILL)
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Aline Uwase')
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('aline@example.com')
    expect(screen.getByRole('textbox', { name: 'Phone number' })).toHaveValue('+250788123456')
    expect(screen.getByRole('textbox', { name: 'Shoot location' })).toHaveValue('')
  })

  it('the filled values stay editable', async () => {
    renderWith(PREFILL)
    const user = userEvent.setup({ delay: null })
    const name = screen.getByRole('textbox', { name: 'Full name' })
    await user.clear(name)
    await user.type(name, 'Someone Else')
    expect(name).toHaveValue('Someone Else')
  })

  it('arriving late, it never writes over what was typed, and fills only what is empty', async () => {
    const view = renderWith(null)
    await userEvent.setup({ delay: null }).type(screen.getByRole('textbox', { name: 'Email' }), 'typed@example.com')
    view.rerender(PREFILL)
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('typed@example.com')
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('Aline Uwase')
  })

  it('a field cleared after filling stays clear when the account answers again', async () => {
    const view = renderWith(PREFILL)
    await userEvent.setup({ delay: null }).clear(screen.getByRole('textbox', { name: 'Phone number' }))
    view.rerender({ ...PREFILL })
    expect(screen.getByRole('textbox', { name: 'Phone number' })).toHaveValue('')
  })

  it('an account with no name or phone fills only the email', () => {
    renderWith({ ...PREFILL, fullName: null, phone: null })
    expect(screen.getByRole('textbox', { name: 'Full name' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Phone number' })).toHaveValue('')
    expect(screen.getByRole('textbox', { name: 'Email' })).toHaveValue('aline@example.com')
  })

  it('a guest gets an empty form', () => {
    renderWith(null)
    for (const name of ['Full name', 'Email', 'Phone number']) expect(screen.getByRole('textbox', { name })).toHaveValue('')
  })
})
