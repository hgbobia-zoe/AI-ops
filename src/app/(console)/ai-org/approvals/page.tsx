// Approvals (AI Org v2) — the real queue of AI-prepared actions awaiting a human OK. Each pending
// request renders the six-field card (what / why / data used / expected outcome / risk / what happens
// if approved) with APPROVE / REJECT / EDIT / REQUEST MORE INFO. Approving routes to the EXISTING
// execution path (a gs_outbox op) and respects the send gates (EMAIL_SEND_ENABLED / SMS_SEND_ENABLED);
// money / pricing / schedule / hiring / Instawork actions are FORBIDDEN to execute here (intent only).
// $-bearing cards are hidden from roles that can't see financials. Owner/admin only.

import { redirect } from "next/navigation";
import { viewerRole } from "@/lib/auth/getSession";
import { canManageSettings, canSeeFinancials } from "@/lib/auth/roles";
import { listPendingApprovals, listDecidedApprovals, type AiApproval } from "@/lib/aiorg/approvals";
import { OrgTabs } from "@/components/aiorg/AiOrgBits";
import { ApprovalCard, type ApprovalCardData } from "@/components/aiorg/ApprovalCard";
import { ProposeButtons } from "@/components/aiorg/ProposeButtons";

export const dynamic = "force-dynamic";

function toCardData(a: AiApproval): ApprovalCardData {
  return {
    id: a.id,
    agentId: a.agentId,
    owner: a.owner,
    title: a.title,
    actionType: a.actionType,
    status: a.status,
    financial: a.financial,
    card: a.card,
    payload: {
      transactionId: typeof a.actionPayload.transactionId === "string" ? a.actionPayload.transactionId : undefined,
      leadId: typeof a.actionPayload.leadId === "string" ? a.actionPayload.leadId : undefined,
      body: typeof a.actionPayload.body === "string" ? a.actionPayload.body : undefined,
      subject: typeof a.actionPayload.subject === "string" ? a.actionPayload.subject : undefined,
    },
    createdAt: a.createdAt,
    decidedBy: a.decidedBy,
    decidedAt: a.decidedAt,
    decisionNote: a.decisionNote,
    outboxOpId: a.outboxOpId,
  };
}

export default async function AiOrgApprovalsPage(): Promise<React.JSX.Element> {
  const role = await viewerRole();
  if (!canManageSettings(role)) redirect("/dashboard");
  const showMoney = canSeeFinancials(role);

  let pending: AiApproval[] = [];
  let decided: AiApproval[] = [];
  try {
    pending = listPendingApprovals(100);
    decided = listDecidedApprovals(50);
  } catch {
    pending = [];
    decided = [];
  }

  const visible = pending.filter((a) => showMoney || !a.financial);
  const hiddenFinancial = pending.length - visible.length;

  const emailGate = process.env.EMAIL_SEND_ENABLED === "true";
  const smsGate = process.env.SMS_SEND_ENABLED === "true";

  return (
    <main className="max-w-[1000px] p-6">
      <header className="mb-4">
        <h1 className="text-[22px] font-medium tracking-tight">Approvals</h1>
        <p className="text-[12.5px] text-meta">AI-prepared actions awaiting a human OK. {visible.length} pending.</p>
      </header>

      <OrgTabs active="/ai-org/approvals" />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 border border-border bg-panel px-3 py-2.5">
        <ProposeButtons />
        <div className="flex items-center gap-3 text-[11px] text-meta">
          <span>Email send: <span className={emailGate ? "text-positive" : "text-attention"}>{emailGate ? "on" : "off"}</span></span>
          <span>SMS send: <span className={smsGate ? "text-positive" : "text-attention"}>{smsGate ? "on" : "off"}</span></span>
        </div>
      </div>

      <p className="mb-5 text-[12px] text-meta">
        Approving routes to the existing Goodshuffle outbox and respects the send gates above. A gate that is off records the decision but holds the send, never forces it. Money, pricing, schedule, hiring and Instawork actions cannot execute here (intent only).
      </p>

      {visible.length === 0 ? (
        <p className="border border-border px-3 py-3 text-[13px] text-positive">Nothing pending. Use Draft &amp; propose to prepare actions from the live worklist.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((a) => (
            <ApprovalCard key={a.id} data={toCardData(a)} actionable />
          ))}
        </div>
      )}

      {hiddenFinancial > 0 && (
        <p className="mt-3 border border-border px-3 py-2.5 text-[12.5px] text-meta">{hiddenFinancial} dollar-bearing approval{hiddenFinancial === 1 ? " is" : "s are"} hidden for your role.</p>
      )}

      {decided.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-2 text-[13px] font-medium uppercase tracking-[0.1em] text-tertiary-text">Decided</h2>
          <div className="space-y-2">
            {decided.filter((a) => showMoney || !a.financial).map((a) => (
              <ApprovalCard key={a.id} data={toCardData(a)} actionable={false} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}
