import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The DB client switches to in-process pglite when NODE_ENV=test (see db/client.ts).
    env: { NODE_ENV: "test" },
    setupFiles: ["./test/setup.ts"],
    // pglite boot + schema push add a little per-file startup; give hooks room.
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
