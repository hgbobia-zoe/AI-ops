// Approvals — the queue of AI-prepared actions awaiting a human OK. v1 is READ-ONLY: it lists the
// currently outbox-queued write-backs (the external-action channel an AI employee's EXECUTE / approval
// action will enqueue), honestly labeled "wired next". The six-field approval card
// (WHAT / WHY / DATA USED / EXPECTED OUTCOME / RISK / IF APPROVED) and approve/reject/edit/request-info
// are v2 — no send/execute path is wired here. Owner/admin only.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings } from "@/lib/auth/roles";
import { listGsOps } from "@/lib/db/repo";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { tableCls, theadCls, thCls } from "@/components/console-primitives";

export const dynamic = "force-dynamic";

function ago(ts: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(ts)) / 60_000));
  if (!Number.isFinite(min)) return "—";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export default async function AiOrgApprovalsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");

  let pending: ReturnType<typeof listGsOps> = [];
  try {
    pending = listGsOps(100).filter((o) => o.status === "pending");
  } catch {
    pending = [];
  }

  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Approvals</h1>
        <p className="text-[12.5px] text-meta">Actions prepared for a human OK. {pending.length} queued write-back{pending.length === 1 ? "" : "s"} awaiting a logged-in session.</p>
      </header>

      <OrgTabs active="/ai-org/approvals" />

      <p className="mb-5 border border-border bg-panel px-3 py-2.5 text-[12.5px] text-tertiary-text">
        Read-only in v1. The six-field approval card (what, why, data used, expected outcome, risk, what happens if approved) with approve / reject / edit / request-more-info is wired next (v2). Nothing here sends or executes.
      </p>

      {pending.length === 0 ? (
        <p className="border border-border px-3 py-3 text-[13px] text-positive">Nothing queued. No AI-prepared write-backs are waiting.</p>
      ) : (
        <div className="overflow-x-auto border border-border">
          <table className={tableCls}>
            <colgroup>
              <col style={{ width: "160px" }} />
              <col />
              <col style={{ width: "120px" }} />
              <col style={{ width: "110px" }} />
            </colgroup>
            <thead className={theadCls}>
              <tr>
                <th className={thCls}>Operation</th>
                <th className={thCls}>Target</th>
                <th className={thCls}>Attempts</th>
                <th className={thCls}>Queued</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((o) => (
                <tr key={o.id} className="border-t border-[var(--row-rule)] hover:bg-[var(--row-hover)]">
                  <td className="px-2.5 py-2.5 text-[13px] font-medium">{o.op}</td>
                  <td className="px-2.5 py-2.5 text-[12.5px] text-meta">{o.label || o.transactionId || o.routeId || o.stopId || "—"}</td>
                  <td className="px-2.5 py-2.5 text-[13px] tabular-nums text-tertiary-text">{o.attempts}</td>
                  <td className="px-2.5 py-2.5 text-[12.5px] tabular-nums text-meta">{ago(o.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
