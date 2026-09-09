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

  // Not signed into Goodshuffle → report it so Zoe can banner. Cheap probe: the app 302s API calls
  // to a login page when the session is gone, and the visible path turns to /auth|/login|/signin.
  const path = location.pathname.toLowerCase();
  if (path.indexOf("auth") >= 0 || path.indexOf("login") >= 0 || path.indexOf("signin") >= 0) {
    return Promise.resolve({ ok: false, loggedIn: false, stops: 0, bookings: 0, notes: 0, photos: 0, error: "not signed in" });
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
  function pullRoutes() {
    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0); const end = new Date(start.getTime() + 24 * 3600 * 1000);
    const body = { from: start.toISOString(), to: end.toISOString(), warehouseCanonicalIDs: null, crew: null, vehicles: null, statuses: null };
    return fetch("/app/routing/listRoutes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "include" }).then((r) => r.json()).then((routes) => {
      const byTruck = {}, gsBy = {}; let chain = Promise.resolve(); const unmatched = {};
      (routes || []).forEach((rt) => { chain = chain.then(() => { const title = (rt.vehicle && rt.vehicle.title) || ""; const tid = truckIdFor(title); if (!tid) { if (title) unmatched[title] = 1; return; }
        return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers: { accept: "application/json" }, credentials: "include" }).then((r) => r.json()).then((full) => attachItems(extractStops(full)).then((stops) => { byTruck[tid] = (byTruck[tid] || []).concat(stops); if (!gsBy[tid]) gsBy[tid] = String(rt.id); })); }); });
      return chain.then(() => {
        const trucks = Object.keys(byTruck).filter((t) => byTruck[t].length); let totalStops = 0, failed = 0; const unm = Object.keys(unmatched);
        return Promise.all(trucks.map((tid) => { const st = byTruck[tid]; totalStops += st.length; return fetch(API + "/api/route/import", { method: "POST", headers: POSTH, body: JSON.stringify({ truckId: tid, stops: st, gsRouteId: gsBy[tid] }) }).then((r) => { if (!r.ok) failed++; }).catch(() => { failed++; }); })).then(() => ({ stops: totalStops, failed, unmatched: unm }));
      });
    }).catch(() => ({ stops: 0, failed: 1, unmatched: [] }));
  }

  // ---- Outbox drain: push queued Dispatch → Goodshuffle writes (photos, note appends) ----
  function ackOp(id, ok, err) { return fetch(API + "/api/gs/outbox", { method: "POST", headers: POSTH, body: JSON.stringify({ id, ok, error: ok ? undefined : err }) }).catch(() => {}); }
  function drainOutbox() {
    return fetch(API + "/api/gs/outbox", { headers: POSTH }).then((r) => r.json()).then((j) => {
      const all = (j && j.ops) || [];
      const photoOps = all.filter((o) => o.op === "photo_upload" && o.transactionId && o.payload && o.payload.photoIds && o.payload.photoIds.length);
      const noteOps = all.filter((o) => o.op === "note_append" && o.transactionId && o.payload && o.payload.line);
      let pushed = 0, failed = 0, notes = 0, chain = Promise.resolve();
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
      return chain.then(() => ({ pushed, failed, notes }));
    }).catch(() => ({ pushed: 0, failed: 0, notes: 0 }));
  }

  return Promise.all([pullRoutes(), pullProjects(), drainOutbox()]).then((res) => {
    const r = res[0] || { stops: 0, failed: 0, unmatched: [] };
    const bk = res[1] || { saved: 0, partial: false, notes: 0 };
    const ph = res[2] || { pushed: 0, failed: 0 };
    return { ok: !r.failed && !bk.partial, loggedIn: true, stops: r.stops || 0, bookings: bk.saved || 0, notes: bk.notes || 0, photos: ph.pushed || 0, unmatched: r.unmatched || [], partial: !!bk.partial, error: r.failed ? "routes failed to save" : bk.partial ? "bookings incomplete" : null };
  }).catch((e) => ({ ok: false, loggedIn: true, stops: 0, bookings: 0, notes: 0, photos: 0, error: String(e).slice(0, 120) }));
}
