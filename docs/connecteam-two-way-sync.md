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
- **Follow-up (not in this PR):** a `needs_review` surface in the `/scheduling` UI so Lisa sees flagged shifts
  without reading the audit log. The data + audit trail are in place for it.
