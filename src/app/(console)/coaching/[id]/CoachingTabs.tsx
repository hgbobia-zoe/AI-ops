"use client";

// Spiky-style tabbed analysis panel: Overview / Coaching / Objections / Actions / Transcript, each
// with a count badge. Pure presentation over the recap + Quo summary + transcript passed in.

import { useState } from "react";
import { FileText, GraduationCap, AlertTriangle, CheckSquare, ArrowRight, ScrollText, MessageSquareReply, MessageCircleQuestion, Gauge } from "lucide-react";
import type { CallQuestion } from "@/lib/coach/metrics";

export interface CoachingTabsProps {
  signals?: React.ReactNode; // metric tiles + sliders + momentum (Coaching board), tabbed in
  quoSummary: string | null;
  executive: string;
  keyPoints: string[];
  questions: CallQuestion[];
  coachingNotes: string[];
  customerConcerns: string[];
  objections: { objection: string; response: string }[];
  actionItems: string[];
  nextStep: string;
  followUpEmail: string;
  transcript: string | null;
  analyzed: boolean;
}

type TabKey = "signals" | "overview" | "questions" | "coaching" | "objections" | "actions" | "transcript";

export function CoachingTabs(props: CoachingTabsProps): React.JSX.Element {
  const summary = props.quoSummary?.trim() || props.executive?.trim() || "";
  const actionsCount = props.actionItems.length + (props.nextStep ? 1 : 0) + (props.followUpEmail ? 1 : 0);

  const tabs: { key: TabKey; label: string; count: number | null; icon: typeof FileText }[] = [
    ...(props.signals ? [{ key: "signals" as TabKey, label: "Signals", count: null, icon: Gauge }] : []),
    { key: "overview", label: "Overview", count: null, icon: FileText },
    { key: "questions", label: "Questions", count: props.questions.length || null, icon: MessageCircleQuestion },
    { key: "coaching", label: "Coaching", count: props.coachingNotes.length || null, icon: GraduationCap },
    { key: "objections", label: "Objections", count: (props.objections.length || props.customerConcerns.length) || null, icon: AlertTriangle },
    { key: "actions", label: "Actions", count: actionsCount || null, icon: CheckSquare },
    { key: "transcript", label: "Transcript", count: null, icon: ScrollText },
  ];

  const [active, setActive] = useState<TabKey>(props.signals ? "signals" : props.analyzed ? "coaching" : "overview");

  return (
    <section className="surface overflow-hidden border border-white/5">
      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b border-white/10 px-2 pt-2">
        {tabs.map((t) => {
          const on = active === t.key;
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
                on ? "border-foreground text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="size-4" /> {t.label}
              {t.count != null && (
                <span className={`ml-0.5 rounded-full px-1.5 text-[10px] font-semibold tabular-nums ${on ? "bg-white/15" : "bg-white/[0.06]"}`}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>

      <div className="p-4 md:p-5">
        {active === "signals" && props.signals}

        {active === "overview" && (
          <div className="space-y-4">
            {summary ? (
              <div>
                <Label>Summary{props.quoSummary?.trim() ? " · from Quo" : ""}</Label>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{summary}</p>
              </div>
            ) : (
              <Empty>No summary yet.</Empty>
            )}
            {props.keyPoints.length > 0 && (
              <div>
                <Label>Key points</Label>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {props.keyPoints.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        {active === "questions" && (
          props.questions.length > 0 ? (
            <ul className="space-y-2">
              {props.questions.map((q, i) => (
                <li key={i} className="flex items-start gap-2.5 rounded-lg border border-white/10 bg-white/[0.02] p-3 text-sm">
                  <MessageCircleQuestion className="mt-0.5 size-4 shrink-0 text-sky-300" />
                  <div className="min-w-0">
                    <span className="mr-2 rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{q.speaker}</span>
                    {q.text}
                  </div>
                </li>
              ))}
            </ul>
          ) : <Empty>No questions detected in this call.</Empty>
        )}

        {active === "coaching" && (
          props.coachingNotes.length > 0 ? (
            <ul className="space-y-2.5">
              {props.coachingNotes.map((n, i) => (
                <li key={i} className="flex items-start gap-2.5 rounded-lg border border-violet-500/20 bg-violet-500/[0.05] p-3 text-sm">
                  <GraduationCap className="mt-0.5 size-4 shrink-0 text-violet-300" /> <span>{n}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{props.analyzed ? "No coaching notes — the call went cleanly." : "Not analyzed yet."}</Empty>
        )}

        {active === "objections" && (
          props.objections.length > 0 ? (
            // Spiky's objection → response pairing.
            <ul className="space-y-3">
              {props.objections.map((o, i) => (
                <li key={i} className="grid gap-2 rounded-lg border border-white/10 p-3 sm:grid-cols-2 sm:gap-3">
                  <div className="rounded-md border border-amber-500/25 bg-amber-500/[0.06] p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-200"><AlertTriangle className="size-3.5" /> Objection</div>
                    <p className="text-sm">{o.objection || "—"}</p>
                  </div>
                  <div className="rounded-md border border-emerald-500/25 bg-emerald-500/[0.05] p-2.5">
                    <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-200"><MessageSquareReply className="size-3.5" /> Response</div>
                    <p className="text-sm">{o.response || "—"}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : props.customerConcerns.length > 0 ? (
            <ul className="space-y-2.5">
              {props.customerConcerns.map((c, i) => (
                <li key={i} className="flex items-start gap-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] p-3 text-sm">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-300" /> <span>{c}</span>
                </li>
              ))}
            </ul>
          ) : <Empty>{props.analyzed ? "No objections surfaced on this call." : "Not analyzed yet."}</Empty>
        )}

        {active === "actions" && (
          actionsCount > 0 ? (
            <div className="space-y-4">
              {props.nextStep && (
                <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.05] p-3">
                  <Label className="text-emerald-200">Recommended next step</Label>
                  <p className="flex items-start gap-2 text-sm"><ArrowRight className="mt-0.5 size-4 shrink-0 text-emerald-300" /> {props.nextStep}</p>
                </div>
              )}
              {props.actionItems.length > 0 && (
                <div>
                  <Label>Your action items</Label>
                  <ul className="space-y-1.5 text-sm">
                    {props.actionItems.map((a, i) => (
                      <li key={i} className="flex items-start gap-2"><CheckSquare className="mt-0.5 size-4 shrink-0 text-sky-300" /> {a}</li>
                    ))}
                  </ul>
                </div>
              )}
              {props.followUpEmail && (
                <div>
                  <Label>Follow-up email · draft, review before sending</Label>
                  <pre className="whitespace-pre-wrap rounded-md bg-black/20 p-3 font-sans text-sm leading-relaxed">{props.followUpEmail}</pre>
                </div>
              )}
            </div>
          ) : <Empty>{props.analyzed ? "No action items from this call." : "Not analyzed yet."}</Empty>
        )}

        {active === "transcript" && (
          props.transcript ? (
            <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted-foreground">{props.transcript}</pre>
          ) : <Empty>No transcript on this call.</Empty>
        )}
      </div>
    </section>
  );
}

function Label({ children, className = "" }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <h3 className={`mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground ${className}`}>{children}</h3>;
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="py-6 text-center text-sm text-muted-foreground">{children}</p>;
}
