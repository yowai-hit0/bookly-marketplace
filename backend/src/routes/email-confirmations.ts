import { Router } from 'express';
import { confirmEmailChange, type EmailChangeDeps } from '../booking/email-change.js';

/**
 * The link in a contact-email confirmation (docs/prompts/client-access-and-admin-polish.md, item 6):
 *
 *   POST /api/email-confirmations/:token
 *        200 { confirmed: true }   the booking now writes to the new address
 *        404 not_found             unknown, expired, replaced or already used, alike
 *
 * A POST the page makes when its button is pressed, never a GET the email's
 * link could trigger by itself: mail scanners open links, and a change must be
 * someone's decision. The token is 256 random bits, so guessing one is not a
 * way in, and the answer names nothing about any booking.
 */
export function emailConfirmationsRouter(deps: EmailChangeDeps): Router {
  const router = Router();

  router.post('/:token', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const result = await confirmEmailChange(deps, req.params.token);
    if (result.status === 'not_found') {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.json({ confirmed: true });
  });

  return router;
}
