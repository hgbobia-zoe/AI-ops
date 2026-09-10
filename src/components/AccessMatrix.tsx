// Access matrix reference — what each role can do. Static, derived from the same rules in
// src/lib/auth/roles.ts (kept in sync by hand; roles.ts is the source of truth). Shown on the Team
// screen so whoever invites people can pick the right role at a glance.

import { Check, Minus, ShieldCheck } from "lucide-react";

type Cell = "yes" | "no" | { note: string };

interface Capability {
  label: string;
  detail?: string;
  owner: Cell;
  admin: Cell;
  member: Cell;
}

const ROWS: Capability[] = [
  {
    label: "Day-to-day ops",
    detail: "Dispatch, Event Risk, Staffing, History, Ops Manager, Sales OS, Customers",
    owner: "yes",
    admin: "yes",
    member: "yes",
  },
  {
    label: "See dollar figures",
    detail: "Financial blade + revenue / cost / totals everywhere (hidden for Members)",
    owner: "yes",
    admin: "yes",
    member: "no",
  },
  {
    label: "Settings & integrations",
    detail: "App settings, providers, pull routes / data health",
    owner: "yes",
    admin: "yes",
    member: "no",
  },
  {
    label: "Invite & manage teammates",
    owner: "yes",
    admin: { note: "Members only" },
    member: "no",
  },
  {
    label: "Manage Admins & Owners",
    owner: "yes",
    admin: "no",
    member: "no",
  },
];

function CellMark({ cell }: { cell: Cell }): React.JSX.Element {
  if (cell === "yes") return <Check className="mx-auto size-4 text-emerald-400" aria-label="yes" />;
  if (cell === "no") return <Minus className="mx-auto size-4 text-white/25" aria-label="no" />;
  return <span className="text-[11px] text-amber-300">{cell.note}</span>;
}

export function AccessMatrix(): React.JSX.Element {
  return (
    <section className="surface border border-white/10">
      <div className="flex items-center gap-2 border-b border-white/10 p-3 text-sm font-semibold">
        <ShieldCheck className="size-4" /> What each role can do
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="p-3 font-medium">Capability</th>
              <th className="p-3 text-center font-medium">Owner</th>
              <th className="p-3 text-center font-medium">Admin</th>
              <th className="p-3 text-center font-medium">Member</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {ROWS.map((r) => (
              <tr key={r.label}>
                <td className="p-3">
                  <div className="font-medium">{r.label}</div>
                  {r.detail && <div className="text-[11px] text-muted-foreground">{r.detail}</div>}
                </td>
                <td className="p-3 text-center"><CellMark cell={r.owner} /></td>
                <td className="p-3 text-center"><CellMark cell={r.admin} /></td>
                <td className="p-3 text-center"><CellMark cell={r.member} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-white/10 p-3 text-[11px] text-muted-foreground">
        Members run the day-to-day but never see money or settings. Admins add financials, settings, and can invite Members.
        Owners can do everything, including managing Admins and other Owners.
      </p>
    </section>
  );
}
