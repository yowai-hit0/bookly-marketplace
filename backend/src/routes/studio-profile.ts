import { Router } from 'express';
import { z } from 'zod';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals } from '../auth/middleware.js';
import { normalizePhone } from '../booking/phone.js';
import { PORTFOLIO_LIMIT } from '../catalogue/public.js';
import { handleField } from '../photographers/handle.js';
import { addPortfolioImage, deletePortfolioImage, listPortfolio, reorderPortfolio, updatePortfolioCaption } from '../photographers/portfolio.js';
import { studioProfile, updateStudioProfile } from '../photographers/profile.js';
import { parseOrReject } from './validation.js';

/**
 * The studio's Profile and Portfolio pages (marketplace-spec.md R7.2), behind
 * `requirePhotographer`; everything is the signed-in photographer's own (R1.4).
 *
 *   GET    /profile          200 { profile }
 *   PATCH  /profile          { handle?, displayName?, bio?, contactPhone?, whatsappPhone?,
 *                              contactEmail?, coverImageUrl?, districts?, categories? }
 *          200 { profile } | 400 | 409 handle_taken | 409 handle_locked | 422 { fields }
 *   GET    /portfolio        200 { images, limit }
 *   POST   /portfolio        { url, caption? }   201 { image } | 400 | 409 portfolio_full | 422
 *   PUT    /portfolio/order  { ids }             200 { images } | 400 | 422 { fields: ['ids'] }
 *   PATCH  /portfolio/:id    { caption }         200 { image } | 400 | 404 | 422
 *   DELETE /portfolio/:id                        204 | 400 | 404
 *
 * The editor's lists are the public ones: `GET /api/categories` (active
 * categories) and `GET /api/districts` (the 30 districts by province).
 *
 * Validation follows the studio's rule (routes/validation.ts): a malformed
 * value is a 400 -- a handle outside the CHECK's format, an address or URL that
 * is not one, a district code or slug of the wrong form, an id that is not a
 * uuid -- and a well-formed one breaking a rule a 422 naming the field: a
 * length past its CHECK, an `http:` URL, a number that is not a phone number,
 * a district or category that names nothing (active), a repeat in a list.
 *
 * Text is trimmed. An optional field takes null, or a blank string, to clear
 * it. Lengths are the database's CHECKs, counted as PostgreSQL counts them
 * (characters, not UTF-16 units): display name 1-80, bio up to 2,000, caption
 * up to 200. Phones are stored E.164: a Rwandan local `078 123 4567` becomes
 * `+250781234567`, any other number needs its `+` and country code. Images are
 * `https://` only (R6.5; `photographer_cover_image_https`, `portfolio_image_url_https`).
 *
 * A handle changed while the studio is pending and submitted for review saves,
 * flags the row and emails every platform admin the old and the new handle
 * (photographers/profile.ts; user decision 2026-10-27).
 *
 * No rate limit: these writes call no provider and hash no password, like the
 * catalogue, hours and settings writes beside them (http/rate-limit.ts says
 * what the limits are for). The one email a save can send goes to the
 * platform's own admins, never to an address the request names, and only from
 * a signed-in studio under review.
 */

const NUL = String.fromCharCode(0);
const URL_MAX_LENGTH = 2000;
const PHONE_MAX_LENGTH = 40;
/** E.164: a `+`, a country code that does not start with 0, at most 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/** Characters as PostgreSQL's `char_length` counts them: code points. */
function chars(value: string): number {
  return [...value].length;
}

/** Trimmed text a column can store, `min` to `max` characters (each CHECK's own bounds). */
const storableText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => chars(value) >= min, `At least ${min} characters`)
    .refine((value) => chars(value) <= max, `At most ${max} characters`)
    .refine((value) => !value.includes(NUL), 'Contains a NUL character');

/** An optional field: null or a blank string clears it. */
const clearable = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), schema.nullable()).optional();

/**
 * A pasted image link (no uploads): malformed is a 400, a well-formed non-https
 * one a 422. Stored in its canonical form (the WHATWG serialisation: `HTTPS://`
 * and `https:host` become `https://host/`, a space `%20`), which always starts
 * with `https://` -- the CHECKs' case-sensitive `^https://` would otherwise
 * refuse a URL zod accepts, as a 500.
 */
const imageUrl = z
  .string()
  .trim()
  .max(URL_MAX_LENGTH)
  .pipe(z.url())
  // The parsed scheme, so `HTTPS://` counts as https too.
  .refine((value) => !URL.canParse(value) || new URL(value).protocol === 'https:', 'Must be an https URL')
  .transform((value) => new URL(value).href);

/** A phone number as people type it, stored as E.164 (booking/phone.ts reads Rwanda's own formats). */
const phone = z
  .string()
  .max(PHONE_MAX_LENGTH)
  .transform((typed) => normalizePhone(typed) ?? typed.trim())
  .refine((value) => E164.test(value), 'Must be a phone number in international form');

const unique = (values: string[]) => new Set(values).size === values.length;

/** `photographer_display_name_length`, `photographer_bio_length`. */
const profileBody = z.strictObject({
  handle: handleField.optional(),
  displayName: storableText(1, 80).optional(),
  bio: clearable(storableText(1, 2000)),
  contactPhone: clearable(phone),
  whatsappPhone: clearable(phone),
  contactEmail: clearable(
    z
      .string()
      .trim()
      .max(320)
      .pipe(z.email())
      .transform((email) => email.toLowerCase()),
  ),
  coverImageUrl: clearable(imageUrl),
  // The whole set, each once. District codes and category slugs in their CHECK's form; names that exist are checked after.
  districts: z
    .array(z.string().max(32).regex(/^[a-z]+(-[a-z]+)*$/))
    .max(30)
    .refine(unique, 'Each district at most once')
    .optional(),
  categories: z
    .array(z.string().max(64).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/))
    .max(50)
    .refine(unique, 'Each category at most once')
    .optional(),
});

/** `portfolio_image_caption_length`. */
const caption = clearable(storableText(1, 200));

const addImageBody = z.strictObject({ url: imageUrl, caption });
// The key is required (null clears): a PATCH without it would change nothing silently.
const captionBody = z.strictObject({ caption: z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? null : value), storableText(1, 200).nullable()) });
const orderBody = z.strictObject({
  // Lowercased first: a uuid is case-insensitive, so `[id, ID]` is a repeat.
  ids: z
    .array(z.guid().transform((id) => id.toLowerCase()))
    .max(PORTFOLIO_LIMIT)
    .refine(unique, 'Each image at most once'),
});

const rowId = z.guid().transform((id) => id.toLowerCase());

export function studioProfileRouter(deps: AuthDeps): Router {
  const router = Router();

  router.get('/profile', async (_req, res) => {
    res.json({ profile: await studioProfile(deps.prisma, photographerLocals(res).photographerId) });
  });

  router.patch('/profile', async (req, res) => {
    const body = parseOrReject(profileBody, req.body, res);
    if (body === undefined) return;

    // An absent key is undefined, which Prisma leaves alone: only what was sent changes.
    const result = await updateStudioProfile(deps.prisma, photographerLocals(res).photographerId, body, deps.now());
    switch (result.status) {
      case 'ok':
        res.json({ profile: result.profile });
        return;
      case 'unknown':
        res.status(422).json({ error: 'validation_failed', fields: result.fields });
        return;
      case 'handle_taken':
      case 'handle_locked':
        res.status(409).json({ error: result.status });
        return;
    }
  });

  router.get('/portfolio', async (_req, res) => {
    res.json({ images: await listPortfolio(deps.prisma, photographerLocals(res).photographerId), limit: PORTFOLIO_LIMIT });
  });

  router.post('/portfolio', async (req, res) => {
    const body = parseOrReject(addImageBody, req.body, res);
    if (body === undefined) return;
    const result = await addPortfolioImage(deps.prisma, photographerLocals(res).photographerId, { url: body.url, caption: body.caption ?? null });
    if (result.status === 'portfolio_full') {
      res.status(409).json({ error: 'portfolio_full', limit: PORTFOLIO_LIMIT });
      return;
    }
    res.status(201).json({ image: result.image });
  });

  router.put('/portfolio/order', async (req, res) => {
    const body = parseOrReject(orderBody, req.body, res);
    if (body === undefined) return;
    const result = await reorderPortfolio(deps.prisma, photographerLocals(res).photographerId, body.ids);
    if (result.status === 'mismatch') {
      // Not exactly the photographer's images: one missing, one extra, or another photographer's.
      res.status(422).json({ error: 'validation_failed', fields: ['ids'] });
      return;
    }
    res.json({ images: result.images });
  });

  router.patch('/portfolio/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    const body = parseOrReject(captionBody, req.body, res);
    if (body === undefined) return;
    const image = await updatePortfolioCaption(deps.prisma, photographerLocals(res).photographerId, id, body.caption);
    if (image === null) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ image });
  });

  router.delete('/portfolio/:id', async (req, res) => {
    const id = parseOrReject(rowId, req.params.id, res);
    if (id === undefined) return;
    if (!(await deletePortfolioImage(deps.prisma, photographerLocals(res).photographerId, id))) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(204).end();
  });

  return router;
}
