// Zoe Auto-Pull — create_project drainer (declared content script on /app/project/detail*).
//
// GOAL 2, OPT-IN (default OFF; see options "Create projects from queued intakes"). The background worker
// opens a background tab at /app/project/createNewProject for one pending create op; Goodshuffle
// redirects that to /app/project/detail?id=<newId>, where THIS script runs. It asks the worker whether
// this exact tab was opened for a create ("claim" — returned once, atomically, only for that tab id),
// and if so runs the SAME populate sequence as the in-app drainer (src/lib/gsPull.ts) and the standalone
// runner (scripts/zoe-pull/run.mts populateCreate): saveEventDetails → saveEventNotes →
// saveDefaultEventLocation → line-item groups + items → logistics legs → window upgrade, then reports
// intake-result + acks the outbox op, and asks the worker to close this tab.
//
// Fetches are same-origin (carry the operator's GS cookies); the Zoe posts carry Origin
// pro.goodshuffle.com, which the CORS-locked ingest endpoints allow — no token needed (fail-open), same
// as the read-pull. On a HARD failure (no project id — e.g. GS signed out) we DO NOT ack: the op stays
// pending for a later cycle and the read-pull is never touched. Item/leg adds are best-effort: once a
// shell exists we ack success (avoids creating a duplicate shell on retry), mirroring the proven path.

(function () {
  // Only a createNewProject redirect lands here with ?id=<digits>. A normal detail page a human opens
  // also matches, but the worker will not hand it an op (claim returns null), so we no-op there.
  const idMatch = location.href.match(/[?&]id=(\d+)/);
  if (!idMatch) return;

  function claim() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "zoe-create-claim" }, (resp) => {
          void chrome.runtime.lastError; // worker asleep / no pending → treat as no op
          resolve((resp && resp.op) || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }
  function done(ok) {
    try { chrome.runtime.sendMessage({ type: "zoe-create-done", ok: !!ok }, () => void chrome.runtime.lastError); } catch (e) { /* no-op */ }
  }

  async function apiBase() {
    const c = await chrome.storage.local.get({ apiBase: "https://zoe-dispatch.fly.dev" });
    return (c.apiBase || "https://zoe-dispatch.fly.dev").replace(/\/+$/, "");
  }

  // Populate one project. Mirrors scripts/zoe-pull/run.mts populateCreate. `pid` is the new project id.
  async function populate(op, api) {
    const p = op.payload || {};
    const pid = idMatch[1];
    const GH = { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    const JH = { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" };
    const APPH = { "content-type": "application/json" };
    const d = p.details || {};

    await fetch("/app/vendorTransaction/saveEventDetails", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), eventName: String(d.eventName || ""), fromDateStr: String(d.fromDateStr || ""), fromTimeStr: String(d.fromTimeStr || ""), toDateStr: String(d.toDateStr || ""), toTimeStr: String(d.toTimeStr || ""), eventType: String(d.eventType || ""), headCount: String(d.headCount || "") }).toString() }).catch(() => {});
    await fetch("/app/vendorTransaction/saveEventNotes", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), clientVisibleNotes: "", internalNotes: String(p.notes || ""), fulfillmentNotes: "" }).toString() }).catch(() => {});

    const loc = p.location || null;
    if (loc) await fetch("/app/vendorTransaction/saveDefaultEventLocation", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), venueName: String(loc.venueName || ""), venuePhoneNumber: "", venueAddress: String(loc.address || ""), venueAddress_line2: String(loc.line2 || ""), venueCity: String(loc.city || ""), venueCounty: String(loc.county || ""), venueState: String(loc.state || ""), venueZipCode: String(loc.zip || ""), venueCountry: String(loc.country || "US"), venueLatitude: String(loc.latitude || ""), venueLongitude: String(loc.longitude || ""), venueNotes: "" }).toString() }).catch(() => {});

    const gdate = String(p.eventDateMDY || "") || new Date().toLocaleDateString("en-US");
    const makeGroup = async (name) => {
      try {
        const gj = await (await fetch("/app/lineItemGroup/saveLineItemGroupEdits", { method: "POST", headers: GH, credentials: "include", body: new URLSearchParams({ transactionID: String(pid), lineItemGroupID: "", lineItemGroupName: String(name), lineItemGroupFromDate: gdate, lineItemGroupToDate: gdate, recalculateDailyItems: "false" }).toString() })).json();
        return (gj && gj.newLineItemGroup && gj.newLineItemGroup.id) || null;
      } catch (e) { return null; }
    };
    const addSvc = (gid, it) => fetch("/app/transactionItemRelation/addInventoryItemToContract", { method: "POST", headers: JH, credentials: "include", body: JSON.stringify({ transactionID: Number(pid), lineItemGroupID: gid, parentRelationID: null, relationType: null, fulfillment: false, inventoryTypeStr: it.inventoryTypeStr, rateType: it.rateType, itemID: it.itemID, unitPrice: it.unitPrice || 0, quantity: it.quantity || 1 }) }).catch(() => {});

    const items = p.addItems || [];
    if (items.length) { const rg = await makeGroup("Rental Items"); if (rg) for (const it of items) await addSvc(rg, it); }

    const legs = p.logisticsLegs || [];
    if (legs.length && loc) {
      try {
        const cv = await (await fetch("/app/vendorTransaction/initContractView?transactionID=" + pid, { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" })).json();
        const groups = (cv && cv.lineItemGroupsToLoad) || [];
        let logiGrp = null;
        for (const g of groups) if (g.logisticsContainer) { logiGrp = g.id; break; }
        const evDate = String(d.fromDateStr || "");
        if (logiGrp) for (const lg of legs) {
          await fetch("/app/transactionItemRelation/addInventoryItemToContract", { method: "POST", headers: JH, credentials: "include", body: JSON.stringify({ inventoryInjection: true, itemID: lg.itemID, fulfillment: false, transactionID: Number(pid), lineItemGroupID: logiGrp, relationID: null, relationType: null, parentRelationID: null, inventoryTypeStr: "SERVICE", rateType: lg.rateType, title: lg.title, description: null, isSubrental: false, internalNotes: "", showItemDescription: true, showItemAttributes: true, quantity: 1, unitPriceOverridden: false, unitPrice: 0, mileageFee: 0, discountDollarAmount: 0, discountPercentage: 0, itemStartDate: evDate, itemStartTime: null, itemEndDate: evDate, itemEndTime: null, itemHoursRented: null, eventTimeLineMarker: lg.eventTimeLineMarker, selectedTaxTypes: [], serviceStoreLocationID: null, venueName: loc.venueName, venueAddress: loc.address, venueAddress_line2: loc.line2, venueAddress_city: loc.city, venueAddress_state: loc.state, venueAddress_zipCode: loc.zip, venueAddress_county: loc.county, venueAddress_country: loc.country, venueAddress_latitude: loc.latitude, venueAddress_longitude: loc.longitude }) }).catch(() => {});
        }
      } catch (e) { /* best-effort */ }
    }

    const wu = p.windowUpgrade || null;
    if (wu && wu.item) { const g = await makeGroup(wu.groupName || "Delivery Timing"); if (g) await addSvc(g, wu.item); }

    const url = "https://pro.goodshuffle.com/app/project/detail?id=" + pid;
    await fetch(api + "/api/gs/intake-result", { method: "POST", headers: APPH, body: JSON.stringify({ intakeId: p.intakeId, projectId: pid, url, ok: true }) }).catch(() => {});
    await fetch(api + "/api/gs/outbox", { method: "POST", headers: APPH, body: JSON.stringify({ id: op.id, ok: true }) }).catch(() => {});
    return { pid };
  }

  (async () => {
    const op = await claim();
    if (!op) return; // not a create tab (or already claimed) → leave this page alone
    try {
      const api = await apiBase();
      await populate(op, api);
      done(true);
    } catch (e) {
      // Hard failure before/at shell creation: do NOT ack — leave the op pending to retry next cycle.
      done(false);
    }
  })();
})();
