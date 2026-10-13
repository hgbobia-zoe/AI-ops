# Responder (office-machine)

The **responder** is the external agent that does what the app cannot: it reads the work queue, works in an
isolated git worktree, writes code, runs tests, and opens PRs — while the app governs and records it. For
Phase 1 the responder is a **Claude Code session on the office machine**.

- **The contract** (what to do, and the hard rules): [`docs/ai-bridge-responder.md`](../../docs/ai-bridge-responder.md)
- **The pattern** (why it's built this way, and how to reuse it): [`docs/self-improving-app-pattern.md`](../../docs/self-improving-app-pattern.md)
- **Provisioning + go-live order**: [`docs/self-improvement-setup.md`](../../docs/self-improvement-setup.md)

## Quick start

1. Provision first (see the setup doc): the machine-user identity + scoped PAT, and `AI_BRIDGE_TOKEN` on the
   app. **Until the scoped, non-admin identity + sandbox exist, keep all autonomy switches OFF** — the gates
   are only advisory against an agent holding owner/admin creds.
2. Export the bridge token (same value as the app's Fly secret) and, if not prod, the app URL:
   ```bash
   export AI_BRIDGE_TOKEN=...            # bash
   # $env:AI_BRIDGE_TOKEN = "..."        # PowerShell
   ```
3. Each cycle (~every 3 min), run the helper to see what to work on:
   ```bash
   node scripts/responder/poll.mjs
   ```
   It heartbeats the bridge (so the app shows it live), lists pending human instructions, and lists active
   improvement runs. It is **read-only + heartbeat** — it never claims, answers, merges, or deploys.
4. To claim an item before working it (idempotent; drops it from the queue so a second responder can't
   double-handle it):
   ```bash
   node scripts/responder/poll.mjs --claim <sessionId> <instructionTs>
   ```
5. Then classify (`question` / `operational` / `feature`) and act per the contract. For code changes: a new
   branch off `origin/main` in a worktree, tests green, open a PR, record it — **stop there. A human merges.**

## One-command start (Windows)

`start.ps1` loads the bridge token for you (so you don't paste it each time) and runs a cycle:

```powershell
.\scripts\responder\start.ps1
```

It takes the token from `$env:AI_BRIDGE_TOKEN` if set, else from `~/.zoe-responder/bridge.token`. **One-time
setup** (generates a fresh token, sets it on Fly, makes it persist in every new shell, and saves it locally):

```powershell
$tok = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
flyctl secrets set AI_BRIDGE_TOKEN=$tok -a zoe-dispatch
[Environment]::SetEnvironmentVariable('AI_BRIDGE_TOKEN', $tok, 'User')   # every NEW shell now has it
New-Item -ItemType Directory -Force (Split-Path $HOME\.zoe-responder\bridge.token) | Out-Null
$tok | Out-File -NoNewline -Encoding ascii $HOME\.zoe-responder\bridge.token
```

After the `SetEnvironmentVariable` line, new shells (and a restarted Claude Code) already have the token — so
the responder session just works. The token file is a fallback for a shell that doesn't inherit it.

## What this helper is NOT

It is not an autonomous worker. The intelligence is the Claude Code session reading this output and the
contract. A true hands-off 24/7 worker is the Fly Agent-SDK path (same contract) — a later phase, not a
rewrite.
