-- ============================================================================
-- Google sign-in flows (Phase 2, decision 6; marketplace-spec.md R2.4, T2.3;
-- marketplace-data-model.md §3.14).
--
-- One row per `POST /api/account/auth/google/start`: the SHA-256 of the
-- `state` handed to Google, the PKCE code verifier the token exchange needs,
-- and the nonce the id_token must carry back. Good for 10 minutes and
-- single-use: the callback consumes it with one
-- `UPDATE ... WHERE consumed_at IS NULL AND expires_at > now RETURNING`, so two
-- callbacks with one state cannot both proceed.
--
-- The state itself is never stored, only its hash, like every other emailed or
-- redirected token in this schema. The verifier is stored as is: the token
-- endpoint needs it, and it is worthless without the one-time code Google
-- returns to the browser.
--
-- Generated with `migrate dev --create-only`; the CHECKs below are hand-written.
-- ============================================================================

-- CreateTable
CREATE TABLE "oauth_flow" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state_hash" TEXT NOT NULL,
    "code_verifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "consumed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_flow_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_flow_state_hash_key" ON "oauth_flow"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_flow_expires_at_idx" ON "oauth_flow"("expires_at");

-- ============================================================================
-- HAND-WRITTEN (invisible to Prisma).
--
-- The state hash is a SHA-256 hex digest, never the state: a plaintext state
-- written here by mistake is refused. The verifier is RFC 7636 §4.1's: 43 to
-- 128 characters of [A-Za-z0-9-._~].
-- ============================================================================
ALTER TABLE "oauth_flow"
  ADD CONSTRAINT "oauth_flow_state_hash_sha256" CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "oauth_flow_code_verifier_rfc7636" CHECK (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$'),
  ADD CONSTRAINT "oauth_flow_nonce_length" CHECK (char_length(nonce) BETWEEN 16 AND 128);
