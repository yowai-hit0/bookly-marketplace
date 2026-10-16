import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './locales/en.json'

/**
 * Page copy resolves through here (spec §7, A-14). English is the only locale
 * that ships; the FR side is a content drop — another resource file and one
 * entry in SUPPORTED_LOCALES — rather than a rebuild.
 *
 * There is no locale-prefixed routing (plan.md Task 2, R-2). Routes are plain
 * paths; adding French later means adding routes, which is work, not a rebuild.
 */
export const DEFAULT_LOCALE = 'en'
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE] as const

export type Locale = (typeof SUPPORTED_LOCALES)[number]

export const i18n: I18n = i18next.createInstance()

// Resources are inline, so there is no async loader and init resolves before
// this module finishes evaluating. No top-level await, no async importers.
void i18n.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  defaultNS: 'common',
  ns: Object.keys(en),
  resources: { en },
  interpolation: { escapeValue: false },
})
