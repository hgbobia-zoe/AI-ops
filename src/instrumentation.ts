// Next.js instrumentation — runs once when the server process starts. We use it to run the pull
// staleness check on a server-side timer, so a lapsed pull is caught even when nobody has the app
// open. Single Fly machine → one interval is correct; guarded so it never double-registers.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return; // skip edge/build runtimes

  const g = globalThis as unknown as { __zoePullStaleTimer?: NodeJS.Timeout };
  if (g.__zoePullStaleTimer) return;

  // Seed the first Owner from env on boot (idempotent), so the access gate has an account to log
  // into the moment the secrets are set.
  try {
    const { bootstrapOwner } = await import("@/lib/auth/users");
    bootstrapOwner();
  } catch {
    /* non-fatal */
  }

  const run = async (): Promise<void> => {
    try {
      const { checkPullStaleness } = await import("@/lib/pull/staleness");
      checkPullStaleness();
    } catch {
      /* never let the timer crash the process */
    }
  };

  // Check every 15 minutes, plus once ~1 min after boot.
  g.__zoePullStaleTimer = setInterval(() => void run(), 15 * 60 * 1000);
  setTimeout(() => void run(), 60 * 1000);
}
