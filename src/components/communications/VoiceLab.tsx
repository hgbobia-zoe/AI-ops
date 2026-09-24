"use client";

// Voice Lab — validate context assembly BEFORE a real line is live. Enter a caller number + a scenario
// (and optionally anchor a customer), Run Simulation, and see the exact Context Pack the agent would get,
// the read-only tools that would fire (with real results), the controlled actions the scenario implies
// (returned BLOCKED — the agent can't self-authorize), and a placeholder AI response. No real call is
// placed. This is a test harness.

import { useState } from "react";
import { FlaskConical, Loader2, Play, CheckCircle2, ShieldX, Bot } from "lucide-react";
import { PERMISSION_LABEL } from "@/lib/comms/toolRegistry";
import type { ToolResult } from "@/lib/comms/tools";
import type { ContextPack } from "@/lib/comms/types";
import { ContextPackView } from "./ContextPackView";

interface SimResult {
  reasonLabel: string;
  reasonConfidence: number;
  context: ContextPack;
  readTools: ToolResult[];
  actionTools: ToolResult[];
  aiResponse: string;
  expectedResult: string;
}

const SCENARIOS = [
  "Hi, I'm calling to check when my delivery is arriving on Saturday.",
  "I wanted to follow up on the quote you sent me last week.",
  "One of the chairs arrived broken and I'm really unhappy.",
  "I need to make a payment on my balance.",
  "Do you have any 20x40 tents available for June 14th?",
];

export function VoiceLab({ showMoney }: { showMoney: boolean }): React.JSX.Element {
  const [phone, setPhone] = useState("");
  const [scenario, setScenario] = useState("");
  const [bookingId, setBookingId] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<SimResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    setLoading(true);
    setErr(null);
    fetch("/api/communications/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone: phone.trim() || null, scenario: scenario.trim(), bookingId: bookingId.trim() || null }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((j: SimResult) => setResult(j))
      .catch(() => setErr("Simulation failed."))
      .finally(() => setLoading(false));
  };

  return (
    <main className="max-w-[1100px] p-6">
      <header className="mb-4">
        <h1 className="flex items-center gap-2 text-[22px] font-medium tracking-tight">
          <FlaskConical className="size-5 text-meta" /> Voice Lab
        </h1>
        <p className="mt-1 max-w-[680px] text-[13px] text-meta">
          Simulate a call to validate what the Tower would hand the voice agent — the Context Pack, the tool calls that would fire, and the actions that stay blocked. No real call is placed and nothing is sent.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[360px_1fr]">
        {/* Form */}
        <div className="space-y-3 rounded border border-border p-4">
          <Field label="Caller phone">
            <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+1 301 555 0142" className="w-full rounded border border-border bg-[var(--row)] px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40" />
          </Field>
          <Field label="Scenario (what the caller says)">
            <textarea value={scenario} onChange={(e) => setScenario(e.target.value)} rows={3} placeholder="e.g. Checking on my delivery for Saturday" className="w-full resize-y rounded border border-border bg-[var(--row)] px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40" />
            <div className="mt-1.5 flex flex-wrap gap-1">
              {SCENARIOS.map((s, i) => (
                <button key={i} onClick={() => setScenario(s)} className="rounded border border-border px-1.5 py-0.5 text-[10.5px] text-meta transition-colors hover:bg-[var(--row-hover)] hover:text-foreground">
                  {s.slice(0, 26)}…
                </button>
              ))}
            </div>
          </Field>
          <Field label="Anchor booking id (optional)">
            <input value={bookingId} onChange={(e) => setBookingId(e.target.value)} placeholder="Goodshuffle project id" className="w-full rounded border border-border bg-[var(--row)] px-2.5 py-2 text-[13px] text-foreground outline-none placeholder:text-meta focus:border-foreground/40" />
          </Field>
          <button onClick={run} disabled={loading || !scenario.trim()} className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-foreground/30 bg-foreground/[0.06] px-3 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50">
            {loading ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />} Run simulation
          </button>
          {err && <p className="text-[12.5px] text-critical">{err}</p>}
        </div>

        {/* Result */}
        <div className="min-w-0">
          {!result ? (
            <div className="flex h-full min-h-[200px] items-center justify-center rounded border border-dashed border-border text-[13px] text-meta">
              Run a simulation to see the assembled context and tool plan.
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3 rounded border border-border p-3">
                <span className="text-[11px] uppercase tracking-[0.08em] text-meta">Classified reason</span>
                <span className="text-[14px] font-medium text-foreground">{result.reasonLabel}</span>
                <span className="text-[11.5px] text-meta">{Math.round(result.reasonConfidence * 100)}% · heuristic (inference)</span>
              </div>

              <div className="rounded border border-border p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-meta"><Bot className="size-3.5" /> AI response</div>
                <p className="text-[13px] leading-relaxed text-tertiary-text">{result.aiResponse}</p>
                <p className="mt-2 border-t border-[var(--row-rule)] pt-2 text-[12px] text-meta"><span className="text-tertiary-text">Expected:</span> {result.expectedResult}</p>
              </div>

              {/* Tool plan */}
              <div className="rounded border border-border p-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Tool calls that would fire</div>
                <ul className="space-y-1">
                  {result.readTools.map((t, i) => <ToolLine key={`r${i}`} t={t} />)}
                  {result.actionTools.map((t, i) => <ToolLine key={`a${i}`} t={t} />)}
                </ul>
              </div>

              {/* Context pack */}
              <div className="rounded border border-border p-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-meta">Context pack handed to the agent</div>
                <ContextPackView pack={result.context} showMoney={showMoney} />
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

function ToolLine({ t }: { t: ToolResult }): React.JSX.Element {
  const blocked = t.blocked || !t.ok;
  return (
    <li className="flex items-center gap-2 rounded border border-border px-2.5 py-1.5 text-[12.5px]">
      {blocked ? <ShieldX className="size-3.5 shrink-0 text-critical" /> : <CheckCircle2 className="size-3.5 shrink-0 text-positive" />}
      <span className="font-medium text-foreground">{t.tool}</span>
      <span className="rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-meta">{PERMISSION_LABEL[t.permission]}</span>
      <span className={`ml-auto truncate text-[11.5px] ${blocked ? "text-critical" : "text-meta"}`}>{blocked ? t.reason ?? "Blocked" : "OK"}</span>
    </li>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div>
      <label className="mb-1 block text-[11px] font-medium uppercase tracking-[0.08em] text-meta">{label}</label>
      {children}
    </div>
  );
}
