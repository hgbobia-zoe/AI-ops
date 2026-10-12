#!/usr/bin/env node
// Office-machine responder helper. One cycle: heartbeat the bridge, pull the pending-instruction queue,
// and list active improvement runs — then print a concise "here's what to work on" summary for the Claude
// Code session that IS the responder (see docs/ai-bridge-responder.md for the full contract).
//
// This helper only READS + heartbeats (both safe). It never claims, answers, proposes, opens a PR, merges,
// or deploys — the responder session does those deliberately, per the contract. Dependency-free (Node 18+).
//
//   AI_BRIDGE_TOKEN=... node scripts/responder/poll.mjs
//   APP_URL=https://zoe-dispatch.fly.dev AI_BRIDGE_TOKEN=... node scripts/responder/poll.mjs
//   node scripts/responder/poll.mjs --claim <sessionId> <instructionTs>   # claim one item (a write)

const APP_URL = (process.env.APP_URL || "https://zoe-dispatch.fly.dev").replace(/\/+$/, "");
const TOKEN = process.env.AI_BRIDGE_TOKEN || "";

if (!TOKEN) {
  console.error("AI_BRIDGE_TOKEN is not set. Export the bridge token (same value as the app's Fly secret).");
  process.exit(2);
}

const H = { "x-bridge-token": TOKEN, "content-type": "application/json", accept: "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${APP_URL}${path}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, ok: res.ok, json, text };
}

async function claim(sessionId, instructionTs) {
  if (!sessionId || !instructionTs) {
    console.error("Usage: --claim <sessionId> <instructionTs>");
    process.exit(2);
  }
  const r = await call("POST", "/api/ai/bridge", { sessionId, claim: true, instructionTs });
  console.log(r.ok ? `Claimed ${sessionId} @ ${instructionTs}` : `Claim failed (${r.status}): ${r.text.slice(0, 200)}`);
  process.exit(r.ok ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--claim") return claim(args[1], args[2]);

  // 1) Heartbeat — tells the app the bridge is live.
  const hb = await call("POST", "/api/ai/bridge", { connected: true });
  console.log(hb.ok ? `✓ bridge heartbeat (${APP_URL})` : `✗ heartbeat failed (${hb.status}): ${hb.text.slice(0, 200)}`);
  if (hb.status === 403) {
    console.error("403 — the bridge token is wrong, or AI_BRIDGE_TOKEN is unset on the app. Fix before continuing.");
    process.exit(1);
  }

  // 2) Pending human instructions (oldest first).
  const pend = await call("GET", "/api/ai/bridge/pending?limit=20");
  const pending = (pend.json && pend.json.pending) || [];
  console.log(`\nPENDING INSTRUCTIONS: ${pending.length}${pend.json && pend.json.total != null ? ` of ${pend.json.total}` : ""}`);
  for (const p of pending) {
    console.log(`  • [${p.blade || "?"}] ${p.title || "(untitled)"} — asked by ${p.askedBy || p.owner || "?"}`);
    console.log(`    session=${p.sessionId} ts=${p.instructionTs}`);
    console.log(`    "${String(p.instruction || "").slice(0, 200)}"`);
  }
  if (pending.length === 0) console.log("  (queue empty)");

  // 3) Active improvement runs (the self-improvement loop's in-flight work).
  const runs = await call("GET", "/api/ai/improvement?active=1");
  const list = (runs.json && runs.json.runs) || [];
  console.log(`\nACTIVE IMPROVEMENT RUNS: ${list.length}`);
  for (const r of list) {
    console.log(`  • ${r.id} [${r.state}] ${r.scope && r.scope.summary ? r.scope.summary : ""}${r.prUrl ? ` — ${r.prUrl}` : ""}`);
  }
  if (runs.json && runs.json.counts) {
    const nonzero = Object.entries(runs.json.counts).filter(([, n]) => n > 0).map(([s, n]) => `${s}:${n}`);
    if (nonzero.length) console.log(`  counts: ${nonzero.join("  ")}`);
  }

  console.log(`\nNext: for each pending item — claim it (--claim), classify (question | operational | feature),`);
  console.log(`then act per docs/ai-bridge-responder.md. Never merge or deploy; a human does that.`);
}

main().catch((e) => { console.error("poll failed:", e?.message || e); process.exit(1); });
