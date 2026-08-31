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
  },
});
