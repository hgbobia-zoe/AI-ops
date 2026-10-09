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
    // Each test FILE starts with a clean DB (vitest.setup.ts clears every table in beforeAll), so the
    // in-memory SQLite connection (which survives vitest's per-file module isolation) never leaks one
    // file's rows into the next. The default pool is fine once CI runs Node >=22 (better-sqlite3's engine).
    setupFiles: ["./vitest.setup.ts"],
  },
});
