// Zoe standalone Auto-Pull runner (Playwright).
//
// WHY THIS EXISTS: the browser-extension pull works for reads (routes/bookings) but can only CREATE a
// Goodshuffle project shell from a real navigation. The old drainer used a popup (window.open) that fires
// only on a manual bookmarklet click, so create_project ops never drained on their own. This runner
// launches its OWN Chrome (a dedicated profile kept logged into Goodshuffle), does the same read-pull,
// and CREATES projects by navigating a tab — no popup, no open tab in your everyday Chrome, no clicks.
// Run it on a schedule (Windows Task Scheduler); nothing else needs to be open.
//
// Cloudflare blocks datacenter IPs, so this MUST run on an office machine (residential IP) with real
// Chrome (channel:"chrome") + a persistent profile — indistinguishable from a normal signed-in browser.
//
// One-time setup: run once headful and sign into pro.goodshuffle.com in the window it opens. The session
// then persists in the profile; later scheduled runs reuse it.
//
// Env:
//   ZOE_API           default https://zoe-dispatch.fly.dev
//   GS_INGEST_TOKEN   x-publish-token for the ingest APIs (only if the server sets it; fail-open otherwise)
//   ZOE_PROFILE       Chrome user-data-dir (default: %USERPROFILE%\ZoePull\profile)
//   ZOE_HEADLESS      "1" to run headless (only works once the profile is already logged in; not for setup)
//   ZOE_LOGIN_WAIT_MS how long to wait for a manual login on first run (default 180000)

import { chromium, type BrowserContext, type Page } from "playwright";
import { buildOfficePullScript } from "../../src/lib/gsPull";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const API = (process.env.ZOE_API || "https://zoe-dispatch.fly.dev").replace(/\/+$/, "");
const TOKEN = process.env.GS_INGEST_TOKEN || "";
const PROFILE = process.env.ZOE_PROFILE || path.join(os.homedir(), "ZoePull", "profile");
const HEADLESS = process.env.ZOE_HEADLESS === "1";
const LOGIN_WAIT_MS = Number(process.env.ZOE_LOGIN_WAIT_MS || 180000);
const GS = "https://pro.goodshuffle.com";

const log = (...a: unknown[]): void => console.log(new Date().toISOString(), ...a);

/** Logged in when the projects search API returns its usual shape (a 302 to /ui/auth returns HTML). */
async function loggedIn(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const r = await fetch("/app/project/searchProjects?page=0&pageSize=1&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true", { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" });
      if (!r.ok) return false;
      const j = await r.json().catch(() => null);
      return !!(j && (j as { projectSearch?: unknown }).projectSearch);
    } catch {
      return false;
    }
  });
}

/** Create + fully populate ONE project for a create_project outbox op, in the current (already-navigated
 *  to detail?id=…) page. Mirrors the in-app drainer (gsPull.ts). Returns a small status object. */
async function populateCreate(page: Page, op: { id: string; payload: Record<string, unknown> }, api: string, token: string): Promise<unknown> {
  return page.evaluate(
    async ({ op, api, token }) => {
      const p = op.payload as Record<string, unknown>;
      const pid = (location.href.match(/[?&]id=(\d+)/) || [])[1];
      if (!pid) return { error: "no project id after createNewProject", url: location.href };
      const GH = { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" } as Record<string, string>;
      const JH = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" } as Record<string, string>;
      const APPH: Record<string, string> = token ? { "content-type": "application/json", "x-publish-token": token } : { "content-type": "application/json" };
      const d = (p.details as Record<string, string>) || {};
      await fetch("/app/vendorTransaction/saveEventDetails", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), eventName: String(d.eventName || ""), fromDateStr: String(d.fromDateStr || ""), fromTimeStr: String(d.fromTimeStr || ""), toDateStr: String(d.toDateStr || ""), toTimeStr: String(d.toTimeStr || ""), eventType: String(d.eventType || ""), headCount: String(d.headCount || "") }).toString() });
      await fetch("/app/vendorTransaction/saveEventNotes", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), clientVisibleNotes: "", internalNotes: String(p.notes || ""), fulfillmentNotes: "" }).toString() });
      const loc = p.location as Record<string, string> | null;
      if (loc) await fetch("/app/vendorTransaction/saveDefaultEventLocation", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), venueName: String(loc.venueName || ""), venuePhoneNumber: "", venueAddress: String(loc.address || ""), venueAddress_line2: String(loc.line2 || ""), venueCity: String(loc.city || ""), venueCounty: String(loc.county || ""), venueState: String(loc.state || ""), venueZipCode: String(loc.zip || ""), venueCountry: String(loc.country || "US"), venueLatitude: String(loc.latitude || ""), venueLongitude: String(loc.longitude || ""), venueNotes: "" }).toString() });
      const gdate = String(p.eventDateMDY || "") || new Date().toLocaleDateString("en-US");
      const makeGroup = async (name: string): Promise<number | null> => { const gj = await (await fetch("/app/lineItemGroup/saveLineItemGroupEdits", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), lineItemGroupID: "", lineItemGroupName: String(name), lineItemGroupFromDate: gdate, lineItemGroupToDate: gdate, recalculateDailyItems: "false" }).toString() })).json(); return (gj && gj.newLineItemGroup && gj.newLineItemGroup.id) || null; };
      const addSvc = (gid: number, it: Record<string, unknown>): Promise<Response> => fetch("/app/transactionItemRelation/addInventoryItemToContract", { method: "POST", headers: JH, credentials: "include", body: JSON.stringify({ transactionID: Number(pid), lineItemGroupID: gid, parentRelationID: null, relationType: null, fulfillment: false, inventoryTypeStr: it.inventoryTypeStr, rateType: it.rateType, itemID: it.itemID, unitPrice: (it.unitPrice as number) || 0, quantity: (it.quantity as number) || 1 }) });
      const items = (p.addItems as Record<string, unknown>[]) || [];
      let ranItems = 0;
      if (items.length) { const rg = await makeGroup("Rental Items"); if (rg) for (const it of items) { await addSvc(rg, it); ranItems++; } }
      const legs = (p.logisticsLegs as Record<string, unknown>[]) || [];
      let ranLegs = 0;
      if (legs.length && loc) { const cv = await (await fetch("/app/vendorTransaction/initContractView?transactionID=" + pid, { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" })).json(); const groups = (cv && cv.lineItemGroupsToLoad) || []; let logiGrp: number | null = null; for (const g of groups) if (g.logisticsContainer) { logiGrp = g.id; break; } const evDate = String(d.fromDateStr || ""); if (logiGrp) for (const lg of legs) { await fetch("/app/transactionItemRelation/addInventoryItemToContract", { method: "POST", headers: JH, credentials: "include", body: JSON.stringify({ inventoryInjection: true, itemID: lg.itemID, fulfillment: false, transactionID: Number(pid), lineItemGroupID: logiGrp, relationID: null, relationType: null, parentRelationID: null, inventoryTypeStr: "SERVICE", rateType: lg.rateType, title: lg.title, description: null, isSubrental: false, internalNotes: "", showItemDescription: true, showItemAttributes: true, quantity: 1, unitPriceOverridden: false, unitPrice: 0, mileageFee: 0, discountDollarAmount: 0, discountPercentage: 0, itemStartDate: evDate, itemStartTime: null, itemEndDate: evDate, itemEndTime: null, itemHoursRented: null, eventTimeLineMarker: lg.eventTimeLineMarker, selectedTaxTypes: [], serviceStoreLocationID: null, venueName: loc.venueName, venueAddress: loc.address, venueAddress_line2: loc.line2, venueAddress_city: loc.city, venueAddress_state: loc.state, venueAddress_zipCode: loc.zip, venueAddress_county: loc.county, venueAddress_country: loc.country, venueAddress_latitude: loc.latitude, venueAddress_longitude: loc.longitude }) }); ranLegs++; } }
      const wu = p.windowUpgrade as { groupName?: string; item?: Record<string, unknown> } | null;
      let ranWu = false;
      if (wu && wu.item) { const g = await makeGroup(wu.groupName || "Delivery Timing"); if (g) { await addSvc(g, wu.item); ranWu = true; } }
      const url = "https://pro.goodshuffle.com/app/project/detail?id=" + pid;
      const ir = await fetch(api + "/api/gs/intake-result", { method: "POST", headers: APPH, body: JSON.stringify({ intakeId: p.intakeId, projectId: pid, url, ok: true }) });
      const ak = await fetch(api + "/api/gs/outbox", { method: "POST", headers: APPH, body: JSON.stringify({ id: op.id, ok: true }) });
      return { pid, intake: p.intakeId, name: d.eventName, ranItems, ranLegs, ranWu, irStatus: ir.status, ackStatus: ak.status };
    },
    { op, api, token },
  );
}

async function main(): Promise<void> {
  fs.mkdirSync(PROFILE, { recursive: true });
  const ctx: BrowserContext = await chromium.launchPersistentContext(PROFILE, { channel: "chrome", headless: HEADLESS, viewport: { width: 1280, height: 900 } });
  const page = ctx.pages()[0] || (await ctx.newPage());
  let heartbeatStatus = "error";
  let heartbeatDetail = "";
  try {
    await page.goto(GS + "/app/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    if (!(await loggedIn(page))) {
      if (HEADLESS) { log("NOT logged in and headless — run once headful to sign in. Aborting."); heartbeatStatus = "not_logged_in"; heartbeatDetail = "profile signed out"; return; }
      log(`Not signed in — sign into Goodshuffle in the window (waiting up to ${Math.round(LOGIN_WAIT_MS / 1000)}s)…`);
      const deadline = Date.now() + LOGIN_WAIT_MS;
      while (Date.now() < deadline && !(await loggedIn(page))) await page.waitForTimeout(3000);
      if (!(await loggedIn(page))) { log("Still not signed in — aborting."); heartbeatStatus = "not_logged_in"; return; }
      log("Signed in.");
    }

    // 1) READ PULL — reuse the exact in-app pull (routes + bookings + notes + photo drain), skipCreate.
    await page.goto(GS + "/app/dashboard", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.evaluate(buildOfficePullScript(API, TOKEN || undefined, 0, true));
    const pull = await page.waitForFunction(() => (window as unknown as { __zoePullDone?: unknown }).__zoePullDone, { timeout: 180000 }).then((h) => h.jsonValue()).catch(() => null);
    log("read-pull:", pull);

    // 2) CREATE DRAIN — createNewProject via a real navigation (no popup), then populate + report + ack.
    const ops = (await page.evaluate(async (api) => {
      try { const r = await fetch(api + "/api/gs/outbox", { headers: { accept: "application/json" } }); const j = await r.json(); return ((j.ops || []) as Record<string, unknown>[]).filter((o) => o.op === "create_project" && o.payload && (o.payload as Record<string, unknown>).intakeId).map((o) => ({ id: o.id as string, payload: o.payload as Record<string, unknown> })); } catch { return []; }
    }, API)) as { id: string; payload: Record<string, unknown> }[];
    log(`create ops pending: ${ops.length}`);
    let created = 0;
    for (const op of ops) {
      const cp = await ctx.newPage();
      try {
        await cp.goto(GS + "/app/project/createNewProject", { waitUntil: "domcontentloaded", timeout: 60000 });
        await cp.waitForFunction(() => /[?&]id=\d+/.test(location.href), { timeout: 30000 }).catch(() => {});
        const res = await populateCreate(cp, op, API, TOKEN);
        log("created:", res);
        created++;
      } catch (e) { log("create FAILED:", String(e).slice(0, 160)); }
      finally { await cp.close().catch(() => {}); }
    }

    heartbeatStatus = "ok";
    heartbeatDetail = `${(pull as { msg?: string } | null)?.msg || "read-pull done"} · ${created}/${ops.length} projects created`;
  } catch (e) {
    heartbeatDetail = String(e).slice(0, 160);
    log("RUN ERROR:", heartbeatDetail);
  } finally {
    // Heartbeat so the app's Connections health shows the runner is alive (agent "extension" reuses the dot).
    try { await page.evaluate(async ({ api, status, detail }) => { try { await fetch(api + "/api/pull/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agent: "extension", status, detail, at: new Date().toISOString() }) }); } catch { /* best-effort */ } }, { api: API, status: heartbeatStatus, detail: heartbeatDetail }); } catch { /* ignore */ }
    await ctx.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
