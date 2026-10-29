// Marketing overview — the PURE presentation model for the /marketing landing blade. Takes the
// deterministic MarketingDashboard aggregation and derives the task-first view: whether the blade is in
// setup (nothing entered, no tools linked), what genuinely needs the operator's attention right now, the
// single most meaningful next action, and HONEST scope strings for every figure.
//
// Honesty rules this model enforces (no fabrication, "rules calculate / AI interprets"):
//  - Every counted thing here is a FACT the team entered manually (campaigns, content plan, reviews,
//    outreach prospects) or a link they saved. Nothing is pulled from a live Google/The-Knot feed.
//  - "No reviews logged" means nothing has been LOGGED HERE — it must never read as "the business has no
//    reviews". The scope strings below say so in words.
//  - Zero is distinct from unavailable: an empty section is a real empty set of MANUAL records, labelled
//    with its source and period, not an outage and not "complete company reporting".

import type { MarketingDashboard } from "./dashboard";
import type { Tone } from "@/lib/tone";

/** A single bucket of work that needs the operator — only surfaced when its count > 0. */
export interface AttentionItem {
  key: "outreach" | "content" | "reviews";
  count: number;
  /** The subset that is already past its date (drives the "overdue" wording + critical tone). */
  overdue: number;
  title: string;
  detail: string;
  href: string;
  linkLabel: string;
  tone: Tone;
}

export interface MarketingOverviewModel {
  /** Nothing has been entered anywhere AND no tools are linked — show the focused setup state. */
  isSetup: boolean;
  hasLinks: boolean;
  linkCount: number;
  /** Non-zero work buckets, highest-priority first. Empty when the operator is caught up. */
  attention: AttentionItem[];
  attentionTotal: number;
  /** The one meaningful primary action. `tone:"attention"` when it clears pending work. */
  primary: { label: string; href: string; tone: "attention" | "neutral" };
  /** Honest scope line per area: what the figure counts, its source, and its period. */
  scope: {
    reviews: string;
    content: string;
    campaigns: string;
    outreach: string;
  };
  hasCampaignData: boolean;
  hasContentData: boolean;
  hasReviewData: boolean;
  hasOutreachData: boolean;
}

// Attention is surfaced in a fixed, deterministic priority: time-sensitive relationship work
// (outreach follow-ups) first, then a missed public commitment (content past its date), then
// reputation replies. Within the chosen primary we prefer whatever is actually overdue.
const PRIORITY: AttentionItem["key"][] = ["outreach", "content", "reviews"];

export function buildMarketingOverview(d: MarketingDashboard): MarketingOverviewModel {
  const today = d.today;

  // ── Outreach follow-ups: open prospects whose next action is due this week or already past. ──
  const dueOutreach = d.outreach.dueThisWeek;
  const outreachOverdue = dueOutreach.filter((p) => p.nextAction != null && p.nextAction < today).length;
  const outreachCount = dueOutreach.length;

  // ── Content past its planned date and not posted. ──
  const contentOverdue = d.content.overdue.length;

  // ── Reviews logged here with no response recorded. ──
  const reviewsUnanswered = d.reviews.unresponded;

  const buckets: Record<AttentionItem["key"], AttentionItem | null> = {
    outreach:
      outreachCount > 0
        ? {
            key: "outreach",
            count: outreachCount,
            overdue: outreachOverdue,
            title: "Outreach follow-ups",
            detail:
              outreachOverdue > 0
                ? `${outreachCount} due this week · ${outreachOverdue} overdue`
                : `${outreachCount} due this week`,
            href: "/marketing/outreach",
            linkLabel: "Work outreach",
            tone: outreachOverdue > 0 ? "critical" : "attention",
          }
        : null,
    content:
      contentOverdue > 0
        ? {
            key: "content",
            count: contentOverdue,
            overdue: contentOverdue,
            title: "Content past its date",
            detail: `${contentOverdue} planned ${contentOverdue === 1 ? "piece is" : "pieces are"} past date, not posted`,
            href: "/marketing/content",
            linkLabel: "Update content",
            tone: "critical",
          }
        : null,
    reviews:
      reviewsUnanswered > 0
        ? {
            key: "reviews",
            count: reviewsUnanswered,
            overdue: 0,
            title: "Reviews to answer",
            detail: `${reviewsUnanswered} logged ${reviewsUnanswered === 1 ? "review has" : "reviews have"} no reply recorded`,
            href: "/marketing/reviews",
            linkLabel: "Reply to reviews",
            tone: "attention",
          }
        : null,
  };

  const attention = PRIORITY.map((k) => buckets[k]).filter((x): x is AttentionItem => x != null);
  const attentionTotal = attention.reduce((n, a) => n + a.count, 0);

  const hasCampaignData = d.campaigns.total > 0;
  const hasContentData = d.content.upcoming.length > 0 || d.content.overdue.length > 0 || d.content.ideas > 0;
  const hasReviewData = d.reviews.count > 0;
  const hasOutreachData = d.outreach.open > 0 || d.outreach.winsRecent > 0 || Object.values(d.outreach.byStage).some((n) => n > 0);

  const linkCount = Object.values(d.links).filter((v) => typeof v === "string" && v.trim().length > 0).length;
  const hasLinks = linkCount > 0;

  const isSetup = !hasCampaignData && !hasContentData && !hasReviewData && !hasOutreachData && !hasLinks;

  // Primary action: clear the top attention bucket if there is one; otherwise grow the top of the
  // funnel. Prefer an overdue bucket for the primary even if it is lower in the base priority.
  let primary: MarketingOverviewModel["primary"];
  if (attention.length > 0) {
    const overdueFirst = [...attention].sort((a, b) => b.overdue - a.overdue || PRIORITY.indexOf(a.key) - PRIORITY.indexOf(b.key));
    const top = overdueFirst[0];
    primary = { label: `${top.linkLabel} (${top.count})`, href: top.href, tone: "attention" };
  } else {
    primary = { label: "Add a prospect", href: "/marketing/outreach", tone: "neutral" };
  }

  return {
    isSetup,
    hasLinks,
    linkCount,
    attention,
    attentionTotal,
    primary,
    scope: {
      reviews: "Manually logged here — not a live Google / The Knot feed",
      content: "Planned items you logged, next 3 weeks",
      campaigns: "Campaigns tracked in this blade",
      outreach: "Prospects you're tracking before Goodshuffle · wins = last 30 days",
    },
    hasCampaignData,
    hasContentData,
    hasReviewData,
    hasOutreachData,
  };
}
