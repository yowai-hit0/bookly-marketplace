import type { AppUser } from '@prisma/client';

/**
 * The only shape of a signed-in user that may leave the API (plan.md Task 7).
 * The studio endpoints still send it under the `admin` key in Phase 1, so the
 * frontend keeps working until Phase 2's `/api/studio/*` (brief decision 3).
 *
 * An explicit allowlist, never a spread with deletions: a column added to
 * `app_user` later must stay private until someone chooses to publish it.
 * `password_hash`, the reset and verification token hashes, `google_sub` and
 * the lockout state never appear.
 */
export type PublicUser = {
  id: string;
  email: string;
  lastLoginAt: string | null;
};

export function toPublicUser(user: AppUser): PublicUser {
  return {
    id: user.id,
    email: user.email,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
  };
}
