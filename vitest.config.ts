import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // A cold CI runner loads the orchestrator module graph in seconds; the
    // harness tests boot it inside the test body.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
