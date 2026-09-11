// Coaching detail — one call's transcript + its post-call recap (Custodian's coaching brain in
// Maestro). The recap is generated on demand via a server action and cached in coaching_analyses, so
// re-visits are free. Owner/admin only (enforced here and in the proxy). The recap is INFERENCE over
// the transcript — labelled as such; it never invents facts.

import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import { revalidatePath } from "next/cache";
import { ArrowLeft, Headphones, ListChecks, CheckSquare, AlertTriangle, Mail, ArrowRight, GraduationCap } from "lucide-react";
import { getCallEventById, getCoachingAnalysis, saveCoachingAnalysis } from "@/lib/db/repo";
import { generateRecap } from "@/lib/coach/recap";
import { viewerRole } from "@/lib/auth/getSession";
import { canSeeCoaching } from "@/lib/auth/roles";
import { llmConfigured } from "@/lib/llm";
import { AnalyzeButton } from "./AnalyzeButton";

export const dynamic = "force-dynamic";

function fmtWhen(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
}

export default async function CoachingDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<React.JSX.Element> {
  if (!canSeeCoaching(await viewerRole())) redirect("/dashboard");
  const { id } = await params;
  const call = getCallEventById(id);
  if (!call) notFound();

  const recap = getCoachingAnalysis(id);
  const party = call.contactName || (call.direction === "outgoing" ? call.toPhone : call.fromPhone) || "Unknown caller";

  // Server action: (re)generate the recap for this call and cache it.
  async function analyze(): Promise<void> {
    "use server";
    const c = getCallEventById(id);
    if (!c || !c.transcript) return;
    const r = await generateRecap({
      transcript: c.transcript,
      direction: c.direction,
      contactName: c.contactName,
      durationSec: c.durationSec,
    });
    if (r) saveCoachingAnalysis(id, r);
    revalidatePath(`/coaching/${id}`);
  }

  return (
    <main className="mx-auto max-w-3xl p-5 pb-16 md:p-8">
      <Link href="/coaching" className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="size-4" /> All calls
      </Link>

      <header className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <Headphones className="size-6" /> {party}
          </h1>
          <p className="text-sm text-muted-foreground">
            {call.direction ?? "call"} · {fmtWhen(call.occurredAt ?? call.ts)}
            {call.sentiment ? ` · ${call.sentiment}` : ""}
          </p>
        </div>
        {call.transcript && llmConfigured() && (
          <form action={analyze}>
            <AnalyzeButton label={recap ? "Re-analyze" : "Analyze call"} />
          </form>
        )}
      </header>

      {!llmConfigured() && (
        <div className="surface mb-4 border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          The coaching model isn&apos;t configured — set <code>ANTHROPIC_API_KEY</code> to generate a recap.
        </div>
      )}

      {recap ? (
        <div className="space-y-5">
          <section className="surface border border-white/5 p-4">
            <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Summary</h2>
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{recap.executive || "—"}</p>
          </section>

          {recap.keyPoints.length > 0 && (
            <section className="surface border border-white/5 p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <ListChecks className="size-3.5" /> Key points
              </h2>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {recap.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </section>
          )}

          {recap.actionItems.length > 0 && (
            <section className="surface border border-white/5 p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <CheckSquare className="size-3.5" /> Your action items
              </h2>
              <ul className="space-y-1 text-sm">
                {recap.actionItems.map((a, i) => (
                  <li key={i} className="flex items-start gap-2"><CheckSquare className="mt-0.5 size-3.5 shrink-0 text-sky-300" /> {a}</li>
                ))}
              </ul>
            </section>
          )}

          {recap.customerConcerns.length > 0 && (
            <section className="surface border border-amber-500/20 p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-amber-200">
                <AlertTriangle className="size-3.5" /> Customer concerns
              </h2>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {recap.customerConcerns.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </section>
          )}

          {recap.coachingNotes.length > 0 && (
            <section className="surface border border-violet-500/25 bg-violet-500/[0.05] p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-200">
                <GraduationCap className="size-3.5" /> Coaching notes
              </h2>
              <ul className="space-y-1.5 text-sm">
                {recap.coachingNotes.map((n, i) => (
                  <li key={i} className="flex items-start gap-2"><GraduationCap className="mt-0.5 size-3.5 shrink-0 text-violet-300" /> {n}</li>
                ))}
              </ul>
            </section>
          )}

          {recap.followUpEmail && (
            <section className="surface border border-white/5 p-4">
              <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <Mail className="size-3.5" /> Follow-up email <span className="font-normal normal-case text-muted-foreground">· draft, review before sending</span>
              </h2>
              <pre className="whitespace-pre-wrap rounded-md bg-black/20 p-3 font-sans text-sm leading-relaxed">{recap.followUpEmail}</pre>
            </section>
          )}

          {recap.nextStep && (
            <section className="surface border border-emerald-500/20 bg-emerald-500/[0.04] p-4">
              <h2 className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-200">
                <ArrowRight className="size-3.5" /> Recommended next step
              </h2>
              <p className="text-sm">{recap.nextStep}</p>
            </section>
          )}

          <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            AI-generated recap — INFERENCE over the transcript, not a system of record. Review before acting; the
            follow-up email is a draft and never sends on its own.
          </p>
        </div>
      ) : (
        <div className="surface border border-white/10 p-8 text-center text-sm text-muted-foreground">
          {call.transcript
            ? "No recap yet. Click Analyze call to generate one from the transcript."
            : "This call has no transcript, so it can't be coached."}
        </div>
      )}

      {call.transcript && (
        <details className="surface mt-6 border border-white/5 p-4">
          <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Transcript</summary>
          <pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted-foreground">{call.transcript}</pre>
        </details>
      )}
    </main>
  );
}
