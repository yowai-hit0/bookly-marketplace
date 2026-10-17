import type { AppUser } from '@prisma/client';

/**
 * The only shape of a signed-in user that may leave the API (plan.md Task 7),
 * in every area: the login and `/me` of the studio, the platform and the
 * account all send it under the `user` key (Phase 2 decision 1).
 *
 * An explicit allowlist, never a spread with deletions: a column added to
 * `app_user` later must stay private until someone chooses to publish it.
 * `password_hash`, the reset and verification token hashes, `google_sub`,
 * `token_version` and the lockout state never appear. Nor does the role: a
 * client knows it from the area it signed in to.
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

/**
 * A client's own view of their account (`GET /api/account/me`): the public user
 * and the name they gave, for the greeting. Still an allowlist; whether the
 * account has a password or a Google identity stays private (Phase 8 decides
 * what the profile page needs).
 */
export type AccountUser = PublicUser & { fullName: string | null };

export function toAccountUser(user: AppUser): AccountUser {
  return { ...toPublicUser(user), fullName: user.fullName };
}
