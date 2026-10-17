import { z } from 'zod';
import { defineTemplate, personName, siteUrl, text, tr } from './shared.js';

/**
 * To a photographer, when a platform admin suspends their studio (Phase 2
 * decision 7; marketplace-spec.md R9.1), with the reason the admin gave.
 * Suspension hides the profile and refuses new bookings, but keeps every
 * existing booking, and the photographer can still sign in to manage them --
 * the email says so, so nobody abandons a client they still owe a shoot.
 * Sent once per suspension: its instant is in the dedupe key.
 */
export const photographerSuspended = defineTemplate({
  payload: z.object({
    displayName: personName,
    /** What the platform admin typed: plain text, escaped by the layout. */
    reason: text(500),
  }),
  compose(p, ctx) {
    return {
      subject: tr(ctx, 'email:photographerSuspended.subject'),
      preheader: tr(ctx, 'email:photographerSuspended.preheader'),
      blocks: [
        { type: 'heading', text: tr(ctx, 'email:photographerSuspended.heading') },
        { type: 'paragraph', text: tr(ctx, 'email:common.greeting', { name: p.displayName }) },
        { type: 'paragraph', text: tr(ctx, 'email:photographerSuspended.intro') },
        { type: 'details', rows: [{ label: tr(ctx, 'email:photographerSuspended.reasonLabel'), value: p.reason }] },
        { type: 'note', text: tr(ctx, 'email:photographerSuspended.existingBookings') },
        { type: 'paragraph', text: tr(ctx, 'email:photographerSuspended.questions') },
        { type: 'button', label: tr(ctx, 'email:photographerSuspended.button'), href: siteUrl(ctx, '/studio') },
      ],
    };
  },
});
