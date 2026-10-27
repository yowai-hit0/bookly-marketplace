import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { PortfolioImage } from '@/admin/portfolio'
import { saveSession } from '@/admin/session'
import { routes } from '@/routes'
import { type Sent, json, stubApi } from '@/test/fetch'
import { portfolioImage } from '@/test/onboarding-fixtures'
import { STUDIO_ME_URL, studioMeBody } from '@/test/studio-me'

/**
 * `/studio/portfolio` (R7.2) through the real routes: the list with its
 * count, add by link (and the limit), caption edits, removal after a
 * confirmation, and one-place moves saved with the whole order, focus kept on
 * the moved photo.
 */

const API = '/api/studio/portfolio'
const ONE = portfolioImage(1, 'Golden hour at Kimironko')
const TWO = portfolioImage(2)
const THREE = portfolioImage(3, 'Wedding, Nyamata')

type Handlers = Partial<Record<'add' | 'caption' | 'remove' | 'order', (call: Sent) => Response | Promise<Response>>>

/** A small portfolio API over `start`, behaving like the real one unless a handler says otherwise. */
function stubPortfolio(start: PortfolioImage[] = [ONE, TWO, THREE], handlers: Handlers = {}, limit = 24, load?: () => Response) {
  let images = [...start]
  const api = stubApi((call) => {
    if (call.url === STUDIO_ME_URL) return json(studioMeBody('approved'))
    if (call.method === 'GET' && call.url === API) return load?.() ?? json({ images, limit })
    if (call.method === 'POST' && call.url === API) {
      if (handlers.add !== undefined) return handlers.add(call)
      const body = call.body as { url: string; caption: string | null }
      const image = { ...portfolioImage(9), url: body.url, caption: body.caption, sortOrder: images.length }
      images = [...images, image]
      return json({ image }, 201)
    }
    if (call.method === 'PUT' && call.url === `${API}/order`) {
      if (handlers.order !== undefined) return handlers.order(call)
      const ids = (call.body as { ids: string[] }).ids
      images = ids.map((id, index) => ({ ...(images.find((each) => each.id === id) as PortfolioImage), sortOrder: index }))
      return json({ images })
    }
    const one = new RegExp(`^${API}/([^/]+)$`).exec(call.url)
    if (one !== null && call.method === 'PATCH') {
      if (handlers.caption !== undefined) return handlers.caption(call)
      const caption = (call.body as { caption: string | null }).caption
      images = images.map((each) => (each.id === one[1] ? { ...each, caption } : each))
      return json({ image: images.find((each) => each.id === one[1]) })
    }
    if (one !== null && call.method === 'DELETE') {
      if (handlers.remove !== undefined) return handlers.remove(call)
      images = images.filter((each) => each.id !== one[1])
      return new Response(null, { status: 204 })
    }
    return undefined
  })
  return api
}

function renderPage() {
  saveSession({ token: 'studio.jwt', expiresAt: '2099-01-01T00:00:00.000Z' })
  const router = createMemoryRouter(routes, { initialEntries: ['/studio/portfolio'] })
  render(<RouterProvider router={router} />)
  return router
}

const user = () => userEvent.setup({ delay: null })
const rows = () => [...document.querySelectorAll('[data-portfolio-image]')] as HTMLElement[]
const order = () => rows().map((row) => row.dataset.portfolioImage)
const writes = (api: ReturnType<typeof stubApi>) => api.sent.filter((call) => call.method !== 'GET')

async function loaded() {
  await waitFor(() => expect(document.querySelector('[data-portfolio-count]')).not.toBeNull())
}

afterEach(() => {
  sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the portfolio list', () => {
  it('lists the photos in order with their count, thumbnails sent no referrer, and a word for a missing caption', async () => {
    stubPortfolio()
    renderPage()
    await loaded()

    expect(document.querySelector('[data-portfolio-count]')).toHaveTextContent('3 of 24 photos')
    expect(order()).toEqual([ONE.id, TWO.id, THREE.id])
    const first = screen.getByRole('img', { name: 'Golden hour at Kimironko' })
    expect(first).toHaveAttribute('src', ONE.url)
    expect(first).toHaveAttribute('referrerpolicy', 'no-referrer')
    expect(within(rows()[1] as HTMLElement).getByText('No caption')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'Photo 2' })).toBeInTheDocument()
  })

  it('says when there are no photos yet', async () => {
    stubPortfolio([])
    renderPage()
    await loaded()
    expect(screen.getByText('No photos yet. Add your first one by its link.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a photo' })).toBeEnabled()
  })

  it('shows a photo that will not load as a notice, the row still usable', async () => {
    stubPortfolio()
    renderPage()
    await loaded()

    fireEvent.error(screen.getByRole('img', { name: 'Golden hour at Kimironko' }))
    expect(within(rows()[0] as HTMLElement).getByText('This image could not be loaded.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove photo 1' })).toBeEnabled()
  })

  it('says it is loading, then a failure with Try again, which asks again', async () => {
    let fail = true
    stubPortfolio([ONE], {}, 24, () => (fail ? json({ error: 'internal_error' }, 500) : json({ images: [ONE], limit: 24 })))
    renderPage()

    expect(screen.getByText('Loading your portfolio…')).toBeInTheDocument()
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load your portfolio.')
    fail = false
    await user().click(screen.getByRole('button', { name: 'Try again' }))
    await loaded()
    expect(order()).toEqual([ONE.id])
  })

  it('marks Portfolio current in the nav', async () => {
    stubPortfolio()
    renderPage()
    await loaded()
    expect(within(screen.getByRole('navigation', { name: 'Studio' })).getByRole('link', { name: 'Portfolio' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('adding a photo', () => {
  it('adds by link with an optional caption, previews it, and appends it', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Add a photo' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a photo' })
    await user().type(within(dialog).getByLabelText('Image link'), ' https://images.example/new.jpg ')
    await waitFor(() => expect(within(dialog).getByRole('img', { name: 'Preview' })).toHaveAttribute('src', 'https://images.example/new.jpg'))
    await user().type(within(dialog).getByLabelText('Caption'), '  Engagement shoot  ')
    await user().click(within(dialog).getByRole('button', { name: 'Add photo' }))

    expect(await screen.findByText('Photo added.')).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(api)).toEqual([
      expect.objectContaining({ method: 'POST', url: API, body: { url: 'https://images.example/new.jpg', caption: 'Engagement shoot' } }),
    ])
    expect(rows()).toHaveLength(4)
    expect(document.querySelector('[data-portfolio-count]')).toHaveTextContent('4 of 24 photos')
  })

  it('refuses a link that is not https, or a caption past 200, before sending', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Add a photo' }))
    const dialog = await screen.findByRole('dialog')
    await user().type(within(dialog).getByLabelText('Image link'), 'http://images.example/new.jpg')
    fireEvent.change(within(dialog).getByLabelText('Caption'), { target: { value: 'x'.repeat(201) } })
    await user().click(within(dialog).getByRole('button', { name: 'Add photo' }))

    expect(within(dialog).getByLabelText('Image link')).toHaveAttribute('aria-invalid', 'true')
    expect(within(dialog).getByLabelText('Caption')).toHaveAttribute('aria-invalid', 'true')
    expect(writes(api)).toHaveLength(0)
  })

  it('puts the fields a 422 names on them, and keeps the dialog open', async () => {
    stubPortfolio(undefined, { add: () => json({ error: 'validation_failed', fields: ['url'] }, 422) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Add a photo' }))
    const dialog = await screen.findByRole('dialog')
    await user().type(within(dialog).getByLabelText('Image link'), 'https://images.example/new.jpg')
    await user().click(within(dialog).getByRole('button', { name: 'Add photo' }))

    await waitFor(() => expect(within(dialog).getByLabelText('Image link')).toHaveAttribute('aria-invalid', 'true'))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('says a failure inside the dialog, and lets him try again', async () => {
    stubPortfolio(undefined, { add: () => json({ error: 'internal_error' }, 500) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Add a photo' }))
    const dialog = await screen.findByRole('dialog')
    await user().type(within(dialog).getByLabelText('Image link'), 'https://images.example/new.jpg')
    await user().click(within(dialog).getByRole('button', { name: 'Add photo' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not save.')
    expect(within(dialog).getByRole('button', { name: 'Add photo' })).toBeEnabled()
  })

  it('disables Add at the limit, saying why', async () => {
    const full = Array.from({ length: 24 }, (_, index) => ({ ...portfolioImage(1), id: `id-${index}`, sortOrder: index }))
    stubPortfolio(full)
    renderPage()
    await loaded()

    expect(document.querySelector('[data-portfolio-count]')).toHaveTextContent('24 of 24 photos')
    const add = screen.getByRole('button', { name: 'Add a photo' })
    expect(add).toBeDisabled()
    expect(add).toHaveAccessibleDescription('Your portfolio is full. Remove a photo to add another.')
  })

  it('on 409 portfolio_full (filled elsewhere) closes, reloads and says so', async () => {
    const api = stubPortfolio(undefined, { add: () => json({ error: 'portfolio_full', limit: 24 }, 409) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Add a photo' }))
    const dialog = await screen.findByRole('dialog')
    await user().type(within(dialog).getByLabelText('Image link'), 'https://images.example/new.jpg')
    await user().click(within(dialog).getByRole('button', { name: 'Add photo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your portfolio is already full, so the photo was not added.')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(api.sent.filter((call) => call.method === 'GET' && call.url === API)).toHaveLength(2))
  })
})

describe('captions and removal', () => {
  it('edits a caption, a blank one clearing it', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Edit the caption of photo 1' }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit the caption' })
    expect(within(dialog).getByLabelText('Caption')).toHaveValue('Golden hour at Kimironko')
    await user().clear(within(dialog).getByLabelText('Caption'))
    await user().click(within(dialog).getByRole('button', { name: 'Save caption' }))

    expect(await screen.findByText('Caption saved.')).toBeInTheDocument()
    expect(writes(api)).toEqual([expect.objectContaining({ method: 'PATCH', url: `${API}/${ONE.id}`, body: { caption: null } })])
    expect(within(rows()[0] as HTMLElement).getByText('No caption')).toBeInTheDocument()
  })

  it('on a 404 for a caption closes, reloads and says the photo was already removed', async () => {
    stubPortfolio(undefined, { caption: () => json({ error: 'not_found' }, 404) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Edit the caption of photo 2' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save caption' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That photo was already removed.')
  })

  it('removes a photo only after the confirmation', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Remove photo 2' }))
    const dialog = await screen.findByRole('dialog', { name: 'Remove this photo?' })
    expect(writes(api)).toHaveLength(0)
    await user().click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes(api)).toHaveLength(0)

    await user().click(screen.getByRole('button', { name: 'Remove photo 2' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove photo' }))

    expect(await screen.findByText('Photo removed.')).toBeInTheDocument()
    expect(writes(api)).toEqual([expect.objectContaining({ method: 'DELETE', url: `${API}/${TWO.id}` })])
    expect(order()).toEqual([ONE.id, THREE.id])
  })

  it('on a 404 for a removal reloads and says it was already gone', async () => {
    const api = stubPortfolio(undefined, { remove: () => json({ error: 'not_found' }, 404) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Remove photo 1' }))
    await user().click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove photo' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('That photo was already removed.')
    await waitFor(() => expect(api.sent.filter((call) => call.method === 'GET' && call.url === API)).toHaveLength(2))
  })
})

describe('reordering', () => {
  it('disables Move up on the first photo and Move down on the last', async () => {
    stubPortfolio()
    renderPage()
    await loaded()

    expect(screen.getByRole('button', { name: 'Move photo 1 up' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move photo 1 down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Move photo 3 down' })).toBeDisabled()
  })

  it('moves a photo one place, saves the whole order, keeps focus on the moved photo and says where it went', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Move photo 2 down' }))

    await waitFor(() => expect(order()).toEqual([ONE.id, THREE.id, TWO.id]))
    expect(writes(api)).toEqual([expect.objectContaining({ method: 'PUT', url: `${API}/order`, body: { ids: [ONE.id, THREE.id, TWO.id] } })])
    await waitFor(() => expect(screen.getByText('Photo moved to position 3 of 3.')).toBeInTheDocument())
    // Now last, its Move down is disabled: focus falls to its Move up.
    expect(screen.getByRole('button', { name: 'Move photo 3 up' })).toHaveFocus()
  })

  it('works from the keyboard', async () => {
    const api = stubPortfolio()
    renderPage()
    await loaded()

    screen.getByRole('button', { name: 'Move photo 3 up' }).focus()
    await user().keyboard('{Enter}')
    await waitFor(() => expect(order()).toEqual([ONE.id, THREE.id, TWO.id]))
    // The moved photo is now photo 2; focus stayed on its Move up.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Move photo 2 up' })).toHaveFocus())
    await user().keyboard('{Enter}')
    await waitFor(() => expect(order()).toEqual([THREE.id, ONE.id, TWO.id]))
    expect(writes(api)).toHaveLength(2)
  })

  it('on a 422 (the set changed elsewhere) reloads the list and says so', async () => {
    const api = stubPortfolio(undefined, { order: () => json({ error: 'validation_failed', fields: ['ids'] }, 422) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Move photo 1 down' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Your portfolio changed somewhere else, so it has been reloaded.')
    await waitFor(() => expect(order()).toEqual([ONE.id, TWO.id, THREE.id]))
    expect(api.sent.filter((call) => call.method === 'GET' && call.url === API)).toHaveLength(2)
  })

  it('on a failure puts the old order back and says so', async () => {
    stubPortfolio(undefined, { order: () => json({ error: 'internal_error' }, 500) })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Move photo 1 down' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the new order.')
    expect(order()).toEqual([ONE.id, TWO.id, THREE.id])
  })

  it('ignores a second move while the first is saving', async () => {
    let release: () => void = () => {}
    const api = stubPortfolio(undefined, {
      order: (call) =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json({ images: (call.body as { ids: string[] }).ids.map((id) => [ONE, TWO, THREE].find((each) => each.id === id)) }))
        }),
    })
    renderPage()
    await loaded()

    await user().click(screen.getByRole('button', { name: 'Move photo 1 down' }))
    await user().click(screen.getByRole('button', { name: 'Move photo 3 up' }))
    expect(writes(api)).toHaveLength(1)
    release()
    await waitFor(() => expect(screen.getByText('Photo moved to position 2 of 3.')).toBeInTheDocument())
  })
})
