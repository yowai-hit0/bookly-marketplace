import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { kigaliDateOf } from '../../availability/engine.js';
import { formatDate, formatMoney, formatTime } from '../../format.js';
import { type Locale, t } from '../../i18n/index.js';
import type { ComposedEmail } from '../layout.js';

/**
 * What every template shares (plan.md Task 15): the render context, the payload
 * building blocks, and the phrasing of dates, money and links.
 *
 * Copy resolves through the translation layer; times are Kigali and amounts
 * whole RWF because they go through `format.ts`; and every link to the site is
 * built here from `WEB_ORIGIN`, so no template can point at the API host.
 */

export type EmailContext = {
  /** The public site. Every link to it starts here. */
  webOrigin: string;
  locale: Locale;
};

export type EmailTemplateDefinition<Payload> = {
  /** Validated before rendering; a payload that fails is `EmailPayloadError`. */
  payload: z.ZodType<Payload>;
  compose: (payload: Payload, ctx: EmailContext) => ComposedEmail;
};

/**
 * Any template, whatever its payload: what the registry holds. The schema's
 * output is `unknown` and `compose` takes `never`, which every definition
 * satisfies; `renderEmail` only ever passes `compose` what its own schema parsed.
 */
export type AnyEmailTemplate = {
  payload: z.ZodType<unknown>;
  compose: (payload: never, ctx: EmailContext) => ComposedEmail;
};

/** Lets TypeScript infer `Payload` from the schema. */
export function defineTemplate<Payload>(definition: EmailTemplateDefinition<Payload>): EmailTemplateDefinition<Payload> {
  return definition;
}

/** A payload no retry can render: the wrong shape, or a link off the site. */
export class EmailPayloadError extends Error {
  override readonly name = 'EmailPayloadError';
}

// --- Payload building blocks ------------------------------------------------------

export const instant = z.iso.datetime({ offset: true });
export const calendarDate = z.iso.date();
/** Whole RWF: `formatMoney` refuses anything else. */
export const amountRwf = z.int().min(0);
export const text = (max: number) => z.string().trim().min(1).max(max);
export const reference = text(40);
export const personName = text(200);
/** A booking's access token: base64url, at least 96 bits (spec §7 asks for 128). */
export const accessToken = z.string().regex(/^[A-Za-z0-9_-]{16,256}$/);
export const paymentKind = z.enum(['booking_fee', 'session_fee']);
/** `cash` is money the photographer recorded by hand (admin console fixes, item 7). */
export const paymentProvider = z.enum(['mtn_momo_direct', 'flutterwave', 'cash']);

/** The booking fields most client emails carry. */
export const bookingBasics = {
  reference,
  clientName: personName,
  serviceName: text(200),
  packageName: text(200),
  startsAt: instant,
  endsAt: instant,
};

// --- Phrasing ---------------------------------------------------------------------

/**
 * A translation in the email's locale, with text values inserted verbatim.
 *
 * Not simply `t(key, values)`: i18next replaces each placeholder by searching
 * the string built so far, so a value that itself contains `{{reference}}` -- a
 * visitor can type one into their name -- gets the reference substituted into
 * it, or swaps places with the real placeholder. Every string value therefore
 * goes in as a slot marker with a per-call random nonce, which no visitor can
 * predict, and the real text replaces the markers after i18next is done.
 * Numbers pass straight through, so plurals still see their `count`.
 */
export function tr(ctx: EmailContext, key: string, values: Record<string, unknown> = {}): string {
  const nonce = randomUUID();
  const slots: [marker: string, value: string][] = [];
  const safeValues: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'string') {
      const marker = `\uE000${nonce}:${slots.length}\uE001`;
      slots.push([marker, value]);
      safeValues[name] = marker;
    } else {
      safeValues[name] = value;
    }
  }
  let translated = t(key, { ...safeValues, lng: ctx.locale });
  for (const [marker, value] of slots) translated = translated.split(marker).join(value);
  return translated;
}

export function money(amount: number): string {
  return formatMoney(amount);
}

/** `Wednesday, 7 October 2026`: the Kigali date an instant falls on. */
export function dateOf(instantValue: string): string {
  return formatDate(kigaliDateOf(new Date(instantValue)));
}

/** `Wednesday, 7 October 2026, 10:00 to 11:00 (Kigali time)`. */
export function when(ctx: EmailContext, startsAt: string, endsAt: string): string {
  return tr(ctx, 'email:common.whenValue', {
    date: dateOf(startsAt),
    start: formatTime(startsAt),
    end: formatTime(endsAt),
  });
}

// --- Links ------------------------------------------------------------------------

/**
 * Where a booking's client page lives: the token in the path, never a query
 * string (plan.md Task 18). One definition, so the page and every email agree.
 */
export const BOOKING_PAGE_PATH = '/booking';

export function bookingLink(ctx: EmailContext, token: string): string {
  return siteUrl(ctx, `${BOOKING_PAGE_PATH}/${token}`);
}

/**
 * Where a client confirms a new contact email (2026-09-25): the token in the
 * path, as the booking page's is. The page posts it; opening it changes nothing.
 */
export const EMAIL_CONFIRM_PAGE_PATH = '/email-confirm';

export function emailConfirmLink(ctx: EmailContext, token: string): string {
  return siteUrl(ctx, `${EMAIL_CONFIRM_PAGE_PATH}/${token}`);
}

/** The admin calendar, open on the day of `startsAt` (plan.md Task 9). */
export function adminCalendarLink(ctx: EmailContext, startsAt: string): string {
  return siteUrl(ctx, `/admin/calendar?view=day&date=${kigaliDateOf(new Date(startsAt))}`);
}

export function siteUrl(ctx: EmailContext, path: string): string {
  return new URL(path, ctx.webOrigin).toString();
}

/**
 * A full URL a payload carries (a password-reset link), accepted only when it is
 * on the site: an email never sends the photographer to the API host, or
 * anywhere else.
 */
export function onSite(ctx: EmailContext, url: string): string {
  if (!URL.canParse(url) || new URL(url).origin !== new URL(ctx.webOrigin).origin) {
    throw new EmailPayloadError('A link in the payload is not on WEB_ORIGIN');
  }
  return url;
}
