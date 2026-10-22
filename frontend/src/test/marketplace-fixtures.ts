import type {
  DirectoryPage,
  ProvinceDistricts,
  PublicCategory,
  PublicPhotographerProfile,
  PublicPhotographerSummary,
  PublicServiceSummary,
} from '@/catalogue/api'

/**
 * Phase 6's public shapes (backend/openapi/components/catalogue.yaml), built
 * the way the API answers them, for the directory, profile and landing tests.
 * Each builder takes overrides, so a test names only what it is about.
 */

export const CATEGORIES: PublicCategory[] = [
  { slug: 'wedding', name: 'Wedding' },
  { slug: 'portrait', name: 'Portrait' },
  { slug: 'event', name: 'Event' },
  { slug: 'product', name: 'Product' },
]

export const PROVINCES: ProvinceDistricts[] = [
  {
    code: 'kigali',
    name: 'Kigali City',
    districts: [
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'kicukiro', name: 'Kicukiro' },
      { code: 'nyarugenge', name: 'Nyarugenge' },
    ],
  },
  { code: 'western', name: 'Western Province', districts: [{ code: 'rubavu', name: 'Rubavu' }] },
]

export function summary(overrides: Partial<PublicPhotographerSummary> = {}): PublicPhotographerSummary {
  return {
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    coverImageUrl: 'https://images.example.com/kigali.jpg',
    fromPriceRwf: 35_000,
    districts: [{ code: 'gasabo', name: 'Gasabo' }],
    categories: [{ slug: 'wedding', name: 'Wedding' }],
    takingBookings: true,
    ...overrides,
  }
}

export function directoryPage(photographers: PublicPhotographerSummary[], overrides: Partial<DirectoryPage> = {}): DirectoryPage {
  return { photographers, page: 1, pageSize: 24, hasMore: false, total: photographers.length, ...overrides }
}

export function serviceSummary(overrides: Partial<PublicServiceSummary> = {}): PublicServiceSummary {
  return {
    slug: 'portraits',
    nameEn: 'Portraits',
    descriptionEn: 'Studio portraits.',
    coverImageUrl: 'https://images.example.com/portraits.jpg',
    fromPriceRwf: 25_000,
    ...overrides,
  }
}

export function profile(overrides: Partial<PublicPhotographerProfile> = {}): PublicPhotographerProfile {
  return {
    handle: 'kigali-lens',
    displayName: 'Kigali Lens',
    bio: 'Portraits and weddings in natural light.',
    coverImageUrl: 'https://images.example.com/kigali-cover.jpg',
    contactPhone: '+250 788 000 000',
    whatsappPhone: '+250 788 111 222',
    email: 'hello@kigalilens.rw',
    takingBookings: true,
    cancellationPolicy: { cutoffHours: 24, bookingFeeRefundable: true },
    districts: [
      { code: 'gasabo', name: 'Gasabo' },
      { code: 'kicukiro', name: 'Kicukiro' },
    ],
    categories: [
      { slug: 'wedding', name: 'Wedding' },
      { slug: 'portrait', name: 'Portrait' },
    ],
    portfolio: [
      { url: 'https://images.example.com/p1.jpg', caption: 'Akagera at dawn' },
      { url: 'https://images.example.com/p2.jpg', caption: null },
      { url: 'https://images.example.com/p3.jpg', caption: 'A wedding in Rubavu' },
    ],
    services: [
      serviceSummary(),
      serviceSummary({ slug: 'weddings', nameEn: 'Weddings', descriptionEn: null, coverImageUrl: null, fromPriceRwf: 600_000 }),
    ],
    ...overrides,
  }
}
