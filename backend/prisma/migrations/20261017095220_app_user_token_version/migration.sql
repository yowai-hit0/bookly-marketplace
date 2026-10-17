-- ============================================================================
-- A per-user token version (Phase 2, decision 2; marketplace-spec.md R2.1, T2.5).
--
-- Every bearer token carries a credential fingerprint: an HMAC, under
-- SESSION_SECRET, of the user's password hash, Google subject and this
-- version (auth/token.ts `credentialFingerprint`). The middleware recomputes it
-- from the row on every request, so changing any of the three revokes every
-- token issued before the change.
--
-- A password user is revoked by changing the password, as before. A
-- Google-only client has no password to change; adding one to this column is
-- their equivalent ("sign out everywhere", erasure, a Google unlink), and it
-- works for every other role too (`revokeTokens`, auth/account-auth.ts).
--
-- Generated with `migrate dev --create-only`; the CHECK below is hand-written.
-- DEFAULT 0 applies to existing rows, which keep their tokens valid only until
-- the audience change of the same phase refuses them anyway.
-- ============================================================================

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "token_version" INTEGER NOT NULL DEFAULT 0;

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma). The version only ever goes up.
-- ============================================================================
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_token_version_non_negative" CHECK (token_version >= 0);
