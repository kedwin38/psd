import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30000,
    hookTimeout: 30000,
    globals: false,
    include: ["test/**/*.test.ts"],
  },
});
