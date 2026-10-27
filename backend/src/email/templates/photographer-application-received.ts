import { z } from 'zod';
import { defineTemplate, personName, siteUrl, text, tr } from './shared.js';

/**
 * To every platform admin, about a photographer's application. One row per
 * admin (`outbox/recipients.ts` `platformAdminRecipients`), enqueued in the
 * transaction that causes it, so a change that rolls back announces nothing.
 * Two moments, told apart by `variant`:
 *
 *   signup      (absent, the Phase 2 payload) a photographer signed up (Phase 2
 *               decision 4; marketplace-spec.md R2.2): their studio is pending.
 *               Their address has not been verified yet when this is sent; the
 *               console shows whether it has since.
 *   submitted   they finished the setup checklist and submitted the studio for
 *               review (marketplace-spec.md R7.3, Phase 7): it now waits on an
 *               admin's approval, the only kind approval accepts. The button
 *               opens the console's "awaiting review" list.
 *   handle_changed
 *               after submitting, and before approval, they changed their
 *               handle (Phase 7, user decision 2026-10-27): the one profile
 *               detail the platform treats as crucial, since it becomes the
 *               studio's public address for good at approval. Names the old
 *               handle (`previousHandle`, required here and only here) and the
 *               new one (`handle`). One per change; the same button.
 *
 * `variant` is optional, not a discriminated union, so a signup row queued
 * before Phase 7 (which carries none) still renders.
 *
 * The applicant's name is what they typed, so it stays out of the subject (a
 * header) and goes into the body, where the layout escapes it.
 */

/** `photographer_handle_format`. */
const handle = z.string().regex(/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/);

const VARIANT_KEYS = {
  signup: { subject: 'subject', preheader: 'preheader', heading: 'heading', intro: 'intro', button: 'button' },
  submitted: {
    subject: 'submittedSubject',
    preheader: 'submittedPreheader',
    heading: 'submittedHeading',
    intro: 'submittedIntro',
    button: 'submittedButton',
  },
  handle_changed: {
    subject: 'handleChangedSubject',
    preheader: 'handleChangedPreheader',
    heading: 'handleChangedHeading',
    intro: 'handleChangedIntro',
    button: 'submittedButton',
  },
} as const;

export const photographerApplicationReceived = defineTemplate({
  payload: z
    .object({
      variant: z.enum(['signup', 'submitted', 'handle_changed']).optional(),
      displayName: personName,
      handle,
      /** The handle before the change: `handle_changed` only. */
      previousHandle: handle.optional(),
      email: text(320),
    })
    .refine((p) => (p.variant === 'handle_changed') === (p.previousHandle !== undefined), {
      path: ['previousHandle'],
      message: "Required for variant 'handle_changed', and only there",
    }),
  compose(p, ctx) {
    const variant = p.variant ?? 'signup';
    const keys = VARIANT_KEYS[variant];
    const key = (name: keyof typeof keys) => `email:photographerApplicationReceived.${keys[name]}`;
    const label = (name: string) => tr(ctx, `email:photographerApplicationReceived.${name}`);
    const handleRows =
      p.previousHandle === undefined
        ? [{ label: label('handleLabel'), value: p.handle }]
        : [
            { label: label('previousHandleLabel'), value: p.previousHandle },
            { label: label('newHandleLabel'), value: p.handle },
          ];
    return {
      subject: tr(ctx, key('subject')),
      preheader: tr(ctx, key('preheader')),
      blocks: [
        { type: 'heading', text: tr(ctx, key('heading')) },
        { type: 'paragraph', text: tr(ctx, key('intro'), { displayName: p.displayName }) },
        {
          type: 'details',
          rows: [
            { label: label('displayNameLabel'), value: p.displayName },
            ...handleRows,
            { label: label('emailLabel'), value: p.email },
          ],
        },
        {
          type: 'button',
          label: tr(ctx, key('button')),
          href: siteUrl(ctx, variant === 'signup' ? '/platform/photographers?status=pending' : '/platform/photographers?review=awaiting'),
        },
      ],
    };
  },
});
