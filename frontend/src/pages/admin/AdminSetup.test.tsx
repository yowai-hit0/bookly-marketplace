import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import { saveSession } from '@/admin/session'
import { formatDateTime } from '@/lib/format'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { ALL_DONE, setupBody } from '@/test/onboarding-fixtures'
import { STUDIO_ME_URL, studioMeBody } from '@/test/studio-me'

/**
 * `/studio/setup` (R7.3, T7.1) through the real routes: the six items with
 * their state in words and their links, the progress, Submit enabled only
 * when the API says so, the missing list of a refused submission, and the
 * awaiting, approved and suspended states.
 */

const SETUP = '/api/studio/setup'
const SUBMIT = '/api/studio/setup/submit'

type Answer = unknown | ((call: Sent) => Response | Promise<Response>)

/** The setup answers each of `loads` in turn (the last repeats); `onSubmit` answers the POST. */
function stubSetup(loads: Answer[], onSubmit: Answer = () => json({ error: 'internal_error' }, 500)) {
  let call = 0
  return stubApi((sent) => {
    if (sent.url === STUDIO_ME_URL) return json(studioMeBody('pending'))
    if (sent.method === 'GET' && sent.url === SETUP) {
      const answer = loads[Math.min(call, loads.length - 1)]
      call += 1
      return typeof answer === 'function' ? (answer as (s: Sent) => Response)(sent) : json(answer)
    }
    if (sent.method === 'POST' && sent.url === SUBMIT) return typeof onSubmit === 'function' ? (onSubmit as (s: Sent) => Response)(sent) : json(onSubmit)
    return undefined
  })
}

function renderPage() {
  saveSession({ token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' })
  const router = createMemoryRouter(routes, { initialEntries: ['/studio/setup'] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })
const items = () => [...document.querySelectorAll('[data-setup-item]')] as HTMLElement[]
const submitButton = () => screen.getByRole('button', { name: 'Submit for review' })
const calls = (api: ReturnType<typeof stubApi>, method: string, url: string) => api.sent.filter((s) => s.method === method && s.url === url)

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the setup checklist', () => {
  it('lists the six items in order, each with its state in words and the page that fixes it', async () => {
    stubSetup([setupBody({ profile: true, payoutMethod: true })])
    renderPage()

    expect(await screen.findByRole('heading', { level: 2, name: '2 of 6 done' })).toBeInTheDocument()
    expect(items().map((li) => li.dataset.setupItem)).toEqual(['profile', 'categories', 'districts', 'payoutMethod', 'services', 'workingHours'])
    expect(screen.getByRole('heading', { level: 3, name: 'Your profile Done' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 3, name: 'Categories To do' })).toBeInTheDocument()

    const links = items().map((li) => within(li).getByRole('link'))
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Edit your profile', '/studio/profile'],
      ['Choose categories', '/studio/profile#categories'],
      ['Choose districts', '/studio/profile#districts'],
      ['Add a payout method', '/studio/payout-method'],
      ['Add a service', '/studio/catalogue'],
      ['Set working hours', '/studio/availability'],
    ])
  })

  it('keeps Submit disabled with the reason beside it until every item is done', async () => {
    const api = stubSetup([setupBody({ profile: true })])
    renderPage()

    await screen.findByRole('heading', { level: 2, name: '1 of 6 done' })
    expect(submitButton()).toBeDisabled()
    expect(submitButton()).toHaveAccessibleDescription('Finish every step to submit.')
    await user().click(submitButton())
    expect(calls(api, 'POST', SUBMIT)).toHaveLength(0)
  })

  it('submits once when every item is done, then says it is waiting for review and asks the layout to read /me again', async () => {
    const submittedAt = '2026-10-25T08:00:00.000Z'
    const api = stubSetup([setupBody(ALL_DONE)], setupBody(ALL_DONE, { submittedAt }))
    renderPage()

    await screen.findByRole('heading', { level: 2, name: '6 of 6 done' })
    expect(submitButton()).toBeEnabled()
    expect(submitButton()).not.toHaveAccessibleDescription()
    const meBefore = calls(api, 'GET', STUDIO_ME_URL).length

    await user().dblClick(submitButton())

    expect(await screen.findByRole('status')).toHaveTextContent('Your studio is submitted for review.')
    expect(calls(api, 'POST', SUBMIT)).toHaveLength(1)
    expect(document.querySelector('[data-setup-state="awaiting_review"]')).toHaveTextContent(
      `You submitted your studio for review on ${formatDateTime(submittedAt)}.`,
    )
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
    await waitFor(() => expect(calls(api, 'GET', STUDIO_ME_URL).length).toBe(meBefore + 1))
  })

  it('lists what is still missing when the API refuses (T7.1), each a link, and reads the checklist again', async () => {
    const api = stubSetup(
      [setupBody(ALL_DONE), setupBody({ ...ALL_DONE, services: false })],
      () => json({ error: 'setup_incomplete', missing: ['services'] }, 422),
    )
    renderPage()
    await screen.findByRole('heading', { level: 2, name: '6 of 6 done' })

    await user().click(submitButton())

    const missing = await waitFor(() => {
      const box = document.querySelector('[data-setup-missing]')
      expect(box).not.toBeNull()
      return box as HTMLElement
    })
    expect(missing).toHaveAttribute('role', 'alert')
    expect(missing).toHaveTextContent('These steps still need finishing before you can submit:')
    expect(within(missing).getByRole('link', { name: 'Services' })).toHaveAttribute('href', '/studio/catalogue')
    expect(await screen.findByRole('heading', { level: 2, name: '5 of 6 done' })).toBeInTheDocument()
    expect(calls(api, 'GET', SETUP)).toHaveLength(2)
    expect(submitButton()).toBeDisabled()
  })

  it('on 409 not_pending says so and reloads into the state it now has', async () => {
    stubSetup([setupBody(ALL_DONE), setupBody(ALL_DONE, { status: 'approved' })], () => json({ error: 'not_pending' }, 409))
    renderPage()
    await screen.findByRole('heading', { level: 2, name: '6 of 6 done' })

    await user().click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Your studio is no longer waiting to be submitted')
    await waitFor(() => expect(document.querySelector('[data-setup-state="approved"]')).not.toBeNull())
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
  })

  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s says it could not submit and lets him try again', async (_label, respond) => {
    stubSetup([setupBody(ALL_DONE)], respond)
    renderPage()
    await screen.findByRole('heading', { level: 2, name: '6 of 6 done' })

    await user().click(submitButton())

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not submit. Check your connection and try again.')
    expect(submitButton()).toBeEnabled()
  })

  it('shows a submitted studio as waiting for review, with the items still live and no button', async () => {
    stubSetup([setupBody({ ...ALL_DONE, services: false }, { submittedAt: '2026-10-20T08:00:00.000Z' })])
    renderPage()

    await screen.findByRole('heading', { level: 2, name: '5 of 6 done' })
    expect(document.querySelector('[data-setup-state="awaiting_review"]')).toHaveTextContent('You can keep editing meanwhile.')
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
  })

  it.each([
    ['approved', 'Your studio is approved: clients can find and book you.'],
    ['suspended', 'Your studio is suspended, so there is nothing to submit.'],
  ])('shows an %s studio its state instead of the button', async (status, words) => {
    stubSetup([setupBody(ALL_DONE, { status })])
    renderPage()

    await screen.findByRole('heading', { level: 2, name: '6 of 6 done' })
    expect(document.querySelector(`[data-setup-state="${status}"]`)).toHaveTextContent(words)
    expect(screen.queryByRole('button', { name: 'Submit for review' })).not.toBeInTheDocument()
  })

  it('says it is loading, then a failure with Try again, which asks again', async () => {
    const api = stubSetup([() => json({ error: 'internal_error' }, 500), setupBody()])
    renderPage()

    expect(screen.getByText('Loading your setup…')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your setup.')

    await user().click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('heading', { level: 2, name: '0 of 6 done' })).toBeInTheDocument()
    expect(calls(api, 'GET', SETUP)).toHaveLength(2)
  })

  it('treats an answer it cannot read as a failed load', async () => {
    stubSetup([{ setup: { items: 'nope' } }])
    renderPage()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your setup.')
  })

  it('marks Setup current in the nav of a pending studio', async () => {
    stubSetup([setupBody()])
    renderPage()
    const nav = screen.getByRole('navigation', { name: 'Studio' })
    expect(await within(nav).findByRole('link', { name: 'Setup' })).toHaveAttribute('aria-current', 'page')
  })

  it('on a 401 leaves for the studio sign in', async () => {
    stubApi(() => json({ error: 'invalid_token' }, 401))
    const router = renderPage()
    await waitFor(() => expect(router.state.location.pathname).toBe('/studio/login'))
  })
})
