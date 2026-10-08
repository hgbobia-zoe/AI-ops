# Self-Improvement Controller — operator setup & go-live

The controller (code) is built and tested: the state machine, scope gate, change budget, validation/CI
routing, deploy detection, post-deploy verification, and rollback all live in `src/lib/ai/improvement/*`
and `/api/ai/improvement/*`, with the operator view at `/ai-command/improvements`. This doc is the part a
**human must provision** — the identity the agent runs as, the sandbox it runs in, and the secrets the
gates depend on — plus the safe order to turn autonomy on. Until these are done, the loop runs
**human-supervised**: the AI opens PRs, a human merges, deploys happen via CI, and nothing auto-merges or
auto-rolls-back.

## 1. The scoped agent identity (audit gate 12 — the keystone)

The controls (CODEOWNERS, branch protection, FORBIDDEN executions) only *bind the agent* when the agent runs
as an identity that **cannot bypass them**. Today, if the responder used your owner credentials it could
merge its own PRs and edit its own guardrails. Fix that by giving the agent its own least-privilege
identity:

1. Create a dedicated GitHub account (a "machine user"), e.g. `zoe-ai-agent`, and add it to the repo as a
   **collaborator with `write`** (not admin). Write lets it push branches and open PRs; it does **not** let
   it change branch protection, CODEOWNERS, or merge against a protected branch.
2. Make a **fine-grained personal access token** on that account, scoped to **this repo only**, with:
   `Contents: read/write`, `Pull requests: read/write`, and nothing else. **No** "Administration", **no**
   "Workflows", **no** org scopes.
3. This is the token the responder uses for `git push` / `gh pr create`. It is NOT the deploy token and NOT
   an admin token.
4. Because the agent is now a *different* identity from you (the code owner), CODEOWNERS "require Code Owner
   review" becomes a real gate: the agent cannot approve its own safety-path PR; you must.
5. Keep branch protection's **"Require review from Code Owners"** on (already set) and leave
   **"Include administrators" OFF** so you retain an escape hatch while the agent is fully gated.

## 2. The sandbox (treat the coding agent as untrusted)

Run the responder/coding agent in an **isolated sandbox**, not on a machine with ambient credentials:

- Its own git worktree per run (the controller already models `branch`; the responder creates the worktree).
- **No** Fly token, **no** owner GitHub token, **no** production DB access on that machine/container.
- Only the three scoped secrets below, injected as env.
- Network egress limited to GitHub + the Anthropic API + this app's ingest endpoints where practical.

The office-machine responder is acceptable to *prove* the loop; a dedicated sandboxed worker (Fly/container)
is the real-operation target.

## 3. Secrets — who holds what (least privilege)

| Secret | Held by | Purpose | Must NOT be |
|---|---|---|---|
| `AI_BRIDGE_TOKEN` | the responder + the app (Fly) | authenticate to the bridge + controller APIs | an admin/deploy cred |
| `<agent fine-grained PAT>` | the responder only | push branches, open PRs | admin / workflow / org scope |
| `FLY_API_TOKEN` | **GitHub Actions only** (deploy.yml / rollback.yml) | deploy + roll back | ever on the agent's machine |
| `GITHUB_DISPATCH_TOKEN` | the app (controller) | fire ONLY the rollback workflow (`repository_dispatch`) | code-write / admin |

`GITHUB_DISPATCH_TOKEN` should be a fine-grained token with just **"Contents: read"** + the repo's
`repository_dispatch` permission — enough to POST a dispatch event, nothing else. Without it the controller
cannot auto-rollback and will escalate to a human instead (honest).

## 4. Enabling autonomy (safe order)

All autonomy is **OFF** by default (`/ai-command/improvements` → Governance). Turn it on in this order, only
after each prior step has a track record:

1. **Human-supervised** (default): AI opens PRs, you review + merge, CI deploys, controller verifies, you
   roll back by running the Rollback workflow manually. Live here first.
2. **Validate rollback once**: Actions → Rollback → "Run workflow" to confirm `rollback.yml` actually reverts
   the live app. Do NOT trust auto-rollback until this passes once.
3. **autoRollback on**: now a failed post-deploy health check reverts automatically (and still records +
   surfaces it).
4. **autoMerge on**: the controller merges a PR when CI + code-owner review are green. Safety-path PRs still
   need your review (CODEOWNERS), so the agent still can't self-approve guardrail changes.
5. **autoDeploy**: deploys already run on merge via CI; this switch only governs the controller's own
   triggering. Leave last.

## 5. Go-live checklist

- [ ] `AI_BRIDGE_TOKEN` set on Fly (done) and given to the responder.
- [ ] Agent machine user + fine-grained PAT created; added to repo as `write`.
- [ ] Responder runs in a sandbox with only the scoped secrets.
- [ ] `GITHUB_DISPATCH_TOKEN` set on the app (for auto-rollback) — optional until step 3.
- [ ] Branch protection: require CI + Code-Owner review, admins exempt (done).
- [ ] Rollback workflow validated once by hand.
- [ ] Autonomy enabled step by step, watching `/ai-command/improvements` between each.

Until the first three boxes are checked, **keep autonomy off** — the gates are advisory against an agent
that holds owner/admin creds.
