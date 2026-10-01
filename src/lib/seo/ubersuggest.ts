// ── Ubersuggest MCP integration boundary (server-only) ────────────────────────────────────────────
//
// The ONE place the platform talks to the Ubersuggest MCP server. Everything the Phase 2+ engine needs
// (keyword research, volume/difficulty, competitor ranking keywords, backlinks, site audit, …) goes
// through here, so credential handling, timeouts, retries, rate-limit backoff, retrieval logging and
// caching are enforced in a single audited place.
//
// HONESTY LAW (matches the rest of the platform): this boundary NEVER fabricates SEO data. If no MCP
// credential is configured it reports `not_configured` and makes no network call. A probe reports `ok`
// ONLY when the live server actually returned a valid result; otherwise `error`/`stale`, with the real
// error. Mocks are used ONLY in automated tests (see ubersuggest.test.ts), never here.
//
// VERIFICATION STATUS: the Ubersuggest MCP is an OAuth-2.0-authenticated remote MCP server
// (https://ubersuggest-mcp.neilpatelapi.com/mcp, ~37 read-only tools across keyword research, domain
// analysis, backlinks, site audit, content and SERP utilities — confirmed from Neil Patel's published
// docs). We did NOT have live credentials to exercise the wire protocol end-to-end, so the request
// plumbing below is written to the MCP Streamable-HTTP + JSON-RPC spec but is UNVERIFIED against the live
// server. It is therefore gated behind `configured()` and fails safe: no creds → no call → honest status.
// A bearer access token (from the OAuth flow) is read from the secret store / env; wiring the full OAuth
// authorization-code flow is a Phase 2 task.

import { getSecret } from "@/lib/secrets";
import { logImport } from "@/lib/pull/state";
import {
  recordRetrieval,
  latestSuccess,
  latestDiagnostic,
} from "./store";
import { type SeoHealth, type SeoHealthStatus, type SeoDiagnostic, SEO_STALE_HOURS } from "./types";

/** The Ubersuggest remote MCP endpoint (overridable for staging/testing). */
export const MCP_URL = process.env.UBERSUGGEST_MCP_URL || "https://ubersuggest-mcp.neilpatelapi.com/mcp";

const SECRET_KEY = "ubersuggest.mcpToken";
const DEFAULT_TIMEOUT_MS = 15_000;
const PROBE_CACHE_MS = 60_000;

/**
 * The MCP bearer credential (an OAuth access token for the Ubersuggest MCP), or null. Secret store wins,
 * then env. Never returned to the browser.
 */
export function mcpCredential(): string | null {
  return getSecret(SECRET_KEY) || process.env.UBERSUGGEST_MCP_TOKEN || process.env.UBERSUGGEST_API_KEY || null;
}

/** True when an MCP credential is present. Does NOT prove the connection works — see probe(). */
export function configured(): boolean {
  return mcpCredential() !== null;
}

// ── low-level MCP request ─────────────────────────────────────────────────────────
export interface McpResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  statusCode?: number;
  rateLimited?: boolean;
  durationMs: number;
  retrievedAt: string;
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string };
}

/** Parse a Streamable-HTTP response body that may be plain JSON or an SSE stream of `data:` frames. */
function parseBody(contentType: string, text: string): JsonRpcResponse | null {
  const ct = contentType.toLowerCase();
  try {
    if (ct.includes("text/event-stream")) {
      // Take the last non-empty `data:` frame (the JSON-RPC response).
      const frames = text
        .split(/\n\n/)
        .map((block) =>
          block
            .split(/\n/)
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join(""),
        )
        .filter(Boolean);
      const last = frames[frames.length - 1];
      return last ? (JSON.parse(last) as JsonRpcResponse) : null;
    }
    return text ? (JSON.parse(text) as JsonRpcResponse) : null;
  } catch {
    return null;
  }
}

let rpcId = 0;

/**
 * One JSON-RPC call to the MCP server with timeout, a single rate-limit/5xx backoff retry, and diagnostic
 * logging. NEVER throws — returns a structured result so callers can branch without try/catch. `sessionId`
 * is threaded through when the server issued one at initialize.
 */
async function mcpRequest<T = unknown>(
  method: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number; sessionId?: string | null; operation?: string; tool?: string | null } = {},
): Promise<McpResult<T> & { sessionId?: string | null }> {
  const token = mcpCredential();
  const operation = opts.operation ?? method;
  const started = Date.now();
  const retrievedAt = new Date().toISOString();

  if (!token) {
    const r: McpResult<T> = { ok: false, error: "not_configured", durationMs: 0, retrievedAt };
    return r;
  }

  const attempt = async (): Promise<{ res: Response | null; text: string; error?: string }> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      };
      if (opts.sessionId) headers["mcp-session-id"] = opts.sessionId;
      const res = await fetch(MCP_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
        signal: controller.signal,
      });
      const text = await res.text();
      return { res, text };
    } catch (e) {
      return { res: null, text: "", error: e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : "network error" };
    } finally {
      clearTimeout(timer);
    }
  };

  let { res, text, error } = await attempt();
  // One backoff retry on transient failure (429 / 5xx / network).
  if (!res || res.status === 429 || res.status >= 500) {
    const retryAfter = res?.headers.get("retry-after");
    const waitMs = retryAfter ? Math.min(Number(retryAfter) * 1000 || 1000, 5000) : 750;
    await new Promise((r) => setTimeout(r, waitMs));
    ({ res, text, error } = await attempt());
  }

  const durationMs = Date.now() - started;
  const sessionId = res?.headers.get("mcp-session-id") ?? opts.sessionId ?? null;

  const finish = (r: McpResult<T>): McpResult<T> & { sessionId?: string | null } => {
    recordRetrieval({
      operation,
      ok: r.ok,
      tool: opts.tool ?? null,
      statusCode: r.statusCode ?? null,
      rateLimited: r.rateLimited ?? false,
      durationMs: r.durationMs,
      detail: r.ok ? null : r.error ?? null,
    });
    // Also surface on the global data-health page's import ledger.
    try {
      logImport("ubersuggest", r.ok, { detail: r.ok ? operation : `${operation}: ${r.error ?? "failed"}` });
    } catch {
      /* best effort */
    }
    return { ...r, sessionId };
  };

  if (!res) return finish({ ok: false, error: error ?? "network error", durationMs, retrievedAt });

  const rateLimited = res.status === 429;
  if (!res.ok) {
    return finish({ ok: false, error: `HTTP ${res.status}`, statusCode: res.status, rateLimited, durationMs, retrievedAt });
  }

  const body = parseBody(res.headers.get("content-type") || "", text);
  if (!body) return finish({ ok: false, error: "unparseable response", statusCode: res.status, durationMs, retrievedAt });
  if (body.error) return finish({ ok: false, error: body.error.message || `rpc error ${body.error.code ?? ""}`.trim(), statusCode: res.status, durationMs, retrievedAt });
  return finish({ ok: true, data: body.result as T, statusCode: res.status, durationMs, retrievedAt });
}

// ── health ────────────────────────────────────────────────────────────────────────
function ageHours(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

/** Build the honest health view from the credential state + the two stored diagnostics. Pure. */
function buildHealth(isConfigured: boolean, lastSuccessDiag: SeoDiagnostic | null, lastAttemptDiag: SeoDiagnostic | null): SeoHealth {
  const lastSuccessAt = lastSuccessDiag?.ts ?? null;
  const lastAttemptAt = lastAttemptDiag?.ts ?? null;
  const successAge = ageHours(lastSuccessAt);
  const stale = successAge != null && successAge > SEO_STALE_HOURS;

  if (!isConfigured) {
    return {
      status: "not_configured",
      configured: false,
      headline: "Not configured",
      detail: "Add the Ubersuggest MCP credential in Settings to enable keyword research. No live SEO data is shown until it is connected.",
      lastSuccessAt,
      lastAttemptAt,
      lastError: null,
      stale: false,
    };
  }

  // Configured but never probed.
  if (!lastAttemptDiag) {
    return {
      status: "never",
      configured: true,
      headline: "Not checked",
      detail: "Credential is set. Run a health check to verify the Ubersuggest connection.",
      lastSuccessAt,
      lastAttemptAt,
      lastError: null,
      stale: false,
    };
  }

  // Last attempt failed → error (distinguish rate-limit).
  if (!lastAttemptDiag.ok) {
    return {
      status: "error",
      configured: true,
      headline: lastAttemptDiag.rateLimited ? "Rate-limited" : "Error",
      detail: lastAttemptDiag.detail || (lastAttemptDiag.rateLimited ? "Ubersuggest is rate-limiting requests; it will resume shortly." : "The last Ubersuggest request failed."),
      lastSuccessAt,
      lastAttemptAt,
      lastError: lastAttemptDiag.detail ?? "request failed",
      stale,
    };
  }

  // Last attempt succeeded.
  const status: SeoHealthStatus = stale ? "stale" : "ok";
  return {
    status,
    configured: true,
    headline: stale ? "Stale" : "Connected",
    detail: stale
      ? `Last successful retrieval was over ${SEO_STALE_HOURS} hours ago. Data may be out of date.`
      : "Connected to Ubersuggest. Keyword research available.",
    lastSuccessAt,
    lastAttemptAt,
    lastError: null,
    stale,
  };
}

/**
 * SYNCHRONOUS health for server-rendered views (Overview). Reads only the credential state + stored
 * diagnostics — makes NO network call, so it is safe to call on every page render. Use probe() to actually
 * contact the server and refresh the diagnostics.
 */
export function getHealth(): SeoHealth {
  return buildHealth(configured(), latestSuccess(), latestDiagnostic());
}

let probeCache: { at: number; health: SeoHealth } | null = null;

/**
 * LIVE health probe. Contacts the MCP server (initialize → tools/list), records a diagnostic, and returns
 * the refreshed health. Cached for PROBE_CACHE_MS unless `force`. If not configured, returns the honest
 * not_configured health WITHOUT any network call.
 */
export async function probe(opts: { force?: boolean } = {}): Promise<SeoHealth> {
  if (!configured()) return buildHealth(false, latestSuccess(), latestDiagnostic());
  if (!opts.force && probeCache && Date.now() - probeCache.at < PROBE_CACHE_MS) return probeCache.health;

  // MCP handshake, then list tools. tools/list succeeding is our proof of a live, authorized connection.
  const init = await mcpRequest(
    "initialize",
    {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "zoe-ops-seo", version: "1.0.0" },
    },
    { operation: "probe", tool: "initialize" },
  );
  if (init.ok) {
    await mcpRequest("tools/list", {}, { operation: "tools_list", tool: null, sessionId: init.sessionId });
  }

  const health = buildHealth(true, latestSuccess(), latestDiagnostic());
  probeCache = { at: Date.now(), health };
  return health;
}

/**
 * Generic call to a named Ubersuggest MCP tool. Phase 2 entry point for keyword/domain/competitor
 * retrievals. Returns a structured McpResult; the caller interprets `data` per tool. Not used in Phase 1
 * beyond the probe, so no tool-specific parsing is baked in yet (kept deliberately thin + honest).
 */
export async function callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<McpResult<T>> {
  return mcpRequest<T>("tools/call", { name, arguments: args }, { operation: name, tool: name });
}
