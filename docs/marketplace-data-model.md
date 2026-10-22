# Marketplace data model changes

Companion to `docs/marketplace-spec.md`. Supersedes `docs/data-model_v2.md` for the marketplace; rules not restated here still hold there.


**Amendments from later decisions** (apply on top of the sections below):
- `photographer_setting` gains `client_cancel_cutoff_hours int NOT NULL DEFAULT 0 CHECK (>= 0)` and `booking_fee_refundable_on_client_cancel boolean NOT NULL DEFAULT false` (R1.8).
- `booking` snapshots both at creation: `client_cancel_cutoff_hours int NOT NULL CHECK (>= 0)` and `booking_fee_refundable_on_client_cancel boolean NOT NULL`, no defaults (R1.8, §2.9). Incremental migration `20261017000000_booking_cancellation_policy`.
- `app_user.password_hash` becomes **nullable**. Add `google_sub text` with a partial unique index `WHERE google_sub IS NOT NULL`, and the CHECKs `app_user_google_client_only (google_sub IS NULL OR role = 'client')` and `app_user_has_credential (password_hash IS NOT NULL OR google_sub IS NOT NULL)` (R2.4).
- `platform_setting.trial_days` defaults to **30**, matching the decision.
- **New table `oauth_flow`** (Phase 2 decision 6, §3.14), migration `20261017104433_oauth_flow`. The marketplace therefore has **27** tables once subscriptions and payouts land (22 after Phase 2).
- `account_verify_email` and `photographer_application_received` have renderers from Phase 2 (no CHECK change); `account_security_alert` gains the variant `account_exists` (marketplace-spec.md R2.1c).
- **Linking** (§2.8) runs on verification, on a password reset that verifies, and on Google sign-in; it skips erased client rows (`anonymized_at IS NULL`).

| | |
|---|---|
| **Expands** | `docs/data-model_v2.md`. Rules that are not restated here still apply: uuid PKs, snake_case singular tables, whole-RWF `Int`, `timestamptz` rendered in Africa/Kigali, text + CHECK instead of native enums, constraints written by hand in migration SQL, and `prisma db push` forbidden. |
| **Target engine** | PostgreSQL 15+ with **`btree_gist`**. data-model_v2.md:753 already says a second photographer would need it. |
| **Tables** | 14 → **26**. Nothing is dropped without a replacement: `admin_user` becomes `app_user`, and `setting` becomes `photographer_setting` + `platform_setting`. |
| **Production data** | None, so no backfill is needed. §5 recommends one squashed baseline migration. |

## 1. Summary: every current model

| Current model (table) | Verdict | One-line reason |
|---|---|---|
| `AdminUser` (`admin_user`) | **REPLACE** → `AppUser` (`app_user`) | One login table for `platform_admin` / `photographer` / `client`. Adds a role and email verification. (`user` is a reserved word in PG, so the table is `app_user`.) |
| `Setting` (`setting`) | **REPLACE** → `PhotographerSetting` + `PlatformSetting` | The singleton is split by owner. Fee rate, lead time, buffer and delivery expiry go per photographer. The checkout hold and subscription plan go to the platform. |
| `WorkingHours` (`working_hours`) | **CHANGE** | Add `photographer_id`. Both partial uniques become per photographer. |
| `AvailabilityBlock` (`availability_block`) | **CHANGE** | Add `photographer_id`. The GiST index becomes `(photographer_id, range)`. |
| `Service` (`service`) | **CHANGE** | Add `photographer_id`. Slug is unique per photographer instead of globally. |
| `Package` (`package`) | **CHANGE** | Add `photographer_id`, used by the composite FK that keeps one tenant per row and by the directory price index. |
| `Addon` (`addon`) | **CHANGE** | Add `photographer_id`. `service_id IS NULL` now means "every service of *this* photographer". |
| `Client` (`client`) | **CHANGE** | Add an optional `user_id` link to an account. It stays a platform-global dedupe record. |
| `Booking` (`booking`) | **CHANGE** | Add `photographer_id`. Exclusion becomes `photographer_id WITH =, range WITH &&`. Composite FKs to service/package. Status `cancelled_by_admin` is renamed and `cancelled_by_platform` is added. |
| `BookingAddon` (`booking_addon`) | **KEEP** | Scoped through its booking. Tenant consistency of the add-on is checked in the app (§2.10). |
| `Payment` (`payment`) | **CHANGE** | `booking_id` becomes nullable. Adds `subscription_id`, `plan_interval`, `checkout_url`, kind `subscription` and provider `flutterwave_checkout`. **`checkout_url` and `flutterwave_checkout` are deferred with card payments (user decision, 2026-10-17; §2.11).** |
| `WebhookEvent` (`webhook_event`) | **CHANGE** (CHECK only) | The provider vocabulary gains `flutterwave_checkout`. **Deferred with card payments (2026-10-17; §2.12).** |
| `BookingNote` (`booking_note`) | **KEEP** | Scoped through its booking. |
| `Outbox` (`outbox`) | **CHANGE** | Add `photographer_id`. Template vocabulary changes: photographer, platform, account, subscription and payout emails. |

**New models:** `AppUser`, `PlatformSetting`, `Photographer`, `PhotographerSetting`, `District`, `PhotographerDistrict`, `Category`, `PhotographerCategory`, `PortfolioImage`, `Subscription`, `SubscriptionPeriod`, `PayoutMethod`, `Payout`, `PayoutItem`. That is 14 names, but `AppUser` and the two setting tables replace existing ones, so the table count goes from 14 to 26.

## 2. Per existing model

### 2.1 `AdminUser` → `AppUser` (`app_user`)
**Current:** `backend/prisma/schema.prisma:26-43`; table at `migrations/20260910141543_init/migration.sql:2-15`; `admin_user_lower_email_unique` at init `:335`.

| Change | Detail |
|---|---|
| Rename | Table `admin_user` → `app_user`, model `AdminUser` → `AppUser`. |
| Add | `role` text NOT NULL, CHECK `IN ('platform_admin','photographer','client')`. |
| Add | `full_name` text NULL |
| Add | `email_verified_at`, `email_verify_token_hash`, `email_verify_expires_at`. A client account links to `client` rows only after verification. |
| Add | `disabled_at` (platform admin switched the login off) and `anonymized_at` (erasure). |
| Add (Phase 2) | `token_version int NOT NULL DEFAULT 0`, CHECK `app_user_token_version_non_negative`. Covered by every token's credential fingerprint; adding one revokes all of the user's tokens (marketplace-spec.md R2.1a). Migration `20261017095220_app_user_token_version`. |
| Keep | `email`, `password_hash` (nullable per amendment), `failed_login_count`, `locked_until`, `password_reset_token_hash`, `password_reset_expires_at`, `last_login_at`, timestamps. |
| Unique | `app_user_lower_email_unique ON app_user (lower(email))`, replacing init `:335`. |
| New partial uniques | `app_user_password_reset_token_hash_unique` and `app_user_email_verify_token_hash_unique`, each `WHERE … IS NOT NULL`. With many users a token hash must address one row. Today `findFirst` by hash at `auth/admin-auth.ts:149` assumes there is a single row. |
| New CHECKs | `app_user_role_allowed`, `app_user_email_verify_complete` (hash and expiry both set or both null), `app_user_password_reset_complete`. |

**One role per login.** A photographer who wants to book another photographer does it as a guest or with a second email. If dual roles are ever needed, `role` becomes a `user_role (user_id, role)` join table.

### 2.2 `Setting` → `PhotographerSetting` + `PlatformSetting`
**Current:** `schema.prisma:49-59`; init `:18-28`; CHECKs init `:408-414`.

| Current column | Destination | Why |
|---|---|---|
| `booking_fee_rate` | `photographer_setting.booking_fee_rate` | Each photographer sets their own deposit. There is no commission, so the platform has no stake in it. |
| `min_lead_time_minutes` | `photographer_setting` | Depends on the photographer's working style. |
| `buffer_minutes` | `photographer_setting` | Travel time between shoots differs per photographer. It is snapshotted into `booking.buffer_ends_at`. |
| `delivery_expiry_days` | `photographer_setting` | Each photographer chooses their own file host. |
| `hold_minutes` | **`platform_setting.hold_minutes`** | The checkout hold belongs to the payment infrastructure. It must stay inside the reconciler window (`payments/reconcile.ts:24`, 60 minutes) and match how long MoMo prompts last. |
| `id = 1` CHECK | `platform_setting_single_row` | The singleton survives only at platform level. |
| (new) | `platform_setting.trial_days`, `subscription_monthly_price_rwf`, `subscription_yearly_price_rwf`, `subscription_grace_days`, `subscription_reminder_days int[]` | Subscription plan configuration. |

A separate `photographer_setting` table, rather than columns on `photographer`, for three reasons:
1. `settings/repository.ts` is the only module allowed to touch these values (enforced by `settings/settings.test.ts:48-50`).
2. The public profile row then carries no private operating values.
3. It mirrors the current `Setting` shape.

The row is created in the same transaction as `photographer`.

### 2.3 `WorkingHours` (`working_hours`)
**Current:** `schema.prisma:66-84`; init `:31-43`; partial uniques init `:357-359`, `:364-366`; CHECKs init `:416-424`.
- **Add** `photographerId` (uuid) and a relation with `onDelete: Cascade` (configuration only).
- **Drop and recreate** both partial uniques with `photographer_id` as the leading column (SQL in §3.12).
- The five CHECKs are unchanged.
- Seed: the five global weekday rows in `db/seed.ts:81-89` go away. Default hours are inserted per photographer at sign-up.

### 2.4 `AvailabilityBlock` (`availability_block`)
**Current:** `schema.prisma:89-102`; init `:46-56`; `availability_block_range_idx` init `:381-382`; CHECK init `:426-427`.
- **Add** `photographerId` plus a relation with `onDelete: Cascade`.
- **Drop** the range index and **recreate** it as `USING gist (photographer_id, tstzrange(starts_at, ends_at, '[)'))`. This needs `btree_gist`.

### 2.5 `Service` (`service`)
**Current:** `schema.prisma:106-127` (`slug @unique` at `:108`); `service_slug_key` init `:247`; CHECK init `:429-433`.
- **Add** `photographerId` plus a relation with `onDelete: Restrict`.
- **Remove** `@unique` from `slug`. **Add** `@@unique([photographerId, slug])`.
- **Add** `@@unique([id, photographerId])`, the target of the composite FKs.
- **New CHECK** `service_slug_format`: `slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`.
- The booking-fee override now falls back to `photographer_setting.booking_fee_rate`.

### 2.6 `Package` (`package`)
**Current:** `schema.prisma:129-151`; FK init `:298`; CHECKs init `:435-438`.
- **Add** `photographerId` plus a relation (Restrict).
- **Change** the `service` relation to the composite `(serviceId, photographerId) → (id, photographerId)`, so a package cannot belong to another photographer's service.
- **Add** `@@unique([id, photographerId])`.
- **New partial index** `package_directory_price_idx ON package (photographer_id, price_rwf) WHERE is_active`.

### 2.7 `Addon` (`addon`)
**Current:** `schema.prisma:153-170`; FK init `:301`; CHECK init `:440-441`.
- **Add** `photographerId` (NOT NULL), a relation (Restrict) and `@@index([photographerId])`.
- The `service` relation **stays a simple FK**, because Prisma rejects a composite relation that mixes optional and required fields.
- **Application rule:** the add-on's photographer must equal the booking's or package's. Fix `catalogue/basket.ts:66-72` and `booking/addons.ts:73-79`. `routes/admin-catalogue.ts:211,224` must check that `serviceId` belongs to the signed-in photographer.

### 2.8 `Client` (`client`)
**Current:** `schema.prisma:177-192`; `client_lower_email_unique` init `:336`.
- **Add** `userId String?`, `user AppUser? @relation(onDelete: SetNull)` and `@@index([userId])`. It is **not unique**: one user can own several client rows after an email change.
- `lower(email)` uniqueness stays **global**.
- **Linking:**
  - On email verification: `UPDATE client SET user_id = $user WHERE lower(email) = lower($verified_email) AND user_id IS NULL`.
  - In `upsertClient` (`booking/client.ts:24-36`), set `user_id` from a verified client account with the same email. On conflict, use `COALESCE(client.user_id, EXCLUDED.user_id)`.
- **Privacy:** photographer endpoints show only the booking snapshots (`contact_*`), never the live `client` row.

### 2.9 `Booking` (`booking`)
**Current:** `schema.prisma:196-305`; init `:124-168`; indexes `:256-271`; FKs `:304-310`; `booking_hold_expires_at_idx` `:376-378`; **`booking_no_overlap` `:399-401`**; CHECKs `:443-457`; pending-email CHECK and partial unique in `20260925190000_contact_email_change/migration.sql:11-20`.

```prisma
model Booking {
  // ...unchanged fields...
+ /// Resolved on the server from the package, never taken from the request body.
+ photographerId String @map("photographer_id") @db.Uuid
  /// pending_payment | confirmed | completed | no_show | expired |
  /// cancelled_by_client | cancelled_by_photographer | cancelled_by_platform
  status String @default("pending_payment")
  /// = ends_at + photographer_setting.buffer_minutes AT CREATION.
  bufferEndsAt  DateTime
  /// = now() + platform_setting.hold_minutes at creation.
  holdExpiresAt DateTime?
  /// Resolved at creation: service override, else photographer_setting.booking_fee_rate.
  bookingFeeRate Decimal
+ /// = photographer_setting.client_cancel_cutoff_hours AT CREATION (R1.8).
+ clientCancelCutoffHours            Int     @map("client_cancel_cutoff_hours")
+ /// = photographer_setting.booking_fee_refundable_on_client_cancel AT CREATION (R1.8).
+ bookingFeeRefundableOnClientCancel Boolean @map("booking_fee_refundable_on_client_cancel")
+ photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Restrict)
- service  Service @relation(fields: [serviceId], references: [id], onDelete: Restrict)
- package  Package @relation(fields: [packageId], references: [id], onDelete: Restrict)
+ service  Service @relation(fields: [serviceId, photographerId], references: [id, photographerId], onDelete: Restrict)
+ package  Package @relation(fields: [packageId, photographerId], references: [id, photographerId], onDelete: Restrict)

  @@index([status, startsAt])                                  // kept: global jobs
+ @@index([photographerId, status, startsAt])                  // studio calendar/list/availability
  @@index([clientId, startsAt(sort: Desc)])                    // kept: client account across photographers
+ @@index([photographerId, clientId, startsAt(sort: Desc)])
  @@index([serviceId])
  @@index([packageId])
}
```

**Exclusion constraint replaced:**
```sql
ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (
    photographer_id WITH =,
    tstzrange(starts_at, buffer_ends_at, '[)') WITH &&
  )
  WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'));
```

**Status CHECK replaced:** `cancelled_by_admin` → `cancelled_by_photographer`, and `cancelled_by_platform` is added (a platform admin cancelling an individual booking). Both release the slot, and both refund the booking fee in full. `OCCUPYING_STATUSES` is unchanged.

All other CHECKs, uniques and indexes are carried over verbatim. The hold sweeper stays global.

**Cancellation policy snapshot (decided 2026-10-16, R1.8).** A booking keeps the client cancellation policy it was made under, exactly as it keeps its price, fee rate and buffer. `photographer_setting` holds what a photographer offers *now*; editing it must never change the terms of a booking the client has already paid for. So `booking` carries its own copy:
- `client_cancel_cutoff_hours int NOT NULL`, with `CHECK booking_cancel_cutoff_non_negative (client_cancel_cutoff_hours >= 0)`.
- `booking_fee_refundable_on_client_cancel boolean NOT NULL`.

Both are written by `booking/create.ts` inside the slot claim, from the photographer's settings at that moment, and have no column default, so no insert can skip them. `booking/access.ts` (`cancellationPolicyOf`), `canCancel` and `booking/cancel.ts` read the booking's columns, never the settings. The client's booking page and the checkout expose them as `cancellation: { deadline, bookingFeeRefundable }`. The incremental migration `20261017000000_booking_cancellation_policy` adds the columns with temporary defaults, backfills any existing rows from their photographer's current settings, then drops the defaults.

### 2.10 `BookingAddon`: KEEP
Unchanged. Cross-tenant add-ons are prevented in the write paths listed in §2.7.

### 2.11 `Payment` (`payment`)
> **Deferred with cards (user decision, 2026-10-17).** Card payments are deferred (marketplace-spec.md R3.2, R3.3), so `checkout_url`, the `flutterwave_checkout` provider id and the `payment_checkout_url_https` CHECK below are **not** built in Phase 3 and no migration adds them. Phase 3 keeps `payment` as it is: providers `mtn_momo_direct`, `flutterwave` and `cash`; the `method` vocabulary keeps `card` reserved. Phase 3 now writes `payment.method` with the attempt (the client's choice), not only from the provider's event. The rest of this section (nullable `booking_id`, `subscription_id`, `plan_interval`, kind `subscription`) is unchanged and still arrives with Phase 5.

**Current:** `schema.prisma:334-371`; init `:186-205`; uniques and indexes `:280`, `:283`, `:342-344`, `:350-352`; FK `:319`; CHECKs init `:465-472` and `20260928100000_cash_payments/migration.sql:7-14`.

**Decision: one `payment` table**, with `booking_id` nullable plus a new `subscription_id` and a CHECK that exactly one is set. A separate subscription-payment table is rejected because:
- webhook matching (`payments/webhooks.ts:312-327`), the `our_ref` / `provider_ref` uniqueness, reconcile (`reconcile.ts:54-63`), the state machine and `webhook_event.our_ref` all stay single and unchanged
- a second table would need cross-table uniqueness, which PG can't do

A polymorphic `subject_type` / `subject_id` design is rejected too: it has no FK.

```prisma
model Payment {
- bookingId      String  @map("booking_id") @db.Uuid
+ /// Set for booking_fee and session_fee. Null for subscription.
+ bookingId      String? @map("booking_id") @db.Uuid
+ subscriptionId String? @map("subscription_id") @db.Uuid
  /// booking_fee | session_fee | subscription
  kind     String
  /// mtn_momo_direct | flutterwave | flutterwave_checkout | cash
  provider String
  /// momo_mtn | momo_airtel | card
  method   String?
+ /// monthly | yearly. Frozen at initiation for kind = subscription.
+ planInterval String? @map("plan_interval")
+ /// Hosted checkout page. Lets "in progress" send the payer back to the same page.
+ checkoutUrl  String? @map("checkout_url")
  // ...amount_rwf, status, failure_reason, initiated_at, settled_at, refunded_at, refund_reference, note unchanged
+ booking            Booking?      @relation(fields: [bookingId], references: [id], onDelete: Restrict)
+ subscription       Subscription? @relation(fields: [subscriptionId], references: [id], onDelete: Restrict)
+ subscriptionPeriod SubscriptionPeriod?
+ payoutItems        PayoutItem[]
  @@index([bookingId, kind, status])
+ @@index([subscriptionId, status])
}
```

There is deliberately no `payment.photographer_id`; it is derivable through the booking or the subscription.

```sql
ALTER TABLE "payment"
  ADD CONSTRAINT "payment_kind_allowed" CHECK (kind IN ('booking_fee', 'session_fee', 'subscription')),
  ADD CONSTRAINT "payment_provider_allowed" CHECK (provider IN ('mtn_momo_direct', 'flutterwave', 'flutterwave_checkout', 'cash')),
  ADD CONSTRAINT "payment_method_allowed" CHECK (method IS NULL OR method IN ('momo_mtn', 'momo_airtel', 'card')),
  ADD CONSTRAINT "payment_amount_positive" CHECK (amount_rwf > 0),
  ADD CONSTRAINT "payment_status_allowed" CHECK (status IN ('initiated', 'pending', 'succeeded', 'failed', 'refund_due', 'refunded')),
  ADD CONSTRAINT "payment_note_length" CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 500),
  ADD CONSTRAINT "payment_subject_exactly_one" CHECK (num_nonnulls(booking_id, subscription_id) = 1),
  ADD CONSTRAINT "payment_subject_matches_kind" CHECK ((kind = 'subscription') = (subscription_id IS NOT NULL)),
  ADD CONSTRAINT "payment_plan_interval_matches_kind" CHECK ((kind = 'subscription') = (plan_interval IS NOT NULL)),
  ADD CONSTRAINT "payment_plan_interval_allowed" CHECK (plan_interval IS NULL OR plan_interval IN ('monthly', 'yearly')),
  ADD CONSTRAINT "payment_cash_is_session_fee" CHECK (provider <> 'cash' OR kind = 'session_fee'),
  ADD CONSTRAINT "payment_checkout_url_https" CHECK (checkout_url IS NULL OR checkout_url ~ '^https://');

CREATE INDEX "payment_pending_lookup_idx" ON "payment" (provider, initiated_at) WHERE status = 'pending';
```

`payment_provider_ref_unique` and `payment_one_succeeded_booking_fee` are recreated verbatim.

**Why `flutterwave_checkout` is a separate provider id:** the provider seam (`payments/provider.ts:145-163`) has one initiate, verify and lookup per id. Hosted checkout returns a redirect, which the current adapter refuses (`flutterwave.ts:129-130`, `redirect_required`).

### 2.12 `WebhookEvent`: CHECK only
The provider CHECK gains `flutterwave_checkout`. **Deferred with cards (2026-10-17):** until card payments are built, the CHECK stays `provider IN ('mtn_momo_direct', 'flutterwave')`.

### 2.13 `BookingNote`: KEEP
Authorisation is scoped through `booking.photographer_id` in `booking/notes.ts`.

### 2.14 `Outbox` (`outbox`)
**Current:** `schema.prisma:428-461`; init `:227-244`; latest template CHECK in `20260925210000_booking_notes/migration.sql:21-28`.
- **Add** `photographerId String?`, a relation (Restrict) and `@@index([photographerId, createdAt])`.

```sql
ALTER TABLE "outbox"
  ADD CONSTRAINT "outbox_booking_has_photographer" CHECK (booking_id IS NULL OR photographer_id IS NOT NULL),
  ADD CONSTRAINT "outbox_template_allowed" CHECK (template IS NULL OR template IN (
    'booking_confirmation', 'photographer_new_booking', 'session_fee_request',
    'payment_receipt', 'photo_delivery', 'cancellation', 'reschedule',
    'access_link_resend', 'photographer_alert', 'platform_alert', 'booking_links',
    'email_change_confirm', 'email_changed_notice', 'client_note',
    'account_verify_email', 'account_password_reset', 'account_security_alert',
    'photographer_application_received', 'photographer_approved', 'photographer_suspended',
    'subscription_reminder', 'subscription_receipt', 'subscription_expired',
    'payout_sent'
  ));
```

- `admin_alert` is split into `photographer_alert` and `platform_alert`.
- Password reset and lockout move to `account_password_reset` and `account_security_alert`.
- `enqueue()` sets `photographer_id` from the booking.
- **Phase 1 refinements (2026-10-16):**
  - A row with no booking may name its photographer explicitly; `photographer_alert` rows do. Naming a photographer other than the booking's is refused.
  - Account and platform mail (`account_*`, `platform_alert`) has no `photographer_id`.
  - When the worker gives up on a row, the alert goes to the row's photographer as `photographer_alert`. A row with no photographer alerts every platform admin whose login is on, one `platform_alert` row each. A failed alert is logged only.
  - The names reserved for later phases (`account_verify_email`, `photographer_*` lifecycle mail, `subscription_*`, `payout_sent`) are in the CHECK but have no renderer yet. In code, `RESERVED_EMAIL_TEMPLATES` lists them and `enqueue()` refuses them at the type level.

## 3. New models

### 3.1 `AppUser`
```prisma
model AppUser {
  id                     String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  email                  String    /// unique on lower(email), SQL
  role                   String    /// platform_admin | photographer | client
  fullName               String?   @map("full_name")
  passwordHash           String?   @map("password_hash")   /// nullable: Google-only clients
  googleSub              String?   @map("google_sub")      /// clients only
  emailVerifiedAt        DateTime? @map("email_verified_at") @db.Timestamptz(6)
  emailVerifyTokenHash   String?   @map("email_verify_token_hash")
  emailVerifyExpiresAt   DateTime? @map("email_verify_expires_at") @db.Timestamptz(6)
  failedLoginCount       Int       @default(0) @map("failed_login_count")
  lockedUntil            DateTime? @map("locked_until") @db.Timestamptz(6)
  passwordResetTokenHash String?   @map("password_reset_token_hash")
  passwordResetExpiresAt DateTime? @map("password_reset_expires_at") @db.Timestamptz(6)
  lastLoginAt            DateTime? @map("last_login_at") @db.Timestamptz(6)
  disabledAt             DateTime? @map("disabled_at") @db.Timestamptz(6)
  anonymizedAt           DateTime? @map("anonymized_at") @db.Timestamptz(6)
  tokenVersion           Int       @default(0) @map("token_version")   /// Phase 2: revokes every token when bumped
  createdAt              DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt              DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  photographer          Photographer?  @relation("PhotographerOwner")
  approvedPhotographers Photographer[] @relation("PhotographerApprovedBy")
  clients               Client[]
  payoutsCreated        Payout[]       @relation("PayoutCreatedBy")
  payoutsPaid           Payout[]       @relation("PayoutPaidBy")
  @@map("app_user")
}
```
`photographer.user_id` must point at a user with `role = 'photographer'`. This is enforced in the signup transaction and covered by a test.

### 3.2 `PlatformSetting` and `PhotographerSetting`
```prisma
/// One row, CHECK (id = 1).
model PlatformSetting {
  id                          Int      @id @default(1)
  holdMinutes                 Int      @default(30) @map("hold_minutes")
  trialDays                   Int      @default(30) @map("trial_days")
  subscriptionMonthlyPriceRwf Int      @map("subscription_monthly_price_rwf")
  subscriptionYearlyPriceRwf  Int      @map("subscription_yearly_price_rwf")
  subscriptionGraceDays       Int      @default(7) @map("subscription_grace_days")
  subscriptionReminderDays    Int[]    @default([7, 3, 1]) @map("subscription_reminder_days")
  updatedAt                   DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@map("platform_setting")
}

model PhotographerSetting {
  photographerId                    String   @id @map("photographer_id") @db.Uuid
  bookingFeeRate                    Decimal  @default(0.400) @map("booking_fee_rate") @db.Decimal(4, 3)
  minLeadTimeMinutes                Int      @default(120) @map("min_lead_time_minutes")
  bufferMinutes                     Int      @default(30) @map("buffer_minutes")
  deliveryExpiryDays                Int      @default(90) @map("delivery_expiry_days")
  clientCancelCutoffHours           Int      @default(0) @map("client_cancel_cutoff_hours")
  bookingFeeRefundableOnClientCancel Boolean @default(false) @map("booking_fee_refundable_on_client_cancel")
  updatedAt                         DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Cascade)
  @@map("photographer_setting")
}
```

### 3.3 `Photographer`
```prisma
model Photographer {
  id               String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  userId           String    @unique @map("user_id") @db.Uuid
  handle           String    @unique   /// /p/<handle>; lowercase by CHECK
  displayName      String    @map("display_name")
  bio              String?
  contactPhone     String?   @map("contact_phone")
  whatsappPhone    String?   @map("whatsapp_phone")
  contactEmail     String?   @map("contact_email")
  coverImageUrl    String?   @map("cover_image_url")   /// pasted https URL
  status           String    @default("pending")       /// pending | approved | suspended
  submittedAt      DateTime? @map("submitted_at") @db.Timestamptz(6)  /// set by the setup checklist (R7.3)
  approvedAt       DateTime? @map("approved_at") @db.Timestamptz(6)
  approvedByUserId String?   @map("approved_by_user_id") @db.Uuid
  suspendedAt      DateTime? @map("suspended_at") @db.Timestamptz(6)
  suspensionReason String?   @map("suspension_reason")
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)

  user               AppUser                @relation("PhotographerOwner", fields: [userId], references: [id], onDelete: Restrict)
  approvedBy         AppUser?               @relation("PhotographerApprovedBy", fields: [approvedByUserId], references: [id], onDelete: SetNull)
  setting            PhotographerSetting?
  subscription       Subscription?
  districts          PhotographerDistrict[]
  categories         PhotographerCategory[]
  portfolioImages    PortfolioImage[]
  workingHours       WorkingHours[]
  availabilityBlocks AvailabilityBlock[]
  services           Service[]
  packages           Package[]
  addons             Addon[]
  bookings           Booking[]
  outbox             Outbox[]
  payoutMethods      PayoutMethod[]
  payouts            Payout[]
  payoutItems        PayoutItem[]
  @@index([status])
  @@map("photographer")
}
```

### 3.4 `District` and `PhotographerDistrict`
```prisma
/// Rwanda's 30 districts, inserted BY THE MIGRATION.
model District {
  code      String @id          /// e.g. 'gasabo'
  name      String
  province  String              /// kigali | eastern | northern | southern | western
  sortOrder Int    @default(0) @map("sort_order")
  photographers PhotographerDistrict[]
  @@map("district")
}
model PhotographerDistrict {
  photographerId String @map("photographer_id") @db.Uuid
  districtCode   String @map("district_code")
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Cascade)
  district     District     @relation(fields: [districtCode], references: [code], onDelete: Restrict)
  @@id([photographerId, districtCode])
  @@index([districtCode, photographerId])
  @@map("photographer_district")
}
```

### 3.5 `Category` and `PhotographerCategory`
```prisma
model Category {
  id        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug      String   @unique
  nameEn    String   @map("name_en")
  nameFr    String?  @map("name_fr")
  isActive  Boolean  @default(true) @map("is_active")
  sortOrder Int      @default(0) @map("sort_order")
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  photographers PhotographerCategory[]
  @@map("category")
}
model PhotographerCategory {
  photographerId String @map("photographer_id") @db.Uuid
  categoryId     String @map("category_id") @db.Uuid
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Cascade)
  category     Category     @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  @@id([photographerId, categoryId])
  @@index([categoryId, photographerId])
  @@map("photographer_category")
}
```

### 3.6 `PortfolioImage`
```prisma
/// Pasted https URLs only; at most 24 per photographer (enforced in the app).
model PortfolioImage {
  id             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  photographerId String   @map("photographer_id") @db.Uuid
  url            String
  caption        String?
  sortOrder      Int      @default(0) @map("sort_order")
  createdAt      DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Cascade)
  @@index([photographerId, sortOrder])
  @@map("portfolio_image")
}
```

### 3.7 `Subscription` and `SubscriptionPeriod`
```prisma
/// One per photographer, created at APPROVAL with its trial period. Never auto-charged.
model Subscription {
  id                  String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  photographerId      String   @unique @map("photographer_id") @db.Uuid
  status              String   @default("trialing")   /// trialing | active | past_due | expired
  currentPeriodEndsAt DateTime @map("current_period_ends_at") @db.Timestamptz(6)
  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt           DateTime @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  photographer Photographer         @relation(fields: [photographerId], references: [id], onDelete: Restrict)
  periods      SubscriptionPeriod[]
  payments     Payment[]
  @@index([status, currentPeriodEndsAt])
  @@map("subscription")
}
model SubscriptionPeriod {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  subscriptionId String    @map("subscription_id") @db.Uuid
  kind           String    /// trial | paid
  planInterval   String?   @map("plan_interval")    /// monthly | yearly; null for the trial
  priceRwf       Int       @map("price_rwf")         /// 0 for the trial
  startsAt       DateTime  @map("starts_at") @db.Timestamptz(6)
  endsAt         DateTime  @map("ends_at") @db.Timestamptz(6)
  paymentId      String?   @unique @map("payment_id") @db.Uuid
  voidedAt       DateTime? @map("voided_at") @db.Timestamptz(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  subscription Subscription @relation(fields: [subscriptionId], references: [id], onDelete: Restrict)
  payment      Payment?     @relation(fields: [paymentId], references: [id], onDelete: Restrict)
  @@index([subscriptionId, endsAt])
  @@map("subscription_period")
}
```

Rules:
- **New period:** `starts_at = greatest(now(), current_period_ends_at)`, and `ends_at` adds one month or one year on the Kigali calendar.
- **Status:** `trialing` or `active` while `now < current_period_ends_at`; `past_due` until the end plus the grace days; `expired` after that.
- **Bookable** iff `photographer.status = 'approved' AND subscription.status IN ('trialing','active') AND current_period_ends_at > now()`.
- **Reminders:** an outbox row with `dedupe_key = 'email:subscription_reminder:<sub_id>:<period_end ISO>:<days>'`.

### 3.8 `PayoutMethod`
```prisma
/// IMMUTABLE: a change retires the row and inserts a new one.
model PayoutMethod {
  id                String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  photographerId    String    @map("photographer_id") @db.Uuid
  kind              String    /// momo | bank
  momoNetwork       String?   @map("momo_network")        /// mtn | airtel
  momoNumber        String?   @map("momo_number")         /// E.164
  bankName          String?   @map("bank_name")
  bankAccountNumber String?   @map("bank_account_number")
  accountName       String    @map("account_name")
  retiredAt         DateTime? @map("retired_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Restrict)
  payouts      Payout[]
  @@index([photographerId, createdAt])
  @@map("payout_method")
}
```

### 3.9 `Payout` and `PayoutItem`
```prisma
model Payout {
  id                String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  photographerId    String    @map("photographer_id") @db.Uuid
  status            String    @default("draft")   /// draft | paid | cancelled
  amountRwf         Int       @map("amount_rwf")
  payoutMethodId    String    @map("payout_method_id") @db.Uuid
  transferReference String?   @map("transfer_reference")
  note              String?
  createdByUserId   String    @map("created_by_user_id") @db.Uuid
  paidByUserId      String?   @map("paid_by_user_id") @db.Uuid
  paidAt            DateTime? @map("paid_at") @db.Timestamptz(6)
  cancelledAt       DateTime? @map("cancelled_at") @db.Timestamptz(6)
  createdAt         DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime  @default(now()) @updatedAt @map("updated_at") @db.Timestamptz(6)
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Restrict)
  payoutMethod PayoutMethod @relation(fields: [payoutMethodId], references: [id], onDelete: Restrict)
  createdBy    AppUser      @relation("PayoutCreatedBy", fields: [createdByUserId], references: [id], onDelete: Restrict)
  paidBy       AppUser?     @relation("PayoutPaidBy", fields: [paidByUserId], references: [id], onDelete: Restrict)
  items        PayoutItem[]
  @@index([photographerId, createdAt(sort: Desc)])
  @@index([status])
  @@map("payout")
}
model PayoutItem {
  id             String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  photographerId String    @map("photographer_id") @db.Uuid
  paymentId      String    @map("payment_id") @db.Uuid
  kind           String    /// earning | reversal
  amountRwf      Int       @map("amount_rwf")   /// earning > 0, reversal < 0
  payoutId       String?   @map("payout_id") @db.Uuid
  voidedAt       DateTime? @map("voided_at") @db.Timestamptz(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  photographer Photographer @relation(fields: [photographerId], references: [id], onDelete: Restrict)
  payment      Payment      @relation(fields: [paymentId], references: [id], onDelete: Restrict)
  payout       Payout?      @relation(fields: [payoutId], references: [id], onDelete: Restrict)
  @@unique([paymentId, kind])
  @@index([payoutId])
  @@map("payout_item")
}
```

Lifecycle, all in the transaction that changes the payment:
- **Payment succeeds** (booking or session fee, not cash): insert an `earning` of `amount_rwf - overpaid_rwf` (the full amount unless the session fee was overpaid; see the overpayment refinements below).
- **Payment becomes `refund_due`:** set `voided_at` if the earning has no `payout_id`, otherwise insert a `reversal`.

"Payable now" is calculated each time:
```sql
SELECT pi.* FROM payout_item pi
  JOIN payment p ON p.id = pi.payment_id
  LEFT JOIN booking b ON b.id = p.booking_id
 WHERE pi.photographer_id = $1 AND pi.payout_id IS NULL AND pi.voided_at IS NULL
   AND ( pi.kind = 'reversal'
      OR (p.status = 'succeeded' AND p.kind = 'booking_fee')
      OR (p.status = 'succeeded' AND p.kind = 'session_fee' AND b.ends_at <= now()
          AND b.status NOT IN ('cancelled_by_client','cancelled_by_photographer','cancelled_by_platform','expired')) );
```

- **Build:** lock the items, create a draft with the total, and set `payout_id`. If the total is ≤ 0, no payout is created.
- **Mark paid:** set the reference, paid time and paid-by user, then enqueue `payout_sent`.
- **Cancel a draft:** clear `payout_id` on its items.

**Phase 4 refinements (as built, migration `20261017172827_payouts`):**
- **Who did what** on every row of money out:
  - `payout.cancelled_by_user_id` (RESTRICT → `app_user`), required once cancelled (CHECK `payout_cancelled_has_user`).
  - `payment.refunded_by_user_id` (RESTRICT → `app_user`), set only on a refunded payment (CHECK `payment_refunded_by_when_refunded`). It is the photographer for cash and a platform admin for money paid online (marketplace-spec.md Phase 4 refund decision).
- **`payout → payout_method` is a composite foreign key** `(payout_method_id, photographer_id) → payout_method (id, photographer_id)`, with `@@unique([id, photographerId])` on `PayoutMethod`, so a payout can only name its own photographer's destination. `payout_item → payout` stays a simple key: Prisma refuses a composite relation mixing the optional `payout_id` with the required `photographer_id`. The ledger and the build scope it in code.
- **Extra CHECKs** beyond §3.11:
  - `payout_method_momo_number_e164`: `^\+2507[2389][0-9]{7}$`.
  - `payout_method_bank_fields_length`: bank name 1-100, account number 1-40.
  - `payout_unpaid_has_no_transfer`: only a paid payout carries a reference, a paid time or a paid-by user.
  - `payout_transfer_reference_length` (1-100) and `payout_note_length` (1-500).
- **Refund while the earning is in a draft:** the earning gets a reversal (the rule above), so the draft's amount stays true. **Cancelling that draft voids the earning and its reversal together**: otherwise the earning, no longer `succeeded`, would never be payable while its reversal always is (`releaseDraftItems`, payouts/ledger.ts).
- **"Payable now"** binds the app's injected clock where the SQL above says `now()`.
- **No backfill:** payments that succeeded before the migration have no earning.
- **`payout_sent`** is sendable (it has a renderer); `RESERVED_EMAIL_TEMPLATES` now holds only the three `subscription_*` names. `account_security_alert` gains the `payout_method_changed` variant.

**Phase 4 overpayment refinements (as built, migration `20261017193312_payment_overpayment`; marketplace-spec.md Phase 4 overpayment decision):**

```prisma
model Payment {
  // ...
  overpaidRwf                 Int       @default(0) @map("overpaid_rwf")
  overpaymentRefundedAt       DateTime? @map("overpayment_refunded_at") @db.Timestamptz(6)
  overpaymentRefundReference  String?   @map("overpayment_refund_reference")
  overpaymentRefundedByUserId String?   @map("overpayment_refunded_by_user_id") @db.Uuid
  overpaymentRefundedBy AppUser? @relation("PaymentOverpaymentRefundedBy", fields: [overpaymentRefundedByUserId], references: [id], onDelete: Restrict)
}
```

- **Columns on `payment`, not a table.** A payment has at most one overpayment, fixed as it succeeds, and the full refund it might later need is already on the same row.
- **`overpaid_rwf`** is the part of an online session fee over what the booking was worth when it succeeded. It is set in the update that sets `succeeded`, under the booking's row lock, and measured against what was due before it (earlier overpaid parts excluded). The payment stays `succeeded`, and its earning is `amount_rwf - overpaid_rwf`. A fee that is wholly extra (`overpaid >= amount`) is `refund_due` instead (`duplicate_payment`), and earns nothing.
- **Derived totals** (§6.1 of data-model_v2.md, `booking/totals.ts`):
  - `collectedRwf` sums each succeeded payment's `amount_rwf - overpaid_rwf`.
  - `refundDueRwf` adds overpaid parts not yet returned. A `refund_due` payment counts as its `amount_rwf`, less `overpaid_rwf` when the overpayment was already returned (`refundAmountRwf`).
- **CHECKs:**
  - `payment_overpaid_range`: `overpaid_rwf >= 0 AND overpaid_rwf < amount_rwf`.
  - `payment_overpaid_online_session_fee`: only a non-cash session fee is ever overpaid.
  - `payment_overpayment_refund_complete`: the three `overpayment_*` columns are all set or all null, and set only when `overpaid_rwf > 0`.
  - `payment_overpayment_refund_reference_length`: 1-100.
- **`overpayment_refunded_by_user_id`** is RESTRICT → `app_user`: the platform admin who recorded it.
- **Online refund references are used once**, across both columns:
  - `payment_refund_reference_online_unique` on `(refund_reference) WHERE refund_reference IS NOT NULL AND provider <> 'cash'`;
  - `payment_overpayment_refund_reference_unique` on `(overpayment_refund_reference) WHERE overpayment_refund_reference IS NOT NULL`;
  - the check across the two columns is in code, under a per-reference advisory lock (`payments/refund.ts`), with `23505` mapped to `duplicate_refund_reference`.

  Cash references are the photographer's own words and stay outside the rule. If a database already holds two online refunds with one reference, the first index refuses to build: resolve them by hand before migrating.
- **No backfill:** an overpayment taken before this migration has `overpaid_rwf = 0` and its earning at the full amount.

### 3.10 Referential behaviour
| Relationship | On delete |
|---|---|
| `photographer` → `app_user` | RESTRICT |
| `photographer.approved_by_user_id` | SET NULL |
| setting, hours, blocks, districts, categories and portfolio → `photographer` | CASCADE |
| service, package, addon, booking, subscription, payout_method, payout, payout_item, outbox → `photographer` | RESTRICT |
| composite package → service, booking → service/package | RESTRICT |
| `client.user_id` | SET NULL |
| payment, subscription_period, payout_item and payout relations | RESTRICT |
| booking_addon, booking_note → booking | CASCADE (unchanged) |

### 3.11 Hand-written SQL block (baseline migration)
```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- top of file

CREATE UNIQUE INDEX "app_user_lower_email_unique" ON "app_user" (lower(email));
CREATE UNIQUE INDEX "client_lower_email_unique"   ON "client"   (lower(email));
CREATE UNIQUE INDEX "app_user_google_sub_unique"  ON "app_user" (google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX "app_user_password_reset_token_hash_unique" ON "app_user" (password_reset_token_hash) WHERE password_reset_token_hash IS NOT NULL;
CREATE UNIQUE INDEX "app_user_email_verify_token_hash_unique"   ON "app_user" (email_verify_token_hash)   WHERE email_verify_token_hash IS NOT NULL;
CREATE UNIQUE INDEX "payment_provider_ref_unique"        ON "payment" (provider_ref) WHERE provider_ref IS NOT NULL;
CREATE UNIQUE INDEX "payment_one_succeeded_booking_fee"  ON "payment" (booking_id)   WHERE kind = 'booking_fee' AND status = 'succeeded';
CREATE UNIQUE INDEX "booking_pending_email_token_hash_unique" ON "booking" (pending_email_token_hash) WHERE pending_email_token_hash IS NOT NULL;
CREATE UNIQUE INDEX "working_hours_weekday_unique"        ON "working_hours" (photographer_id, weekday)        WHERE effective_date IS NULL;
CREATE UNIQUE INDEX "working_hours_effective_date_unique" ON "working_hours" (photographer_id, effective_date) WHERE weekday IS NULL;
CREATE UNIQUE INDEX "subscription_period_one_trial"       ON "subscription_period" (subscription_id) WHERE kind = 'trial';
CREATE UNIQUE INDEX "payout_method_one_current"           ON "payout_method" (photographer_id) WHERE retired_at IS NULL;
CREATE UNIQUE INDEX "payout_one_draft"                    ON "payout" (photographer_id) WHERE status = 'draft';
CREATE UNIQUE INDEX "payout_transfer_reference_unique"    ON "payout" (transfer_reference) WHERE transfer_reference IS NOT NULL;

CREATE INDEX "outbox_queue_idx"             ON "outbox" (status, next_attempt_at) WHERE status IN ('pending', 'processing');
CREATE INDEX "booking_hold_expires_at_idx"  ON "booking" (hold_expires_at) WHERE status = 'pending_payment';
CREATE INDEX "availability_block_range_idx" ON "availability_block" USING gist (photographer_id, tstzrange(starts_at, ends_at, '[)'));
CREATE INDEX "package_directory_price_idx"  ON "package" (photographer_id, price_rwf) WHERE is_active;
CREATE INDEX "payment_pending_lookup_idx"   ON "payment" (provider, initiated_at) WHERE status = 'pending';
CREATE INDEX "payout_item_unpaid_idx"       ON "payout_item" (photographer_id) WHERE payout_id IS NULL AND voided_at IS NULL;

ALTER TABLE "booking" ADD CONSTRAINT "booking_no_overlap"
  EXCLUDE USING gist (photographer_id WITH =, tstzrange(starts_at, buffer_ends_at, '[)') WITH &&)
  WHERE (status IN ('pending_payment', 'confirmed', 'completed', 'no_show'));
ALTER TABLE "subscription_period" ADD CONSTRAINT "subscription_period_no_overlap"
  EXCLUDE USING gist (subscription_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (voided_at IS NULL);

ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_role_allowed" CHECK (role IN ('platform_admin', 'photographer', 'client')),
  ADD CONSTRAINT "app_user_email_verify_complete" CHECK ((email_verify_token_hash IS NULL) = (email_verify_expires_at IS NULL)),
  ADD CONSTRAINT "app_user_password_reset_complete" CHECK ((password_reset_token_hash IS NULL) = (password_reset_expires_at IS NULL)),
  ADD CONSTRAINT "app_user_google_client_only" CHECK (google_sub IS NULL OR role = 'client'),
  ADD CONSTRAINT "app_user_has_credential" CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL);
ALTER TABLE "platform_setting"
  ADD CONSTRAINT "platform_setting_single_row" CHECK (id = 1),
  ADD CONSTRAINT "platform_setting_hold_minutes_positive" CHECK (hold_minutes > 0),
  ADD CONSTRAINT "platform_setting_trial_days_non_negative" CHECK (trial_days >= 0),
  ADD CONSTRAINT "platform_setting_prices_positive" CHECK (subscription_monthly_price_rwf > 0 AND subscription_yearly_price_rwf > 0),
  ADD CONSTRAINT "platform_setting_grace_days_non_negative" CHECK (subscription_grace_days >= 0),
  ADD CONSTRAINT "platform_setting_reminder_days_valid" CHECK (cardinality(subscription_reminder_days) <= 10 AND 0 < ALL (subscription_reminder_days));
ALTER TABLE "photographer_setting"
  ADD CONSTRAINT "photographer_setting_booking_fee_rate_range" CHECK (booking_fee_rate >= 0 AND booking_fee_rate <= 1),
  ADD CONSTRAINT "photographer_setting_min_lead_time_non_negative" CHECK (min_lead_time_minutes >= 0),
  ADD CONSTRAINT "photographer_setting_buffer_minutes_non_negative" CHECK (buffer_minutes >= 0),
  ADD CONSTRAINT "photographer_setting_delivery_expiry_days_positive" CHECK (delivery_expiry_days > 0),
  ADD CONSTRAINT "photographer_setting_cancel_cutoff_non_negative" CHECK (client_cancel_cutoff_hours >= 0);
ALTER TABLE "photographer"
  ADD CONSTRAINT "photographer_status_allowed" CHECK (status IN ('pending', 'approved', 'suspended')),
  ADD CONSTRAINT "photographer_handle_format" CHECK (handle ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$'),
  ADD CONSTRAINT "photographer_display_name_length" CHECK (char_length(display_name) BETWEEN 1 AND 80),
  ADD CONSTRAINT "photographer_bio_length" CHECK (bio IS NULL OR char_length(bio) <= 2000),
  ADD CONSTRAINT "photographer_cover_image_https" CHECK (cover_image_url IS NULL OR cover_image_url ~ '^https://'),
  ADD CONSTRAINT "photographer_approved_has_date" CHECK (status <> 'approved' OR approved_at IS NOT NULL),
  ADD CONSTRAINT "photographer_suspended_has_date" CHECK (status <> 'suspended' OR suspended_at IS NOT NULL);
ALTER TABLE "district" ADD CONSTRAINT "district_province_allowed" CHECK (province IN ('kigali', 'eastern', 'northern', 'southern', 'western'));
ALTER TABLE "category" ADD CONSTRAINT "category_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "portfolio_image"
  ADD CONSTRAINT "portfolio_image_url_https" CHECK (url ~ '^https://'),
  ADD CONSTRAINT "portfolio_image_caption_length" CHECK (caption IS NULL OR char_length(caption) <= 200);
ALTER TABLE "service" ADD CONSTRAINT "service_slug_format" CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "booking" ADD CONSTRAINT "booking_status_allowed" CHECK (status IN ('pending_payment', 'confirmed', 'completed', 'no_show', 'expired', 'cancelled_by_client', 'cancelled_by_photographer', 'cancelled_by_platform'));
-- working_hours, availability_block, service fee override, package, addon, booking (other), booking_addon,
-- booking_note, webhook_event, outbox kind/status/attempts: carried over VERBATIM from the current migrations.
-- payment: §2.11. outbox templates: §2.14.
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_status_allowed" CHECK (status IN ('trialing', 'active', 'past_due', 'expired'));
ALTER TABLE "subscription_period"
  ADD CONSTRAINT "subscription_period_kind_allowed" CHECK (kind IN ('trial', 'paid')),
  ADD CONSTRAINT "subscription_period_plan_interval_allowed" CHECK (plan_interval IS NULL OR plan_interval IN ('monthly', 'yearly')),
  ADD CONSTRAINT "subscription_period_shape" CHECK (
       (kind = 'trial' AND payment_id IS NULL AND plan_interval IS NULL AND price_rwf = 0)
    OR (kind = 'paid'  AND payment_id IS NOT NULL AND plan_interval IS NOT NULL AND price_rwf > 0)),
  ADD CONSTRAINT "subscription_period_range_valid" CHECK (ends_at > starts_at);
ALTER TABLE "payout_method"
  ADD CONSTRAINT "payout_method_kind_allowed" CHECK (kind IN ('momo', 'bank')),
  ADD CONSTRAINT "payout_method_network_allowed" CHECK (momo_network IS NULL OR momo_network IN ('mtn', 'airtel')),
  ADD CONSTRAINT "payout_method_shape" CHECK (
       (kind = 'momo' AND momo_network IS NOT NULL AND momo_number IS NOT NULL AND bank_name IS NULL AND bank_account_number IS NULL)
    OR (kind = 'bank' AND bank_name IS NOT NULL AND bank_account_number IS NOT NULL AND momo_network IS NULL AND momo_number IS NULL)),
  ADD CONSTRAINT "payout_method_account_name_length" CHECK (char_length(account_name) BETWEEN 1 AND 120);
ALTER TABLE "payout"
  ADD CONSTRAINT "payout_status_allowed" CHECK (status IN ('draft', 'paid', 'cancelled')),
  ADD CONSTRAINT "payout_amount_positive" CHECK (amount_rwf > 0),
  ADD CONSTRAINT "payout_paid_complete" CHECK (status <> 'paid' OR (transfer_reference IS NOT NULL AND paid_at IS NOT NULL AND paid_by_user_id IS NOT NULL)),
  ADD CONSTRAINT "payout_cancelled_has_date" CHECK (status <> 'cancelled' OR cancelled_at IS NOT NULL);
ALTER TABLE "payout_item"
  ADD CONSTRAINT "payout_item_kind_allowed" CHECK (kind IN ('earning', 'reversal')),
  ADD CONSTRAINT "payout_item_sign_matches_kind" CHECK ((kind = 'earning' AND amount_rwf > 0) OR (kind = 'reversal' AND amount_rwf < 0)),
  ADD CONSTRAINT "payout_item_void_or_paid" CHECK (voided_at IS NULL OR payout_id IS NULL);

INSERT INTO "district" (code, name, province, sort_order) VALUES
  ('gasabo','Gasabo','kigali',1),('kicukiro','Kicukiro','kigali',2),('nyarugenge','Nyarugenge','kigali',3),
  ('bugesera','Bugesera','eastern',4),('gatsibo','Gatsibo','eastern',5),('kayonza','Kayonza','eastern',6),
  ('kirehe','Kirehe','eastern',7),('ngoma','Ngoma','eastern',8),('nyagatare','Nyagatare','eastern',9),('rwamagana','Rwamagana','eastern',10),
  ('burera','Burera','northern',11),('gakenke','Gakenke','northern',12),('gicumbi','Gicumbi','northern',13),
  ('musanze','Musanze','northern',14),('rulindo','Rulindo','northern',15),
  ('gisagara','Gisagara','southern',16),('huye','Huye','southern',17),('kamonyi','Kamonyi','southern',18),('muhanga','Muhanga','southern',19),
  ('nyamagabe','Nyamagabe','southern',20),('nyanza','Nyanza','southern',21),('nyaruguru','Nyaruguru','southern',22),('ruhango','Ruhango','southern',23),
  ('karongi','Karongi','western',24),('ngororero','Ngororero','western',25),('nyabihu','Nyabihu','western',26),
  ('nyamasheke','Nyamasheke','western',27),('rubavu','Rubavu','western',28),('rusizi','Rusizi','western',29),('rutsiro','Rutsiro','western',30);
```

### 3.12 Directory query
SQL handles status, subscription, category, district, price and a cheap date pre-filter (open that day and not wholly blocked). It joins a lateral subquery for `min(price_rwf)` over active packages of active services, orders by `from_price_rwf, display_name`, and uses `LIMIT/OFFSET`.

The exact "has at least one slot" check then runs the existing engine (`availability/engine.ts`) on the current page only, for the shortest active package.

Indexes serving it: `photographer_status_idx`, the subscription status index, the category and district join-table indexes, `package_directory_price_idx`, the working-hours uniques, `availability_block_range_idx`, and `booking_no_overlap`'s GiST index.

### 3.13 Reviews (later, not modelled)
A future `review` table would hang off `booking`:
- `booking_id` unique, allowed only for `completed` bookings
- `photographer_id`, `client_id`, optional `author_user_id`
- `rating smallint CHECK 1..5`, `body`, `photographer_reply`, `published_at` / `hidden_at`

### 3.14 `OauthFlow` (`oauth_flow`), Phase 2
One Google sign-in in flight (marketplace-spec.md R2.4, R2.1c; Phase 2 decision 6).
```prisma
model OauthFlow {
  id           String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  stateHash    String    @unique @map("state_hash")   /// SHA-256 hex of the state; never the state
  codeVerifier String    @map("code_verifier")        /// PKCE verifier, sent with the code
  nonce        String                                 /// must return as the id_token's nonce
  expiresAt    DateTime  @map("expires_at") @db.Timestamptz(6)   /// start + 10 minutes
  consumedAt   DateTime? @map("consumed_at") @db.Timestamptz(6)  /// set by the one consuming UPDATE
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  @@index([expiresAt])
  @@map("oauth_flow")
}
```
- **Hand-written CHECKs:** `oauth_flow_state_hash_sha256 (state_hash ~ '^[0-9a-f]{64}$')`, `oauth_flow_code_verifier_rfc7636 (code_verifier ~ '^[A-Za-z0-9._~-]{43,128}$')`, `oauth_flow_nonce_length (char_length(nonce) BETWEEN 16 AND 128)`.
- **Single-use:** the callback runs `UPDATE oauth_flow SET consumed_at = now WHERE state_hash = $1 AND consumed_at IS NULL AND expires_at > now RETURNING code_verifier, nonce`; a flow is spent even when the exchange that follows fails.
- **Retention:** each start deletes flows that expired more than a day ago. No foreign keys: a flow belongs to no user until Google answers.

## 4. Vocabularies (text + CHECK, with TS consts)

| Column | Values | TS home |
|---|---|---|
| `app_user.role` | `platform_admin`, `photographer`, `client` | new `auth/roles.ts` |
| `photographer.status` | `pending`, `approved`, `suspended` | new `photographers/statuses.ts` |
| `booking.status` | `cancelled_by_admin` → `cancelled_by_photographer`, + `cancelled_by_platform` | `db/statuses.ts:11-19` |
| `payment.kind` | + `subscription` | `payments/provider.ts:97` |
| `payment.provider`, `webhook_event.provider` | + `flutterwave_checkout` | `payments/provider.ts:79` |
| `plan_interval` | `monthly`, `yearly` | new `subscriptions/plan.ts` |
| `subscription.status` | `trialing`, `active`, `past_due`, `expired` | `subscriptions/plan.ts` |
| `subscription_period.kind` | `trial`, `paid` | `subscriptions/plan.ts` |
| `outbox.template` | 24 values (§2.14) | `outbox/enqueue.ts:25-39` |
| `district.province` | 5 provinces | new `directory/districts.ts` |
| `payout_method.kind` / `momo_network` | `momo`, `bank` / `mtn`, `airtel` | new `payouts/vocab.ts` |
| `payout.status` | `draft`, `paid`, `cancelled` | `payouts/vocab.ts` |
| `payout_item.kind` | `earning`, `reversal` | `payouts/vocab.ts` |

## 5. Migration strategy
**One squashed baseline**, `backend/prisma/migrations/<ts>_marketplace_init/migration.sql`. Production is empty, the change touches almost every table, and several vocabularies have been rewritten across four migrations already.

1. Write the new `schema.prisma`.
2. Delete the five old migration directories. Keep `migration_lock.toml`.
3. Run `npx prisma migrate dev --create-only --name marketplace_init` on an empty dev DB.
4. Prepend `CREATE EXTENSION IF NOT EXISTS btree_gist;`. Leave the Prisma DDL as generated. Append the §3.11 block in this order: uniques → indexes → exclusions → CHECKs → district rows.
5. Run `prisma migrate dev`, then the schema tests.
6. Seed (`db/seed.ts`): the platform admin from env, the `platform_setting` row and the categories. The demo seed adds 3 photographers.
7. Future changes are incremental: `--create-only`, then hand edits. Review generated files for drops of hand-written objects.

Confirm that Neon allows `btree_gist`. It is a trusted extension since PG 13.

**Phase 1 scope of the baseline (decided 2026-10-16).** The squashed baseline is `20261016000000_marketplace_init`, and it covers only Phase 1's tables, so it has **21** tables, not 26:
- Every existing table changed per §2 (`admin_user` → `app_user`, `setting` → `photographer_setting` + `platform_setting`).
- The new `photographer`, `district`, `photographer_district`, `category`, `photographer_category` and `portfolio_image`.
- `btree_gist`, the 30 districts and the amendments at the top of this document.

Later phases add the rest as incremental migrations:
- `subscription`, `subscription_period`, `payout_method`, `payout` and `payout_item`, with their indexes, exclusions and CHECKs from §3.11.
- The `payment` changes of §2.11: nullable `booking_id`, `subscription_id`, `plan_interval`, `checkout_url`, kind `subscription`, provider `flutterwave_checkout` and the CHECKs that mention them. Until then `payment` keeps its current shape, and so does `webhook_event`'s provider CHECK (§2.12). `checkout_url` and `flutterwave_checkout` wait for card payments, deferred 2026-10-17; the subscription columns still come with Phase 5.
- `platform_setting` has only `hold_minutes` and `trial_days` (default 30). `subscription_monthly_price_rwf`, `subscription_yearly_price_rwf`, `subscription_grace_days` and `subscription_reminder_days`, with their CHECKs, come with Phase 5.

The outbox template CHECK already lists the full §2.14 vocabulary, including the subscription and payout names, so those phases need no template migration. `payment_cash_is_session_fee` and `payment_pending_lookup_idx` from §2.11 hold for the current shape and are in the baseline.

## 6. Code impact: what breaks, by model
Paths are relative to `backend/src/`.

**AdminUser → AppUser**
- `auth/admin-auth.ts:70,101,149,154,190,263,265` (lockout and lookup raw SQL use the table name).
- `auth/middleware.ts:16,41`, `auth/token.ts:35` (claims), `auth/public-admin.ts`.
- Recipient lookups: `booking/admin-actions.ts:307`, `booking/cancel.ts:74`, `outbox/worker.ts:310-330`, `payments/webhooks.ts:600-603`.
- `db/seed.ts:47,52`, `test/payment-fixtures.ts:56`.

**Setting**
- The studio settings API (`routes/admin-settings.ts`) reads and writes the signed-in photographer's row only. It drops `holdMinutes` (the platform's now) and gains the two cancellation-policy fields (brief decision 5).
- `settings/repository.ts:20,28`, `settings/index.ts:25,38`.
- Callers: `availability/query.ts:45`, `booking/admin-actions.ts:66`, `booking/delivery.ts:138`, `catalogue/basket.ts:61`, `catalogue/public.ts:77`, `booking/create.ts:132` (hold now comes from the platform), `routes/admin-settings.ts:23-39`.
- Seeds and fixtures.

**WorkingHours**
- `availability/query.ts:48`, `routes/admin-availability.ts:69,81,97,111`, `routes/admin-catalogue.ts:293`, `db/seed.ts:81,89`.

**AvailabilityBlock**
- `availability/query.ts:63`, `calendar/query.ts:90`, `routes/admin-availability.ts:214-255`.

**Service**
- `catalogue/public.ts:58,75` (lookup by handle and slug), `routes/public-catalogue.ts:40-41`, `routes/admin-catalogue.ts:120-171`.

**Package**
- `catalogue/basket.ts:57`, `routes/public-availability.ts:47` (also checks bookability), `routes/admin-catalogue.ts:181-201`.

**Addon**
- Cross-tenant holes: `catalogue/basket.ts:66-72`, `booking/addons.ts:73-79`.
- Also `catalogue/public.ts:93`, `routes/admin-catalogue.ts:124,211-231`.

**Client**
- `booking/client.ts:24-36` (`upsertClient`: add `user_id` linking).

**Booking**
- **Concurrency core:**
  - `booking/claim.ts:80`: the lock is per photographer.
  - `claim.ts:119-131`: stale-hold expiry is scoped to the photographer.
  - `payments/webhooks.ts:219`: lock order is payment row lock, then the photographer lock, then the booking `FOR UPDATE`.
  - `webhooks.ts:330-341`: `slotOccupied` is scoped to the photographer.
- **IDOR-scope sites:** `booking/admin-actions.ts:79,146,236,245`, `admin-list.ts:84,90`, `admin-view.ts:96`, `delivery.ts:67,100`, `cancel.ts:43`, `calendar/query.ts:71`, `routes/admin-availability.ts:294`.
  - Done in Phase 1: every studio action takes `photographerId` from `photographerLocals(res)` and looks the booking up by id **and** photographer (`findAdminBooking(prisma, photographerId, id)`, and the row locks in `addons.ts`, `payments/cash.ts` and `payments/session-fee.ts`). Notes and refunds are scoped through their booking's photographer. The admin booking view no longer includes the shared `client` row (R1.6). `routes/studio-isolation.test.ts` is the T1.2 sweep.
- `booking/link-lookup.ts:57`: the email names each booking's photographer, and the F1 fix applies here.
- **Status rename** across `db/statuses.ts`, `booking/stage.ts`, `admin-actions.ts`, `webhooks.ts`, `email/render.ts`, frontend `admin/bookings.ts`, `catalogue/booking-access.ts`, `components/ui/status-badge.tsx`, `en.json` and `openapi/components/common.yaml`.

**Payment**
- `payments/webhooks.ts`: `matchPayment` (`:316,324`), a new subscription branch, payout-item hooks.
- `payments/initiate.ts`: the provider comes from the chosen method (built in Phase 3, `payments/routing.ts`), and `checkout_url` is stored (deferred with cards, 2026-10-17).
- `payments/reconcile.ts`: loops over providers (built in Phase 3: one reconciler per configured provider, `reconcilerPlans`).
- `payments/providers.ts` and `env.ts`: the enabled set (built in Phase 3: `MOMO_MTN_PROVIDER` and `PAYMENT_METHODS_ENABLED` replace `PAYMENT_PROVIDER`).
- Also `payments/refund.ts`, `booking/cancel.ts:131`, `payments/cash.ts` (no payout item), `routes/public-checkout.ts`.

**WebhookEvent**
- A new route and verifier for `flutterwave_checkout` in `routes/payment-webhooks.ts` (deferred with cards, 2026-10-17).

**BookingNote**
- `booking/notes.ts:29,56`: authorise through the booking's photographer.

**Outbox**
- `outbox/enqueue.ts:20-39,67`, `outbox/worker.ts`, `auth/admin-auth.ts:109,227`, `email/templates/*` (rename, split, new templates), `email/render.ts`.

## 7. Schema tests to add or update (`db/schema.test.ts`, `test/database.ts`)
- **Table count:** 14 → 26, `btree_gist` is installed, and `booking_no_overlap` includes `photographer_id WITH =`.
- **Overlap:** two photographers can book the same range; the same photographer gets `23P01`; the new cancel statuses free the slot.
- **Composite FKs** reject a cross-photographer booking→package, package→service or booking→service (`23503`).
- **Slugs and working hours** are unique per photographer.
- **Payment CHECKs:** subject exactly one, kind/plan agreement, cash is a session fee only, https `checkout_url`. `payment_one_succeeded_booking_fee` still holds.
- **Subscription periods:** overlap `23P01`, a voided period frees the range, one trial only, the shape CHECK, unique `payment_id`.
- **Payout items, payouts and payout methods:** sign/kind, one earning per payment, void-or-paid, paid requires a reference, one draft, one current method, the shape CHECK. Built in Phase 4, plus:
  - the index predicates;
  - a unique transfer reference across photographers;
  - cancelled requires its date and user;
  - the MoMo number format;
  - the composite payout → method key;
  - `refunded_by_user_id` only when refunded;
  - the RESTRICT deletes;
  - the overpayment CHECKs: range, online session fee only, refund recorded whole and only when overpaid;
  - both refund-reference partial uniques (and cash left free), and RESTRICT on the admin who recorded an overpayment refund.
  
  `test/database.ts` truncates the three tables first.
- **Photographer:** handle format, approved/suspended dates, https cover image.
- **Settings:** single row, positive prices, reminder days, fee rate range.
- **Districts:** 30 rows, FK enforced. `test/database.ts` must not truncate `district`.
- **Outbox:** a `booking_id` requires a `photographer_id`; the new templates are accepted; `admin_alert` is refused.
- **Referential:** a photographer with bookings can't be deleted; configuration rows cascade; deleting a user sets `client.user_id` to null; a category in use can't be deleted.
- **app_user:** Google-only for clients only; at least one credential.
- **Fixtures:** `test/payment-fixtures.ts` and `db/seed.test.ts` are updated to create a photographer with a live subscription.
