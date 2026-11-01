"use client";

// Quo contact cleanup screen. Loads the duplicate report (GET /api/integrations/quo/contacts), shows the
// counts, and merges groups one at a time through POST /api/integrations/quo/contacts/merge. "Exact" groups
// (same name or no name) can be merged in bulk; "needs review" groups (different names on a shared number
// or email) need a per-group "same person" confirm. Merges only DELETE copies: a group whose kept contact
// is missing something a copy carries is marked "merge by hand in Quo" and has no Merge button. The server
// re-checks every group before it touches Quo.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, Users, Merge, Square } from "lucide-react";
import type { DedupeReport, ReportGroup } from "@/lib/comms/quoContacts";

type Tab = "exact" | "review";
type GroupState = { status: "merging" } | { status: "merged"; removed: number } | { status: "error"; reason: string };

const PAGE = 40;

type LoadResult = { report: DedupeReport } | { error: string };

async function fetchReport(refresh: boolean): Promise<LoadResult> {
  try {
    const r = await fetch(`/api/integrations/quo/contacts${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
    const json = await r.json().catch(() => null);
    if (r.ok) return { report: json as DedupeReport };
    return {
      error:
        json?.error === "quo_not_configured"
          ? "Quo is not connected. Add the Quo API key in Settings."
          : `Couldn't read Quo contacts (${json?.message ?? r.status}).`,
    };
  } catch {
    return { error: "Couldn't reach the server." };
  }
}

function fmtPhone(d10: string): string {
  return d10.length === 10 ? `(${d10.slice(0, 3)}) ${d10.slice(3, 6)}-${d10.slice(6)}` : d10;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso);
  return Number.isNaN(t.getTime())
    ? ""
    : t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}

export function QuoContactCleanup(): React.JSX.Element {
  const [report, setReport] = useState<DedupeReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("exact");
  const [shown, setShown] = useState(PAGE);
  const [pin, setPin] = useState("");
  const [states, setStates] = useState<Record<string, GroupState>>({});
  const [confirmed, setConfirmed] = useState<Record<string, boolean>>({});
  const [bulk, setBulk] = useState<{ running: boolean; done: number; total: number; confirming: boolean }>({
    running: false,
    done: 0,
    total: 0,
    confirming: false,
  });
  const [stopRequested, setStopRequested] = useState(false);
  const stopRef = useRef(false);
  const [authError, setAuthError] = useState(false);

  function apply(res: LoadResult): void {
    if ("error" in res) setLoadError(res.error);
    else {
      setReport(res.report);
      setStates({});
      setConfirmed({});
      setShown(PAGE);
    }
    setLoading(false);
  }

  function refresh(): void {
    setLoading(true);
    setLoadError(null);
    void fetchReport(true).then(apply);
  }

  useEffect(() => {
    void fetchReport(false).then(apply);
  }, []);

  const groups = useMemo(() => (report?.groups ?? []).filter((g) => g.confidence === tab), [report, tab]);
  const exactPending = useMemo(
    () =>
      (report?.groups ?? []).filter((g) => g.confidence === "exact" && g.deleteOnly && states[g.key]?.status !== "merged"),
    [report, states],
  );
  const removedSoFar = Object.values(states).reduce((n, s) => n + (s.status === "merged" ? s.removed : 0), 0);

  async function mergeGroup(g: ReportGroup): Promise<"ok" | "error" | "auth"> {
    setStates((s) => ({ ...s, [g.key]: { status: "merging" } }));
    try {
      const r = await fetch("/api/integrations/quo/contacts/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": pin },
        body: JSON.stringify({ contactIds: g.contacts.map((c) => c.id), confirmReview: g.confidence === "review" }),
      });
      if (r.status === 401) {
        setAuthError(true);
        setStates((s) => ({ ...s, [g.key]: { status: "error", reason: "Wrong admin code." } }));
        return "auth";
      }
      const json = await r.json().catch(() => null);
      if (json?.ok) {
        setStates((s) => ({ ...s, [g.key]: { status: "merged", removed: (json.deletedIds as string[]).length } }));
        return "ok";
      }
      setStates((s) => ({ ...s, [g.key]: { status: "error", reason: json?.reason ?? `Merge failed (${r.status}).` } }));
      return "error";
    } catch {
      setStates((s) => ({ ...s, [g.key]: { status: "error", reason: "Network error. Refresh to see where this group stands." } }));
      return "error";
    }
  }

  async function mergeAllExact(): Promise<void> {
    const queue = exactPending;
    stopRef.current = false;
    setStopRequested(false);
    setBulk({ running: true, done: 0, total: queue.length, confirming: false });
    let done = 0;
    for (const g of queue) {
      if (stopRef.current) break;
      const res = await mergeGroup(g);
      if (res === "auth") break;
      done++;
      setBulk((b) => ({ ...b, done }));
    }
    setBulk((b) => ({ ...b, running: false }));
  }

  if (loading && !report) {
    return (
      <div className="surface flex items-center gap-3 rounded-2xl border border-white/5 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Reading every Quo contact. A large address book takes a minute.
      </div>
    );
  }

  if (loadError && !report) {
    return (
      <div className="flex items-start gap-2 rounded-2xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-300">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <span>{loadError}</span>
      </div>
    );
  }

  if (!report) return <></>;
  const st = report.stats;

  return (
    <div className="space-y-5">
      {/* Counts */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Contacts in Quo" value={st.totalContacts} />
        <Stat label="Duplicate groups" value={st.groups} />
        <Stat label="Ready to remove" value={st.readyCopies} hint={`extra copies in ${st.readyGroups} exact groups`} />
        <Stat label="Merge by hand" value={st.handMergeGroups} hint="groups needing details copied in Quo" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>
          Read {fmtDate(report.fetchedAt)} at{" "}
          {new Date(report.fetchedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })}.
          {st.noPhoneOrEmail ? ` ${st.noPhoneOrEmail} contacts have no phone or email and can't be matched.` : ""}
          {removedSoFar ? ` Removed ${removedSoFar} copies this session.` : ""}
        </span>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || bulk.running}
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-1.5 text-sm text-foreground hover:bg-accent disabled:opacity-50"
        >
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Refresh from Quo
        </button>
      </div>

      {/* Admin code + bulk merge */}
      <section className="surface space-y-3 rounded-2xl border border-white/5 p-5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-sm">
            <span className="block text-xs uppercase tracking-wide text-muted-foreground">Admin code</span>
            <input
              type="password"
              inputMode="numeric"
              value={pin}
              onChange={(e) => {
                setPin(e.target.value.replace(/\D/g, "").slice(0, 8));
                setAuthError(false);
              }}
              className="w-32 rounded-xl border border-white/15 bg-transparent px-3 py-2 text-sm"
              placeholder="••••"
            />
          </label>
          {bulk.running ? (
            <div className="flex items-center gap-3 text-sm">
              <Loader2 className="size-4 animate-spin" /> Merging {bulk.done} of {bulk.total}
              <button
                type="button"
                onClick={() => {
                  stopRef.current = true;
                  setStopRequested(true);
                }}
                disabled={stopRequested}
                className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
              >
                <Square className="size-3.5" /> {stopRequested ? "Stopping…" : "Stop after this one"}
              </button>
            </div>
          ) : bulk.confirming ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-amber-200">
                Merge all {exactPending.length} exact groups? This removes{" "}
                {exactPending.reduce((n, g) => n + g.contacts.length - 1, 0)} extra copies from Quo.
              </span>
              <button
                type="button"
                onClick={() => void mergeAllExact()}
                className="rounded-xl bg-foreground px-4 py-2 text-sm font-medium text-background"
              >
                Yes, merge them
              </button>
              <button
                type="button"
                onClick={() => setBulk((b) => ({ ...b, confirming: false }))}
                className="rounded-xl border border-white/15 px-4 py-2 text-sm text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={!exactPending.length}
              onClick={() => setBulk((b) => ({ ...b, confirming: true }))}
              className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm hover:bg-accent disabled:opacity-50"
            >
              <Merge className="size-4" /> Merge all exact matches ({exactPending.length})
            </button>
          )}
        </div>
        {!bulk.running && bulk.total > 0 && (
          <p className="text-sm text-muted-foreground">
            Finished {bulk.done} of {bulk.total} groups. Anything that failed shows its reason on the group below.
          </p>
        )}
        {authError && <p className="text-sm text-red-400">That admin code was not accepted. Nothing was merged.</p>}
        <p className="text-xs text-muted-foreground">
          Each merge re-reads the contacts from Quo, checks the kept contact already has every phone number, email and
          detail the copies carry, saves a full backup in the audit log, and only then removes the extra copies. The
          kept contact itself is never changed. Groups where it is missing something are left for you to merge by hand
          in Quo.
        </p>
      </section>

      {/* Tabs */}
      <div className="flex gap-2">
        {(["exact", "review"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => {
              setTab(t);
              setShown(PAGE);
            }}
            className={`rounded-xl px-3 py-1.5 text-sm ${tab === t ? "bg-foreground text-background" : "border border-white/15 text-muted-foreground hover:text-foreground"}`}
          >
            {t === "exact" ? `Exact matches (${st.exactGroups})` : `Needs review (${st.reviewGroups})`}
          </button>
        ))}
      </div>

      {groups.length === 0 ? (
        <p className="rounded-2xl border border-white/5 p-5 text-sm text-muted-foreground">
          {tab === "exact" ? "No exact duplicates. Nice and clean." : "Nothing needs review."}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.slice(0, shown).map((g) => (
            <GroupCard
              key={g.key}
              group={g}
              state={states[g.key]}
              confirmed={!!confirmed[g.key]}
              onConfirm={(v) => setConfirmed((c) => ({ ...c, [g.key]: v }))}
              onMerge={() => void mergeGroup(g)}
              disabled={bulk.running}
            />
          ))}
          {groups.length > shown && (
            <button
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
              className="w-full rounded-xl border border-white/15 py-2 text-sm text-muted-foreground hover:text-foreground"
            >
              Show more ({groups.length - shown} left)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }): React.JSX.Element {
  return (
    <div className="surface rounded-2xl border border-white/5 p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value.toLocaleString("en-US")}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

function GroupCard({
  group,
  state,
  confirmed,
  onConfirm,
  onMerge,
  disabled,
}: {
  group: ReportGroup;
  state: GroupState | undefined;
  confirmed: boolean;
  onConfirm: (v: boolean) => void;
  onMerge: () => void;
  disabled: boolean;
}): React.JSX.Element {
  const merged = state?.status === "merged";
  const review = group.confidence === "review";
  return (
    <div className={`surface space-y-3 rounded-2xl border p-4 ${merged ? "border-emerald-500/20 opacity-60" : review ? "border-amber-500/25" : "border-white/5"}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2 font-medium">
            <Users className="size-4" /> {group.names.join(" / ") || "No name"}
          </div>
          <p className="text-xs text-muted-foreground">{group.reason}</p>
          {!group.deleteOnly && group.keptLacks.length > 0 && (
            <p className="text-xs text-amber-200">The kept contact is missing {group.keptLacks.join(", ")}.</p>
          )}
        </div>
        {merged ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-emerald-300">
            <Check className="size-4" /> Merged, {state.removed} removed
          </span>
        ) : !group.deleteOnly ? (
          <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs text-amber-200">Merge by hand in Quo</span>
        ) : (
          <div className="flex items-center gap-3">
            {review && (
              <label className="flex items-center gap-1.5 text-xs text-amber-200">
                <input type="checkbox" checked={confirmed} onChange={(e) => onConfirm(e.target.checked)} /> Same person
              </label>
            )}
            <button
              type="button"
              onClick={onMerge}
              disabled={disabled || state?.status === "merging" || (review && !confirmed)}
              className="inline-flex items-center gap-1.5 rounded-xl border border-white/15 px-3 py-1.5 text-sm hover:bg-accent disabled:opacity-50"
            >
              {state?.status === "merging" ? <Loader2 className="size-3.5 animate-spin" /> : <Merge className="size-3.5" />} Merge
            </button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <tbody>
            {group.contacts.map((c) => (
              <tr key={c.id} className="border-t border-white/5 align-top">
                <td className="py-1.5 pr-3">
                  {c.survivor ? (
                    <span className="rounded-md bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300">Keep</span>
                  ) : (
                    <span className="rounded-md bg-white/5 px-1.5 py-0.5 text-xs text-muted-foreground">Copy</span>
                  )}
                </td>
                <td className="py-1.5 pr-3">
                  {c.name || <span className="text-muted-foreground">No name</span>}
                  {c.company && c.company !== c.name ? <div className="text-xs text-muted-foreground">{c.company}</div> : null}
                </td>
                <td className="py-1.5 pr-3 tabular-nums">{c.phones.map(fmtPhone).join(", ")}</td>
                <td className="py-1.5 pr-3">{c.emails.join(", ")}</td>
                <td className="whitespace-nowrap py-1.5 text-xs text-muted-foreground">
                  {fmtDate(c.createdAt)}
                  {c.source ? ` · ${c.source}` : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {state?.status === "error" && <p className="text-sm text-red-400">{state.reason}</p>}
    </div>
  );
}
