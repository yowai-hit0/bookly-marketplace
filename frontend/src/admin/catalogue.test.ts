import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type AdminAddon,
  type AdminPackage,
  type AdminService,
  addonFormSchema,
  addonFormValues,
  catalogueApi,
  formatMinuteOfDay,
  packageFormSchema,
  packageFormValues,
  serviceFormSchema,
  serviceFormValues,
} from './catalogue'
import { saveSession } from './session'

/**
 * The catalogue CMS's form schemas, form values and API calls (plan.md
 * Task 10). The schemas turn what he types into the payload the API takes;
 * the API revalidates everything, so these are asserted for conversion and
 * for naming the wrong field, not as the authority.
 */

const SERVICE: AdminService = {
  id: 's1',
  slug: 'portraits',
  nameEn: 'Portraits',
  nameFr: 'Portraits FR',
  descriptionEn: 'Studio portraits.',
  descriptionFr: 'Portraits en studio.',
  coverImageUrl: 'https://images.example.com/portraits.jpg',
  bookingFeeRateOverride: 0.375,
  isActive: false,
  sortOrder: 3,
}

const PACKAGE: AdminPackage = {
  id: 'p1',
  serviceId: 's1',
  nameEn: 'Standard',
  nameFr: 'Standard FR',
  descriptionEn: 'One look.',
  descriptionFr: 'Un look.',
  priceRwf: 40_000,
  photoCount: 20,
  durationMinutes: 60,
  isActive: true,
  sortOrder: 1,
}

const ADDON: AdminAddon = {
  id: 'a1',
  serviceId: null,
  nameEn: 'Rush edit',
  nameFr: 'Retouche express',
  priceRwf: 5_000,
  isActive: false,
  sortOrder: 2,
}

const SERVICE_INPUT = {
  nameEn: 'Portraits',
  slug: 'portraits',
  descriptionEn: '',
  coverImageUrl: '',
  bookingFeePercent: '',
  sortOrder: '0',
  isActive: true,
}

const PACKAGE_INPUT = {
  nameEn: 'Standard',
  descriptionEn: '',
  priceRwf: '40000',
  photoCount: '20',
  durationMinutes: '60',
  sortOrder: '0',
  isActive: true,
}

const ADDON_INPUT = { nameEn: 'Rush edit', priceRwf: '5000', sortOrder: '0', isActive: true }

/** The top-level fields a failed parse names, or null when it succeeded. */
function invalidFields(result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }): string[] | null {
  if (result.success) return null
  return [...new Set(result.error?.issues.map((issue) => String(issue.path[0])))]
}

// --- Service form ------------------------------------------------------------------

describe('serviceFormSchema', () => {
  it('turns the form’s strings into the API payload, trimming and nulling blanks', () => {
    expect(
      serviceFormSchema.parse({
        nameEn: '  Portraits ',
        slug: ' portraits ',
        descriptionEn: '   ',
        coverImageUrl: '  ',
        bookingFeePercent: '',
        sortOrder: ' 7 ',
        isActive: false,
      }),
    ).toEqual({
      nameEn: 'Portraits',
      slug: 'portraits',
      descriptionEn: null,
      coverImageUrl: null,
      bookingFeeRateOverride: null,
      sortOrder: 7,
      isActive: false,
    })
  })

  it('accepts an https cover URL whose scheme is written in capitals', () => {
    expect(serviceFormSchema.parse({ ...SERVICE_INPUT, coverImageUrl: 'HTTPS://images.example.com/p.jpg' })).toMatchObject({
      coverImageUrl: 'HTTPS://images.example.com/p.jpg',
    })
  })

  it('keeps a description and an https cover URL', () => {
    expect(
      serviceFormSchema.parse({
        ...SERVICE_INPUT,
        descriptionEn: ' Studio portraits. ',
        coverImageUrl: 'https://images.example.com/portraits.jpg?w=1200',
      }),
    ).toMatchObject({ descriptionEn: 'Studio portraits.', coverImageUrl: 'https://images.example.com/portraits.jpg?w=1200' })
  })

  it.each<[string, number | null]>([
    ['', null],
    ['   ', null],
    ['0', 0],
    ['37.5', 0.375],
    [' 40 ', 0.4],
    ['12.5', 0.125],
    ['33.3', 0.333],
    ['0.1', 0.001],
    ['28.5', 0.285],
    ['100', 1],
    ['100.0', 1],
  ])('reads a booking fee of %j percent as the rate %j', (percent, rate) => {
    const payload = serviceFormSchema.parse({ ...SERVICE_INPUT, bookingFeePercent: percent })

    expect(payload.bookingFeeRateOverride).toBe(rate)
    expect(payload).not.toHaveProperty('bookingFeePercent')
  })

  it.each(['100.1', '101', '1000', '33.33', '-5', '12.', '.5', '1e2', '12.5%', '12,5', 'forty'])(
    'refuses a booking fee of %j percent, naming the field',
    (percent) => {
      expect(invalidFields(serviceFormSchema.safeParse({ ...SERVICE_INPUT, bookingFeePercent: percent }))).toEqual([
        'bookingFeePercent',
      ])
    },
  )

  it.each<[string, Partial<Record<keyof typeof SERVICE_INPUT, string>>, string[]]>([
    ['a blank name', { nameEn: '   ' }, ['nameEn']],
    ['a name over 200 characters', { nameEn: 'n'.repeat(201) }, ['nameEn']],
    ['a blank slug', { slug: '' }, ['slug']],
    ['an uppercase slug', { slug: 'Portraits' }, ['slug']],
    ['a slug with a double hyphen', { slug: 'corporate--events' }, ['slug']],
    ['a slug with a space', { slug: 'corporate events' }, ['slug']],
    ['a slug over 100 characters', { slug: 's'.repeat(101) }, ['slug']],
    ['a description over 5000 characters', { descriptionEn: 'd'.repeat(5001) }, ['descriptionEn']],
    ['an http cover URL', { coverImageUrl: 'http://images.example.com/p.jpg' }, ['coverImageUrl']],
    ['a cover URL that is not a URL', { coverImageUrl: 'images/p.jpg' }, ['coverImageUrl']],
    ['a blank sort order', { sortOrder: '' }, ['sortOrder']],
    ['a negative sort order', { sortOrder: '-1' }, ['sortOrder']],
    ['a fractional sort order', { sortOrder: '1.5' }, ['sortOrder']],
    ['a sort order past int4', { sortOrder: '2147483648' }, ['sortOrder']],
    ['several fields', { nameEn: '', slug: 'Bad Slug', sortOrder: 'x' }, ['nameEn', 'slug', 'sortOrder']],
  ])('refuses %s, naming the fields', (_label, input, fields) => {
    expect(invalidFields(serviceFormSchema.safeParse({ ...SERVICE_INPUT, ...input }))).toEqual(fields)
  })

  it('leaves the French fields out when the form has none, and accepts them when given (plan.md Task 10)', () => {
    const english = serviceFormSchema.parse(SERVICE_INPUT)
    const french = serviceFormSchema.parse({ ...SERVICE_INPUT, nameFr: ' Portraits FR ', descriptionFr: '' })

    expect(english).not.toHaveProperty('nameFr')
    expect(english).not.toHaveProperty('descriptionFr')
    expect(french).toMatchObject({ nameFr: 'Portraits FR', descriptionFr: null })
    expect(invalidFields(serviceFormSchema.safeParse({ ...SERVICE_INPUT, nameFr: 'n'.repeat(201) }))).toEqual(['nameFr'])
  })
})

// --- Package and add-on forms ------------------------------------------------------------

describe('packageFormSchema', () => {
  it('turns the form’s strings into whole numbers', () => {
    expect(
      packageFormSchema.parse({ ...PACKAGE_INPUT, priceRwf: ' 40000 ', descriptionEn: ' One look. ', sortOrder: '2', isActive: false }),
    ).toEqual({
      nameEn: 'Standard',
      descriptionEn: 'One look.',
      priceRwf: 40_000,
      photoCount: 20,
      durationMinutes: 60,
      sortOrder: 2,
      isActive: false,
    })
  })

  it.each<[string, Partial<Record<keyof typeof PACKAGE_INPUT, string>>]>([
    ['a price, photo count and sort order of 0 and a 1-minute duration', { priceRwf: '0', photoCount: '0', sortOrder: '0', durationMinutes: '1' }],
    ['a price at the int4 maximum', { priceRwf: '2147483647' }],
    ['leading zeros', { priceRwf: '0040000' }],
  ])('accepts %s', (_label, input) => {
    expect(packageFormSchema.safeParse({ ...PACKAGE_INPUT, ...input }).success).toBe(true)
  })

  it.each<[string, Partial<Record<keyof typeof PACKAGE_INPUT, string>>, string[]]>([
    ['a blank price', { priceRwf: '' }, ['priceRwf']],
    ['a price with a thousands separator', { priceRwf: '40,000' }, ['priceRwf']],
    ['a price in exponent form', { priceRwf: '4e4' }, ['priceRwf']],
    ['a fractional price', { priceRwf: '40000.5' }, ['priceRwf']],
    ['a negative price', { priceRwf: '-1' }, ['priceRwf']],
    ['a price with a currency', { priceRwf: '40000 RWF' }, ['priceRwf']],
    ['a price past int4', { priceRwf: '2147483648' }, ['priceRwf']],
    ['an 11-digit price', { priceRwf: '10000000000' }, ['priceRwf']],
    ['a blank photo count', { photoCount: '' }, ['photoCount']],
    ['a duration of 0', { durationMinutes: '0' }, ['durationMinutes']],
    ['a blank duration', { durationMinutes: ' ' }, ['durationMinutes']],
    ['a blank name', { nameEn: '' }, ['nameEn']],
    ['several fields', { priceRwf: '-1', durationMinutes: '0' }, ['priceRwf', 'durationMinutes']],
  ])('refuses %s, naming the fields', (_label, input, fields) => {
    expect(invalidFields(packageFormSchema.safeParse({ ...PACKAGE_INPUT, ...input }))).toEqual(fields)
  })

  it('leaves the French fields out when the form has none, and accepts them when given', () => {
    expect(packageFormSchema.parse(PACKAGE_INPUT)).not.toHaveProperty('nameFr')
    expect(packageFormSchema.parse(PACKAGE_INPUT)).not.toHaveProperty('descriptionFr')
    expect(packageFormSchema.parse({ ...PACKAGE_INPUT, nameFr: 'Journée', descriptionFr: ' ' })).toMatchObject({
      nameFr: 'Journée',
      descriptionFr: null,
    })
  })
})

describe('addonFormSchema', () => {
  it('turns the form’s strings into the API payload', () => {
    expect(addonFormSchema.parse({ nameEn: ' Rush edit ', priceRwf: '5000', sortOrder: '4', isActive: true })).toEqual({
      nameEn: 'Rush edit',
      priceRwf: 5_000,
      sortOrder: 4,
      isActive: true,
    })
  })

  it.each<[string, Partial<Record<keyof typeof ADDON_INPUT, string>>, string[]]>([
    ['a blank name', { nameEn: ' ' }, ['nameEn']],
    ['a negative price', { priceRwf: '-5000' }, ['priceRwf']],
    ['a decimal price', { priceRwf: '5000.00' }, ['priceRwf']],
    ['a blank sort order', { sortOrder: '' }, ['sortOrder']],
  ])('refuses %s, naming the fields', (_label, input, fields) => {
    expect(invalidFields(addonFormSchema.safeParse({ ...ADDON_INPUT, ...input }))).toEqual(fields)
  })

  it('leaves nameFr out when the form has none, and accepts it when given', () => {
    expect(addonFormSchema.parse(ADDON_INPUT)).not.toHaveProperty('nameFr')
    expect(addonFormSchema.parse({ ...ADDON_INPUT, nameFr: 'Retouche express' })).toMatchObject({ nameFr: 'Retouche express' })
  })
})

// --- Form values ----------------------------------------------------------------------------

describe('form values', () => {
  it('start a new service, package and add-on blank, active, at display order 0, with no French field', () => {
    expect(serviceFormValues()).toEqual({
      nameEn: '',
      slug: '',
      descriptionEn: '',
      coverImageUrl: '',
      bookingFeePercent: '',
      sortOrder: '0',
      isActive: true,
    })
    expect(packageFormValues()).toEqual({
      nameEn: '',
      descriptionEn: '',
      priceRwf: '',
      photoCount: '',
      durationMinutes: '',
      sortOrder: '0',
      isActive: true,
    })
    expect(addonFormValues()).toEqual({ nameEn: '', priceRwf: '', sortOrder: '0', isActive: true })
  })

  it('fill an edit form from the stored rows, the rate shown as a percentage', () => {
    expect(serviceFormValues(SERVICE)).toEqual({
      nameEn: 'Portraits',
      slug: 'portraits',
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
      bookingFeePercent: '37.5',
      sortOrder: '3',
      isActive: false,
    })
    expect(serviceFormValues({ ...SERVICE, descriptionEn: null, coverImageUrl: null, bookingFeeRateOverride: null })).toMatchObject({
      descriptionEn: '',
      coverImageUrl: '',
      bookingFeePercent: '',
    })
    expect(packageFormValues(PACKAGE)).toEqual({
      nameEn: 'Standard',
      descriptionEn: 'One look.',
      priceRwf: '40000',
      photoCount: '20',
      durationMinutes: '60',
      sortOrder: '1',
      isActive: true,
    })
    expect(addonFormValues(ADDON)).toEqual({ nameEn: 'Rush edit', priceRwf: '5000', sortOrder: '2', isActive: false })
  })

  it.each<[number, string]>([
    [0, '0'],
    [0.001, '0.1'],
    [0.125, '12.5'],
    [0.285, '28.5'],
    [0.3, '30'],
    [0.4, '40'],
    [1, '100'],
  ])('shows the rate %j as %j percent', (rate, percent) => {
    expect(serviceFormValues({ ...SERVICE, bookingFeeRateOverride: rate }).bookingFeePercent).toBe(percent)
  })

  it('round-trips every rate numeric(4,3) can hold through the form unchanged', () => {
    const mismatches: number[] = []
    for (let thousandths = 0; thousandths <= 1000; thousandths++) {
      const rate = thousandths / 1000
      const payload = serviceFormSchema.parse(serviceFormValues({ ...SERVICE, bookingFeeRateOverride: rate }))
      if (payload.bookingFeeRateOverride !== rate) mismatches.push(rate)
    }

    expect(mismatches).toEqual([])
  })

  it('round-trip a stored row to the same payload, never carrying French', () => {
    expect(serviceFormSchema.parse(serviceFormValues(SERVICE))).toEqual({
      nameEn: 'Portraits',
      slug: 'portraits',
      descriptionEn: 'Studio portraits.',
      coverImageUrl: 'https://images.example.com/portraits.jpg',
      bookingFeeRateOverride: 0.375,
      sortOrder: 3,
      isActive: false,
    })
    expect(packageFormSchema.parse(packageFormValues(PACKAGE))).toEqual({
      nameEn: 'Standard',
      descriptionEn: 'One look.',
      priceRwf: 40_000,
      photoCount: 20,
      durationMinutes: 60,
      sortOrder: 1,
      isActive: true,
    })
    expect(addonFormSchema.parse(addonFormValues(ADDON))).toEqual({ nameEn: 'Rush edit', priceRwf: 5_000, sortOrder: 2, isActive: false })
  })

  it('leave a new package or add-on form invalid until its numbers are typed', () => {
    expect(invalidFields(packageFormSchema.safeParse(packageFormValues()))).toEqual([
      'nameEn',
      'priceRwf',
      'photoCount',
      'durationMinutes',
    ])
    expect(invalidFields(addonFormSchema.safeParse(addonFormValues()))).toEqual(['nameEn', 'priceRwf'])
    expect(invalidFields(serviceFormSchema.safeParse(serviceFormValues()))).toEqual(['nameEn', 'slug'])
  })
})

// --- formatMinuteOfDay -------------------------------------------------------------------------

describe('formatMinuteOfDay', () => {
  it.each<[number, string]>([
    [0, '00:00'],
    [5, '00:05'],
    [65, '01:05'],
    [540, '09:00'],
    [1020, '17:00'],
    [1439, '23:59'],
    [1440, '24:00'],
  ])('renders minute %j as %j', (minute, text) => {
    expect(formatMinuteOfDay(minute)).toBe(text)
  })
})

// --- API calls ---------------------------------------------------------------------------------

describe('catalogueApi', () => {
  type Call = [label: string, run: () => Promise<unknown>, method: string, url: string, body: unknown]

  beforeEach(() => {
    saveSession({ token: 'header.payload.signature', expiresAt: '2999-01-01T00:00:00.000Z' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.clear()
  })

  const service = { nameEn: 'Portraits', slug: 'portraits', descriptionEn: null, coverImageUrl: null, bookingFeeRateOverride: null, sortOrder: 0, isActive: true }
  const pkg = { nameEn: 'Standard', descriptionEn: null, priceRwf: 40_000, photoCount: 20, durationMinutes: 60, sortOrder: 0, isActive: true }
  const addon = { nameEn: 'Rush edit', priceRwf: 5_000, sortOrder: 0, isActive: true }

  it.each<Call>([
    ['load', () => catalogueApi.load(), 'GET', '/api/admin/catalogue', undefined],
    ['createService', () => catalogueApi.createService(service), 'POST', '/api/admin/services', service],
    ['updateService', () => catalogueApi.updateService('s1', { isActive: false }), 'PATCH', '/api/admin/services/s1', { isActive: false }],
    ['deleteService', () => catalogueApi.deleteService('s1'), 'DELETE', '/api/admin/services/s1', undefined],
    ['createPackage', () => catalogueApi.createPackage({ ...pkg, serviceId: 's1' }), 'POST', '/api/admin/packages', { ...pkg, serviceId: 's1' }],
    ['updatePackage', () => catalogueApi.updatePackage('p1', { priceRwf: 1 }), 'PATCH', '/api/admin/packages/p1', { priceRwf: 1 }],
    ['deletePackage', () => catalogueApi.deletePackage('p1'), 'DELETE', '/api/admin/packages/p1', undefined],
    ['createAddon', () => catalogueApi.createAddon({ ...addon, serviceId: null }), 'POST', '/api/admin/addons', { ...addon, serviceId: null }],
    ['updateAddon', () => catalogueApi.updateAddon('a1', { sortOrder: 2 }), 'PATCH', '/api/admin/addons/a1', { sortOrder: 2 }],
    ['deleteAddon', () => catalogueApi.deleteAddon('a1'), 'DELETE', '/api/admin/addons/a1', undefined],
  ])('%s sends the right method, path and JSON body', async (_label, run, method, url, body) => {
    const fetchMock = vi.fn(async (..._args: [string, RequestInit?]) =>
      method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ ok: true }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await run()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [input, init = {}] = fetchMock.mock.calls[0] ?? []
    const headers = new Headers(init.headers)
    expect([String(input), init.method ?? 'GET']).toEqual([url, method])
    expect(headers.get('Authorization')).toBe('Bearer header.payload.signature')
    if (body === undefined) {
      expect(init.body).toBeUndefined()
      expect(headers.has('Content-Type')).toBe(false)
    } else {
      expect(JSON.parse(String(init.body))).toEqual(body)
      expect(headers.get('Content-Type')).toBe('application/json')
    }
  })
})
