// Guided Outreach Plan engine. Turns one radar recommendation into a coached, step-by-step outreach
// playbook: the strategy, the exact touches in order, copy-paste scripts, objection handling, and how to
// get to the win (a quote). Deterministic floor written for a beginner; scripts can be AI-refined
// (facts-only, house voice). Never invents a contact, a date, or a claim about Zoe.

import { chat, llmConfigured, llmModel } from "@/lib/llm";
import { humanize } from "@/lib/salesos/outreach";
import { opportunityDetail } from "./service";
import { JURISDICTION_LABEL, ZOE_CATEGORY_LABEL } from "./types";
import { getCapabilityProfile } from "@/lib/pursuit/capabilityProfile";
import type { OutreachPlan, PlanStep, Objection } from "./outreachPlanShape";

function categoriesPhrase(cats: string[]): string {
  const labels = cats.map((c) => ZOE_CATEGORY_LABEL[c as keyof typeof ZOE_CATEGORY_LABEL] ?? c).filter(Boolean);
  return labels.length ? labels.map((l) => l.toLowerCase()).join(", ") : "tents, tables, chairs and event rentals";
}
const firstNameOf = (name: string): string => (name && name !== "the organizer" ? name.split(/\s+/)[0] : "there");

/** Build the coached outreach plan for one opportunity. Returns null if the opportunity is unknown. */
export function buildOutreachPlan(opportunityId: string, repName = "[your name]"): OutreachPlan | null {
  const d = opportunityDetail(opportunityId);
  if (!d) return null;
  const profile = getCapabilityProfile();

  const cats = categoriesPhrase(d.opp.zoeCategories as string[]);
  const jur = JURISDICTION_LABEL[d.opp.jurisdiction];
  const primary = d.primaryTarget;
  const targetName = d.awarded && d.awardee ? d.awardee : primary?.edge.entity.name ?? d.opp.organization ?? "the organizer";
  const targetLabel = d.awarded && d.awardee ? "Awarded event manager" : primary?.relationshipLabel ?? "Organizer";
  const email = primary?.edge.entity.email ?? null;
  const phone = primary?.edge.entity.phone ?? null;
  const hasContact = !!(email || phone);
  const rep = repName.trim() || "[your name]";
  const first = firstNameOf(targetName);
  const yourPhone = (profile.phone || profile.bidContactPhone || "").trim();

  // ── Strategy header ──────────────────────────────────────────────────────────────────────────
  let angle: string;
  if (d.awarded && d.awardee) {
    angle = `This one is already awarded to ${d.awardee}. Do not chase the government buyer. Reach ${d.awardee} as the event manager and offer Zoe as their rental subcontractor.`;
  } else if (d.opp.kind === "PROCUREMENT") {
    angle = `This is an open ${jur} solicitation. Your goal is to get on the buyer's radar and be positioned to quote or respond before the deadline.`;
  } else {
    angle = `This is a ${jur} event. Your goal is to reach whoever handles rentals and get them to ask you for a quote.`;
  }

  const dDeadline = d.maturity.daysToDeadline;
  const dEvent = d.maturity.daysToEvent;
  let whyNow: string;
  if (dDeadline != null && dDeadline <= 21) whyNow = `The deadline is about ${dDeadline} days out, so move now and keep it short.`;
  else if (dEvent != null && dEvent <= 45) whyNow = `The event is roughly ${dEvent} days away, so reach out this week while they are still choosing vendors.`;
  else if (dEvent != null || dDeadline != null) whyNow = `You have runway here, so lead with a relationship rather than a hard pitch.`;
  else whyNow = `No firm date on file, so this is an early relationship play. Introduce Zoe and stay on their radar.`;

  const strategyHeadline = d.awarded && d.awardee
    ? `Approach ${d.awardee} as a rental subcontractor`
    : hasContact
      ? `Reach ${targetName} and earn a quote conversation`
      : `Find the right person, then earn a quote conversation`;

  const channelPlan = !hasContact
    ? "No contact on file yet, so step one is finding the right person. Then email first and call if there is no reply."
    : email && phone
      ? "Email first. If there is no reply in three days, call and leave a voicemail."
      : email
        ? "Email first. If there is no reply in three days, follow up and try to find a phone number."
        : "No email on file, so start with a call and leave a short voicemail, then follow up.";

  // ── Steps ────────────────────────────────────────────────────────────────────────────────────
  const steps: PlanStep[] = [];

  steps.push({
    id: "prep",
    title: "Step 1 — Do your homework",
    channel: "research",
    when: "Before you reach out",
    goal: "Know who you are contacting and your one reason for reaching out.",
    actions: [
      `Confirm the right person at ${d.opp.organization ?? targetName}.`,
      `Note one detail about ${d.opp.name ?? "this opportunity"} you can mention (the date, venue, or scope).`,
      "Have your one-line reason ready: why Zoe is a fit for this specific event.",
      d.opp.sourceUrl ? "Open the source link so the details are in front of you." : "Do a quick search to fill in any missing details.",
    ].filter(Boolean),
    script: null,
    coaching: [
      "Spend five minutes, not an hour. You need three things: the right person, one detail about the event, and your one-line reason.",
      "Personalize the first line so it does not read like a mass blast.",
    ],
    successSignal: "You can name the person and say in one sentence why Zoe fits this event.",
  });

  if (!hasContact) {
    steps.push({
      id: "find-contact",
      title: "Step 2 — Find the right contact",
      channel: "research",
      when: "Day 1",
      goal: "Get an email or phone number for the person who handles rentals or procurement.",
      actions: [
        `Check ${d.opp.organization ?? "the organization"}'s website for a contact or procurement page.`,
        "Look for a planner, facilities, or procurement contact on LinkedIn.",
        "If it is a venue, call the main line and ask who handles outside rentals.",
      ],
      script: humanize(`Hi, I am ${rep} with Zoe Event Rentals. I am trying to reach whoever handles rentals for ${d.opp.name ?? "an upcoming event"}. Could you point me to the right person or their email?`),
      coaching: [
        "Getting the name is half the battle. A direct email beats a generic info@ every time.",
        "Do not pitch here. You are only asking who to talk to.",
      ],
      successSignal: "You have a name and an email or phone number.",
    });
  }

  // First touch — email if we have one, else call.
  if (email || !phone) {
    steps.push({
      id: "first-email",
      title: `Step ${steps.length + 1} — Send the first email`,
      channel: "email",
      when: hasContact ? "Day 1" : "Once you have the contact",
      goal: "Introduce Zoe and ask for one small yes: a quick call.",
      actions: ["Send the email below.", "Send it Tuesday to Thursday morning if you can.", "Set a reminder to follow up in three days."],
      script: humanize(
        `Subject: Event rentals for ${d.opp.name ?? "your event"}\n\n` +
          `Hi ${first},\n` +
          `I am ${rep} with Zoe Event Rentals. We provide ${cats} for events across the DC, Maryland and Virginia area.\n` +
          `I came across ${d.opp.name ?? "your event"} and wanted to introduce us as a resource. If your team is sorting out ${cats} for this, I would love to help.\n` +
          `Would you be open to a quick call this week to see if we are a fit?\n` +
          `Thanks,\n${rep}\nZoe Event Rentals${yourPhone ? `\n${yourPhone}` : ""}`,
      ),
      coaching: [
        "Keep it under ninety words. Busy people skim.",
        "One ask only, and make it a yes or no question in the last line.",
        "Do not attach a giant brochure on the first email. It can look like spam.",
      ],
      successSignal: "They reply, even a short one. Any reply means keep going.",
    });
  } else {
    steps.push({
      id: "first-call",
      title: `Step ${steps.length + 1} — Make the first call`,
      channel: "call",
      when: "Day 1",
      goal: "Reach the person, or leave a voicemail and follow up the same day.",
      actions: ["Call using the opener below.", "If it goes to voicemail, leave the short voicemail and send an email the same day."],
      script: humanize(
        `Opener: Hi ${first}, this is ${rep} with Zoe Event Rentals. Do you have a quick minute?\n` +
          `Reason: I saw ${d.opp.name ?? "your event"} and we handle ${cats} for DMV events.\n` +
          `Ask: Who handles rentals for this, and would it help if I put together a quick quote?`,
      ),
      coaching: [
        "Stand up and smile. It genuinely changes your voice.",
        "Say your name and company in the first sentence, then why you are calling.",
        "Ask one question, then stop talking and listen.",
      ],
      successSignal: "You reach them and learn who handles rentals, or you leave a voicemail and send an email.",
    });
  }

  steps.push({
    id: "call",
    title: `Step ${steps.length + 1} — Call and have the conversation`,
    channel: "call",
    when: "Day 5 to 7 (if no reply)",
    goal: "Have a real conversation: learn the details and ask for a quote.",
    actions: ["Call and use the opener.", "Ask the discovery questions.", "If it is a fit, ask to send a quote."],
    script: humanize(
      `Opener: Hi ${first}, this is ${rep} with Zoe Event Rentals, following up on my note about ${d.opp.name ?? "your event"}.\n` +
        `Discovery questions to ask:\n` +
        `- Who is handling rentals for this?\n` +
        `- What is the date and roughly how many guests?\n` +
        `- Have you locked in a vendor yet?\n` +
        `The ask: Based on that, can I put together a quick quote so you have options?\n` +
        `Voicemail if they do not pick up: Hi ${first}, ${rep} with Zoe Event Rentals about ${d.opp.name ?? "your event"}. We handle ${cats}. I will follow up by email${yourPhone ? `, or reach me at ${yourPhone}` : ""}. Thanks.`,
    ),
    coaching: [
      "Let them talk more than you do. Your job is to learn and to make the next step easy.",
      "You are not closing a sale on this call. You are earning a yes to a quote.",
      "Write down the date, location, and headcount. You need those for the quote.",
    ],
    successSignal: "They agree to receive a quote, or give you the details to build one.",
  });

  steps.push({
    id: "followup",
    title: `Step ${steps.length + 1} — Follow up with value`,
    channel: "email",
    when: "Day 10 to 14",
    goal: "Stay useful without pestering. Give a reason to reply.",
    actions: ["Send a short, helpful follow-up.", "Offer something concrete: a quick quote, a similar past event, or references."],
    script: humanize(
      `Hi ${first},\n` +
        `Circling back on ${d.opp.name ?? "your event"}. I know these get busy. If rentals are still on your list, I can put together a quick quote so you have options, no obligation. Want me to?\n` +
        `Thanks,\n${rep}`,
    ),
    coaching: [
      "Follow up is where most people quit and most deals are won. Three to four touches is normal, not annoying.",
      "Every message should give them something or ask one easy question. Never just 'checking in'.",
    ],
    successSignal: "They reply or agree to a quote.",
  });

  steps.push({
    id: "advance",
    title: `Step ${steps.length + 1} — Turn interest into a quote`,
    channel: "email",
    when: "As soon as they show interest",
    goal: "Get the yes to a quote. That is the win.",
    actions: [
      "The moment they show any interest, ask directly: can I put together a quote for you?",
      "Collect the date, location, and rough headcount.",
      "Build the quote in Goodshuffle and send it. From here it is a Goodshuffle lead.",
    ],
    script: humanize(`Great. To put together an accurate quote, can you tell me the date, the venue or location, and roughly how many guests? I will get you numbers within a day.`),
    coaching: [
      "A yes to a quote is the win. Once they are in Goodshuffle, they are engaged and the sale continues there.",
      "Do not over-negotiate now. Get the quote in front of them and keep the momentum.",
    ],
    successSignal: "They agree to a quote. Log it and continue in Goodshuffle / Sales OS.",
  });

  // ── Objection handling ─────────────────────────────────────────────────────────────────────────
  const objections: Objection[] = [
    {
      id: "have-vendor",
      trigger: "We already have a rental company.",
      response: "Totally understand, and I am not asking you to switch. A lot of our clients keep us on file for overflow or when their vendor is booked. Can I send a quick capabilities sheet so you have us if you need a backup?",
      why: "You lower the stakes. A backup is an easy yes, and vendors fall through more than you think.",
    },
    {
      id: "send-info",
      trigger: "Just email me some information.",
      response: "Happy to. I will send a short one-page overview today. Can I follow up Friday to answer any questions?",
      why: "Always pin a next step. 'Send info' with no follow-up date is where leads go to die.",
    },
    {
      id: "not-interested",
      trigger: "We are not interested.",
      response: "No problem at all, thanks for letting me know. If plans change or your vendor falls through, we are here and easy to reach.",
      why: "Do not argue. A gracious exit keeps the door open, and people remember it.",
    },
    {
      id: "price",
      trigger: "What are your prices?",
      response: "It depends on the setup, but I can turn around a quick quote if you tell me the date, location, and rough headcount. Want me to?",
      why: "Do not quote blind. Turn the price question into the quote you actually want to send.",
    },
    {
      id: "too-early",
      trigger: "We are not planning that yet.",
      response: "That is actually a great time to talk. I can share a few ideas and hold a soft date so you are covered when you are ready. Would that help?",
      why: "Early is good news. You get to shape the plan before a competitor does.",
    },
  ];

  return {
    opportunityId,
    opportunityName: d.opp.name,
    targetName,
    targetLabel,
    hasContact,
    strategyHeadline,
    whyNow,
    angle,
    channelPlan,
    steps,
    objections,
    source: "template",
    aiAvailable: llmConfigured(),
  };
}

/** Optionally rewrite the scripts in a warmer, more natural voice using ONLY the facts already in the
 *  plan. On any failure or when no LLM is configured, returns the deterministic scripts unchanged. */
export async function refinePlanScripts(plan: OutreachPlan): Promise<{ steps: { id: string; script: string }[]; source: "template" | "ai"; model?: string }> {
  const withScripts = plan.steps.filter((s) => s.script);
  if (!llmConfigured() || withScripts.length === 0) {
    return { steps: withScripts.map((s) => ({ id: s.id, script: s.script as string })), source: "template" };
  }
  const sys =
    "You polish outreach SCRIPTS (emails, call openers, voicemails) for Zoe Event Rentals in the DC/MD/VA area. " +
    "Use ONLY the facts already in each script. Never invent a name, a date, a price, a certification, or a claim. Keep every script short and plain. No dashes as punctuation, no emojis. " +
    'Return strict JSON: {"scripts": [{"id": string, "script": string}]} covering exactly the ids given.';
  const payload = withScripts.map((s) => ({ id: s.id, script: s.script }));
  const res = await chat([{ role: "user", content: `${sys}\n\nSCRIPTS:\n${JSON.stringify(payload, null, 2)}` }], { json: true, temperature: 0.4, maxTokens: 1200 });
  if (res.ok && res.text) {
    try {
      const parsed = JSON.parse(res.text) as { scripts?: { id: string; script: string }[] };
      if (Array.isArray(parsed.scripts) && parsed.scripts.length) {
        const byId = new Map(parsed.scripts.map((s) => [s.id, humanize((s.script ?? "").trim())]));
        return {
          steps: withScripts.map((s) => ({ id: s.id, script: byId.get(s.id) || (s.script as string) })),
          source: "ai",
          model: res.model ?? llmModel(),
        };
      }
    } catch {
      /* fall through */
    }
  }
  return { steps: withScripts.map((s) => ({ id: s.id, script: s.script as string })), source: "template" };
}
