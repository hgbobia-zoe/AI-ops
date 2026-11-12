// Fire-and-forget nudges to the Zoe Auto-Pull browser extension from an app page. The server CANNOT push
// to the extension (and can't call Goodshuffle at all — Cloudflare blocks it), so "on demand" means: when
// the operator does something in the app that just queued a Goodshuffle write, poke the extension in THIS
// browser to drain it now instead of waiting for its background alarm.
//
// Only works in the office-machine Chrome that actually has the extension installed (externally_connectable
// is declared for this origin). Everywhere else — a salesperson's phone, Safari, an extension-less Chrome —
// this silently no-ops, and the extension's own alarm picks the work up on its next cycle. Never throws.

import { sendToExtension } from "@/lib/extensionId";

// Shared poster. Sends a single {type} message to the extension (store build first, then the "Load unpacked"
// build) and resolves true ONLY if it answered with { ok: true }. Resolves false when this isn't Chrome, no
// extension answers, or after a 1.5s timeout (never hangs the caller). Never throws.
function poke(type: string): Promise<boolean> {
  const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1500));
  const ask = sendToExtension({ type }).then((r) => r.ok && Boolean(r.response && (r.response as { ok?: boolean }).ok));
  return Promise.race([ask, timeout]).catch(() => false);
}

/** Ask the extension to drain any pending create_project ops NOW (used right after a guided-intake submit).
 *  Best-effort: resolves true only if the extension answered. Resolves false when it's absent / not Chrome. */
export function nudgeCreateNow(): Promise<boolean> {
  return poke("zoe-create-now");
}

/** Ask the extension to drain the GENERAL gs_outbox NOW (photos / notes / delivery-fee / email / tasks),
 *  instead of waiting for its ~10-min read-pull. Used right after an app action queues such a write — e.g.
 *  the Delivery Pricing "Push delivery fee to Goodshuffle" button. Best-effort: resolves true only if the
 *  extension answered (so the caller can tell "office browser got it" from "extension absent"). Resolves
 *  false when it's absent / not Chrome. */
export function nudgeDrainNow(): Promise<boolean> {
  return poke("zoe-drain-now");
}
