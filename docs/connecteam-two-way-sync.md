# Connecteam ↔ Dispatch: true two-way sync

Follows `docs/connecteam-sync-accuracy.md` (PR #47, the accuracy diagnosis + the read-side mirror). That PR
surfaced everything Lisa scheduled in Connecteam; this one makes the two systems **actually sync** so an app
shift and its Connecteam copy are the **same record**, reconciled in both directions.

Product decisions (set by the user, not re-litigated here):

- **Direction:** true two-way. Both sides can create/edit staff shifts; they stay linked.
- **Conflict rule:** last-edit-wins by timestamp. See the feasibility gate below for what this actually means
  given what Connecteam's API exposes.
- **Published only:** ingest only published Connecteam shifts.
- **Ingested-shift roles:** day-level. The importer never guesses a Zoe route. The existing
  schedule→route prompt (`scheduledUnrouted.ts`, PR #43) still nudges scheduled crew onto routes.

## 1. Feasibility gate — does Connecteam expose a per-shift last-modified? (resolved honestly)

Last-edit-wins needs two things from the Connecteam shifts API: a **stable per-shift id** and a **reliable
per-shift last-modified timestamp**.

- **Stable id: YES.** Connecteam shifts carry an `id` (an ObjectId string). The read path already keys on it
  (`connecteam.ts` `getShifts`), and the app shift row already has `connecteam_shift_id` (set by publish).
  This is the join key — solid.
- **Last-modified: NOT CONFIRMED.** Connecteam has **no public API docs**, and the pre-existing reader never
  captured any `updatedAt`/`lastModified` field off a shift — it only ever read
  `id, startTime, endTime, assignedUserIds, isOpenShift, title, jobId, locationData`. From the code alone we
  **cannot prove** the shift payload carries an edit time, and we must **not fabricate one** (a fake edit time
  would silently corrupt last-edit-wins).

Per the gate, we did **not** build last-edit-wins on an assumed timestamp. Instead:

1. The reader now **opportunistically** captures a last-modified **if the payload exposes one**
   (`CrewShift.lastModifiedUnix`, probed shape-tolerantly across common key names in
   `shiftLastModifiedUnix`). It stays `undefined` when absent. Nothing is invented.
2. The real conflict engine is **content-hash change detection**, which needs **no** timestamp. We remember
   the Connecteam content we last synced (`connecteam_content_hash`), so on each reconcile we can tell **which
   side changed**.
3. **Last-edit-wins is applied only when a genuine Connecteam last-modified is present.** When it is absent
   and both sides changed, we **flag the shift `needs_review`** for a human — never silently clobber.

So: the importer and the per-shift link are fully built and safe today. Last-edit-wins is **wired and will
activate automatically** the moment Connecteam turns out to expose an edit time; until then, true both-sides
conflicts are surfaced, not guessed. **To confirm the timestamp exists**, capture one raw shift payload from a
logged-in call against Lisa's account (`GET /scheduler/v1/schedulers/{id}/shifts`) and look for an edit-time
field; if present, no code change is needed — the shape-tolerant probe already reads the common names.

## 2. The per-shift link (join key)

`staff_shifts.connecteam_shift_id` is the single link between an app shift and its Connecteam shift.

- **App → Connecteam:** the publish path (`/api/scheduling/shift/[id]/publish`) already records
  `connecteam_shift_id` (and `connecteam_scheduler_id`) when it creates/updates the Connecteam shift.
  Unchanged here.
- **Connecteam → app:** the importer stores the Connecteam id on the app shift it creates
  (`createIngestedShift`). Because both sides write the same id, the reconciler **matches** instead of
  **duplicating**.

New additive, nullable bookkeeping columns on `staff_shifts` (migrated via the `MIGRATIONS` array):

| Column | Meaning |
| --- | --- |
| `connecteam_content_hash` | hash of the Connecteam shift content as of the last reconcile (change detection) |
| `connecteam_synced_at` | ISO of the last successful reconcile for this shift |
| `connecteam_last_modified` | ISO last-modified **from Connecteam** when the API exposes one, else null |
| `sync_status` | `null` \| `synced` \| `needs_review` |
| `sync_note` | human explanation when `needs_review` |

A new `ShiftSource` value `"connecteam"` marks shifts the app ingested (vs `derived`/`manual`).

## 3. The importer (Connecteam → app)

Split into a **pure planner** and a **thin DB wrapper**, so the logic is fully unit-tested.

- **`connecteamImport.ts` (pure):** `planReconcile({ date, connecteam, appShifts })` → a `ReconcilePlan`
  (`creates` / `updates` / `flags` / `unchanged`). Also `normalizeForImport` (published-only, day-level role,
  content hash) and `contentHashOf`. No DB, no network.
- **`connecteamReconcile.ts` (effects):** reads the day's Connecteam shifts (`getCrewForDateSafe`, reused from
  #47) + the app's shifts, runs the planner, and applies the plan idempotently with an audit trail
  (`SHIFT_SYNC_IMPORTED` / `SHIFT_SYNC_UPDATED` / `SHIFT_SYNC_NEEDS_REVIEW`).

Per-shift reconciliation logic:

| Situation | Action |
| --- | --- |
| Connecteam shift, no linked app shift | **Create** an app shift (`source=connecteam`, `status=sent`, day-level role, no route) |
| Linked, Connecteam content unchanged | no-op (**idempotent**) |
| Linked, app-pushed, never baselined (no stored hash) | **Baseline**: record the hash, do **not** touch app content |
| Linked, only Connecteam changed | **Update** app ← Connecteam (Connecteam wins) |
| Linked, both changed, Connecteam has a newer last-modified | **Update** app ← Connecteam (last-edit-wins) |
| Linked, both changed, app edit newer (timestamp present) | **Flag `needs_review`** (app should re-publish); not clobbered |
| Linked, both changed, no Connecteam last-modified | **Flag `needs_review`**; not clobbered |
| Linked, Connecteam copy no longer returned | **Flag `needs_review`**; never deleted |

Day-level role: derived from the Connecteam shift **title** (`roleFromTitle`), falling back to the dominant
role among its assignees, else `field`. Never a route guess.

## 4. App → Connecteam (unchanged, still human-gated)

The importer adds **no new Connecteam writes**. The app→Connecteam direction stays the existing, owner/admin,
confirm-first publish path. Because publish records `connecteam_shift_id`, a published shift is adopted
(baselined) by the next reconcile rather than re-imported as a duplicate. An app edit reaches Connecteam only
by **re-publishing** — the importer does not auto-push app edits.

## 5. What runs where

- Reconcile runs server-side in the runtime tick as the **`connecteam-sync`** job
  (`src/lib/runtime/jobs.ts`), RUNTIME_TOKEN-gated like the others. It sweeps **today..+14 days**.
- `configured()` = `connecteamImportEnabled()` = Connecteam configured **and** not killed by the
  `CONNECTEAM_IMPORT_DISABLED=1` env escape hatch.
- Connecteam IS server-side (Fly secret `CONNECTEAM_API_KEY`, direct REST), so unlike Goodshuffle this needs
  no browser/extension.

## 6. Guardrails (house law: never fabricate, never clobber silently)

- **Unreachable → do nothing.** A Connecteam outage (`ok:false`) or a thrown day is an **unknown**: that day
  is skipped, no app shift is created, changed, or deleted. An outage can never read as "nobody scheduled".
- **Vanished copy → flag, never delete.** A linked shift whose Connecteam copy disappears (deleted,
  **unpublished**, or moved out of the window) is marked `needs_review`, not removed.
- **True conflict → flag, never guess.** Both-sides changes with no reliable timestamp are surfaced for a
  human.
- **Idempotent.** Re-running with no changes is a no-op (hash match), and an already-`needs_review` shift is
  left alone (no re-flag thrash).
- **No double-counted coverage.** Ingested shifts are regular `staff_shifts`; the readiness/coverage gate
  still clears only on a real app assignment, and the honest "a Connecteam schedule is not route coverage"
  rule (PR #47) is untouched.

## 7. Honest caveats / open items

- **Last-modified is unverified** (see §1). Until a raw payload is checked, true both-sides conflicts go to
  `needs_review` rather than auto-resolving. This is the conservative, correct behavior.
- **Draft visibility.** We ingest published shifts and drop only **explicit** drafts (`isPublished === false`).
  Whether the endpoint returns drafts at all is unverified; if it doesn't, a shift Lisa builds but never
  publishes in Connecteam simply won't appear — tell her to publish.
- **Cache lag.** Crew reads are SWR-cached ~60s (#47), so a just-made Connecteam edit may take a tick to
  reconcile.
- **Unpublish reads as vanished.** Un-publishing a shift in Connecteam currently surfaces as a
  `needs_review` "copy vanished" flag (it leaves the published set). That is intentional — it is no longer an
  active published shift — but worth knowing.
- **Follow-up (now shipped, see §9):** a `needs_review` surface in `/scheduling` so Lisa sees + resolves
  flagged shifts without reading the audit log.

## 8. Route auto-sync (BOTH directions, automatic) — `routeAutoAssign.ts` + `routeAutoSync.ts`

PR #48 syncs **day-level** Connecteam shifts ↔ app shifts. This layer makes the **Dispatch route roster** and
the **Connecteam schedule** auto-stay-consistent both ways. It runs server-side in the runtime tick as the
**`connecteam-route-sync`** job (RUNTIME_TOKEN-gated), sweeping today..+14 days, and is gated by its own kill
switch **`CONNECTEAM_AUTOSYNC_DISABLED=1`** (mirrors `CONNECTEAM_IMPORT_DISABLED`).

### 8.1 Connecteam → route: AUTO-ASSIGN (not just prompt)
Reuses `scheduledUnrouted.ts` (PR #43), which already computes who is scheduled-but-unrouted, each person's
fillable route seat (driver/field), their eligible routes, and a suggested route. The pure
`planRouteAutoAssign` then decides per person:

| Case | Action |
| --- | --- |
| Exactly **one** eligible route (unambiguous) | **AUTO-ASSIGN** to it |
| **More than one** eligible route (ambiguous) | **Fall back to the one-click prompt** (`ScheduledToRoutePrompt`) |
| Prep not tied to a route | stays day-level (existing design; the detector never surfaces it as a route seat) |

Auto-assign performs a **real app assignment** through the **same store path** the one-click prompt uses
(find/create the route+role shift, add the assignee, dual-write the per-worker `shift_assignments` row). The
staffing gate (`preCheck.ts`) stays honest — a Connecteam schedule is never credited as coverage; the gap
clears only because an actual assignment now exists. **This is not locked:** a dispatcher can move/remove the
person afterward and #48's reconcile + last-edit-wins apply as before.

### 8.2 App route → Connecteam: AUTO-CREATE / ADOPT, **silently**
Enforces the invariant *"nobody on a Dispatch route without being in Connecteam."* For each **route** app
shift (has `routeId`, role driver/field, ≥1 assignee), the pure `planRouteConnecteamCreate` decides against
the day's **live Connecteam shifts** (`crew`, from the live read):

| The shift's assignees in Connecteam | Action |
| --- | --- |
| A single Connecteam shift holds **all** of them | **ADOPT** — `updatePublishedShift` that shift in place (`notifyUsers=false`), link the app shift to its id, and store the **unioned** (never-shrunk) window. No duplicate is created. (`matchConnecteamShiftForPush`) |
| **None** are in Connecteam | **CREATE** one Connecteam shift for the shift (all its assignees), **`notifyUsers=false`** |
| **All** are in Connecteam but spread across different shifts | **skip** — the invariant is already satisfied (no duplicate risk) |
| **Mixed** (some are, some aren't; no single shift holds all) | **flag `needs_review`** — creating one shift could duplicate or drop people; a human decides |

The **ADOPT** branch is the duplication fix (2026-10-29): pushing was previously idempotent only on the app
shift's own `connecteam_shift_id`, so a worker who already had a Connecteam shift (one built directly in
Connecteam, or one from another of the truck's routes) got a **second** shift pushed from the app. Matching on
the **assignee set** (worker + day, regardless of title/role/window) links to the existing shift and updates it
in place instead. The same match runs on the human **publish** path (`/api/scheduling/shift/[id]/publish`).

Already-linked shifts (`connecteam_shift_id` set), `needs_review` shifts, and cancelled shifts are skipped
(idempotent). A create with **no time window** is **deferred** (retried later; never a fabricated time). The
returned Connecteam id is stored (`connecteam_shift_id` + scheduler + `connecteam_published_at`, like the
publish path), so #48's reconcile **baselines** it next cycle and never re-imports a duplicate. The content
hash is left null so the baseline records it — avoiding a hash-mismatch re-flag.

**This changes the prior design** (PR #48 §4, where pushing to Connecteam was a separate human *publish*
step). The human publish path is unchanged and still available; auto-create is the additional automatic path,
and it is **always silent** so no crew is ever spammed by a sync.

### 8.3 Guardrails (maximum care — this auto-writes real employee data)
- **Silent:** every auto-create/update uses `notifyUsers=false` (new `PublishOpts` on
  `createPublishedShift`/`updatePublishedShift`; the human publish path still defaults to `notifyUsers=true`).
- **Idempotent / no duplicates:** dedupe strictly by `connecteam_shift_id`. Once linked, create never fires
  again; once a person is on a route app shift, auto-assign never re-surfaces them. No create-then-delete
  thrash. An accepted create that returns **no id** is flagged `needs_review` (so a re-run can't duplicate).
- **Outage-safe:** Connecteam unreachable → the day is **skipped**, nothing written. Auto-assign uses
  `scheduledUnroutedForDate` (reachable:false on outage); auto-create additionally requires the live crew
  read (to know who is already in Connecteam) — if it can't read it, it does **not** create blind.
- **Uncertain → record-only:** the mixed-presence case is flagged, never auto-written.
- **Kill switch:** `CONNECTEAM_AUTOSYNC_DISABLED=1`.

## 9. The `needs_review` conflict panel (`/scheduling`) + resolve

`needsReview.ts` + `NeedsReviewPanel.tsx` + `ResolveSyncButtons.tsx` + the owner/admin route
`POST /api/scheduling/shift/[id]/resolve-sync`.

- **Readers:** `listNeedsReview(date)` / `listNeedsReviewRange(start,end)` on the store.
- **Panel (server component):** lists every shift flagged `needs_review` for the selected date, each rendered
  **APP vs CONNECTEAM side by side** — role/title, window (start/end), assignees — with each side's **edit
  time** (app `updated_at` vs Connecteam `updateTime`/last-modified), the **newer** side marked, and the
  `sync_note`. `buildConflictViews` is pure (matches each flagged shift to its live Connecteam shift by id).
- **Resolve:** per shift, **Keep app version** or **Keep Connecteam version**.
  - *Keep Connecteam* → **pull** the live Connecteam content onto the app shift (same write as the reconcile
    update), or, for a linked-but-vanished copy, **accept the removal** (cancel + unlink the app shift).
  - *Keep app* → **push** the app version into Connecteam **silently** (`notifyUsers=false`): update the
    linked shift, or create one if unlinked. On success, clears `sync_status` back to `synced`.
  - `planResolve` is pure; the write apply (`applyResolveAction`) takes injectable publishers for testing.
- **Honest-when-unreachable:** if Connecteam is down the panel shows the **stored snapshot** (link id,
  last-modified, synced-at, note) and **disables** the resolve actions (we won't guess the authoritative
  version, and keep-app would need to write to a down Connecteam). Every resolve audits its outcome and
  clears the flag **only after the required write succeeds**.

### Honest caveats (route auto-sync + panel)
- **A person scheduled day-level in Connecteam and then auto-assigned to a route** keeps their day-level
  Connecteam shift; auto-create does **not** add a second (route) Connecteam shift for them, because they are
  already in Connecteam (the "all present → skip" rule). The route assignment lives app-side; this is correct
  and stable (no thrash).
- **The Goodshuffle driverId ≠ Connecteam userId gap (PR #43) still stands:** a route's Dispatch-assigned
  driver is matched to Connecteam crew by the app-shift assignee (a Connecteam userId), not by Goodshuffle's
  driver id. Auto-assign operates on Connecteam-scheduled people (userIds), so it is unaffected — but a route
  "driver" set only in Goodshuffle is not a Connecteam person and won't auto-create.
- **Publish-required-in-Connecteam** and **last-modified unverified** (§1, §7) are unchanged: shifts created
  by auto-sync are published (`isPublished=true`), and last-edit-wins still activates only if Connecteam
  exposes an edit time.
- **Near-window conflicts:** the panel resolves the **selected date** (so the live match is exact);
  `listNeedsReviewRange` is available for a future multi-day roll-up.
