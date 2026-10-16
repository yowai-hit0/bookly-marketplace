import i18next, { type i18n as I18n } from 'i18next';
import en from './locales/en.json' with { type: 'json' };

/**
 * Email copy resolves through here (spec §7, A-14). English is the only locale
 * that ships; the FR side is a content drop — another resource file and one
 * entry in SUPPORTED_LOCALES — rather than a rebuild.
 */
export const DEFAULT_LOCALE = 'en';
export const SUPPORTED_LOCALES = [DEFAULT_LOCALE] as const;

export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const i18n: I18n = i18next.createInstance();

// Resources are inline, so there is no async loader and init resolves before
// this module finishes evaluating. No top-level await, no async importers.
void i18n.init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: SUPPORTED_LOCALES,
  defaultNS: 'common',
  ns: Object.keys(en),
  resources: { en },
  interpolation: { escapeValue: false },
});

export const t: I18n['t'] = i18n.t.bind(i18n);
