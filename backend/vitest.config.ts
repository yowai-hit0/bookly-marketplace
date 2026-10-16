import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Creates and migrates the test database before anything runs. Schema tests
    // hit real PostgreSQL because the thing under test IS the database.
    globalSetup: ['./src/test/global-setup.ts'],
    // The schema suite truncates between tests; parallel files would race.
    fileParallelism: false,
  },
});
