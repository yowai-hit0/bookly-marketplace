/**
 * Operating values with no settings screen behind them (data-model_v2.md §5.2).
 * A setting with no screen is a column that drifts from the code that reads it,
 * so these are constants rather than `setting` rows.
 *
 * They live apart from `settings/index.ts` deliberately: that module reaches the
 * database and instantiates a PrismaClient on import, and the availability
 * engine must stay pure (plan.md Task 5). This file imports nothing.
 */

/** Minutes between offerable slot starts. */
export const SLOT_GRANULARITY_MINUTES = 30;

/** How long a client's access token stays valid after confirmation. */
export const ACCESS_TOKEN_LIFETIME_DAYS = 365;
