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
    // Each test file gets its OWN forked process, so the module-level getDb() singleton (and its in-memory
    // SQLite) starts fresh per file. Without this, files run in a shared worker and the DB leaks across
    // them — e.g. one file's lead "L-1" rows contaminate another's (a latent flake that only shows in the
    // full suite, never when a file runs alone). Deterministic isolation is the prerequisite for CI gating.
    // Cap concurrency: spinning up an unbounded number of forks OOMs the constrained CI runner ("Worker
    // exited unexpectedly"). 2 keeps per-file isolation while staying within a 2-core runner's memory.
    pool: "forks",
    poolOptions: { forks: { isolate: true, singleFork: false } },
    maxWorkers: 2,
    minWorkers: 1,
  },
});
