// The pull, injected into a logged-in pro.goodshuffle.com tab by the service worker
// (chrome.scripting.executeScript). It runs in the page's origin, so /app/* fetches carry the
// operator's Goodshuffle cookies (same-origin) and the POSTs to Zoe carry Origin
// pro.goodshuffle.com — exactly what the ingest endpoints' CORS allows. This mirrors the proven
// office bookmarklet (src/lib/gsPull.ts buildOfficePullScript); keep the two in sync.
//
// MUST be fully self-contained: executeScript serializes the function body and injects it, so it
// loses its lexical scope — every helper is nested inside, and it takes only serializable args.

/** @param {string} apiBase Zoe origin, e.g. https://zoe-dispatch.fly.dev */
export function zoePull(apiBase) {
  const API = String(apiBase || "").replace(/\/+$/, "");
  const H = { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" };
  const POSTH = { "content-type": "application/json" };
  const AUTH_RE = /\/(ui\/auth|app\/login|login|signin|auth)\b/i;

  // Signed-out probe. Goodshuffle keeps the visible path at "/" but 302s an API call to its auth page
  // when the session is gone (fetch follows it → r.redirected, r.url = /ui/auth), and returns no
  // projectSearch. Checking location.pathname is NOT reliable — verify against the real endpoint.
  function loggedInProbe() {
    return fetch("/app/project/searchProjects?page=0&pageSize=1&allProjects=true&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true", H)
      .then((r) => { if (r.redirected && AUTH_RE.test(r.url)) return false; if (!r.ok) return false; return r.json().then((j) => !!(j && j.projectSearch)).catch(() => false); })
      .catch(() => false);
  }

  function d2(s) { try { if (!s) return null; const dt = new Date(s); if (isNaN(dt)) return null; return new Date(dt.getTime() - dt.getTimezoneOffset() * 60000).toISOString().slice(0, 10); } catch (e) { return null; } }

  // ---- Bookings feed (projects) → Sales / Finance / Customer ----
  function pullProjects() {
    const all = {}; let pErr = false;
    function fetchPage(pg) {
      return fetch("/app/project/searchProjects?page=" + pg + "&pageSize=500&allProjects=true&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true", H)
        .then((r) => { if (!r.ok) throw 0; return r.json(); })
        .then((b) => { const ps = b && b.projectSearch; if (!ps) return { count: 0 }; const res = ps.results || []; res.forEach((p) => { if (p && p.id != null && !all[p.id]) all[p.id] = p; }); return { count: res.length }; })
        .catch(() => { pErr = true; return { count: 0 }; });
    }
    function loop(pg) { return fetchPage(pg).then((r) => { if (!pErr && r.count > 0 && pg < 60) return loop(pg + 1); return null; }); }
    return loop(0).then(() => {
      const recs = Object.keys(all).map((id) => { const p = all[id];
        return { bookingId: String(p.id), eventName: p.eventName || "", eventDate: d2(p.logistics_start_date), statusLabel: p.statusLabel || "", signed: !!p.signed, grandTotalCents: p.grand_total, contractTotalCents: p.contract_subtotal, amountPaidCents: p.amount_paid, amountDueCents: p.amount_due, clientName: p.client_name || "", clientEmail: p.client_email || "", clientPhone: p.client_phone || "", quoteSentDate: d2(p.quote_sent_date), dateCreated: d2(p.date_created), venue: p.venueLabel || "", location: p.cityStateZipCounty || "" };
      });
      if (!recs.length) return { saved: 0, partial: pErr };
      const todayY = new Date().toISOString().slice(0, 10);
      const openIds = Object.keys(all).filter((id) => { const p = all[id]; if (p.signed) return false; const s = (p.statusLabel || "").toLowerCase(); if (s.indexOf("lost") >= 0 || s.indexOf("cancel") >= 0 || s.indexOf("dead") >= 0) return false; const d = d2(p.logistics_start_date); return !d || d >= todayY; }).slice(0, 80);
      function titlesFrom(lists) { const t = []; function w(o, d) { if (!o || typeof o !== "object" || d > 7) return; if (Object.prototype.toString.call(o) === "[object Array]") { for (let k = 0; k < o.length; k++) w(o[k], d + 1); return; } if (o.itemTitle) t.push(o.itemTitle); for (const kk in o) w(o[kk], d + 1); } (lists || []).forEach((gj) => { w(gj, 0); }); return t; }
      function pullNotes() {
        const notes = [];
        function one(i) {
          if (i >= openIds.length) return Promise.resolve();
          const id = openIds[i];
          return fetch("/app/vendorTransaction/initContractView?transactionID=" + id, H).then((r) => { if (!r.ok) return; return r.json().then((j) => {
            const g = (j && j.lineItemGroupsToLoad) || [];
            return Promise.all(g.map((x) => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + x.id + "&transactionID=" + id, H).then((r2) => r2.json()).catch(() => null))).then((lists) => {
              notes.push({ bookingId: String(id), internalNotes: (j.internalNotes || "").trim(), clientNotes: (j.clientVisibleNotes || "").trim(), lastSentDate: null, lineItems: titlesFrom(lists) });
            });
          }); }).catch(() => {}).then(() => one(i + 1));
        }
        return one(0).then(() => { if (!notes.length) return { updated: 0 }; return fetch(API + "/api/gs/notes", { method: "POST", headers: POSTH, body: JSON.stringify({ notes }) }).then((r) => r.json()).catch(() => ({ updated: 0 })); });
      }
      return fetch(API + "/api/gs/projects", { method: "POST", headers: POSTH, body: JSON.stringify({ projects: recs, partial: pErr }) }).then((r) => r.json()).then((j) => pullNotes().then((nj) => ({ saved: (j && j.saved) || recs.length, partial: pErr || !!(j && j.partial), notes: (nj && nj.updated) || 0 }))).catch(() => ({ saved: 0, partial: true }));
    });
  }

  // ---- Routes feed (today's logistics) → Dispatch / day-of risk ----
  function truckIdFor(title) { const t = (title || "").toLowerCase();
    if (t.indexOf("ford") >= 0 || t.indexOf("e450") >= 0 || t.indexOf("e-450") >= 0) return "E450";
    if (t.indexOf("isuzu") >= 0 || t.indexOf("npr") >= 0) return t.indexOf("2") >= 0 ? "NPR-2" : "NPR-1";
    if (t.indexOf("2") >= 0) return "NPR-2";
    if (t.indexOf("1") >= 0) return "NPR-1";
    return null; }
  // Fallback for a route with no vehicle assigned: match the truck from the route NAME, but only on an
  // explicit truck word (ford/e450/isuzu/npr) + number — never a bare 1/2 (a date digit must not match).
  function truckFromName(name) { const t = (name || "").toLowerCase();
    if (t.indexOf("ford") >= 0 || t.indexOf("e450") >= 0 || t.indexOf("e-450") >= 0) return "E450";
    if (t.indexOf("isuzu") >= 0 || t.indexOf("npr") >= 0) { if (t.indexOf("2") >= 0) return "NPR-2"; if (t.indexOf("1") >= 0) return "NPR-1"; return null; }
    return null; }
  function fetchEvent(txID) { const out = { items: undefined, contactId: undefined, grandTotalCents: undefined, paidCents: undefined };
    const pI = fetch("/app/vendorTransaction/initContractView?transactionID=" + txID, H).then((r) => r.json())
      .then((cv) => { if (cv && cv.contactID != null) out.contactId = String(cv.contactID); const g = (cv && cv.lineItemGroupsToLoad) || []; return Promise.all(g.map((x) => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + x.id + "&transactionID=" + txID, H).then((r) => r.json()).catch(() => null))); })
      .then((lists) => { const items = []; function w(o, d) { if (!o || typeof o !== "object" || d > 7) return; if (Object.prototype.toString.call(o) === "[object Array]") { for (let i = 0; i < o.length; i++) w(o[i], d + 1); return; } if (o.itemTitle) items.push({ name: o.itemTitle, quantity: o.quantityBooked }); for (const k in o) w(o[k], d + 1); } (lists || []).forEach((gj) => { w(gj, 0); }); if (items.length) out.items = items; })
      .catch(() => {});
    const pR = fetch("/app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID=" + txID, H).then((r) => r.json())
      .then((pt) => { if (pt && typeof pt.grandTotal === "number") out.grandTotalCents = pt.grandTotal; const ph = pt && pt.paymentHistory; if (ph && typeof ph.totalContractApplicablePaid === "number") out.paidCents = ph.totalContractApplicablePaid; })
      .catch(() => {});
    return Promise.all([pI, pR]).then(() => out); }
  function extractStops(route) { const wps = (route.waypoints || []).filter((w) => !w.isOriginWarehouse && !w.isDestinationWarehouse); wps.sort((a, b) => (a.waypointIndex || 0) - (b.waypointIndex || 0));
    return wps.map((w) => { const tl = (w.logisticRelation && w.logisticRelation.targetLocation) || {}; const tx = w.transaction || {}; const line = [tl.streetAddressLine1, tl.streetAddressLine2].filter(Boolean).join(" "); const cs = [tl.city, tl.state].filter(Boolean).join(", "); const address = [line, cs, tl.zipCode].filter(Boolean).join(", "); const r = tx.renter || {}; const sv = r.smsValidation || {}; const name = tl.contactName || (tx.eventName ? String(tx.eventName).split(" - ")[0].trim() : "") || r.name; const doc = tx.dayOfContact || null;
      const s = { custName: name || "", custFirstName: r.firstName || undefined, custLastName: r.lastName || undefined, kind: (w.waypointType === "PICK_UP" ? "pickup" : "delivery"), custPhone: sv.e164PhoneNumber || r.phone || tl.contactPhoneNumber || "", address, plannedWindow: w.scheduledArrivalTime || undefined, eta: w.scheduledArrivalTime || undefined };
      if (doc) { s.dayOfName = doc.name || doc.fullName || undefined; s.dayOfPhone = doc.phoneNumber || doc.phone || undefined; }
      s._txID = w.transactionID || (tx && tx.id) || null; if (s._txID) s.txId = String(s._txID); return s; }); }
  function attachItems(stops) { return Promise.all(stops.map((s) => { if (!s._txID) { delete s._txID; return Promise.resolve(); } return fetchEvent(s._txID).then((ev) => { if (ev) { if (ev.items && ev.items.length) s.items = ev.items; if (ev.contactId) s.contactId = ev.contactId; if (ev.grandTotalCents != null) s.grandTotalCents = ev.grandTotalCents; if (ev.paidCents != null) s.paidCents = ev.paidCents; } delete s._txID; }); })).then(() => stops); }
  // Multi-week route pull: the next ~3 weeks, imported per (truck, DATE) so the dispatch calendar +
  // risk engine stay populated ahead. Near-term routes (<= ENRICH days) get full per-event enrichment
  // (line items → tent/crew rules); farther-out routes import bare stops to keep the pull fast.
  function pullRoutes() {
    const HORIZON = 21, ENRICH = 8;
    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0); const end = new Date(start.getTime() + (HORIZON + 1) * 24 * 3600 * 1000);
    const todayYmd = d2(start.toISOString());
    const body = { from: start.toISOString(), to: end.toISOString(), warehouseCanonicalIDs: null, crew: null, vehicles: null, statuses: null };
    return fetch("/app/routing/listRoutes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "include" }).then((r) => r.json()).then((routes) => {
      const groups = {}; let chain = Promise.resolve(); const unmatched = {};
      (routes || []).forEach((rt) => { chain = chain.then(() => { const title = (rt.vehicle && rt.vehicle.title) || ""; const tid = truckIdFor(title) || truckFromName(rt.name); if (!tid) { if (title || rt.name) unmatched[title || rt.name] = 1; return; }
        return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers: { accept: "application/json" }, credentials: "include" }).then((r) => r.json()).then((full) => {
          const stops = extractStops(full);
          const rdate = d2(rt.startDate) || d2(rt.date) || (stops[0] ? d2(stops[0].eta) : null);
          if (!rdate) return;
          const daysOut = Math.round((Date.parse(rdate + "T00:00:00Z") - Date.parse(todayYmd + "T00:00:00Z")) / 86400000);
          const p = daysOut >= 0 && daysOut <= ENRICH ? attachItems(stops) : Promise.resolve(stops);
          return p.then((st) => { const key = tid + "|" + rdate; if (!groups[key]) groups[key] = { truckId: tid, date: rdate, stops: [], gsRouteId: String(rt.id) }; groups[key].stops = groups[key].stops.concat(st); });
        }); }); });
      return chain.then(() => {
        const keys = Object.keys(groups); let totalStops = 0, failed = 0; const days = keys.length; const unm = Object.keys(unmatched);
        return Promise.all(keys.map((k) => { const g = groups[k]; totalStops += g.stops.length; return fetch(API + "/api/route/import", { method: "POST", headers: POSTH, body: JSON.stringify({ truckId: g.truckId, date: g.date, stops: g.stops, gsRouteId: g.gsRouteId }) }).then((r) => { if (!r.ok) failed++; }).catch(() => { failed++; }); })).then(() => ({ stops: totalStops, days, failed, unmatched: unm }));
      });
    }).catch(() => ({ stops: 0, days: 0, failed: 1, unmatched: [] }));
  }

  // ---- Outbox drain: push queued Dispatch → Goodshuffle writes (photos, note appends) ----
  function ackOp(id, ok, err) { return fetch(API + "/api/gs/outbox", { method: "POST", headers: POSTH, body: JSON.stringify({ id, ok, error: ok ? undefined : err }) }).catch(() => {}); }
  function drainOutbox() {
    return fetch(API + "/api/gs/outbox", { headers: POSTH }).then((r) => r.json()).then((j) => {
      const all = (j && j.ops) || [];
      const photoOps = all.filter((o) => o.op === "photo_upload" && o.transactionId && o.payload && o.payload.photoIds && o.payload.photoIds.length);
      const noteOps = all.filter((o) => o.op === "note_append" && o.transactionId && o.payload && o.payload.line);
      const teamOps = all.filter((o) => o.op === "add_team_member" && o.transactionId && o.payload && o.payload.userID);
      const feeOps = all.filter((o) => o.op === "set_delivery_fee" && o.transactionId && o.payload && o.payload.amount != null);
      let pushed = 0, failed = 0, notes = 0, team = 0, fees = 0, chain = Promise.resolve();
      // add_team_member: add a GSPRO user (e.g. Warehouse Desktop) to the project's team.
      teamOps.forEach((o) => { chain = chain.then(() => {
        const body = new URLSearchParams({ transactionID: String(o.transactionId), userID: String(o.payload.userID), linkType: String(o.payload.linkType || "OTHER") });
        return fetch("/app/project/addNewTeamMember", { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, credentials: "include", body }).then((r) => r.ok).then((ok) => { if (ok) team++; else failed++; return ackOp(o.id, ok, "add_team_member_failed"); }).catch(() => { failed++; return ackOp(o.id, false, "add_team_member_error"); });
      }); });
      photoOps.forEach((o) => { chain = chain.then(() => {
        let ok = Promise.resolve(true);
        o.payload.photoIds.forEach((pid) => { ok = ok.then((soFar) => { if (!soFar) return false;
          return fetch(API + "/api/pod/" + encodeURIComponent(pid)).then((r) => { if (!r.ok) throw 0; return r.blob(); }).then((blob) => { const fd = new FormData(); fd.append("file", blob, pid); return fetch("/app/files/uploadFileToProject?transactionID=" + encodeURIComponent(o.transactionId), { method: "POST", body: fd, credentials: "include" }).then((r) => r.ok); }).catch(() => false);
        }); });
        return ok.then((doneOk) => { if (doneOk) pushed++; else failed++; return ackOp(o.id, doneOk, "photo_upload_failed"); });
      }); });
      noteOps.forEach((o) => { chain = chain.then(() => {
        return fetch("/app/vendorTransaction/initContractView?transactionID=" + encodeURIComponent(o.transactionId), { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" }).then((r) => { if (!r.ok) throw 0; return r.json(); }).then((cv) => {
          const cur = cv.internalNotes || ""; const newInt = (cur ? cur + "\n\n" : "") + o.payload.line;
          const body = new URLSearchParams({ transactionID: String(o.transactionId), clientVisibleNotes: cv.clientVisibleNotes || "", internalNotes: newInt, fulfillmentNotes: cv.fulfillmentNotes || "" });
          return fetch("/app/vendorTransaction/saveEventNotes", { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, credentials: "include", body }).then((r) => r.ok);
        }).then((ok) => { if (ok) notes++; else failed++; return ackOp(o.id, ok, "note_append_failed"); }).catch(() => { failed++; return ackOp(o.id, false, "note_append_error"); });
      }); });
      // set_delivery_fee: override the project's Standard Delivery line(s) with our computed per-leg fee.
      // Load the contract's line item groups, find every base Standard Delivery line (inventory item
      // 392868144), and re-save each via saveInventoryTrackedLineItemEdit with unitPriceOverridden=true +
      // our unitPrice, mileageFee 0. Every other field is echoed from the line as loaded (venue, dates,
      // marker) so nothing else changes. Skips (acks failure) when the project has no Standard Delivery line.
      feeOps.forEach((o) => { chain = chain.then(() => {
        const tx = o.transactionId, amount = o.payload.amount, DELIV = 392868144;
        const ymd = (raw) => { if (!raw) return null; const s = String(raw); return (s.length >= 10 && s[4] === "-" && s[7] === "-") ? s.slice(0, 10) : null; };
        const findDeliv = (li) => { const out = []; (function w(n) { if (!n || typeof n !== "object") return; if (Array.isArray(n)) { n.forEach(w); return; } if (n.itemTitle && n.item && String(n.item.id) === String(DELIV)) out.push(n); for (const k in n) w(n[k]); })(li); return out; };
        const saveLeg = (gid, n) => { const it = n.item || {}, tl = n.targetLocation || {}; const body = { inventoryInjection: true, itemID: it.id, fulfillment: false, transactionID: Number(tx) || tx, lineItemGroupID: gid, parentRelationID: null, relationID: n.id, relationType: null, inventoryTypeStr: it.inventoryType || "SERVICE", rateType: n.rateType || "FLAT_FEE_WITH_MILEAGE", title: n.itemTitle || "Standard Delivery", description: null, isSubrental: false, internalNotes: n.internalNotes || "", showItemDescription: true, showItemAttributes: true, quantity: n.quantityBooked || 1, unitPriceOverridden: true, unitPrice: String(amount), mileageFee: 0, discountDollarAmount: 0, discountPercentage: 0, itemStartDate: ymd(n.rawStartDate), itemStartTime: null, itemEndDate: ymd(n.rawEndDate), itemEndTime: null, itemHoursRented: null, eventTimeLineMarker: n.eventTimeLineMarker || null, selectedTaxTypes: [], serviceStoreLocationID: null, venueName: tl.venueName || null, venueAddress: tl.streetAddressLine1 || null, venueAddress_line2: tl.streetAddressLine2 || null, venueAddress_city: tl.city || null, venueAddress_state: tl.state || null, venueAddress_zipCode: tl.zipCode || null, venueAddress_county: tl.county || null, venueAddress_country: tl.country || null, venueAddress_latitude: tl.latitude || null, venueAddress_longitude: tl.longitude || null, images: [] }; return fetch("/app/transactionItemRelation/saveInventoryTrackedLineItemEdit", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include", body: JSON.stringify(body) }).then((r) => r.ok); };
        return fetch("/app/vendorTransaction/initContractView?transactionID=" + encodeURIComponent(tx), { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" }).then((r) => { if (!r.ok) throw 0; return r.json(); }).then((cv) => {
          const groups = (cv && cv.lineItemGroupsToLoad) || []; const legs = []; let gchain = Promise.resolve();
          groups.forEach((g) => { gchain = gchain.then(() => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + g.id + "&transactionID=" + encodeURIComponent(tx), { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" }).then((r) => r.json()).then((li) => { findDeliv(li).forEach((n) => legs.push({ gid: g.id, n })); }).catch(() => {})); });
          return gchain.then(() => { if (!legs.length) throw "no_delivery_line"; let s = Promise.resolve(true); legs.forEach((L) => { s = s.then((ok) => ok ? saveLeg(L.gid, L.n) : false); }); return s; });
        }).then((ok) => { if (ok) fees++; else failed++; return ackOp(o.id, ok, "set_delivery_fee_failed"); }).catch((e) => { failed++; return ackOp(o.id, false, "set_delivery_fee_" + (typeof e === "string" ? e : "error")); });
      }); });
      return chain.then(() => ({ pushed, failed, notes, team, fees }));
    }).catch(() => ({ pushed: 0, failed: 0, notes: 0, team: 0, fees: 0 }));
  }

  return loggedInProbe().then((ok) => {
    if (!ok) return { ok: false, loggedIn: false, stops: 0, bookings: 0, notes: 0, photos: 0, error: "not signed in" };
    return Promise.all([pullRoutes(), pullProjects(), drainOutbox()]).then((res) => {
      const r = res[0] || { stops: 0, failed: 0, unmatched: [] };
      const bk = res[1] || { saved: 0, partial: false, notes: 0 };
      const ph = res[2] || { pushed: 0, failed: 0 };
      return { ok: !r.failed && !bk.partial, loggedIn: true, stops: r.stops || 0, bookings: bk.saved || 0, notes: bk.notes || 0, photos: ph.pushed || 0, unmatched: r.unmatched || [], partial: !!bk.partial, error: r.failed ? "routes failed to save" : bk.partial ? "bookings incomplete" : null };
    }).catch((e) => ({ ok: false, loggedIn: true, stops: 0, bookings: 0, notes: 0, photos: 0, error: String(e).slice(0, 120) }));
  });
}
