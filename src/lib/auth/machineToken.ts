// Machine-to-machine auth for endpoints a scheduler, extension or webhook calls without a session.
// FAIL CLOSED: an unset token means "not configured" (503), never "open". Header only, never a query
// string (query strings end up in logs and browser history). Constant-time compare on SHA-256 digests.
// The env value may hold several comma-separated tokens so a token can be rotated without downtime.

import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export type MachineAuth = "ok" | "unconfigured" | "forbidden";

const digest = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** Tokens configured in an env var (comma separated, trimmed, empties dropped). */
export function configuredTokens(envName: string): string[] {
  return (process.env[envName] ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

/** PURE given env. Compare a presented token against the configured ones in constant time. */
export function checkMachineToken(envName: string, presented: string | null | undefined): MachineAuth {
  const tokens = configuredTokens(envName);
  if (tokens.length === 0) return "unconfigured";
  const p = (presented ?? "").trim();
  if (!p) return "forbidden";
  const pd = digest(p);
  let ok = false;
  for (const t of tokens) if (timingSafeEqual(pd, digest(t))) ok = true; // no early exit
  return ok ? "ok" : "forbidden";
}

/** Read the token from a header, or from `Authorization: Bearer <token>` when `bearer` is set. */
export function presentedToken(req: Request, opts: { header: string; bearer?: boolean }): string | null {
  const h = req.headers.get(opts.header);
  if (h) return h;
  if (opts.bearer) {
    const auth = req.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
  }
  return null;
}

/**
 * Gate a route. Returns null when authorized, otherwise the response to send: 503 when the token is
 * not configured on the server, 401 when it is missing or wrong. The body never echoes the token.
 */
export function requireMachineToken(
  req: Request,
  opts: { env: string; header: string; bearer?: boolean; headers?: Record<string, string> },
): NextResponse | null {
  const verdict = checkMachineToken(opts.env, presentedToken(req, opts));
  if (verdict === "ok") return null;
  if (verdict === "unconfigured") {
    return NextResponse.json({ error: "not_configured", message: `${opts.env} is not set on the server` }, { status: 503, headers: opts.headers });
  }
  return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: opts.headers });
}
