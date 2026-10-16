import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { RouterProvider, createMemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@/i18n'
import type { AdminAddon, AdminPackage, CatalogueData, CatalogueService, DurationWarning } from '@/admin/catalogue'
import { readSession, saveSession } from '@/admin/session'
import { routes } from '@/routes'

/**
 * The catalogue CMS page (plan.md Task 10; spec §3.4, §6.8, §6.14), rendered
 * through the real routes with `fetch` stubbed.
 *
 * What is proven: every row renders with its status and RWF price; each save
 * sends exactly the form's payload -- never a French field (plan.md Task 10:
 * FR fields exist in the schema and are not rendered) -- then refetches; the
 * API's refusals land on the right field or as the right message; and the §6.8
 * warning appears under the package after the save that earned it.
 */

const NOW = new Date('2026-10-07T08:00:00.000Z')
const TOKEN = 'header.payload.signature'
const CATALOGUE_API = '/api/admin/catalogue'

// --- Fixtures ---------------------------------------------------------------

const STANDARD: AdminPackage = {
  id: 'p1',
  serviceId: 's1',
  nameEn: 'Standard',
  nameFr: 'Formule standard',
  descriptionEn: 'One look, one location.',
  descriptionFr: 'Un look, un lieu.',
  priceRwf: 40_000,
  photoCount: 20,
  durationMinutes: 60,
  isActive: true,
  sortOrder: 0,
}

const RETIRED: AdminPackage = {
  ...STANDARD,
  id: 'p2',
  nameEn: 'Retired',
  nameFr: null,
  descriptionEn: null,
  descriptionFr: null,
  priceRwf: 1_250_000,
  photoCount: 1,
  durationMinutes: 90,
  isActive: false,
  sortOrder: 1,
}

const EXTRA_HOUR: AdminAddon = {
  id: 'a1',
  serviceId: 's1',
  nameEn: 'Extra hour',
  nameFr: 'Heure supplémentaire',
  priceRwf: 15_000,
  isActive: true,
  sortOrder: 0,
}

const RUSH_EDIT: AdminAddon = {
  id: 'a2',
  serviceId: null,
  nameEn: 'Rush edit',
  nameFr: 'Retouche express',
  priceRwf: 5_000,
  isActive: false,
  sortOrder: 3,
}

const PORTRAITS: CatalogueService = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  nameFr: 'Portraits en français',
  descriptionEn: 'Studio portraits.',
  descriptionFr: 'Portraits en studio.',
  coverImageUrl: 'https://images.example.com/portraits.jpg',
  bookingFeeRateOverride: null,
  isActive: true,
  sortOrder: 0,
  packages: [STANDARD, RETIRED],
  addons: [EXTRA_HOUR],
}

const EVENTS: CatalogueService = {
  id: 's2',
  slug: 'corporate-events',
  nameEn: 'Corporate events',
  nameFr: 'Événements',
  descriptionEn: null,
  descriptionFr: 'Conférences.',
  coverImageUrl: null,
  bookingFeeRateOverride: 0.375,
  isActive: false,
  sortOrder: 1,
  packages: [],
  addons: [],
}

const CATALOGUE: CatalogueData = { services: [PORTRAITS, EVENTS], sharedAddons: [RUSH_EDIT] }

const FRENCH_TEXT = [
  'Portraits en français',
  'Portraits en studio.',
  'Événements',
  'Conférences.',
  'Formule standard',
  'Un look, un lieu.',
  'Heure supplémentaire',
  'Retouche express',
]

type Sent = { method: string; url: string; body: unknown }
type Route = (sent: Sent) => Response | Promise<Response>

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * A `fetch` for the admin API. The catalogue GET answers `api.catalogue`,
 * which a route may replace; `routes` answers `"METHOD /path"`; anything else
 * succeeds the way the API would.
 */
function stubApi(routes: Record<string, Route> = {}, catalogue: CatalogueData = CATALOGUE) {
  const api = { catalogue, sent: [] as Sent[] }
  const mock = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const sent: Sent = {
      method: init.method ?? 'GET',
      url: String(input),
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    api.sent.push(sent)
    const route = routes[`${sent.method} ${sent.url}`]
    if (route !== undefined) return route(sent)
    if (sent.method === 'GET' && sent.url === CATALOGUE_API) return json(api.catalogue)
    if (sent.method === 'GET' && sent.url.startsWith('/api/admin/calendar')) return json({ bookings: [], blocks: [] })
    if (sent.method === 'DELETE') return new Response(null, { status: 204 })
    if (sent.url.startsWith('/api/admin/packages')) {
      return json({ package: { ...STANDARD, id: sent.url.split('/')[4] ?? 'p-new' }, warning: null })
    }
    return json({})
  })
  vi.stubGlobal('fetch', mock)
  return api
}

type Api = ReturnType<typeof stubApi>

/** Every write the page sent, in order. */
function writes(api: Api): Sent[] {
  return api.sent.filter((sent) => sent.method !== 'GET')
}

function catalogueLoads(api: Api): number {
  return api.sent.filter((sent) => sent.method === 'GET' && sent.url === CATALOGUE_API).length
}

function signIn() {
  saveSession({ token: TOKEN, expiresAt: '2026-10-07T16:00:00.000Z' })
}

function renderAt(path = '/admin/catalogue') {
  const router = createMemoryRouter(routes, { initialEntries: [path] })
  render(<RouterProvider router={router} />)
  return router
}

function user() {
  return userEvent.setup({ delay: null })
}

/** Renders the page and waits for the catalogue to arrive. */
async function renderLoaded() {
  const router = renderAt()
  await screen.findByRole('heading', { level: 2, name: 'Portraits Active' })
  return router
}

function serviceCard(name: string): HTMLElement {
  const heading = screen.getByRole('heading', { level: 2, name: new RegExp(`^${name} (Active|Inactive)$`) })
  const card = heading.closest<HTMLElement>('[data-slot="card"]')
  if (card === null) throw new Error(`No card holds ${name}`)
  return card
}

function sharedSection(): HTMLElement {
  const section = screen.getByRole('heading', { level: 3, name: 'Add-ons for every service' }).closest('section')
  if (section === null) throw new Error('No shared add-ons section')
  return section
}

/** The list item of a package or add-on, found by its Edit button. */
function row(name: string): HTMLElement {
  const item = screen.getByRole('button', { name: `Edit ${name}` }).closest('li')
  if (item === null) throw new Error(`No row for ${name}`)
  return item
}

function form(name: string): HTMLElement {
  return screen.getByRole('form', { name })
}

/** Types into labelled inputs, replacing what they held. An empty string just clears. */
async function fill(container: HTMLElement, values: Record<string, string>) {
  const u = user()
  for (const [label, value] of Object.entries(values)) {
    const input = within(container).getByLabelText(label)
    await u.clear(input)
    if (value !== '') await u.type(input, value)
  }
}

function labelsIn(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('label')).map((label) => label.textContent ?? '')
}

/** jsdom has no ResizeObserver; Radix's checkbox measures itself with one. */
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubGlobal('ResizeObserver', NoopResizeObserver)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  sessionStorage.clear()
})

// --- Rendering ---------------------------------------------------------------------

describe('the catalogue', () => {
  it('lists every service with its packages and add-ons, statuses in words and prices in RWF', async () => {
    signIn()
    stubApi()
    await renderLoaded()

    expect(screen.getByRole('heading', { level: 1, name: 'Catalogue' })).toBeInTheDocument()

    const portraits = serviceCard('Portraits')
    expect(portraits).toHaveTextContent('/portraits · Default booking fee · Order 0')
    expect(within(portraits).getAllByRole('listitem')).toHaveLength(3)
    expect(row('Standard')).toHaveTextContent('StandardActive40,000 RWF · 20 photos · 60 min · Order 0')
    expect(row('Retired')).toHaveTextContent('RetiredInactive1,250,000 RWF · 1 photo · 90 min · Order 1')
    expect(row('Extra hour')).toHaveTextContent('Extra hourActive15,000 RWF · Order 0')

    const events = serviceCard('Corporate events')
    expect(within(events).getByRole('heading', { level: 2 })).toHaveTextContent('Corporate events Inactive')
    expect(events).toHaveTextContent('/corporate-events · Booking fee 37.5% · Order 1')
    expect(within(events).getByText('No packages yet.')).toBeInTheDocument()
    expect(within(events).getByText('No add-ons yet.')).toBeInTheDocument()

    expect(sharedSection()).toHaveTextContent('Rush editInactive5,000 RWF · Order 3')
    expect(screen.getByText("Offered alongside every service's own add-ons.")).toBeInTheDocument()
  })

  it('offers Deactivate on active rows and Activate on inactive ones', async () => {
    signIn()
    stubApi()
    await renderLoaded()

    for (const name of ['Deactivate Portraits', 'Activate Corporate events', 'Deactivate Standard', 'Activate Retired', 'Deactivate Extra hour', 'Activate Rush edit']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    for (const name of ['Activate Portraits', 'Deactivate Corporate events', 'Activate Standard', 'Deactivate Retired']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
  })

  it('says so when there are no services yet', async () => {
    signIn()
    stubApi({}, { services: [], sharedAddons: [] })
    renderAt()

    expect(await screen.findByText('No services yet. Add the first one.')).toBeInTheDocument()
    expect(within(sharedSection()).getByText('No add-ons yet.')).toBeInTheDocument()
  })

  it('shows a loading status until the catalogue arrives', async () => {
    signIn()
    let answer: (res: Response) => void = () => {}
    stubApi({ [`GET ${CATALOGUE_API}`]: () => new Promise<Response>((resolve) => (answer = resolve)) })
    renderAt()

    expect(await screen.findByRole('status')).toHaveTextContent('Loading catalogue…')

    answer(json(CATALOGUE))

    expect(await screen.findByRole('heading', { level: 2, name: 'Portraits Active' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

// --- French readiness (plan.md Task 10, spec §7) ---------------------------------------------

describe('French fields', () => {
  it('are never rendered: not in the list, and not as an input on any form', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    const forms: [string, string, string[]][] = [
      ['Add service', 'New service', ['Name', 'URL slug', 'Description', 'Cover image URL', 'Booking fee override (%)', 'Display order', 'Active (visible to clients)']],
      ['Edit Portraits', 'Edit service', ['Name', 'URL slug', 'Description', 'Cover image URL', 'Booking fee override (%)', 'Display order', 'Active (visible to clients)']],
      ['Edit Standard', 'Edit package', ['Name', 'Price (RWF)', 'Photos', 'Duration (minutes)', 'Description', 'Display order', 'Active (visible to clients)']],
      ['Edit Extra hour', 'Edit add-on', ['Name', 'Price (RWF)', 'Display order', 'Active (visible to clients)']],
      ['Edit Rush edit', 'Edit add-on', ['Name', 'Price (RWF)', 'Display order', 'Active (visible to clients)']],
    ]

    for (const text of FRENCH_TEXT) expect(document.body).not.toHaveTextContent(text)

    for (const [opener, title, labels] of forms) {
      await u.click(screen.getByRole('button', { name: opener }))
      const open = form(title)
      expect(labelsIn(open)).toEqual(labels)
      expect(open.querySelectorAll('[name$="Fr"]')).toHaveLength(0)
      expect(open.querySelectorAll('input, textarea')).not.toHaveLength(0)
      for (const text of FRENCH_TEXT) expect(open).not.toHaveTextContent(text)
      await u.click(within(open).getByRole('button', { name: 'Cancel' }))
    }

    await u.click(within(serviceCard('Corporate events')).getByRole('button', { name: 'Add package' }))
    expect(labelsIn(form('New package'))).toEqual(['Name', 'Price (RWF)', 'Photos', 'Duration (minutes)', 'Description', 'Display order', 'Active (visible to clients)'])
    await u.click(within(form('New package')).getByRole('button', { name: 'Cancel' }))

    await u.click(within(sharedSection()).getByRole('button', { name: 'Add add-on' }))
    expect(labelsIn(form('New add-on'))).toEqual(['Name', 'Price (RWF)', 'Display order', 'Active (visible to clients)'])
    expect(document.querySelectorAll('[name$="Fr"]')).toHaveLength(0)
    expect(writes(api)).toEqual([])
  })
})

// --- Services -----------------------------------------------------------------------------------

describe('services', () => {
  it.each<[string, Record<string, string>, boolean, unknown]>([
    [
      'every field filled',
      {
        Name: 'Weddings',
        'URL slug': 'weddings',
        Description: 'Full-day coverage.',
        'Cover image URL': 'https://images.example.com/weddings.jpg',
        'Booking fee override (%)': '37.5',
        'Display order': '2',
      },
      true,
      {
        nameEn: 'Weddings',
        slug: 'weddings',
        descriptionEn: 'Full-day coverage.',
        coverImageUrl: 'https://images.example.com/weddings.jpg',
        bookingFeeRateOverride: 0.375,
        sortOrder: 2,
        isActive: true,
      },
    ],
    [
      'only the required fields, unticked',
      { Name: ' Weddings ', 'URL slug': 'weddings' },
      false,
      {
        nameEn: 'Weddings',
        slug: 'weddings',
        descriptionEn: null,
        coverImageUrl: null,
        bookingFeeRateOverride: null,
        sortOrder: 0,
        isActive: false,
      },
    ],
  ])('creates a service from %s, POSTing exactly the form’s payload, then refetches', async (_label, values, active, payload) => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Add service' }))
    const newService = form('New service')
    expect(screen.queryByRole('button', { name: 'Add service' })).not.toBeInTheDocument()
    expect(within(newService).getByRole('checkbox', { name: 'Active (visible to clients)' })).toBeChecked()
    await fill(newService, values)
    if (!active) await u.click(within(newService).getByRole('checkbox', { name: 'Active (visible to clients)' }))
    await u.click(within(newService).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([{ method: 'POST', url: '/api/admin/services', body: payload }])
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add service' })).toBeInTheDocument()
  })

  it('edits a service prefilled from its row, PATCHing only the form’s fields and never its French', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Edit Corporate events' }))
    const edit = form('Edit service')
    expect(within(edit).getByLabelText('Name')).toHaveValue('Corporate events')
    expect(within(edit).getByLabelText('URL slug')).toHaveValue('corporate-events')
    expect(within(edit).getByLabelText('Description')).toHaveValue('')
    expect(within(edit).getByLabelText('Booking fee override (%)')).toHaveValue('37.5')
    expect(within(edit).getByLabelText('Display order')).toHaveValue('1')
    expect(within(edit).getByRole('checkbox', { name: 'Active (visible to clients)' })).not.toBeChecked()

    await fill(edit, { Name: 'Events', 'Booking fee override (%)': '', 'Cover image URL': 'https://images.example.com/events.jpg' })
    await u.click(within(edit).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([
      {
        method: 'PATCH',
        url: '/api/admin/services/s2',
        body: {
          nameEn: 'Events',
          slug: 'corporate-events',
          descriptionEn: null,
          coverImageUrl: 'https://images.example.com/events.jpg',
          bookingFeeRateOverride: null,
          sortOrder: 1,
          isActive: false,
        },
      },
    ])
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  // Forms open in a modal (2026-09-27): while one is open the page behind it
  // is out of reach, so a second form cannot open over it.
  it('closes a form on Cancel without sending anything, and keeps one form open at a time', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Add service' }))
    expect(screen.getByRole('dialog', { name: 'New service' })).toContainElement(form('New service'))
    expect(screen.queryByRole('button', { name: 'Edit Standard' })).not.toBeInTheDocument()
    await u.click(within(form('New service')).getByRole('button', { name: 'Cancel' }))

    await u.click(screen.getByRole('button', { name: 'Edit Standard' }))
    expect(screen.getAllByRole('form')).toHaveLength(1)
    expect(form('Edit package')).toBeInTheDocument()

    await u.click(within(form('Edit package')).getByRole('button', { name: 'Cancel' }))

    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(writes(api)).toEqual([])
    expect(catalogueLoads(api)).toBe(1)
  })

  it('closes a form on Escape too, and gives focus back to the button that opened it', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    const add = screen.getByRole('button', { name: 'Add service' })
    await u.click(add)
    expect(form('New service')).toBeInTheDocument()
    await u.keyboard('{Escape}')

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(add).toHaveFocus()
    expect(writes(api)).toEqual([])
  })
})

// --- Activate and deactivate ------------------------------------------------------------------------

describe('activate and deactivate', () => {
  it.each<[string, string, unknown]>([
    ['Deactivate Portraits', '/api/admin/services/s1', { isActive: false }],
    ['Activate Corporate events', '/api/admin/services/s2', { isActive: true }],
    ['Deactivate Standard', '/api/admin/packages/p1', { isActive: false }],
    ['Activate Retired', '/api/admin/packages/p2', { isActive: true }],
    ['Deactivate Extra hour', '/api/admin/addons/a1', { isActive: false }],
    ['Activate Rush edit', '/api/admin/addons/a2', { isActive: true }],
  ])('%s PATCHes that one field, then refetches', async (button, url, body) => {
    signIn()
    const api = stubApi()
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: button }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([{ method: 'PATCH', url, body }])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the action error when a toggle fails, and clears it on the next success', async () => {
    signIn()
    let calls = 0
    stubApi({ 'PATCH /api/admin/services/s1': () => (++calls === 1 ? json({ error: 'internal_error' }, 500) : json({})) })
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Deactivate Portraits' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("That change didn't save. Try again.")

    await u.click(screen.getByRole('button', { name: 'Deactivate Portraits' }))

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
})

// --- Packages and add-ons ---------------------------------------------------------------------------

describe('packages', () => {
  it('creates a package under its own service', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(within(serviceCard('Corporate events')).getByRole('button', { name: 'Add package' }))
    const newPackage = form('New package')
    await fill(newPackage, { Name: 'Half day', 'Price (RWF)': '250000', Photos: '80', 'Duration (minutes)': '240' })
    await u.click(within(newPackage).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([
      {
        method: 'POST',
        url: '/api/admin/packages',
        body: {
          nameEn: 'Half day',
          descriptionEn: null,
          priceRwf: 250_000,
          photoCount: 80,
          durationMinutes: 240,
          sortOrder: 0,
          isActive: true,
          serviceId: 's2',
        },
      },
    ])
  })

  it('edits a package prefilled from its row, PATCHing without its service or French', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Edit Standard' }))
    const edit = form('Edit package')
    expect(within(edit).getByLabelText('Price (RWF)')).toHaveValue('40000')
    expect(within(edit).getByLabelText('Description')).toHaveValue('One look, one location.')
    await fill(edit, { 'Price (RWF)': '55000', 'Display order': '4' })
    await u.click(within(edit).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([
      {
        method: 'PATCH',
        url: '/api/admin/packages/p1',
        body: {
          nameEn: 'Standard',
          descriptionEn: 'One look, one location.',
          priceRwf: 55_000,
          photoCount: 20,
          durationMinutes: 60,
          sortOrder: 4,
          isActive: true,
        },
      },
    ])
  })
})

describe('add-ons', () => {
  it.each<[string, () => HTMLElement, string | null]>([
    ['a service', () => serviceCard('Portraits'), 's1'],
    ['every service', sharedSection, null],
  ])('creates an add-on for %s', async (_label, container, serviceId) => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    // The form opens in a dialog (2026-09-27); which list it belongs to shows in the POST's scope.
    await u.click(within(container()).getByRole('button', { name: 'Add add-on' }))
    const newAddon = form('New add-on')
    expect(screen.getByRole('dialog', { name: 'New add-on' })).toContainElement(newAddon)
    await fill(newAddon, { Name: 'Printed album', 'Price (RWF)': '25000', 'Display order': '1' })
    await u.click(within(newAddon).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([
      {
        method: 'POST',
        url: '/api/admin/addons',
        body: { nameEn: 'Printed album', priceRwf: 25_000, sortOrder: 1, isActive: true, serviceId },
      },
    ])
  })

  it('edits a shared add-on, PATCHing without its scope or French', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Edit Rush edit' }))
    const edit = form('Edit add-on')
    await u.click(within(edit).getByRole('checkbox', { name: 'Active (visible to clients)' }))
    await u.click(within(edit).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(writes(api)).toEqual([
      { method: 'PATCH', url: '/api/admin/addons/a2', body: { nameEn: 'Rush edit', priceRwf: 5_000, sortOrder: 3, isActive: true } },
    ])
  })
})

// --- Delete ---------------------------------------------------------------------------------------------

describe('delete', () => {
  it.each<[string, string, string]>([
    ['Portraits', '/api/admin/services/s1', 'Delete Portraits? This cannot be undone.'],
    ['Standard', '/api/admin/packages/p1', 'Delete Standard? This cannot be undone.'],
    ['Extra hour', '/api/admin/addons/a1', 'Delete Extra hour? This cannot be undone.'],
    ['Rush edit', '/api/admin/addons/a2', 'Delete Rush edit? This cannot be undone.'],
  ])('deletes %s after confirming, then refetches', async (name, url, question) => {
    signIn()
    const api = stubApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: `Delete ${name}` }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(2))
    expect(confirm).toHaveBeenCalledExactlyOnceWith(question)
    expect(writes(api)).toEqual([{ method: 'DELETE', url, body: undefined }])
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    signIn()
    const api = stubApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Delete Standard' }))

    expect(confirm).toHaveBeenCalledOnce()
    expect(writes(api)).toEqual([])
    expect(catalogueLoads(api)).toBe(1)
    expect(row('Standard')).toBeInTheDocument()
  })

  it('explains a 409 in_use and suggests deactivating, keeping the row', async () => {
    signIn()
    const api = stubApi({ 'DELETE /api/admin/packages/p1': () => json({ error: 'in_use' }, 409) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Delete Standard' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "That can't be deleted because bookings or packages still use it. Deactivate it instead.",
    )
    expect(row('Standard')).toBeInTheDocument()
    expect(catalogueLoads(api)).toBe(1)
  })

  it('shows the generic action error for any other failure', async () => {
    signIn()
    stubApi({ 'DELETE /api/admin/addons/a1': () => Promise.reject(new TypeError('Failed to fetch')) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await renderLoaded()

    await user().click(screen.getByRole('button', { name: 'Delete Extra hour' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("That change didn't save. Try again.")
  })
})

// --- Validation --------------------------------------------------------------------------------------------

describe('form validation', () => {
  it('marks the fields the schema refuses, describes each, and sends nothing until they are fixed', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Add service' }))
    const newService = form('New service')
    await fill(newService, {
      'URL slug': 'Corporate Events',
      Description: 'Conferences.',
      'Cover image URL': 'http://images.example.com/events.jpg',
      'Booking fee override (%)': '150',
      'Display order': '-1',
    })
    await u.click(within(newService).getByRole('button', { name: 'Create' }))

    const expected: [string, string][] = [
      ['Name', 'Enter a name, up to 200 characters.'],
      ['URL slug', 'Use lowercase letters, numbers and single hyphens.'],
      ['Cover image URL', 'Enter a full https:// link, or leave it blank.'],
      ['Booking fee override (%)', 'Enter a percentage from 0 to 100, with one decimal place at most.'],
      ['Display order', 'Enter a whole number, 0 or more.'],
    ]
    for (const [label, message] of expected) {
      const input = within(newService).getByLabelText(label)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(input).toHaveAccessibleDescription(message)
    }
    expect(within(newService).getByLabelText('Description')).not.toHaveAttribute('aria-invalid')
    expect(writes(api)).toEqual([])

    await fill(newService, {
      Name: 'Events',
      'URL slug': 'events',
      'Cover image URL': '',
      'Booking fee override (%)': '100',
      'Display order': '0',
    })
    await u.click(within(newService).getByRole('button', { name: 'Create' }))

    await waitFor(() => expect(writes(api)).toHaveLength(1))
    expect(writes(api)[0]?.body).toMatchObject({ nameEn: 'Events', slug: 'events', bookingFeeRateOverride: 1, coverImageUrl: null })
  })

  it('marks refused numbers on the package form', async () => {
    signIn()
    const api = stubApi()
    await renderLoaded()
    const u = user()

    await u.click(within(serviceCard('Portraits')).getByRole('button', { name: 'Add package' }))
    const newPackage = form('New package')
    await fill(newPackage, { Name: 'Full day', 'Price (RWF)': '40,000', Photos: '2.5', 'Duration (minutes)': '0' })
    await u.click(within(newPackage).getByRole('button', { name: 'Create' }))

    expect(within(newPackage).getByLabelText('Price (RWF)')).toHaveAccessibleDescription('Enter a whole number of RWF, 0 or more.')
    expect(within(newPackage).getByLabelText('Photos')).toHaveAccessibleDescription('Enter a whole number, 0 or more.')
    expect(within(newPackage).getByLabelText('Duration (minutes)')).toHaveAccessibleDescription(
      'Enter a whole number of minutes, at least 1.',
    )
    expect(within(newPackage).getByLabelText('Name')).not.toHaveAttribute('aria-invalid')
    expect(writes(api)).toEqual([])
  })

  it('marks the fields a 422 names, the fee rate on its percentage input, and keeps the form open', async () => {
    signIn()
    const api = stubApi({
      'POST /api/admin/services': () => json({ error: 'validation_failed', fields: ['bookingFeeRateOverride', 'coverImageUrl'] }, 422),
    })
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Add service' }))
    const newService = form('New service')
    await fill(newService, { Name: 'Events', 'URL slug': 'events', 'Booking fee override (%)': '30' })
    await u.click(within(newService).getByRole('button', { name: 'Create' }))

    await waitFor(() =>
      expect(within(newService).getByLabelText('Booking fee override (%)')).toHaveAttribute('aria-invalid', 'true'),
    )
    expect(within(newService).getByLabelText('Cover image URL')).toHaveAttribute('aria-invalid', 'true')
    expect(within(newService).getByLabelText('Name')).not.toHaveAttribute('aria-invalid')
    expect(within(newService).queryByRole('alert')).not.toBeInTheDocument()
    expect(within(newService).getByRole('button', { name: 'Create' })).toBeEnabled()
    expect(writes(api)).toHaveLength(1)
    expect(catalogueLoads(api)).toBe(1)
  })

  it('marks the slug when another service has it', async () => {
    signIn()
    stubApi({ 'PATCH /api/admin/services/s2': () => json({ error: 'slug_taken' }, 409) })
    await renderLoaded()
    const u = user()

    await u.click(screen.getByRole('button', { name: 'Edit Corporate events' }))
    const edit = form('Edit service')
    await fill(edit, { 'URL slug': 'portraits' })
    await u.click(within(edit).getByRole('button', { name: 'Save' }))

    const slug = within(edit).getByLabelText('URL slug')
    await waitFor(() => expect(slug).toHaveAttribute('aria-invalid', 'true'))
    expect(slug).toHaveAccessibleDescription('Another service already uses this slug.')
    expect(form('Edit service')).toBeInTheDocument()
  })

  it.each<[string, string, Route]>([
    ['a 422 naming a field the form does not have', 'POST /api/admin/packages', () => json({ error: 'validation_failed', fields: ['serviceId'] }, 422)],
    ['a 500', 'POST /api/admin/packages', () => json({ error: 'internal_error' }, 500)],
    ['a 409 that is not a taken slug', 'POST /api/admin/packages', () => json({ error: 'in_use' }, 409)],
    ['a network failure', 'POST /api/admin/packages', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('shows a form-level alert for %s, marking no field', async (_label, key, route) => {
    signIn()
    stubApi({ [key]: route })
    await renderLoaded()
    const u = user()

    await u.click(within(serviceCard('Portraits')).getByRole('button', { name: 'Add package' }))
    const newPackage = form('New package')
    await fill(newPackage, { Name: 'Full day', 'Price (RWF)': '90000', Photos: '60', 'Duration (minutes)': '480' })
    await u.click(within(newPackage).getByRole('button', { name: 'Create' }))

    expect(await within(newPackage).findByRole('alert')).toHaveTextContent('Could not save. Try again.')
    expect(newPackage.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0)
  })

  it('shows Saving… and disables the button while the save is in flight', async () => {
    signIn()
    let answer: (res: Response) => void = () => {}
    stubApi({ 'POST /api/admin/addons': () => new Promise<Response>((resolve) => (answer = resolve)) })
    await renderLoaded()
    const u = user()

    await u.click(within(sharedSection()).getByRole('button', { name: 'Add add-on' }))
    const newAddon = form('New add-on')
    await fill(newAddon, { Name: 'Prints', 'Price (RWF)': '2000' })
    await u.click(within(newAddon).getByRole('button', { name: 'Create' }))

    expect(await within(newAddon).findByRole('button', { name: 'Saving…' })).toBeDisabled()

    answer(json({}))

    await waitFor(() => expect(screen.queryByRole('form')).not.toBeInTheDocument())
  })
})

// --- Duration warning (spec §6.8) ---------------------------------------------------------------------------

describe('the duration warning (spec §6.8)', () => {
  const FULL_DAY: AdminPackage = { ...STANDARD, id: 'p9', nameEn: 'Full day', nameFr: null, durationMinutes: 600 }
  const WITH_FULL_DAY: CatalogueData = { ...CATALOGUE, services: [{ ...PORTRAITS, packages: [STANDARD, RETIRED, FULL_DAY] }, EVENTS] }

  it.each<[string, DurationWarning, string]>([
    [
      'the longest open window',
      { code: 'duration_exceeds_longest_window', longestWindow: { opensMinute: 540, closesMinute: 1020 } },
      'Full day lasts 600 min, longer than the longest open day (09:00–17:00, 480 min). Clients will never find a slot for it.',
    ],
    [
      'no open day at all',
      { code: 'duration_exceeds_longest_window', longestWindow: null },
      'Full day is saved, but no day is open at all, so clients will never find a slot for it.',
    ],
  ])('appears under the package saved past %s, and goes once a save fits', async (_label, warning, text) => {
    signIn()
    const api = stubApi({
      'POST /api/admin/packages': () => {
        api.catalogue = WITH_FULL_DAY
        return json({ package: FULL_DAY, warning }, 201)
      },
      'PATCH /api/admin/packages/p9': () => {
        api.catalogue = { ...CATALOGUE, services: [{ ...PORTRAITS, packages: [STANDARD, RETIRED, { ...FULL_DAY, durationMinutes: 480 }] }, EVENTS] }
        return json({ package: { ...FULL_DAY, durationMinutes: 480 }, warning: null })
      },
    })
    await renderLoaded()
    const u = user()

    await u.click(within(serviceCard('Portraits')).getByRole('button', { name: 'Add package' }))
    const newPackage = form('New package')
    await fill(newPackage, { Name: 'Full day', 'Price (RWF)': '40000', Photos: '20', 'Duration (minutes)': '600' })
    await u.click(within(newPackage).getByRole('button', { name: 'Create' }))

    const alert = await within(await waitFor(() => row('Full day'))).findByRole('alert')
    expect(alert).toHaveTextContent(text)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(within(row('Standard')).queryByRole('alert')).not.toBeInTheDocument()

    await u.click(screen.getByRole('button', { name: 'Edit Full day' }))
    const edit = form('Edit package')
    await fill(edit, { 'Duration (minutes)': '480' })
    await u.click(within(edit).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(catalogueLoads(api)).toBe(3))
    expect(within(row('Full day')).queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})

// --- Loading, failure and auth --------------------------------------------------------------------------------

describe('loading and auth', () => {
  it.each<[string, () => Response | Promise<Response>]>([
    ['a 500', () => json({ error: 'internal_error' }, 500)],
    ['a network failure', () => Promise.reject(new TypeError('Failed to fetch'))],
  ])('on %s shows an error whose Try again refetches', async (_label, fail) => {
    signIn()
    let calls = 0
    const api = stubApi({ [`GET ${CATALOGUE_API}`]: () => (++calls === 1 ? fail() : json(CATALOGUE)) })
    renderAt()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Could not load the catalogue.')
    expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument()

    await user().click(within(alert).getByRole('button', { name: 'Try again' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Portraits Active' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(catalogueLoads(api)).toBe(2)
    expect(readSession()).not.toBeNull()
  })

  it('sends the stored token as a bearer header', async () => {
    signIn()
    stubApi()
    await renderLoaded()

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? []
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`)
  })

  it('on a 401 while loading forgets the session and sends him to sign in', async () => {
    signIn()
    stubApi({ [`GET ${CATALOGUE_API}`]: () => json({ error: 'unauthenticated' }, 401) })
    const router = renderAt()

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/login')
    expect(readSession()).toBeNull()
  })

  it.each<[string, string, (u: ReturnType<typeof user>) => Promise<void>]>([
    [
      'a save',
      'PATCH /api/admin/services/s1',
      async (u) => {
        await u.click(screen.getByRole('button', { name: 'Edit Portraits' }))
        await u.click(within(form('Edit service')).getByRole('button', { name: 'Save' }))
      },
    ],
    ['a toggle', 'PATCH /api/admin/services/s1', (u) => u.click(screen.getByRole('button', { name: 'Deactivate Portraits' }))],
    ['a delete', 'DELETE /api/admin/services/s1', (u) => u.click(screen.getByRole('button', { name: 'Delete Portraits' }))],
  ])('on a 401 from %s sends him to sign in', async (_label, key, act) => {
    signIn()
    stubApi({ [key]: () => json({ error: 'unauthenticated' }, 401) })
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    const router = await renderLoaded()

    await act(user())

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/login')
    expect(readSession()).toBeNull()
  })

  it('sends a signed-out visitor to sign in without requesting the catalogue', async () => {
    const api = stubApi()
    const router = renderAt()

    expect(await screen.findByRole('heading', { name: 'Admin sign in' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/login')
    expect(api.sent).toEqual([])
  })
})

// --- Admin navigation ------------------------------------------------------------------------------------------------

describe('the admin navigation', () => {
  it('moves between Calendar and Catalogue, marking the current page', async () => {
    signIn()
    stubApi()
    const router = await renderLoaded()
    const u = user()
    const nav = screen.getByRole('navigation', { name: 'Admin' })

    expect(within(nav).getByRole('link', { name: 'Catalogue' })).toHaveAttribute('aria-current', 'page')
    expect(within(nav).getByRole('link', { name: 'Calendar' })).not.toHaveAttribute('aria-current')

    await u.click(within(nav).getByRole('link', { name: 'Calendar' }))

    expect(await screen.findByRole('heading', { level: 1, name: 'Calendar' })).toBeInTheDocument()
    expect(await screen.findByRole('heading', { level: 2, name: 'October 2026' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/calendar')
    expect(within(nav).getByRole('link', { name: 'Calendar' })).toHaveAttribute('aria-current', 'page')

    await u.click(within(nav).getByRole('link', { name: 'Catalogue' }))

    expect(await screen.findByRole('heading', { level: 2, name: 'Portraits Active' })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/admin/catalogue')
  })
})
