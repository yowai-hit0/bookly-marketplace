/**
 * The `app_user.role` vocabulary (marketplace-data-model.md §2.1, §4), in code,
 * and the one rule for who may use the photographer's studio.
 *
 * One role per login. A photographer who wants to book another photographer
 * does it as a guest or with a second email.
 */

/** `app_user_role_allowed`. */
export const USER_ROLES = ['platform_admin', 'photographer', 'client'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && (USER_ROLES as readonly string[]).includes(value);
}

/** The columns `canUseStudio` reads: an `app_user` row with its photographer's id, if it has one. */
export type StudioCandidate = {
  role: string;
  passwordHash: string | null;
  disabledAt: Date | null;
  anonymizedAt: Date | null;
  photographer: { id: string } | null;
};

/**
 * Whether this login may sign in to, and stay signed in to, the studio on
 * `/api/admin/*` (brief decision 3; Phase 2 moves it to `/api/studio/*`):
 *
 * - the role is `photographer` -- a platform admin or a client is refused the
 *   same way as an unknown email, so the studio login reveals nothing about
 *   other kinds of account;
 * - it owns a photographer row, which is where `photographerId` comes from;
 * - nobody switched the login off (`disabled_at`) or erased it;
 * - it has a password: the bearer token is bound to one (`auth/token.ts`).
 *
 * The photographer's own status does not matter here. A pending photographer
 * sets up their studio before approval, and a suspended one keeps managing the
 * bookings they already have (marketplace-spec.md R2.2, decisions table).
 */
export function canUseStudio(user: StudioCandidate): user is StudioCandidate & { passwordHash: string; photographer: { id: string } } {
  return (
    user.role === 'photographer' &&
    user.photographer !== null &&
    user.disabledAt === null &&
    user.anonymizedAt === null &&
    user.passwordHash !== null
  );
}
