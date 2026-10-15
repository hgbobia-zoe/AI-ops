# Connecteam ↔ Dispatch sync: accuracy diagnosis and two-way-sync recommendation

Reported by Lisa (ops coordinator), 2026-10-15:

> "The app just seems to be pulling inaccurately from Connecteam."
> "Initially I thought you said to make the schedule in Dispatch and it will push it out to Connecteam? But I've been scheduling in Connecteam this week and Dispatch isn't pulling info accurately."
> "I think we talked about the two way sync."

## 1. The core tension

The `/scheduling` blade was built **app-first**: the app owns the schedule, derives crew demand from the
day's routes, a human assigns internal crew, and the result is **published to Connecteam**. Lisa has been
doing the **opposite** — building the schedule directly in Connecteam — and expecting Dispatch to reflect
(pull) it. That reverse direction was only ever partially wired, so what she entered in Connecteam did not
show up as the schedule in Dispatch.

## 2. The Connecteam READ path (as built)

| Step | Where | Notes |
| --- | --- | --- |
| Fetch schedulers | `connecteam.ts` `getSchedulers()` → `GET /scheduler/v1/schedulers` | Filters out `isArchived`. Single call (no pagination). SWR-cached 5 min. |
| Fetch users (roster) | `getUsers()` → `GET /users/v1/users` | Paginated. SWR-cached 5 min. Role derived from the **"Title" custom field** via `roleFromTitle`. |
| Fetch shifts for a day | `getCrewForDateSafe(date)` → per scheduler `GET /scheduler/v1/schedulers/{id}/shifts?startTime=&endTime=` | **Reads ALL non-archived schedulers**, Unix seconds, pads ±1 day then filters by local-day. SWR-cached 60 s. `ok:false` when unreachable (never "nobody"). |
| Time-off / unavailability | `getUnavailabilityForDate` → `.../user-unavailability` | Per-user. Feeds the eligibility classifier. |

Where the pulled data surfaces today on `/scheduling`:

- A one-line **coverage headline** ("Connecteam today: N drivers, N prep…").
- The **"Warehouse / Prep · today"** section (`prepCrewToday`) — prep role only.
- Per-shift **recommendations** (a scheduled-but-unassigned worker ranks as a preferred candidate).
- The **schedule → route bridge** prompt (`scheduledUnrouted.ts`, PR #43) — driver/prep only.
- The **"Staffing roster and open shifts"** disclosure (`StaffingRosterSections`), closed by default,
  bucketed by role (Drivers / Prep / Unload / "Also on the schedule").

Reachability is honest throughout: an outage is `ok:false` and never read as an empty schedule.

## 3. What works each direction (before this change)

- **App → Connecteam (PUSH): works.** A confirmed app shift publishes via `createPublishedShift` /
  `updatePublishedShift` (verified live). Idempotent via `connecteam_shift_id`. This is unchanged here.
- **Connecteam → app (PULL): partial and lossy.** The app reads Connecteam shifts but does **not** render
  them as *the schedule*. They only trickle into the side surfaces above, and several of those drop crew
  (see §4). There is **no app shift created from a Connecteam shift**, and no per-record link back.

## 4. Confirmed accuracy gaps (code-grounded)

1. **The board is app-first; it does not mirror Connecteam.** The route cards + shifts come from the app
   store (`getShiftsForDate`) and route-derived demand. If Lisa builds her week in Connecteam and nobody
   runs demand/assign in the app, the board shows route gaps and recommendations, **not her schedule**.
   This is the primary driver of "Dispatch isn't pulling accurately." _Confirmed._
2. **Headline undercounted.** The old headline counted only `role === "driver"` and `role === "prep"`.
   Anyone whose Connecteam **Title** maps to the catch-all **"other"** bucket (office staff she put on the
   day, an unusual or blank title, a new hire whose Title custom field isn't set) was **silently dropped
   from the count**. The number never matched what she entered. _Confirmed._
3. **Title → role mis-bucketing cascades.** `roleFromTitle` only recognizes `driver` / `warehouse` /
   `asset`. A worker with any other title becomes `"other"`, which is then **excluded from
   `candidateRoles`** (never recommended onto a route), from **`fillRoleFor`** in the schedule→route bridge
   (never suggested), and from the driver/prep roster buckets. A driver with a blank/odd title reads as
   "No driver scheduled." Zoe's *current* real titles all map correctly, so this is a latent fragility, not
   necessarily Lisa's live symptom, but it is a real way the pull "drops" people. _Confirmed in code._

### Not the cause (checked, ruled out)

- **Epoch seconds vs ms:** consistent (seconds on the wire, `*1000` for `Date`). No bug.
- **Date / timezone / day boundary:** the ±1-day pad + local-day (`localYmd`) filter is correct.
- **Scheduler scoping:** reads cover **all** non-archived schedulers, so a shift in a different scheduler is
  still read. `CONNECTEAM_SCHEDULER_ID` only pins the **publish** target, not reads. (Edge: a shift in an
  *archived* scheduler would be dropped — unlikely for an active schedule.)

### Needs live data to confirm

- **Draft vs published shifts in Connecteam.** The read does not filter on `isPublished`; whether
  Connecteam's shifts endpoint returns **unpublished/draft** shifts is unverified. If Lisa builds but does
  not *publish* in Connecteam and the API only returns published shifts, the app cannot see them. Worth a
  live check against her account.
- **SWR cache lag.** Crew shifts are cached 60 s and served **stale-while-revalidate**, so the first load
  after she edits in Connecteam can serve the old value and only *then* refresh — she may need a second
  reload to see a just-made change. Bounded, but a plausible "it didn't update" contributor. Roster/titles
  cache 5 min.

## 5. What this change fixes

- New pure, tested `src/lib/scheduling/connecteamSchedule.ts`:
  - `summarizeConnecteamSchedule(crew)` — a **role-agnostic** mirror of the day: distinct people, counts
    for **every** role (including `other`), open-shift count, and each person's work windows. Honest when
    unreachable (UNKNOWN, never fabricated 0).
  - `connecteamScheduleHeadline(summary)` — an accurate headline that counts **all** roles.
- The scheduling page headline now uses `connecteamScheduleHeadline` (fixes the undercount, gap 4.2).
- A new always-visible **"On the Connecteam schedule"** panel (`ConnecteamScheduleMirror.tsx`) lists
  **everyone** Lisa scheduled in Connecteam that day, with titles and windows, regardless of role bucket
  (addresses gaps 4.1 and 4.3's visibility symptom). It **mirrors only** — it never credits a Connecteam
  schedule as route coverage, so the honest app-assignment gap and the publish gate are untouched.

Deliberately **not** changed (to stay safe): the `roleFromTitle` buckets (which titles count as driver/prep
is a product decision and feeds route-recommendation eligibility), the coverage/eligibility logic, the
app→Connecteam publish path, the SWR caching behavior.

## 6. Two-way sync: what it would take, and the open decisions

To make Dispatch a true two-way mirror (Lisa's real workflow) while keeping app→Connecteam push:

1. **A per-record link.** Give each app `staff_shifts` row a Connecteam shift id and (critically) **ingest
   Connecteam shifts as app shifts** when they have no app origin. The schema already carries
   `connecteam_shift_id` (set by publish); a pull-side importer would match on it and create/update the app
   shift from Connecteam when the id is one the app did not originate. Today matching is only userId + time
   overlap, and there is no importer. This is the keystone and is currently **deferred** (noted in the
   scheduling memory).
2. **A source-of-truth-per-field rule.** Decide which side owns which field so a pull does not clobber a
   local edit and vice versa (e.g. times/assignees from whichever side edited last; route linkage always
   app-owned since Connecteam has no concept of a Zoe route).
3. **A reconciliation pass** (in the runtime tick) that pulls Connecteam, upserts app shifts by id, and
   flags divergences instead of silently overwriting.

### OPEN DECISIONS — need the user (do not guess)

- **Conflict winner:** if the same shift is edited on **both** sides between syncs, who wins — Connecteam,
  the app, or last-writer-wins by timestamp? (Recommendation: last-writer-wins on times/assignees, app
  always wins on route linkage, but confirm.)
- **Is Connecteam the source of truth for the schedule, or the app?** Lisa's workflow implies Connecteam.
  If so, should "build in the app and publish" become the exception rather than the default?
- **Draft shifts:** should Dispatch mirror *unpublished* Connecteam shifts too, or only published ones?
  (Needs the live API check in §4.)
- **Ingested-shift roles:** a Connecteam shift has no Zoe route; when imported, does it become a day-level
  shift, or should the importer try to attach it to a matching route?

Until those are decided, this change ships the safe, clearly-correct half: **everything Lisa scheduled in
Connecteam is now surfaced accurately in Dispatch**, with the honest gap and the publish path intact.
