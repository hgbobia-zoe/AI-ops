// AI Org registry — the SOURCE OF TRUTH for Zoe's AI workforce. A structured config (like RUNTIME_JOBS),
// reviewed in code because permissions/authority are safety-critical. It describes the REAL humans and a
// small, justified roster of 19 AI employees mapped to modules that already exist. Where an agent has no
// real data backing today it is marked backing:"coming" and ships as a placeholder — NEVER with
// fabricated metrics (the derivation in service.ts enforces this).
//
// Authority defaults (§4.4 of the design doc): anything touching money, discounts, refunds, customer
// commitments, operationally significant schedule changes, hiring/firing, high-value comms, contract
// changes, or permanent deletion is APPROVAL_REQUIRED. v1 DECLARES this authority model on the detail
// page; it is not an execution engine yet (read/draft-only).

import type { AIEmployee, BladeKey, Human, Tool } from "./types";

// ── The real human roster (no fabricated people / departments) ────────────────
export const HUMANS: Human[] = [
  { name: "Hermann+Cindy", role: "Ownership / Operations" },
  { name: "Jessie", role: "Sales" },
  { name: "Lisa", role: "Back Office" },
  { name: "Princess", role: "Marketing" },
];

// ── Reusable tool definitions (real repo functions; "none" where a capability does not exist) ──
const T = {
  // DATA (read) — existing module reads
  salesWorklist: (): Tool => ({ id: "sales_worklist", label: "Read Sales OS worklist", category: "DATA", perm: "READ", backing: "salesos/service.ts:salesLeads" }),
  bookingHistory: (): Tool => ({ id: "booking_history", label: "Read booking + quote history", category: "DATA", perm: "READ", backing: "db/repo.ts:getOpenLeads/getBookingById" }),
  commsLog: (): Tool => ({ id: "comms_log", label: "Read comms timeline", category: "DATA", perm: "READ", backing: "comms/service.ts (comms_events)" }),
  routes: (): Tool => ({ id: "routes", label: "Read routes + stops", category: "DATA", perm: "READ", backing: "db/repo.ts:getRoutesForDate" }),
  exceptions: (): Tool => ({ id: "field_exceptions", label: "Read field exceptions", category: "DATA", perm: "READ", backing: "db/repo.ts:getOpenExceptions" }),
  crew: (): Tool => ({ id: "crew", label: "Read crew schedule", category: "DATA", perm: "READ", backing: "connecteam.ts:getCrewForDateSafe" }),
  finance: (): Tool => ({ id: "finance", label: "Read revenue + labor", category: "DATA", perm: "READ", backing: "finance/service.ts:financeForPeriod" }),
  inventoryDemand: (): Tool => ({ id: "inventory_demand", label: "Read concurrent item demand", category: "DATA", perm: "READ", backing: "inventory/inventory.ts:peakItemDemand" }),
  opportunities: (): Tool => ({ id: "opportunities", label: "Read opportunity board", category: "DATA", perm: "READ", backing: "opportunity/service.ts:opportunityBoard" }),
  marketing: (): Tool => ({ id: "marketing", label: "Read campaigns + content", category: "DATA", perm: "READ", backing: "marketing/dashboard.ts:marketingDashboard" }),

  // ANALYSIS — deterministic calcs / scores
  scoreLeads: (): Tool => ({ id: "score_leads", label: "Score + rank leads", category: "ANALYSIS", perm: "ANALYZE", backing: "salesos/nba.ts, salesos/calc.ts" }),
  bidReview: (): Tool => ({ id: "bid_review", label: "Bid percentile + quote-age analysis", category: "ANALYSIS", perm: "ANALYZE", backing: "salesos/bidReview.ts:bidReview" }),
  lossInsights: (): Tool => ({ id: "loss_insights", label: "Cluster lost-deal patterns", category: "ANALYSIS", perm: "ANALYZE", backing: "salesos/lost.ts:lossInsights" }),
  sentiment: (): Tool => ({ id: "sentiment", label: "Score call tone", category: "ANALYSIS", perm: "ANALYZE", backing: "comms/sentiment.ts:heuristicSentiment" }),
  riskScore: (): Tool => ({ id: "risk_score", label: "Score event readiness + risk", category: "ANALYSIS", perm: "ANALYZE", backing: "risk/readiness.ts, risk/engine.ts" }),
  eta: (): Tool => ({ id: "eta", label: "Compute route ETA / risk", category: "ANALYSIS", perm: "ANALYZE", backing: "eta/*, notify/routeRisk.ts" }),
  staffingPlan: (): Tool => ({ id: "staffing_plan", label: "Compute staffing requirement + plan", category: "ANALYSIS", perm: "ANALYZE", backing: "scheduling/optimize.ts, crewRules.ts" }),
  shiftReadiness: (): Tool => ({ id: "shift_readiness", label: "Compute shift readiness + coverage", category: "ANALYSIS", perm: "ANALYZE", backing: "scheduling/readiness.ts, scheduling/coverage.ts" }),
  attentionRank: (): Tool => ({ id: "attention_rank", label: "Rank + dedupe all signals", category: "ANALYSIS", perm: "ANALYZE", backing: "ops/manager.ts:buildAttention" }),
  financeTrend: (): Tool => ({ id: "finance_trend", label: "Compute revenue/labor/contribution trend", category: "ANALYSIS", perm: "ANALYZE", backing: "finance/calc.ts, sales/calc.ts" }),
  briefCompose: (): Tool => ({ id: "brief_compose", label: "Compose the deterministic daily brief", category: "ANALYSIS", perm: "ANALYZE", backing: "command/service.ts:commandCenter" }),
  oppScore: (): Tool => ({ id: "opp_score", label: "Score future-demand opportunities", category: "ANALYSIS", perm: "ANALYZE", backing: "opportunity/score.ts" }),
  connHealth: (): Tool => ({ id: "conn_health", label: "Assess integration health", category: "ANALYSIS", perm: "ANALYZE", backing: "health/connections.ts:computeConnections" }),

  // COMMS — draft (live, LLM key-gated) / send (always APPROVAL + master switch)
  draftComms: (): Tool => ({ id: "draft_comms", label: "Draft SMS / email / call script", category: "COMMS_DRAFT", perm: "DRAFT", backing: "salesos/outreachService.ts, llm.ts (COMMS_STYLE)" }),
  draftCoachNote: (): Tool => ({ id: "draft_coach_note", label: "Draft coaching note / debrief", category: "COMMS_DRAFT", perm: "DRAFT", backing: "coach/recap.ts:generateRecap" }),
  sendSms: (): Tool => ({ id: "send_sms", label: "Send SMS", category: "COMMS_SEND", perm: "APPROVAL_REQUIRED", backing: "api/salesos/send-sms (SMS_SEND_ENABLED)" }),
  sendEmail: (): Tool => ({ id: "send_email", label: "Send email", category: "COMMS_SEND", perm: "APPROVAL_REQUIRED", backing: "api/salesos/send-email -> gs_outbox email_send (EMAIL_SEND_ENABLED)" }),
  postNote: (): Tool => ({ id: "post_note", label: "Post note to Goodshuffle", category: "COMMS_SEND", perm: "APPROVAL_REQUIRED", backing: "gs_outbox note_append" }),

  // WORKFLOW — internal writes / queue ops
  createTask: (): Tool => ({ id: "create_task", label: "Create / assign task", category: "WORKFLOW", perm: "APPROVAL_REQUIRED", backing: "gs_outbox create_gs_task" }),
  raiseException: (): Tool => ({ id: "raise_exception", label: "Raise an exception / escalate", category: "WORKFLOW", perm: "ANALYZE", backing: "insertException(), ops/manager.ts" }),
  recordAudit: (): Tool => ({ id: "record_audit", label: "Record action to audit log", category: "WORKFLOW", perm: "EXECUTE", backing: "audit_logs (insertAudit/logSalesEvent)" }),

  // EXTERNAL — provider / outbox writes (APPROVAL by default)
  changePrice: (): Tool => ({ id: "change_price", label: "Change quote / delivery pricing", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "gs_outbox set_delivery_fee" }),
  publishSchedule: (): Tool => ({ id: "publish_schedule", label: "Publish schedule to Connecteam", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "connecteam.ts publish" }),
  postGig: (): Tool => ({ id: "post_gig", label: "Post an Instawork gig", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "none (capture deferred)" }),
  statusSync: (): Tool => ({ id: "status_sync", label: "Push stop/route status to Goodshuffle", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "none (proposed GS status-sync write, v3)" }),
  publishContent: (): Tool => ({ id: "publish_content", label: "Publish content", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "none (no auto-publish path)" }),
  changeSettings: (): Tool => ({ id: "change_settings", label: "Change settings / users", category: "EXTERNAL", perm: "APPROVAL_REQUIRED", backing: "admin/* (canManageSettings)" }),
};

// ── The roster ────────────────────────────────────────────────────────────────
export const AI_EMPLOYEES: AIEmployee[] = [
  // ───────────────────────── Jessie — Sales ─────────────────────────
  {
    id: "lead-intelligence",
    name: "Lead Intelligence",
    department: "sales",
    owner: "Jessie",
    mission: "Know every open lead and what to do next, before a human has to ask.",
    responsibilities: [
      "Score + rank the open pipeline by priority",
      "Compute the next-best-action and the 'why now' for each lead",
      "Surface high-value leads that just replied and are still untouched",
    ],
    inputs: [
      { label: "Sales OS worklist", ref: "salesos/service.ts:salesLeads", href: "/salesos/worklist" },
      { label: "Next-best-action", ref: "salesos/nba.ts:nextBestAction" },
      { label: "Lead scoring", ref: "salesos/calc.ts:priorityScore" },
    ],
    toolbox: [T.salesWorklist(), T.bookingHistory(), T.commsLog(), T.scoreLeads(), T.raiseException(), T.recordAudit()],
    escalationRules: [{ when: "High-value lead (>= $10k) just replied and is still untouched" }],
    backing: "live",
    valueMeasure: "Worklist coverage, time-to-first-touch",
    healthKey: "bookings",
  },
  {
    id: "quote-analyst",
    name: "Quote / Opportunity Analyst",
    department: "sales",
    owner: "Jessie",
    mission: "Catch quotes that are priced wrong or going stale before the deal is lost.",
    responsibilities: [
      "Run deterministic quote-age + gap analysis",
      "Compute bid percentile ('priced to win?') with no LLM",
      "Recommend REVIEW_QUOTE on at-risk deals",
    ],
    inputs: [
      { label: "Bid review", ref: "salesos/bidReview.ts:bidReview", href: "/salesos/bid" },
      { label: "Quote event-risk", ref: "salesos/quoteReview.ts" },
    ],
    toolbox: [T.bookingHistory(), T.bidReview(), T.draftComms(), T.changePrice(), T.recordAudit()],
    escalationRules: [{ when: "Quote stale past threshold on a large deal" }],
    backing: "live",
    valueMeasure: "Quote-review turnaround, win-rate on reviewed quotes",
    healthKey: "bookings",
  },
  {
    id: "lost-quote",
    name: "Lost Quote",
    department: "sales",
    owner: "Jessie",
    mission: "Learn why deals are lost and surface the ones worth winning back.",
    responsibilities: [
      "Tag loss reasons and cluster lost-deal patterns",
      "Surface win-back candidates",
      "Flag a repeated loss reason on high-value deals",
    ],
    inputs: [
      { label: "Win/loss stats", ref: "salesos/lost.ts:winLossStats", href: "/salesos/lost" },
      { label: "Loss insights", ref: "salesos/lost.ts:lossInsights" },
    ],
    toolbox: [T.bookingHistory(), T.lossInsights(), T.draftComms(), T.sendSms(), T.recordAudit()],
    escalationRules: [{ when: "Pattern of the same loss reason on high-value deals" }],
    backing: "live",
    valueMeasure: "Win-back contact rate, re-engaged revenue",
    healthKey: "bookings",
  },
  {
    id: "outreach",
    name: "Outreach",
    department: "sales",
    owner: "Jessie",
    mission: "Draft history-aware outreach so a rep can send in one click, never auto-send.",
    responsibilities: [
      "Draft history-aware SMS / email / call strategy",
      "Prepare the send for a human to approve",
      "Keep the house voice (no dashes, no emoji)",
    ],
    inputs: [
      { label: "Outreach drafting", ref: "salesos/outreachService.ts:draftLeadOutreach", href: "/radar/outreach" },
      { label: "Templates", ref: "salesos/outreach.ts" },
    ],
    toolbox: [T.salesWorklist(), T.commsLog(), T.draftComms(), T.sendSms(), T.sendEmail(), T.recordAudit()],
    escalationRules: [{ when: "A draft implies a customer commitment" }],
    backing: "live",
    valueMeasure: "Reply rate, drafts accepted vs edited",
    healthKey: "openphone",
  },
  {
    id: "sales-coach",
    name: "Sales Coach",
    department: "sales",
    owner: "Jessie",
    mission: "Score call tone and draft coaching so reps improve, deal by deal.",
    responsibilities: [
      "Score call tone (heuristic floor, LLM when keyed)",
      "Draft coaching notes + a debrief",
      "Flag a negative-tone call on an active deal",
    ],
    inputs: [
      { label: "Call sentiment", ref: "comms/sentiment.ts:heuristicSentiment", href: "/coaching" },
      { label: "Call recap", ref: "coach/recap.ts:generateRecap" },
    ],
    toolbox: [T.commsLog(), T.sentiment(), T.draftCoachNote(), T.postNote(), T.recordAudit()],
    escalationRules: [{ when: "Negative-tone call on an active deal" }],
    backing: "live",
    valueMeasure: "Coaching coverage, call-tone trend",
    healthKey: "openphone",
  },

  // ───────────────────────── Lisa — Back Office ─────────────────────────
  {
    id: "staffing",
    name: "Staffing",
    department: "backoffice",
    owner: "Lisa",
    mission: "Recommend the day's staffing plan and show the temp hours it saves.",
    responsibilities: [
      "Recommend a whole-day staffing plan",
      "Show temp hours / cost saved and coverage gaps",
      "Flag a gap that cannot be filled internally",
    ],
    inputs: [
      { label: "Staffing optimizer", ref: "scheduling/optimize.ts:optimizeStaffing", href: "/staffing" },
      { label: "Crew rules", ref: "crewRules.ts" },
    ],
    toolbox: [T.crew(), T.staffingPlan(), T.publishSchedule(), T.postGig(), T.recordAudit()],
    escalationRules: [{ when: "A coverage gap cannot be filled internally" }],
    backing: "partial",
    valueMeasure: "Temp hours avoided, coverage %",
    healthKey: "connecteam",
  },
  {
    id: "scheduling",
    name: "Scheduling",
    department: "backoffice",
    owner: "Lisa",
    mission: "Turn demand into ready shifts and keep readiness honest.",
    responsibilities: [
      "Materialize demand into draft shifts",
      "Compute readiness + coverage",
      "Flag shifts unready at start",
    ],
    inputs: [
      { label: "Shift readiness", ref: "scheduling/readiness.ts:computeShiftReadiness", href: "/scheduling" },
      { label: "Coverage", ref: "scheduling/coverage.ts" },
      { label: "Exception queue", ref: "scheduling/exceptions.ts:scanShiftExceptions" },
    ],
    toolbox: [T.crew(), T.shiftReadiness(), T.publishSchedule(), T.postGig(), T.recordAudit()],
    escalationRules: [{ when: "A shift is unready at start (RED)" }],
    backing: "partial",
    valueMeasure: "Shift readiness %, open-shift count",
    healthKey: "connecteam",
  },
  {
    id: "hiring",
    name: "Hiring",
    department: "backoffice",
    owner: "Lisa",
    mission: "Recruit and onboard when the roster needs more people.",
    responsibilities: ["Not wired yet — no hiring / HR / applicant store exists in the repo"],
    inputs: [],
    toolbox: [T.recordAudit()],
    escalationRules: [],
    backing: "coming",
    valueMeasure: "Not wired yet",
  },
  {
    id: "back-office",
    name: "Back Office",
    department: "backoffice",
    owner: "Lisa",
    mission: "Keep integrations healthy and surface the setup work that needs a hand.",
    responsibilities: [
      "Surface admin tasks + connection-attention items",
      "Flag an integration that is OFF / needs attention",
    ],
    inputs: [
      { label: "Connections health", ref: "health/connections.ts:computeConnections", href: "/admin/health" },
      { label: "Settings", ref: "settings.ts" },
    ],
    toolbox: [T.connHealth(), T.changeSettings(), T.recordAudit()],
    escalationRules: [{ when: "An integration is OFF or needs ATTENTION" }],
    backing: "partial",
    valueMeasure: "Connections healthy %, setup completeness",
  },

  // ───────────────────────── Princess — Marketing ─────────────────────────
  {
    id: "event-radar",
    name: "Event Radar",
    department: "marketing",
    owner: "Princess",
    mission: "Detect and score future-demand opportunities worth pursuing.",
    responsibilities: [
      "Detect + score future-demand opportunities",
      "Recommend which to pursue",
      "Flag a high-score opportunity near its deadline",
    ],
    inputs: [
      { label: "Opportunity board", ref: "opportunity/service.ts:opportunityBoard", href: "/radar" },
      { label: "Scoring", ref: "opportunity/score.ts" },
    ],
    toolbox: [T.opportunities(), T.oppScore(), T.draftComms(), T.sendEmail(), T.recordAudit()],
    escalationRules: [{ when: "A high-score opportunity is near its deadline" }],
    backing: "seed",
    valueMeasure: "Opportunities surfaced -> pursued, pipeline added",
  },
  {
    id: "content",
    name: "Content",
    department: "marketing",
    owner: "Princess",
    mission: "Keep the content cadence and flag what is overdue.",
    responsibilities: [
      "Flag overdue / upcoming content",
      "Draft copy (via Creative / LLM)",
      "Flag overdue content on a live campaign",
    ],
    inputs: [
      { label: "Marketing dashboard", ref: "marketing/dashboard.ts:marketingDashboard", href: "/marketing/content" },
      { label: "Content store", ref: "marketing/store.ts:listContent" },
    ],
    toolbox: [T.marketing(), T.draftComms(), T.publishContent(), T.recordAudit()],
    escalationRules: [{ when: "Overdue content on a live campaign" }],
    backing: "partial",
    valueMeasure: "Content cadence kept, overdue count",
  },
  {
    id: "campaign-analyst",
    name: "Campaign Analyst",
    department: "marketing",
    owner: "Princess",
    mission: "Aggregate campaign spend vs result and flag underperformers.",
    responsibilities: [
      "Aggregate campaign spend vs result",
      "Flag underperformers",
      "Flag spend rising with no result movement",
    ],
    inputs: [
      { label: "Marketing dashboard", ref: "marketing/dashboard.ts:marketingDashboard", href: "/marketing/campaigns" },
      { label: "Campaign store", ref: "marketing/store.ts:listCampaigns" },
    ],
    toolbox: [T.marketing(), T.financeTrend(), T.changePrice(), T.recordAudit()],
    escalationRules: [{ when: "Spend is up with no result movement" }],
    backing: "partial",
    valueMeasure: "Campaigns with recorded ROI, win-by-source",
  },
  {
    id: "competitive-intelligence",
    name: "Competitive Intelligence",
    department: "marketing",
    owner: "Princess",
    mission: "Track competitors on the keywords and markets that matter.",
    responsibilities: ["Phase-3 placeholder — only signal today is scraped competitor refs behind the unconfigured Ubersuggest MCP"],
    inputs: [{ label: "SEO competitors (stub)", ref: "seo/discovery.ts (competitorRefs)", href: "/seo/competitors" }],
    toolbox: [T.recordAudit()],
    escalationRules: [{ when: "A new competitor appears on a target keyword" }],
    backing: "coming",
    valueMeasure: "Competitor coverage tracked",
  },

  // ───────────────────────── Hermann + Cindy — Ops / Exec ─────────────────────────
  {
    id: "executive-briefing",
    name: "Executive Briefing",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Compose the deterministic daily brief from the existing aggregates.",
    responsibilities: [
      "Compose the daily brief from existing aggregates",
      "Flag a RED day / rising critical count",
    ],
    inputs: [
      { label: "Command Center", ref: "command/service.ts:commandCenter", href: "/dashboard" },
      { label: "Sales year", ref: "sales/service.ts:salesYearOverview" },
    ],
    toolbox: [T.briefCompose(), T.finance(), T.recordAudit()],
    escalationRules: [{ when: "Day status RED or the critical count rises" }],
    backing: "live",
    valueMeasure: "Brief accuracy, owner time saved",
  },
  {
    id: "event-risk",
    name: "Event Risk",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Score readiness and list open risks with a recommended action.",
    responsibilities: [
      "Score readiness, list open risks + recommended action",
      "Feed the attention filter",
      "Flag CRITICAL risk / CONSTRAINED capacity",
    ],
    inputs: [
      { label: "Risk engine", ref: "risk/engine.ts:assessDay", href: "/risk" },
      { label: "Readiness", ref: "risk/readiness.ts:computeReadiness" },
      { label: "Risk queue", ref: "risk/store.ts:getRiskQueue" },
    ],
    toolbox: [T.routes(), T.crew(), T.riskScore(), T.raiseException(), T.recordAudit()],
    escalationRules: [{ when: "A CRITICAL risk or CONSTRAINED capacity day" }],
    backing: "live",
    valueMeasure: "Risks caught pre-event, readiness trend",
  },
  {
    id: "dispatch-route",
    name: "Dispatch / Route",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Monitor route progress and compute ETA / risk live.",
    responsibilities: [
      "Monitor route progress, compute ETA / risk",
      "Prepare a customer-facing status push (approval-gated)",
      "Flag a stop exception / route behind",
    ],
    inputs: [
      { label: "Routes for date", ref: "db/repo.ts:getRoutesForDate", href: "/dispatch" },
      { label: "Open exceptions", ref: "db/repo.ts:getOpenExceptions" },
      { label: "ETA", ref: "eta/*, notify/routeRisk.ts" },
    ],
    toolbox: [T.routes(), T.exceptions(), T.eta(), T.statusSync(), T.recordAudit()],
    escalationRules: [{ when: "A stop exception or a route running behind" }],
    backing: "live",
    valueMeasure: "On-time %, exceptions resolved",
    healthKey: "routes",
  },
  {
    id: "inventory-exception",
    name: "Inventory Exception",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Surface peak concurrent demand per item (over-booking stays UNVERIFIED).",
    responsibilities: [
      "Surface peak concurrent demand per item",
      "Flag concurrency spikes on a date",
      "Over-booking stays UNVERIFIED — no owned-inventory master exists",
    ],
    inputs: [{ label: "Peak item demand", ref: "inventory/inventory.ts:peakItemDemand", href: "/risk" }],
    toolbox: [T.inventoryDemand(), T.raiseException(), T.recordAudit()],
    escalationRules: [{ when: "Peak demand spikes on a date" }],
    backing: "partial",
    valueMeasure: "Concurrency conflicts flagged (not over-booking)",
  },
  {
    id: "business-intelligence",
    name: "Business Intelligence",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Compute revenue / labor / contribution trends and catch variance.",
    responsibilities: [
      "Compute revenue / labor / contribution trends + outcomes",
      "Flag labor over plan past the alert threshold",
      "Contribution stays UNAVAILABLE until real costs resolve — never costs-zeroed",
    ],
    inputs: [
      { label: "Finance period", ref: "finance/service.ts:financeForPeriod", href: "/finance" },
      { label: "Labor allocation", ref: "finance/allocation.ts:allocateDriverLabor" },
      { label: "History snapshots", ref: "history/store.ts" },
    ],
    toolbox: [T.finance(), T.financeTrend(), T.recordAudit()],
    escalationRules: [{ when: "Labor is over plan past the alert threshold" }],
    backing: "live",
    valueMeasure: "Trend accuracy, variance caught",
    healthKey: "connecteam",
  },
  {
    id: "priority-exception",
    name: "Priority / Exception",
    department: "ops_exec",
    owner: "Hermann+Cindy",
    mission: "Collapse all signals to the few that truly need an owner — fewer interruptions, not more.",
    responsibilities: [
      "Rank ALL signals, dedupe, filter to the few that need an owner",
      "Suppress already-acknowledged items",
      "Promote only P0 / P1 to an owner push",
    ],
    inputs: [
      { label: "Attention feed", ref: "ops/manager.ts:buildAttention", href: "/ops" },
      { label: "Ops overview", ref: "ops/service.ts:opsOverview" },
      { label: "Field exceptions", ref: "db/repo.ts:getOpenExceptions" },
    ],
    toolbox: [T.attentionRank(), T.exceptions(), T.raiseException(), T.recordAudit()],
    escalationRules: [{ when: "Critical / high remains after filtering" }],
    backing: "live",
    valueMeasure: "Fewer, higher-signal interruptions (noise reduction)",
  },
];

/** One employee by id, or undefined. */
export function getEmployee(id: string): AIEmployee | undefined {
  return AI_EMPLOYEES.find((e) => e.id === id);
}

// ── Blade mapping (additive) ────────────────────────────────────────────────
// Which AI employees surface INSIDE each operating blade's page. This is the per-blade strip's source of
// placement truth: each human sees their own AI team in context. Some pages deliberately surface a wider
// set than one canonical home — staffing+scheduling share the back-office roster, finance+command share
// the exec trio — so the same id appears under more than one blade here. Every id must exist in
// AI_EMPLOYEES (asserted by the test). No fabrication: the strip only ever shows real registry agents.
export const BLADE_AGENTS: Record<BladeKey, string[]> = {
  salesos: ["lead-intelligence", "quote-analyst", "lost-quote", "outreach", "sales-coach"],
  scheduling: ["scheduling", "staffing", "back-office", "hiring"],
  staffing: ["staffing", "scheduling", "back-office", "hiring"],
  marketing: ["content", "campaign-analyst", "competitive-intelligence"],
  radar: ["event-radar"],
  dispatch: ["dispatch-route", "inventory-exception"],
  "event-risk": ["event-risk", "inventory-exception"],
  finance: ["business-intelligence", "executive-briefing", "priority-exception"],
  command: ["executive-briefing", "priority-exception", "business-intelligence"],
};

// The canonical home blade per employee (the one page that "owns" it). Drives the additive `blade` field
// stamped onto each config below. Every live/seed/partial agent has a home; a "coming" agent still
// declares its intended home so it shows (as "not wired yet") where it will live.
const CANONICAL_BLADE: Record<string, BladeKey> = {
  "lead-intelligence": "salesos",
  "quote-analyst": "salesos",
  "lost-quote": "salesos",
  outreach: "salesos",
  "sales-coach": "salesos",
  staffing: "staffing",
  scheduling: "scheduling",
  hiring: "staffing",
  "back-office": "staffing",
  "event-radar": "radar",
  content: "marketing",
  "campaign-analyst": "marketing",
  "competitive-intelligence": "marketing",
  "executive-briefing": "command",
  "event-risk": "event-risk",
  "dispatch-route": "dispatch",
  "inventory-exception": "event-risk",
  "business-intelligence": "finance",
  "priority-exception": "command",
};

// Stamp the additive `blade` field onto each config from the canonical map (kept here so the per-agent
// home and the per-page composition stay in one file and can't drift unnoticed — the test guards it).
for (const e of AI_EMPLOYEES) e.blade = CANONICAL_BLADE[e.id];

/** The employee ids that surface in a given blade's strip (in display order). */
export function agentIdsForBlade(blade: BladeKey): string[] {
  return BLADE_AGENTS[blade] ?? [];
}
