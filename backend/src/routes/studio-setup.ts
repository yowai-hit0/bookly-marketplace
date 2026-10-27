import { Router } from 'express';
import type { AuthDeps } from '../auth/account-auth.js';
import { photographerLocals } from '../auth/middleware.js';
import { type SubmitDeps, setupChecklist, submitForReview } from '../photographers/setup.js';

/**
 * The studio's setup checklist (marketplace-spec.md R7.3, T7.1), behind
 * `requirePhotographer`; the signed-in photographer's own (R1.4).
 *
 *   GET  /setup          200 { setup: { items, missing, status, submittedAt, canSubmit } }
 *   POST /setup/submit   200 { setup }                          submitted now, or already (idempotent)
 *                        409 not_pending                        approved or suspended
 *                        422 setup_incomplete { missing }       an item not done (T7.1)
 *
 * The submit reads no body. photographers/setup.ts defines every item, and why
 * an edit after submitting keeps the submission.
 */

export type StudioSetupDeps = AuthDeps & Pick<SubmitDeps, 'log'>;

export function studioSetupRouter(deps: StudioSetupDeps): Router {
  const router = Router();

  router.get('/setup', async (_req, res) => {
    res.json({ setup: await setupChecklist(deps.prisma, photographerLocals(res).photographerId) });
  });

  router.post('/setup/submit', async (_req, res) => {
    const result = await submitForReview(
      { prisma: deps.prisma, now: deps.now, ...(deps.log === undefined ? {} : { log: deps.log }) },
      photographerLocals(res).photographerId,
    );
    switch (result.status) {
      case 'ok':
        res.json({ setup: result.setup });
        return;
      case 'not_pending':
        res.status(409).json({ error: 'not_pending' });
        return;
      case 'incomplete':
        res.status(422).json({ error: 'setup_incomplete', missing: result.missing });
        return;
    }
  });

  return router;
}
