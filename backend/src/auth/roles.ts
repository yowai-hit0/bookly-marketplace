/**
 * The `app_user.role` vocabulary (marketplace-data-model.md §2.1, §4), in code,
 * the three signed-in areas of the API (Phase 2, decision 1), and the one rule
 * for who may use each.
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

/**
 * The signed-in areas, each under its own prefix with its own login
 * (marketplace-spec.md URL map, Phase 2 decision 1):
 *
 *   studio     `/api/studio/*`     photographers
 *   platform   `/api/platform/*`   platform admins
 *   account    `/api/account/*`    clients
 */
export const AUTH_AREAS = ['studio', 'platform', 'account'] as const;
export type AuthArea = (typeof AUTH_AREAS)[number];

/** The one role each area admits. An area never admits a second role. */
export const AREA_ROLE = {
  studio: 'photographer',
  platform: 'platform_admin',
  account: 'client',
} as const satisfies Record<AuthArea, UserRole>;

/**
 * Where each area's emailed links land in the web app (marketplace-spec.md URL
 * map, Phase 2 decision 9): the reset link and the lockout alert's sign-in
 * button. Paths on WEB_ORIGIN, never on the API host.
 */
export const AREA_WEB_PATHS = {
  studio: { login: '/studio/login', resetPassword: '/studio/reset-password' },
  platform: { login: '/platform/login', resetPassword: '/platform/reset-password' },
  account: { login: '/account/login', resetPassword: '/account/reset-password' },
} as const satisfies Record<AuthArea, { login: string; resetPassword: string }>;

/** The columns `admitsArea` reads: an `app_user` row with its photographer's id, if it has one. */
export type AreaCandidate = {
  role: string;
  disabledAt: Date | null;
  anonymizedAt: Date | null;
  photographer?: { id: string } | null;
};

/**
 * Whether this login belongs in `area` at all -- the check login, password
 * reset and every authenticated request make, each against the row as it is
 * NOW (marketplace-spec.md R2.1):
 *
 * - the role is the area's own: a login of any other role is refused the same
 *   way as an unknown email, so no area's login reveals anything about the
 *   other kinds of account;
 * - nobody switched the login off (`disabled_at`) or erased it (`anonymized_at`);
 * - for the studio, it owns a photographer row, which is where
 *   `photographerId` comes from.
 *
 * A photographer's own status does not matter here. A pending photographer
 * sets up their studio before approval, and a suspended one keeps managing the
 * bookings they already have (marketplace-spec.md R2.2, decisions table).
 *
 * Email verification is NOT part of this: it is `hasVerifiedEmail`, which login
 * and the middleware check separately (Phase 2 decision 3).
 */
export function admitsArea(area: AuthArea, user: AreaCandidate): boolean {
  return (
    user.role === AREA_ROLE[area] &&
    user.disabledAt === null &&
    user.anonymizedAt === null &&
    (area !== 'studio' || (user.photographer !== undefined && user.photographer !== null))
  );
}

/**
 * THE email-verification gate (Phase 2 decision 3): a login whose address was
 * never verified cannot sign in with a password, in any area, and holds no
 * token any middleware accepts.
 *
 * `attemptLogin` asks this only AFTER the password has been checked, and
 * answers a "no" exactly as it answers a wrong password: the same result, the
 * same attempt counted, the same Argon2 cost. So the login reveals neither
 * that the address has an account nor that the account is unverified.
 *
 * Setting `email_verified_at` belongs to the verification flow (R2.2, R2.3) and
 * to Google sign-in (R2.4); this is the one place that decides what counts as
 * verified.
 */
export function hasVerifiedEmail(user: { emailVerifiedAt: Date | null }): boolean {
  return user.emailVerifiedAt !== null;
}
