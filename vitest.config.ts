import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Mirror the "@/..." path alias from tsconfig so tests import the same way the app does.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // DB tests run against a throwaway in-memory SQLite, never the real file.
    env: { DATABASE_PATH: ":memory:" },
    // Run the whole suite in ONE forked process (no worker pool). better-sqlite3 is a native addon that
    // crashes vitest's multi-process/worker runners on the Linux CI image ("Worker exited unexpectedly");
    // a single long-lived process loads it once and is stable. Each test FILE still starts with a clean DB
    // via vitest.setup.ts (beforeAll clears every table), so there is no cross-file in-memory-SQLite leak.
    // Sequential + single-process = a bit slower, but deterministic and CI-safe.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    setupFiles: ["./vitest.setup.ts"],
  },
});
