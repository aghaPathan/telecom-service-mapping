import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Run integration tests serially to avoid port contention between
    // testcontainers instances.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
