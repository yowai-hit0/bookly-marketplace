import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, i18n, t } from './index.js';

describe('the translation layer', () => {
  it('initialises synchronously — resources are inline, not fetched', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('resolves email copy through i18next rather than a literal', () => {
    expect(t('common:appName')).toBe('Bookly');
  });

  it('ships English as the only locale (spec §4.2, A-14)', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en']);
    expect(i18n.language).toBe(DEFAULT_LOCALE);
  });

  it('falls back to English for an unshipped locale rather than erroring', async () => {
    await i18n.changeLanguage('fr');
    expect(t('common:appName')).toBe('Bookly');
    await i18n.changeLanguage(DEFAULT_LOCALE);
  });

  it('returns the key itself for a missing string, so a gap is visible', () => {
    expect(t('common:nothingHere')).toBe('nothingHere');
  });
});
