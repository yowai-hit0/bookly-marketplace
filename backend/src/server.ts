import { createApp } from './app.js';
import { startHoldSweeper } from './booking/hold-sweeper.js';
import { prisma } from './db/client.js';
import { createEmailHandler } from './email/handler.js';
import { createMailProvider } from './email/mailer.js';
import { EnvValidationError, parseEnv } from './env.js';
import { startOutboxWorker } from './outbox/worker.js';
import { createPaymentProviders } from './payments/providers.js';
import { SANDBOX_RECONCILE_MIN_AGE_SECONDS, SANDBOX_RECONCILE_SCHEDULE, startPaymentReconciler } from './payments/reconcile.js';

function boot(): void {
  let env;
  try {
    env = parseEnv();
  } catch (err) {
    if (err instanceof EnvValidationError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  let payments;
  try {
    payments = createPaymentProviders(env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const app = createApp({
    corsOrigin: env.WEB_ORIGIN,
    trustProxyHops: env.TRUST_PROXY_HOPS,
    auth: {
      prisma,
      sessionSecret: env.SESSION_SECRET,
      webOrigin: env.WEB_ORIGIN,
      now: () => new Date(),
    },
    publicApi: {
      prisma,
      now: () => new Date(),
      payments: { provider: payments.active, secret: env.SESSION_SECRET },
    },
    // Every provider's callbacks, not only the active one's (spec §6.18).
    webhooks: { prisma, providers: payments.all },
  });

  const server = app.listen(env.PORT, () => {
    console.log(`api listening on http://localhost:${env.PORT}`);
  });

  // One instance, one loop (plan.md, Stack decisions). The sweeper is tidiness
  // rather than correctness -- the claim transaction expires the stale holds
  // that block it (data-model_v2.md §9.2) -- so nothing here is load-bearing.
  const holdSweeper = startHoldSweeper(prisma);

  // Lost callbacks, and the MTN sandbox that sends none, settle through a status
  // lookup. Without credentials there is nothing to ask. In the sandbox the
  // lookup is the only signal, so it runs every few seconds rather than a minute.
  const mtnSandbox = env.MTN_MOMO_TARGET_ENVIRONMENT === 'sandbox';
  const reconcilers = Object.values(payments.all)
    .filter((provider) => provider.configured)
    .map((provider) =>
      provider.id === 'mtn_momo_direct' && mtnSandbox
        ? startPaymentReconciler({ prisma, provider, minAgeSeconds: SANDBOX_RECONCILE_MIN_AGE_SECONDS }, SANDBOX_RECONCILE_SCHEDULE)
        : startPaymentReconciler({ prisma, provider }),
    );

  // Everything the system sends goes through the outbox (plan.md Task 14).
  // Calendar kinds get their handler with Task 22; until then they wait.
  const outboxWorker = startOutboxWorker({
    prisma,
    handlers: { email: createEmailHandler({ mail: createMailProvider(env), webOrigin: env.WEB_ORIGIN }) },
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ level: 'info', event: 'shutdown', signal }));
    void holdSweeper.stop();
    for (const reconciler of reconcilers) void reconciler.stop();
    server.close(() => {
      // The worker finishes the message in hand before the connection goes, so
      // no row is left claimed in `processing` (plan.md Task 14).
      void outboxWorker
        .stop()
        .then(() => prisma.$disconnect())
        .then(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot();
