import 'dotenv/config';
import { createPrismaClient } from '../src/db/client.js';
import { seedDatabase } from '../src/db/seed.js';

const prisma = createPrismaClient();

try {
  const { demo, ...summary } = await seedDatabase(prisma);
  const { booking, ...catalogue } = demo ?? { booking: null };
  // The token stays out of the JSON line, which may end up in a log.
  console.log(JSON.stringify({ ...summary, demo: demo === null ? null : { ...catalogue, booking: booking && { reference: booking.reference, created: booking.created } } }));
  if (booking !== null) {
    const origin = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').replace(/\/+$/, '');
    console.log(`\nDemo booking ${booking.reference}: the client's magic link (any earlier one no longer works):`);
    console.log(`  ${origin}/booking/${booking.accessToken}\n`);
  }
} finally {
  await prisma.$disconnect();
}
