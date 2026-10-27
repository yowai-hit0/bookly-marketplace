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
 * A client's own view of their account (`GET /api/account/me`): the public user,
 * the name they gave for the greeting, and what the dashboard's profile page
 * needs (marketplace-spec.md Phase 8, decisions 1 and 2):
 *
 * - `phone`: their own number, E.164, which prefills the booking form;
 * - `hasPassword` and `hasGoogle`: which credentials the account holds -- whether,
 *   never what. The page offers "change password" or "add a password", and
 *   asks a Google-only account to type its address to delete it;
 * - `pendingEmail`: an address change waiting on the new inbox, while its link
 *   still works; null once it has lapsed.
 *
 * Still an allowlist: the hashes, the Google subject, the token version and
 * the lockout state never leave.
 */
export type AccountUser = PublicUser & {
  fullName: string | null;
  phone: string | null;
  hasPassword: boolean;
  hasGoogle: boolean;
  pendingEmail: string | null;
};

export function toAccountUser(user: AppUser, now: Date): AccountUser {
  const pendingLive = user.pendingEmail !== null && user.pendingEmailExpiresAt !== null && user.pendingEmailExpiresAt > now;
  return {
    ...toPublicUser(user),
    fullName: user.fullName,
    phone: user.phone,
    hasPassword: user.passwordHash !== null,
    hasGoogle: user.googleSub !== null,
    pendingEmail: pendingLive ? user.pendingEmail : null,
  };
}
