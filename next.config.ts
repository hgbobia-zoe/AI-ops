import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Pin the Turbopack workspace root to the directory `next` is launched from. Without this, a sibling
  // lockfile (e.g. the main checkout's, when developing in a git worktree) makes Next infer the WRONG root
  // and serve that other checkout's files. process.cwd() is the launch dir — the worktree in dev, the app
  // root in prod — so this resolves correctly everywhere and silences the multi-lockfile warning.
  turbopack: { root: process.cwd() },
  // Native / heavy Node packages used only in server code (route handlers,
  // ingestion). Keep them out of the bundle so they load from node_modules.
  serverExternalPackages: ["better-sqlite3", "playwright"],
};

export default nextConfig;
