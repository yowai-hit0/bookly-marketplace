import type { AdminUser } from '@prisma/client';

/**
 * The only shape of an admin that may leave the API (plan.md Task 7).
 *
 * An explicit allowlist, never a spread with deletions: a column added to
 * `admin_user` later must stay private until someone chooses to publish it.
 * `password_hash`, the reset token hash and the lockout state never appear.
 */
export type PublicAdmin = {
  id: string;
  email: string;
  lastLoginAt: string | null;
};

export function toPublicAdmin(admin: AdminUser): PublicAdmin {
  return {
    id: admin.id,
    email: admin.email,
    lastLoginAt: admin.lastLoginAt?.toISOString() ?? null,
  };
}
