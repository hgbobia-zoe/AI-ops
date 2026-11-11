// The shared tail of every outside lead (web form, Yelp, Google, an email to hello@): record the lead, post it
// to #new-leads when asked, dedupe, and queue the Goodshuffle create_project op. /api/gs/intake-result then
// sends the welcome template from inside the new project. One code path, so every source gets the same
// experience. Moved here unchanged from /api/intake/lead so /api/intake/email can reuse it.

import { createIntake, updateIntake } from "./store";
import { formatIntakeNotes, gsEventDetails, gsClientContact } from "./format";
import { mdyFromYmd } from "./gsItems";
import {
  toIntakePatch,
  webLeadEventName,
  webIntakeEnabled,
  webIntakeSalesPingEnabled,
  webLeadSmsApplies,
  webLeadSmsEnabled,
  webLeadSmsText,
  type NormalizedLead,
} from "./webLead";
import { enqueueGsOp, insertMessage, recentLeadCreateOpExists } from "@/lib/db/repo";
import { logImport } from "@/lib/pull/state";
import { logIntakeEvent } from "./audit";
import { notify } from "@/lib/notify/channels";
import { postNewLeadToSlack } from "./leadSlackReply";
import { sendSms } from "@/lib/notify/sms";
import { getSettings } from "@/lib/settings";
import { signoffHistoryFor } from "@/lib/comms/smsSignoffHistory";

export interface QueueLeadOpts {
  /** Post this text to #new-leads before the project exists (Viktor threads the project link under it). */
  slackText?: string | null;
  /** How far back a create for the same contact counts as a duplicate. Default 10 minutes (web form). */
  dedupeWindowMs?: number;
  /** Extra line for the project notes, after the source tag. */
  notesExtra?: string;
}

export interface QueueLeadResult {
  ok: true;
  created: boolean;
  reason: "queued" | "duplicate" | "intake disabled";
  intakeId: string;
  eventName?: string;
}

export async function queueLeadProject(lead: NormalizedLead, opts: QueueLeadOpts = {}): Promise<QueueLeadResult> {
  // ALWAYS record the lead first (so nothing is lost, even while disabled or on a duplicate).
  const intake = createIntake({ source: lead.source, ...toIntakePatch(lead) });

  if (opts.slackText) {
    await postNewLeadToSlack(lead.source, opts.slackText).catch(() => {});
  }

  // Master switch off: accept + record, but do not create a project or send anything.
  if (!webIntakeEnabled()) {
    logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 0, detail: "accepted (intake disabled)" });
    await logIntakeEvent("WEB_LEAD_DISABLED", intake.id, { source: lead.source });
    return { ok: true, created: false, reason: "intake disabled", intakeId: intake.id };
  }

  // Dedupe: a create for the same contact within the window → do not make a second project.
  if (recentLeadCreateOpExists(lead.emailKey, lead.phoneKey, opts.dedupeWindowMs)) {
    logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 0, rowsSkipped: 1, detail: "duplicate" });
    await logIntakeEvent("WEB_LEAD_DUPLICATE", intake.id, { source: lead.source });
    return { ok: true, created: false, reason: "duplicate", intakeId: intake.id };
  }

  // Reuse the guided-intake pipeline. Outside leads carry no address, so no location / legs / line items.
  const eventName = webLeadEventName(lead);
  const details = { ...gsEventDetails(intake), eventName };
  const notes = `${formatIntakeNotes(intake)}\n\nLead source: ${lead.source} (web intake)${opts.notesExtra ? `\n${opts.notesExtra}` : ""}`;

  enqueueGsOp({
    op: "create_project",
    label: `web lead (${lead.source}) ${eventName}`,
    payload: {
      intakeId: intake.id,
      eventName,
      notes,
      details,
      client: gsClientContact(intake),
      eventDateMDY: mdyFromYmd(lead.eventDate),
      addItems: [],
      windowUpgrade: null,
      location: null,
      logisticsLegs: [],
      // Web-lead specifics (ignored by the drainer; read by our own code):
      kind: "web_lead",
      source: lead.source,
      leadEmail: lead.emailKey,
      leadPhone: lead.phoneKey,
    },
  });
  updateIntake(intake.id, { status: "creating", gsStatus: "queued" });
  logImport(`intake:${lead.source}`, true, { rowsIn: 1, rowsWritten: 1, detail: `queued create: ${eventName}` });
  await logIntakeEvent("WEB_LEAD_QUEUED", intake.id, { source: lead.source, name: eventName });

  // Welcome text for sources whose Zap does not text the customer (Google). Never blocks the lead.
  if (webLeadSmsEnabled() && webLeadSmsApplies(lead.source) && lead.phone.trim()) {
    const text = webLeadSmsText(lead.firstName, signoffHistoryFor(lead.phone));
    const sms = await sendSms(lead.phone, text).catch((e) => ({ ok: false, error: String(e) }));
    // Logged like every other sent text, so the thank-you line rule sees it (never twice in one day).
    try {
      const r = sms as { ok: boolean; skipped?: boolean; providerMsgId?: string | null; error?: string };
      insertMessage({ channel: "sms", provider: getSettings().smsProvider, toPhone: lead.phone, body: text, providerMsgId: r.providerMsgId ?? undefined, status: r.ok ? "sent" : r.skipped ? "skipped" : "failed", error: r.error });
    } catch {
      /* logging never blocks the lead */
    }
    await logIntakeEvent(sms.ok ? "WEB_LEAD_SMS_SENT" : "WEB_LEAD_SMS_FAILED", intake.id, { source: lead.source, error: sms.ok ? undefined : (sms as { error?: string }).error });
  }

  // Optional quiet sales-ai ping (default OFF). Honest wording: the project is QUEUED, not yet created.
  if (webIntakeSalesPingEnabled()) {
    void notify("sales", `New ${lead.source} lead received, project queued: ${eventName}`).catch(() => {});
  }

  return { ok: true, created: true, reason: "queued", intakeId: intake.id, eventName };
}
