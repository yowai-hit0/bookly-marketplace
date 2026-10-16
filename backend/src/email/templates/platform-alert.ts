import { z } from 'zod';
import type { ComposedEmail } from '../layout.js';
import { composeRetriesExhausted, retriesExhausted } from './photographer-alert.js';
import { defineTemplate } from './shared.js';

/**
 * To every platform admin: what concerns no photographer (marketplace-data-model.md
 * §2.14, brief decision 6), the other half of the old `admin_alert`. One
 * variant so far:
 *
 *   retries_exhausted   the outbox gave up on a message that names no studio,
 *                       such as account mail (Task 14)
 *
 * A discriminated union like `photographer_alert`, so later phases add variants
 * without a new template name.
 */
export const platformAlert = defineTemplate({
  payload: z.discriminatedUnion('variant', [retriesExhausted]),
  compose(p, ctx): ComposedEmail {
    return composeRetriesExhausted(p, ctx, 'email:platformAlert.retriesExhausted');
  },
});
