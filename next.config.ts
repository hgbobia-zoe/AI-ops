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
  // Do NOT type-check during `next build`. The merge gate (ci.yml) already runs `tsc --noEmit` and the test
  // suite on every PR, so this is redundant work in the Docker image build — and crucially, the in-build
  // type-check OOM-kills the Fly REMOTE builder (SIGKILL at ~15min / "deadline_exceeded"), which silently
  // breaks auto-deploy (deploy.yml uses `flyctl deploy --remote-only`). Skipping it keeps the image build to
  // the ~17s compile so merges deploy themselves again. Correctness stays gated in CI. (This Next version no
  // longer runs ESLint during `next build`, so there's nothing to disable there.)
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
