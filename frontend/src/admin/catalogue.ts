import { z } from 'zod'
import { adminFetch } from './api'

/**
 * The catalogue CMS's data and forms (plan.md Task 10, spec §3.4).
 *
 * The form schemas are a convenience with no authority: the API revalidates
 * every payload (plan.md, Stack decisions). They turn a form's strings into the
 * payload the API takes, and name the fields that are wrong.
 *
 * `nameFr` and `descriptionFr` are in the schemas as optional and no form
 * renders them (plan.md Task 10). A save therefore never sends them, and a
 * partial update leaves any French the API already holds untouched.
 */

export type AdminService = {
  id: string
  slug: string
  nameEn: string
  nameFr: string | null
  descriptionEn: string | null
  descriptionFr: string | null
  coverImageUrl: string | null
  /** 0 to 1; null uses the global rate. */
  bookingFeeRateOverride: number | null
  isActive: boolean
  sortOrder: number
}

export type AdminPackage = {
  id: string
  serviceId: string
  nameEn: string
  nameFr: string | null
  descriptionEn: string | null
  descriptionFr: string | null
  priceRwf: number
  photoCount: number
  durationMinutes: number
  isActive: boolean
  sortOrder: number
}

export type AdminAddon = {
  id: string
  /** null = offered on every service. */
  serviceId: string | null
  nameEn: string
  nameFr: string | null
  priceRwf: number
  isActive: boolean
  sortOrder: number
}

export type CatalogueService = AdminService & { packages: AdminPackage[]; addons: AdminAddon[] }

export type CatalogueData = {
  services: CatalogueService[]
  sharedAddons: AdminAddon[]
}

/** Spec §6.8: saved, but no open day is long enough for it. */
export type DurationWarning = {
  code: 'duration_exceeds_longest_window'
  longestWindow: { opensMinute: number; closesMinute: number } | null
}

export type PackageSaved = { package: AdminPackage; warning: DurationWarning | null }

// --- API -------------------------------------------------------------------------

function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return adminFetch<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}

export const catalogueApi = {
  load: () => adminFetch<CatalogueData>('/admin/catalogue'),

  createService: (body: ServicePayload) => send<{ service: AdminService }>('POST', '/admin/services', body),
  updateService: (id: string, body: Partial<ServicePayload>) =>
    send<{ service: AdminService }>('PATCH', `/admin/services/${id}`, body),
  deleteService: (id: string) => send<void>('DELETE', `/admin/services/${id}`),

  createPackage: (body: PackagePayload & { serviceId: string }) => send<PackageSaved>('POST', '/admin/packages', body),
  updatePackage: (id: string, body: Partial<PackagePayload>) =>
    send<PackageSaved>('PATCH', `/admin/packages/${id}`, body),
  deletePackage: (id: string) => send<void>('DELETE', `/admin/packages/${id}`),

  createAddon: (body: AddonPayload & { serviceId: string | null }) =>
    send<{ addon: AdminAddon }>('POST', '/admin/addons', body),
  updateAddon: (id: string, body: Partial<AddonPayload>) =>
    send<{ addon: AdminAddon }>('PATCH', `/admin/addons/${id}`, body),
  deleteAddon: (id: string) => send<void>('DELETE', `/admin/addons/${id}`),
}

// --- Form schemas ----------------------------------------------------------------

const INT4_MAX = 2_147_483_647
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const blankToNull = (value: unknown) => (typeof value === 'string' && value.trim() === '' ? null : value)

const requiredText = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (max: number) => z.preprocess(blankToNull, z.string().trim().max(max).nullable())

/** A whole number typed into a form: digits only, so `1e3` and `40,000` are refused. */
const wholeNumber = (min: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,10}$/)
    .transform(Number)
    .refine((value) => value >= min && value <= INT4_MAX)

export const serviceFormSchema = z
  .object({
    nameEn: requiredText(200),
    nameFr: optionalText(200).optional(),
    slug: z.string().trim().max(100).regex(SLUG_PATTERN),
    descriptionEn: optionalText(5000),
    descriptionFr: optionalText(5000).optional(),
    coverImageUrl: z.preprocess(
      blankToNull,
      // An unparseable value is already refused by z.url(); new URL() would throw on it.
      z.url().refine((value) => !URL.canParse(value) || new URL(value).protocol === 'https:').nullable(),
    ),
    /** Typed as a percentage, one decimal place at most: 37.5 is a rate of 0.375. */
    bookingFeePercent: z.preprocess(
      blankToNull,
      z
        .string()
        .trim()
        .regex(/^\d{1,3}(\.\d)?$/)
        .transform(Number)
        .refine((value) => value <= 100)
        .nullable(),
    ),
    sortOrder: wholeNumber(0),
    isActive: z.boolean(),
  })
  .transform(({ bookingFeePercent, ...rest }) => ({
    ...rest,
    bookingFeeRateOverride: bookingFeePercent === null ? null : Number((bookingFeePercent / 100).toFixed(3)),
  }))

export const packageFormSchema = z.object({
  nameEn: requiredText(200),
  nameFr: optionalText(200).optional(),
  descriptionEn: optionalText(5000),
  descriptionFr: optionalText(5000).optional(),
  priceRwf: wholeNumber(0),
  photoCount: wholeNumber(0),
  durationMinutes: wholeNumber(1),
  sortOrder: wholeNumber(0),
  isActive: z.boolean(),
})

export const addonFormSchema = z.object({
  nameEn: requiredText(200),
  nameFr: optionalText(200).optional(),
  priceRwf: wholeNumber(0),
  sortOrder: wholeNumber(0),
  isActive: z.boolean(),
})

export type ServicePayload = z.output<typeof serviceFormSchema>
export type PackagePayload = z.output<typeof packageFormSchema>
export type AddonPayload = z.output<typeof addonFormSchema>

/** A form's starting values, as the strings and booleans its inputs hold. */
export type FormValues = Record<string, string | boolean>

export function serviceFormValues(service?: AdminService): FormValues {
  return {
    nameEn: service?.nameEn ?? '',
    slug: service?.slug ?? '',
    descriptionEn: service?.descriptionEn ?? '',
    coverImageUrl: service?.coverImageUrl ?? '',
    bookingFeePercent:
      service?.bookingFeeRateOverride == null ? '' : String(Number((service.bookingFeeRateOverride * 100).toFixed(1))),
    sortOrder: String(service?.sortOrder ?? 0),
    isActive: service?.isActive ?? true,
  }
}

export function packageFormValues(pkg?: AdminPackage): FormValues {
  return {
    nameEn: pkg?.nameEn ?? '',
    descriptionEn: pkg?.descriptionEn ?? '',
    priceRwf: pkg === undefined ? '' : String(pkg.priceRwf),
    photoCount: pkg === undefined ? '' : String(pkg.photoCount),
    durationMinutes: pkg === undefined ? '' : String(pkg.durationMinutes),
    sortOrder: String(pkg?.sortOrder ?? 0),
    isActive: pkg?.isActive ?? true,
  }
}

export function addonFormValues(addon?: AdminAddon): FormValues {
  return {
    nameEn: addon?.nameEn ?? '',
    priceRwf: addon === undefined ? '' : String(addon.priceRwf),
    sortOrder: String(addon?.sortOrder ?? 0),
    isActive: addon?.isActive ?? true,
  }
}

/** `540` → `09:00`: a minute of the day, not an instant, so no zone applies. */
export function formatMinuteOfDay(minute: number): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(Math.floor(minute / 60))}:${pad(minute % 60)}`
}
