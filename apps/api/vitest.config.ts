import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: false,
    include: ["test/**/*.test.ts"],
    // These integration suites share one real Postgres database and some of
    // them TRUNCATE it in beforeAll — running test files concurrently would
    // let one suite's reset wipe rows another suite is mid-test with.
    fileParallelism: false,
  },
});
