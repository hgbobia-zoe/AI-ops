# The Self-Improving App — a reusable pattern

This document describes, **product-agnostically**, the architecture that lets an application observe its
own health and then improve itself — detect → plan → change → verify → ship — with a human-controlled
governance layer and a full observability surface. It is written so the pattern can be **lifted into
another product**, not just read as docs for this one.

The canonical implementation lives in this repo (zoe-dispatch); file paths below point at it as the
reference. The two product-specific companion docs are:

- [`docs/ai-bridge-responder.md`](./ai-bridge-responder.md) — the wire contract the external agent follows.
- [`docs/self-improvement-setup.md`](./self-improvement-setup.md) — the human provisioning runbook.

This doc is the layer **above** both: the idea, the invariants, and a porting guide.

---

## 1. The one idea

> **The app is the controller and the recorder. It is never the doer.**
> **RULES CONTROL EXECUTION. THE AI INTERPRETS AND GENERATES CHANGES.**

The application never writes its own source code, never opens a PR, never merges, never deploys. All of
that is done by an **external coding agent** (a Claude Code session, or an Agent-SDK worker) that the app
*governs* through two narrow HTTP contracts and *records* in a state machine. The LLM proposes and
generates; deterministic code decides what is allowed and what ships.

This split is the whole safety story. The intelligence is untrusted and sandboxed; the gates are dumb,
deterministic, and own execution. An app that could rewrite its own guardrails has no guardrails — so the
controller is architected to make that structurally impossible, not merely discouraged.

Two consequences that shape everything else:

1. **The app holds no code-write / deploy power.** No `child_process`, no `git`, no `octokit` PR-create,
   no Fly token in the app. (It may hold a *review/merge* token used only by a human, and a *rollback-only*
   dispatch token — see §6.) The reference app was verified to contain none of the former.
2. **Every change reaches production through a gate the agent cannot pass on its own** — CI, Code-Owner
   review, and (until deliberately enabled) a human merge.

---

## 2. Components and who owns what

| Component | Role | Reference (this repo) |
|---|---|---|
| **Controller** | Owns the run lifecycle, the gates, and the record. Pure + deterministic. | `src/lib/ai/improvement/*` |
| **State machine** | The only legal way state changes. Refuses illegal moves. | `improvement/machine.ts`, `store.transitionRun` |
| **Scope gate** | Per-run allowed/forbidden paths + an *always-forbidden* set no run can open. | `improvement/scope.ts` |
| **Change budget** | Configurable caps: files, lines, dirs, commands, retries, wall-clock. | `improvement/budget.ts`, `config.ts` |
| **Autonomy switches** | `autoMerge` / `autoDeploy` / `autoRollback`, **all default OFF**. | `improvement/config.ts` |
| **Deploy/verify/rollback** | Detect a deploy (read-only), health-check it, revert on failure. | `improvement/deploy.ts`, `verify.ts`, `rollback.ts` |
| **Bridge** | The queue + heartbeat the external agent polls; records "working on it", answers, proposals. | `src/lib/ai/sessions.ts`, `/api/ai/bridge*` |
| **Report API** | The step-by-step interface the agent calls to advance a run (plan/validation/ci/artifacts/…). | `/api/ai/improvement/[id]/report` |
| **Approvals** | Operational (business) actions the agent proposes; a human approves; execution routes to an outbox. | `src/lib/aiorg/approvals.ts` |
| **Observability UI** | Every run's state, budget use, PR, deploy, health, and lifecycle trail. | `/ai-command/improvements` |
| **External agent (the doer)** | Reads the queue, works in an isolated worktree, writes code, runs tests, opens the PR, reports back. | *not in the app* — see `ai-bridge-responder.md` |

The dividing line is sharp: everything in the app **records and decides**; only the external agent
**acts on code**, and only CI/human actions **ship**.

---

## 3. The lifecycle

An **improvement run** is one controlled attempt to carry a request through the full loop. States
(`improvement/types.ts`):

```
requested → investigating → planned → coding → validating → pr_created
          → ci_running → ready_to_merge → merged → deploying → deployed
          → verifying → verified            (SUCCESS)
```

plus failure / hold states that are reachable from any live state:

```
validation_failed · ci_failed · scope_exceeded · session_failed
deployment_failed · health_check_failed · rollback_required · rolled_back
human_review_required
```

Division of labor across the loop:

- **Agent does:** investigate, plan, code, run local validation, open the PR, diagnose a CI failure.
- **Controller does:** enforce scope + budget on every reported step, decide the next state, gate the
  merge/deploy, verify the deploy, decide rollback vs human-escalation.
- **CI / human does:** run the authoritative test suite, Code-Owner review, and (until autonomy is on)
  the merge and the deploy.

Bounded self-repair: `validation_failed → coding` and `ci_failed → coding` edges exist, but are capped by
the retry budget; past the cap the run escalates to `human_review_required`. There is no infinite loop by
construction.

---

## 4. The gate model (the invariants to preserve in ANY product)

These are the load-bearing invariants. Port them exactly; everything else is detail.

1. **Always-forbidden paths.** A hard-coded set of paths that **no run's scope can ever open** — the
   agent's own controls: CI/CODEOWNERS (`.github/`), auth, the approvals gate, the provider seam, the
   improvement controller itself, the bridge/merge code, deploy infra, and this contract. A touch trips
   `scope_exceeded`. (`scope.ts: ALWAYS_FORBIDDEN_PATHS`.) *An agent that can edit its own guardrails has
   none.*
2. **Per-run scope.** Beyond the always-forbidden set, each run declares `allowedPaths` / `forbiddenPaths`
   and the controller enforces them against the actually-changed files.
3. **Change budget.** Configurable (never arbitrary) caps; a breach stops the run.
4. **Autonomy off by default.** `autoMerge` / `autoDeploy` / `autoRollback` are off; a human turns each on,
   in order, only after the identity/sandbox exist and rollback has been validated once. The controller
   never flips them for itself.
5. **Human-only merge until autonomy is on.** The human merge of the PR *is* the approval gate between
   AI-written code and production.
6. **Least-privilege identity.** The agent runs as a **distinct, non-admin identity** from the human
   reviewer, so Code-Owner review is a real gate (the agent cannot approve its own safety-path PR).
7. **CI is the authoritative verifier.** "Green" means something only because a real suite runs on the PR
   and is required by branch protection — not because the agent reported success.
8. **Deploy → verify → (rollback | escalate).** A merge is not a success; a *verified healthy deploy* is.
   A failed health check reverts (if `autoRollback`) or escalates to a human — never silently passes.
9. **A successful merge is not a successful improvement.** Only `verified` is.

The honest framing to keep: a control that lives only in prose is **advisory**, not a gate. Mark each
control by how it is *actually* enforced (code / config / CI / human), and keep that map honest as the
loop grows. (The reference does this in `ai-bridge-responder.md` under "ENFORCED vs CONTRACT".)

---

## 5. The two contracts (portable interfaces)

The app exposes exactly two narrow HTTP surfaces to the external agent, both authenticated with a single
bearer token (`AI_BRIDGE_TOKEN`) and **gated-by-default** (unset token ⇒ only a human cookie works, so the
agent is simply unwired until provisioned):

**A. Bridge** — the work queue + heartbeat (`/api/ai/bridge*`):
- `POST /api/ai/bridge {connected:true}` — heartbeat (the app shows the bridge is live).
- `GET  /api/ai/bridge/pending?limit=N` — the oldest-first queue of unanswered human instructions.
- `POST /api/ai/bridge {sessionId, claim:true, instructionTs}` — claim one (idempotent; drops it from the
  queue so two agents can't double-handle it).
- `POST /api/ai/bridge {sessionId, result:{…}}` — post an answer / proposal / acknowledgement back.

**B. Improvement report** — step-by-step run advancement (`/api/ai/improvement/[id]/report`), ops:
`plan · advance · artifacts · scope · budget · validation · ci · retry · merge · verify`. The agent reports
facts (plan text, changed paths, test pass/fail, PR url, CI result); the **controller** decides the
resulting state and enforces scope/budget on every op.

Keeping these two surfaces narrow is what makes the agent swappable (office session ↔ cloud worker) and
keeps the app ignorant of *how* the work is done.

---

## 6. Identity, sandbox, secrets (least privilege)

| Secret | Held by | Purpose | Must NOT be |
|---|---|---|---|
| `AI_BRIDGE_TOKEN` | agent + app | authenticate to the two contracts | an admin/deploy cred |
| agent fine-grained PAT | **agent only** | `git push` + open PR (repo-scoped: Contents RW, PRs RW, nothing else) | admin / workflows / org scope |
| deploy token (e.g. `FLY_API_TOKEN`) | **CI only** | deploy + roll back | ever on the agent's machine |
| rollback dispatch token | **app only** | fire *only* the rollback workflow (`repository_dispatch`) | code-write / admin |

Rules that make the gates real:
- The agent runs under a **machine-user identity with `write` (not admin)** collaborator access — enough to
  push branches and open PRs, unable to change branch protection, CODEOWNERS, or merge a protected branch.
- The agent runs in a **sandbox** with *only* the bridge token + its scoped PAT — **no** deploy token, **no**
  owner token, **no** production DB access, egress limited to GitHub + the model API + the app's endpoints.
- The office-machine agent is fine to *prove* the loop; a dedicated sandboxed worker is the real-operation
  target. Both speak the same two contracts, so moving is a deploy, not a rewrite.

---

## 7. Triggers (how a run gets born)

A run is just a record; something has to open one. Sources, cheapest to richest:

- **Direct request** — a human files "improve X" (a Requests backlog / a button). *Built.*
- **App signals** — the app's own "something's wrong / here's an opportunity" feeds: error/exception
  queues, an audit log (e.g. a recorded operation *failure*), the runtime/health ledger, failed scheduled
  jobs. The controller turns a recurring/again-failing signal into a scoped run.
- **Scheduled self-audit** — a periodic job that proactively scans for bugs, dead code, missing tests, or
  opportunities and files low-risk runs.

In the reference, direct-request is wired; signal→run and the scheduled self-audit are the next increment
(no scheduler opens runs yet). The important design rule: a trigger only ever *opens a scoped run* — it
never bypasses the gates.

---

## 8. Observability

The control plane is a normal part of the app's UI, not a separate tool: a board of runs with their state,
budget consumption, PR link, deploy id, health result, and the full append-only lifecycle trail; plus the
session/queue view and the approvals cards for operational actions. The governance panel is where a human
flips the autonomy switches. (Reference: `/ai-command/improvements`, `/ai-command`.)

---

## 9. Porting this to a new product

What is **generic** (lift almost as-is) vs **product-specific** (reimplement):

**Generic — copy and keep the invariants:**
- The state machine + its transition table (`improvement/machine.ts`, `types.ts`). Pure; no product in it.
- The scope gate (`scope.ts`) — swap the `ALWAYS_FORBIDDEN_PATHS` list for *the new product's* safety files
  (its auth, its approvals/execution gate, its CI/CODEOWNERS, its own improvement controller, its deploy
  infra). The *mechanism* is identical.
- The change budget + autonomy config (`budget.ts`, `config.ts`) — defaults off.
- The two contracts (§5) and the bridge token gating.
- The run store shape (`store.ts`) and the report API ops (§5B).
- The identity/sandbox/secrets model (§6) and the safe autonomy-enablement order.

**Product-specific — reimplement for the new app:**
- **Signals** (§7): every app has different "something's wrong" feeds. Map the new app's error/health/
  audit surfaces to run triggers.
- **Deploy / verify** (`deploy.ts`, `verify.ts`): the deploy detector and the post-deploy health check are
  tied to the host (Fly `/api/version` + integration health here). Reimplement for the new host and the new
  app's notion of "healthy."
- **Rollback** (`rollback.ts`): tied to the new CI/host's rollback mechanism.
- **The observability UI**: skin it to the new app; the data it renders is generic.

**Minimal port checklist:**
1. Copy the controller (`improvement/*`) and the two API surfaces; rename the always-forbidden list to the
   new product's safety files.
2. Stand up branch protection + CI + CODEOWNERS on the new repo (the real gates).
3. Create the machine-user identity + scoped PAT; set the four secrets per §6.
4. Point the external agent (same contract) at the new app's base URL.
5. Wire the new app's signals to open scoped runs.
6. Prove the human-supervised loop end-to-end **before** enabling any autonomy switch, in the order in §4.

**The two load-bearing truths to carry over above all else:** the app never holds code-write/deploy power,
and the agent runs as a least-privilege identity it cannot escape. Everything else is detail you can adapt.

---

## 10. Status in this repo (reference)

- **Built + tested:** controller, state machine, scope/budget gates, validation/CI routing, deploy detect,
  post-deploy verify, rollback, the two API surfaces, the `/ai-command/improvements` UI. Autonomy defaults
  off.
- **Operational, to go live (office-machine Phase 1):** provision the machine-user identity + scoped PAT,
  set the secrets, and **run the responder** (a Claude Code session following `ai-bridge-responder.md`;
  see `scripts/responder/`). The human merges; nothing auto-ships yet.
- **Next:** signal→run + scheduled self-audit triggers; then enable autonomy for low-risk changes in the
  safe order, with auto-rollback validated once first.
