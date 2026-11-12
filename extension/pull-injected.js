// The pull. Loaded as a DECLARED content script on pro.goodshuffle.com (see manifest content_scripts),
// so it runs in the page's origin with host access granted at install — NOT injected from the
// background worker (that programmatic injection is what Chrome's per-site permission model kept
// revoking). /app/* fetches carry the operator's Goodshuffle cookies (same-origin) and the POSTs to
// Zoe carry Origin pro.goodshuffle.com, exactly what the ingest endpoints' CORS allows. This mirrors
// the office bookmarklet (src/lib/gsPull.ts buildOfficePullScript); keep the two in sync.
//
// Defines a global `zoePull(apiBase)` in the content-script world; content.js calls it on a timer.
// Stays fully self-contained (every helper nested) so it also works if ever injected directly.

/** @param {string} apiBase Zoe origin, e.g. https://zoe-dispatch.fly.dev
 *  @param {"active"|"full"} [tier] which lane to run. "active" (default) = routes + active projects +
 *   notes + outbox drain (FAST lane, every few minutes, NEVER prunes). "full" = the archive-inclusive
 *   projects history walk (SLOW lane, hourly — the ONLY lane that prunes orphans). */
function zoePull(apiBase, tier) {
  const TIER = tier === "full" ? "full" : "active";
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

  // Goodshuffle dates. searchProjects used to send logistics_start_date / quote_sent_date / date_created
  // ("Oct 31, 2026") and logistics_start_from_time ("9:00 AM EDT"). In Nov 2026 it switched to *_millis +
  // *_zone (+ logistics_start_time_set). Read the new shape, fall back to the old one. MIRRORS gsYmd /
  // gsWindowTime in src/lib/gsPull.ts (unit-tested).
  function gsYmd(old, ms, zone) {
    if (old) return d2(old);
    if (ms == null || ms === "" || isNaN(Number(ms))) return null;
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: zone || "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Number(ms))); } catch (e) { return d2(new Date(Number(ms)).toISOString()); }
  }
  function evYmd(p) { return gsYmd(p.logistics_start_date, p.logistics_start_millis, p.logistics_start_zone); }
  function gsTime(p) {
    if (p.logistics_start_from_time != null) return String(p.logistics_start_from_time);
    if (p.logistics_start_millis == null || p.logistics_start_millis === "") return null;
    if (p.logistics_start_time_set === false) return "TBD";
    try { return new Intl.DateTimeFormat("en-US", { timeZone: p.logistics_start_zone || "America/New_York", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(Number(p.logistics_start_millis))).replace(/[\u202f\u00a0]/g, " "); } catch (e) { return null; }
  }

  // ---- Bookings feed (projects) → Sales / Finance / Customer ----
  // TWO-TIER: mode="active" pulls ONLY the ~88 active, non-archived projects (searchProjects WITHOUT
  // allProjects, a single page) — the FAST lane that rides with routes/notes/outbox and POSTs
  // scope:"active" (NEVER prunes). mode="full" walks the archive-inclusive history (allProjects=true,
  // paginated) — the SLOW lane that feeds Finance and POSTs scope:"full" (the ONLY scope that prunes).
  function pullProjects(mode) {
    const FULL = mode !== "active"; // default to full for any unexpected value (back-compat / safety)
    const all = {}; let pErr = false;
    function url(pg) { return "/app/project/searchProjects?page=" + pg + "&pageSize=500" + (FULL ? "&allProjects=true" : "") + "&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true"; }
    function fetchPage(pg) {
      return fetch(url(pg), H)
        .then((r) => { if (!r.ok) throw 0; return r.json(); })
        .then((b) => { const ps = b && b.projectSearch; if (!ps) return { count: 0 }; const res = ps.results || []; res.forEach((p) => { if (p && p.id != null && !all[p.id]) all[p.id] = p; }); return { count: res.length }; })
        .catch(() => { pErr = true; return { count: 0 }; });
    }
    function loop(pg) { return fetchPage(pg).then((r) => { if (FULL && !pErr && r.count > 0 && pg < 60) return loop(pg + 1); return null; }); }
    return loop(0).then(() => {
      const recs = Object.keys(all).map((id) => { const p = all[id];
        return { bookingId: String(p.id), eventName: p.eventName || "", eventDate: evYmd(p), statusLabel: p.statusLabel || "", signed: !!p.signed, archived: !!p.archived, grandTotalCents: p.grand_total, contractTotalCents: p.contract_subtotal, amountPaidCents: p.amount_paid, amountDueCents: p.amount_due, clientName: p.client_name || "", clientEmail: p.client_email || "", clientPhone: p.client_phone || "", quoteSentDate: gsYmd(p.quote_sent_date, p.quote_sent_millis, p.quote_sent_zone), dateCreated: gsYmd(p.date_created, p.date_created_millis, p.date_created_zone), venue: p.venueLabel || "", location: p.cityStateZipCounty || "", salesLead: p.salesLeadName || "", logisticsStartTime: gsTime(p), streetAddress: [p.streetLine1, p.streetLine2].filter(Boolean).join(", ") };
      });
      if (!recs.length) return { saved: 0, partial: pErr };
      // Capture comms for OPEN leads AND SIGNED near-term deliveries (within today..+3 days), so the driver
      // debrief can read the office's customer-attention notes before delivery day. Union, deduped (open
      // first), capped at 100. MIRRORS selectNoteCaptureIds() in src/lib/gsPull.ts (unit-tested).
      const todayY = new Date().toISOString().slice(0, 10);
      const horizonY = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
      const openIds = [], signedIds = [];
      Object.keys(all).forEach((id) => { const p = all[id]; const d = evYmd(p);
        if (p.signed) { if (d && d >= todayY && d <= horizonY) signedIds.push(id); return; }
        const s = (p.statusLabel || "").toLowerCase(); if (s.indexOf("lost") >= 0 || s.indexOf("cancel") >= 0 || s.indexOf("dead") >= 0) return;
        if (!d || d >= todayY) openIds.push(id); });
      // Delivery window capture (project timeline ranges, "Saturday, 10/31 [9:00 AM - 8:00 PM]"). MIRRORS
      // selectWindowCaptureIds() in src/lib/gsPull.ts: logistics date within -14..+14 days, not lost/cancelled/
      // dead; the FULL lane takes only archived ones (the active lane cannot see them). Sequential, 250ms apart
      // (Goodshuffle 429s parallel bursts), one retry after a 429. A failed fetch is left out (stored windows
      // stay); an empty timeline is sent (clears). The server parses the labels.
      const winFrom = new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
      const winTo = new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10);
      function windowIds(archivedOnly) {
        const out = [];
        Object.keys(all).forEach((id) => { const p = all[id]; const d = evYmd(p); if (!d || d < winFrom || d > winTo) return;
          const s = (p.statusLabel || "").toLowerCase(); if (s.indexOf("lost") >= 0 || s.indexOf("cancel") >= 0 || s.indexOf("dead") >= 0) return; if (archivedOnly && !p.archived) return; out.push(id); });
        return out.slice(0, 150);
      }
      function pullWindows(ids) {
        const wins = [];
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        const getTl = (id, retry) => fetch("/app/vendorTransaction/initProjectTimeline?transactionID=" + id, H)
          .then((r) => { if (r.status === 429 && !retry) return wait(2000).then(() => getTl(id, true)); return r.ok ? r.json() : null; })
          .catch(() => null);
        function one(i) {
          if (i >= ids.length) return Promise.resolve();
          const id = ids[i];
          return getTl(id, false).then((j) => {
            if (j && Array.isArray(j.events)) {
              const ev = [];
              j.events.forEach((e) => { if (e && e.type === "logisticsDelivery") ev.push({ marker: e.eventTimeLineMarker || null, name: e.name || null, dateLabel: e.dateLabel || null }); });
              wins.push({ bookingId: String(id), events: ev });
            }
          }).then(() => (i + 1 < ids.length ? wait(250).then(() => one(i + 1)) : null));
        }
        return one(0).then(() => {
          if (!wins.length) return { windows: 0 };
          return fetch(API + "/api/gs/projects", { method: "POST", headers: POSTH, body: JSON.stringify({ windows: wins }) }).then((r) => r.json()).then((j) => ({ windows: (j && j.windows) || 0 })).catch(() => ({ windows: 0 }));
        });
      }
      // Active lane: at most every 15 minutes (the fast lane repeats every few minutes).
      function activeWindows() {
        const last = (typeof window !== "undefined" && window.__zoeWinLast) || 0;
        if (Date.now() - last < 15 * 60 * 1000) return Promise.resolve({ windows: 0 });
        if (typeof window !== "undefined") window.__zoeWinLast = Date.now();
        return pullWindows(windowIds(false));
      }
      const seenCap = {}, captureIds = []; openIds.concat(signedIds).forEach((id) => { if (!seenCap[id]) { seenCap[id] = 1; captureIds.push(id); } }); const capIds = captureIds.slice(0, 100);
      function titlesFrom(lists) { const t = []; function w(o, d) { if (!o || typeof o !== "object" || d > 7) return; if (Object.prototype.toString.call(o) === "[object Array]") { for (let k = 0; k < o.length; k++) w(o[k], d + 1); return; } if (o.itemTitle) t.push(o.itemTitle); for (const kk in o) w(o[kk], d + 1); } (lists || []).forEach((gj) => { w(gj, 0); }); return t; }
      // Quote sent/opened from the client email thread (getMessagesForTransaction). sent = earliest
      // outbound quote email; opened = latest client open. Prefer emails whose subject mentions "quote",
      // else any outbound email with client recipients. PARITY with the bookmarklet (gsPull.ts): without
      // this the Pipeline Status shows every open lead as "never contacted / not opened".
      function quoteTimes(mv) {
        const msgs = (mv && mv.client && mv.client.messages) || [];
        let qs = null, qo = null;
        function consider(m) {
          if (m.medium !== "EMAIL") return;
          const recips = m.clientRecipients || [];
          if (!recips.length) return;
          if (m.date && (!qs || m.date < qs)) qs = m.date;
          recips.forEach((rp) => { if (rp.messageOpenedDate && (!qo || rp.messageOpenedDate > qo)) qo = rp.messageOpenedDate; });
        }
        const quoteMsgs = msgs.filter((m) => m.medium === "EMAIL" && (m.clientRecipients || []).length && /quote/i.test(m.subject || ""));
        (quoteMsgs.length ? quoteMsgs : msgs).forEach(consider);
        return { sent: qs, opened: qo };
      }
      // Client EMAIL thread for the lead timeline. PARITY with the bookmarklet (gsPull.ts emailsFrom): without
      // it the extension pull never fed /api/gs/emails, so the timeline (and the morning outreach context)
      // had no Goodshuffle emails at all. FACTS ONLY: id + subject + date + latest open; a snippet only when the
      // message carries a body; direction "outbound" only when it has client recipients, else unknown (null).
      function emailsFrom(mv, id, out) {
        const msgs = (mv && mv.client && mv.client.messages) || [];
        msgs.forEach((m) => {
          if (!m || m.medium !== "EMAIL") return;
          const mid = m.id != null ? String(m.id) : m.messageID != null ? String(m.messageID) : "";
          if (!mid) return;
          const recips = m.clientRecipients || [];
          let opened = null;
          recips.forEach((rp) => { if (rp.messageOpenedDate && (!opened || rp.messageOpenedDate > opened)) opened = rp.messageOpenedDate; });
          const rawBody = m.content || m.body || m.message || m.plainTextBody || m.htmlContent || m.htmlBody || m.preview || "";
          const snip = typeof rawBody === "string" && rawBody ? rawBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : null;
          const participant = recips.length ? recips[0].name || recips[0].email || null : null;
          out.push({ bookingId: String(id), providerMsgId: mid, direction: recips.length ? "outbound" : null, participant, subject: m.subject || null, snippet: snip, occurredAt: m.date || null, openedAt: opened });
        });
      }
      function pullNotes() {
        const notes = [];
        const emails = [];
        function one(i) {
          if (i >= capIds.length) return Promise.resolve();
          const id = capIds[i];
          const pCV = fetch("/app/vendorTransaction/initContractView?transactionID=" + id, H).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          const pMsg = fetch("/app/conversation/getMessagesForTransaction?transactionID=" + id, H).then((r) => (r.ok ? r.json() : null)).catch(() => null);
          return Promise.all([pCV, pMsg]).then((res) => {
            const j = res[0], qt = quoteTimes(res[1]);
            try { emailsFrom(res[1], id, emails); } catch (e) { /* email capture never blocks notes */ }
            if (!j) return; // no contract view → skip (don't blank stored notes with a partial record)
            const g = (j.lineItemGroupsToLoad) || [];
            return Promise.all(g.map((x) => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + x.id + "&transactionID=" + id, H).then((r2) => r2.json()).catch(() => null))).then((lists) => {
              const tx = (res[1] && res[1].transaction) || {}; // the project itself: fromDate/toDate = the EVENT start/end (ISO)
              notes.push({ bookingId: String(id), internalNotes: (j.internalNotes || "").trim(), clientNotes: (j.clientVisibleNotes || "").trim(), lastSentDate: null, lineItems: titlesFrom(lists), quoteSentAt: qt.sent, quoteOpenedAt: qt.opened, eventStart: tx.fromDate || null, eventEnd: tx.toDate || null });
            });
          }).catch(() => {}).then(() => one(i + 1));
        }
        return one(0).then(() => {
          const pN = notes.length ? fetch(API + "/api/gs/notes", { method: "POST", headers: POSTH, body: JSON.stringify({ notes }) }).then((r) => r.json()).catch(() => ({ updated: 0 })) : Promise.resolve({ updated: 0 });
          // idempotent server-side on the Goodshuffle message id, so re-posting the thread every pull is safe
          const pE = emails.length ? fetch(API + "/api/gs/emails", { method: "POST", headers: POSTH, body: JSON.stringify({ emails }) }).then((r) => r.json()).catch(() => ({ written: 0 })) : Promise.resolve({ written: 0 });
          return Promise.all([pN, pE]).then((rs) => ({ updated: (rs[0] && rs[0].updated) || 0, emails: (rs[1] && rs[1].written) || 0 }));
        });
      }
      // FULL lane: archive-inclusive POST (scope:"full" — the ONLY scope that prunes) carrying `partial`,
      // no notes (those ride the fast ACTIVE lane). ACTIVE lane: scope:"active" (never prunes) + notes.
      // Logistics legs for UPCOMING SIGNED projects (delivery pricing): each project timeline lists its
      // drop-off / pickup legs ("logisticsDelivery" = we drive, "logisticsInStore" = customer collects) with
      // date + window. Sent raw; the server parses (src/lib/gs/logistics.ts). Sequential, capped, hourly lane.
      function pullLogistics() {
        const lo = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const hi = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
        const ids = Object.keys(all).filter((id) => { const p = all[id]; const d = evYmd(p); const s = (p.statusLabel || "").toLowerCase();
          return p.signed && !p.archived && d && d >= lo && d <= hi && s.indexOf("lost") < 0 && s.indexOf("cancel") < 0 && s.indexOf("dead") < 0; }).slice(0, 300);
        const out = [];
        function one(i) {
          if (i >= ids.length) return Promise.resolve();
          const id = ids[i];
          return fetch("/app/vendorTransaction/initProjectTimeline?transactionID=" + id, H).then((r) => (r.ok ? r.json() : null)).then((t) => {
            const ev = ((t && t.events) || []).map((e) => ({ type: e && e.type, dateLabel: e && e.dateLabel }));
            if (ev.length) out.push({ bookingId: String(id), startDate: evYmd(all[id]), events: ev });
          }).catch(() => {}).then(() => one(i + 1));
        }
        return one(0).then(() => (out.length ? fetch(API + "/api/gs/logistics", { method: "POST", headers: POSTH, body: JSON.stringify({ logistics: out }) }).then((r) => r.json()).catch(() => ({ updated: 0 })) : { updated: 0 }));
      }
      if (FULL) {
        return fetch(API + "/api/gs/projects", { method: "POST", headers: POSTH, body: JSON.stringify({ projects: recs, partial: pErr, scope: "full" }) }).then((r) => r.json()).then((j) => pullLogistics().catch(() => null).then(() => pullWindows(windowIds(true)).catch(() => ({ windows: 0 }))).then((wj) => ({ saved: (j && j.saved) || recs.length, partial: pErr || !!(j && j.partial), notes: 0, windows: (wj && wj.windows) || 0 }))).catch(() => ({ saved: 0, partial: true }));
      }
      // Offline payment confirmation: the server names projects whose amount paid went up. Read each one's payment
      // history (one at a time, 250ms apart) and post ONLY its offline charges (no card details leave Goodshuffle).
      // MIRRORS pullPayments() in src/lib/gsPull.ts.
      function pullPayments(ids) {
        const list = (ids || []).map(String).slice(0, 25);
        if (!list.length) return Promise.resolve({ cards: 0 });
        const out = [];
        const wait = (ms) => new Promise((res) => setTimeout(res, ms));
        function one(i) {
          if (i >= list.length) return Promise.resolve();
          const id = list[i];
          return fetch("/app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID=" + id, H).then((r) => (r.ok ? r.json() : null)).then((pt) => {
            const ph = pt && pt.paymentHistory;
            if (!ph) { out.push({ bookingId: id, ok: false }); return; }
            const evs = (ph.paymentEvents || []).filter((e) => e && e.offlinePayment === true && e.type === "charge").map((e) => ({ id: e.id, type: e.type, offlinePayment: true, paymentType: (e.offline && e.offline.paymentType) || null, label: e.paymentMethodLabel || null, amount: e.amount, dateMillis: e.dateMillis, status: e.status || null, processedBy: e.processedBy || null }));
            out.push({ bookingId: id, ok: true, grandTotalCents: (typeof pt.grandTotal === "number" ? pt.grandTotal : null), paidCents: (typeof ph.totalContractApplicablePaid === "number" ? ph.totalContractApplicablePaid : null), events: evs });
          }).catch(() => { out.push({ bookingId: id, ok: false }); }).then(() => (i + 1 < list.length ? wait(250).then(() => one(i + 1)) : null));
        }
        return one(0).then(() => fetch(API + "/api/gs/payments", { method: "POST", headers: POSTH, body: JSON.stringify({ payments: out }) }).then((r) => r.json()).then((j) => ({ cards: (j && j.cardsRaised) || 0 })).catch(() => ({ cards: 0 })));
      }
      // Lost-reason tracker: the server names recently lost quotes still missing a reason; re-read their
      // notes too (they are off the open-lead set) so a reason written in Goodshuffle is seen.
      return fetch(API + "/api/gs/projects", { method: "POST", headers: POSTH, body: JSON.stringify({ projects: recs, scope: "active" }) }).then((r) => r.json()).then((j) => { ((j && j.lossNoteIds) || []).forEach((id) => { id = String(id); if (!seenCap[id]) { seenCap[id] = 1; capIds.push(id); } }); return j; }).then((j) => pullPayments(j && j.paymentIds).catch(() => null).then(() => j)).then((j) => pullNotes().then((nj) => activeWindows().catch(() => ({ windows: 0 })).then((wj) => ({ saved: (j && j.saved) || recs.length, partial: false, notes: (nj && nj.updated) || 0, windows: (wj && wj.windows) || 0 })))).catch(() => ({ saved: 0, partial: false }));
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
  function fetchEvent(txID) { const out = { items: undefined, contactId: undefined, grandTotalCents: undefined, paidCents: undefined, rev: undefined };
    const pI = fetch("/app/vendorTransaction/initContractView?transactionID=" + txID, H).then((r) => r.json())
      .then((cv) => { if (cv && cv.contactID != null) out.contactId = String(cv.contactID); const g = (cv && cv.lineItemGroupsToLoad) || []; return Promise.all(g.map((x) => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + x.id + "&transactionID=" + txID, H).then((r) => r.json()).catch(() => null))); })
      .then((lists) => { const items = [];
        // Item photo for the driver load list. The image lives on the inventory item as
        // item.thumbImagePath (a public CloudFront/S3 URL) — already in loadContractLineItemGroup, so no
        // extra fetch. imgFrom matches any image/photo/thumb/picture key; imageOf also checks o.item.
        const absUrl = (u) => { if (!u || typeof u !== "string") return null; const s = u.toLowerCase(); if (s.startsWith("http://") || s.startsWith("https://")) return u; if (u.slice(0, 2) === "//") return "https:" + u; if (u[0] === "/") return "https://pro.goodshuffle.com" + u; return null; };
        const imgFrom = (o) => { if (!o || typeof o !== "object") return null; for (const k in o) { if (/image|photo|thumb|picture/i.test(k)) { const v = o[k]; const a = absUrl(v); if (a) return a; if (v && typeof v === "object") { const au = absUrl(v.url) || absUrl(v.path) || absUrl(v.src) || absUrl(v.thumbUrl) || absUrl(v.thumbnailUrl); if (au) return au; } } } return null; };
        const imageOf = (o) => { const d0 = imgFrom(o); if (d0) return d0; const n = o.item || o.inventoryItem || o.itemData; if (n && typeof n === "object") { const u = imgFrom(n); if (u) return u; } return null; };
        function w(o, d) { if (!o || typeof o !== "object" || d > 7) return; if (Object.prototype.toString.call(o) === "[object Array]") { for (let i = 0; i < o.length; i++) w(o[i], d + 1); return; } if (o.itemTitle) { const it = { name: o.itemTitle, quantity: o.quantityBooked }; const im = imageOf(o); if (im) it.image = im; items.push(it); } for (const k in o) w(o[k], d + 1); } (lists || []).forEach((gj) => { w(gj, 0); }); if (items.length) out.items = items; })
      .catch(() => {});
    const pR = fetch("/app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID=" + txID, H).then((r) => r.json())
      .then((pt) => { if (pt && typeof pt.grandTotal === "number") out.grandTotalCents = pt.grandTotal; const ph = pt && pt.paymentHistory; if (ph && typeof ph.totalContractApplicablePaid === "number") out.paidCents = ph.totalContractApplicablePaid;
        // Stage 3 revenue reconstruction: carry the full component breakdown (CENTS) off the SAME response.
        // MIRRORS extractRevenueComponents() in src/lib/finance/revenueModel.ts (inline here — drift caught in review).
        if (pt) { const N = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
          let rt = null; const etr = pt.effectiveTaxRate; if (typeof etr === "number" && isFinite(etr)) rt = etr; else if (typeof etr === "string" && etr.trim() !== "") { const pf = Number(etr); if (isFinite(pf)) rt = pf; }
          const evs = (ph && ph.paymentEvents && ph.paymentEvents.length) ? ph.paymentEvents : []; let gsf = null; for (let gi = 0; gi < evs.length; gi++) { const gv = N(evs[gi] && evs[gi].goodshuffleFeeAmount); if (gv != null) gsf = (gsf == null ? 0 : gsf) + gv; }
          const opf = N(ph && ph.onlinePaymentsProcessingFeesTotal), ffp = N(ph && ph.offlinePaymentsProcessingFeesTotal); const pfees = (opf == null && ffp == null) ? null : ((opf || 0) + (ffp || 0));
          out.rev = { bookingId: String(txID), quotedSubtotal: N(pt.contractOriginalSubTotal), contractTotal: N(pt.contractTotal), grandTotal: N(pt.grandTotal), productSubtotal: N(pt.contractProductSubTotal), productRentalsSubtotal: N(pt.contractProductRentalsSubTotal), productSalesSubtotal: N(pt.contractProductSalesSubTotal), serviceSubtotal: N(pt.contractServiceSubTotal), logisticsSubtotal: N(pt.contractLogisticsSubTotal), detachedItemSubtotal: N(pt.contractDetachedItemSubTotal), discount: N(pt.contractDiscount), additionalDiscount: N(pt.contractAdditionalDiscount), discountSubtotal: N(pt.contractDiscountSubTotal), taxableSubtotal: N(pt.contractTaxableSubTotal), taxTotal: N(pt.taxMap && pt.taxMap.total), effectiveTaxRate: rt, collected: N(ph && ph.totalContractApplicablePaid), refunds: N(ph && ph.totalSuccessfulRefunds), processingFees: pfees, goodshuffleFees: gsf }; }
      })
      .catch(() => {});
    return Promise.all([pI, pR]).then(() => out); }
  function extractStops(route) { const wps = (route.waypoints || []).filter((w) => !w.isOriginWarehouse && !w.isDestinationWarehouse); wps.sort((a, b) => (a.waypointIndex || 0) - (b.waypointIndex || 0));
    return wps.map((w) => { const tl = (w.logisticRelation && w.logisticRelation.targetLocation) || {}; const tx = w.transaction || {}; const line = [tl.streetAddressLine1, tl.streetAddressLine2].filter(Boolean).join(" "); const cs = [tl.city, tl.state].filter(Boolean).join(", "); const address = [line, cs, tl.zipCode].filter(Boolean).join(", "); const r = tx.renter || {}; const sv = r.smsValidation || {}; const name = tl.contactName || (tx.eventName ? String(tx.eventName).split(" - ")[0].trim() : "") || r.name; const doc = tx.dayOfContact || null;
      const s = { custName: name || "", custFirstName: r.firstName || undefined, custLastName: r.lastName || undefined, kind: (w.waypointType === "PICK_UP" ? "pickup" : "delivery"), custPhone: sv.e164PhoneNumber || r.phone || tl.contactPhoneNumber || "", address, plannedWindow: w.scheduledArrivalTime || undefined, eta: w.scheduledArrivalTime || undefined, windowStart: w.earliestRequiredArrivalTime || undefined, windowEnd: w.latestRequiredArrivalTime || undefined, plannedOnSiteMin: (typeof w.scheduledLoiterMinutes === "number" ? w.scheduledLoiterMinutes : undefined), plannedTransitMin: (w.transitMinutes && typeof w.transitMinutes.left === "number" ? w.transitMinutes.left : undefined) };
      if (doc) { s.dayOfName = doc.name || doc.fullName || undefined; s.dayOfPhone = doc.phoneNumber || doc.phone || undefined; }
      s._txID = w.transactionID || (tx && tx.id) || null; if (s._txID) s.txId = String(s._txID); return s; }); }
  function attachItems(stops) { return Promise.all(stops.map((s) => { if (!s._txID) { delete s._txID; return Promise.resolve(); } return fetchEvent(s._txID).then((ev) => { if (ev) { if (ev.items && ev.items.length) s.items = ev.items; if (ev.contactId) s.contactId = ev.contactId; if (ev.grandTotalCents != null) s.grandTotalCents = ev.grandTotalCents; if (ev.paidCents != null) s.paidCents = ev.paidCents; if (ev.rev) s.revComponents = ev.rev; } delete s._txID; }); })).then(() => stops); }
  // Multi-week route pull: the next ~3 weeks, imported per (truck, DATE) so the dispatch calendar +
  // risk engine stay populated ahead. Near-term routes (<= ENRICH days) get full per-event enrichment
  // (line items → tent/crew rules); farther-out routes import bare stops to keep the pull fast.
  function pullRoutes() {
    const HORIZON = 21, ENRICH = 8;
    const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0); const end = new Date(start.getTime() + (HORIZON + 1) * 24 * 3600 * 1000);
    const todayYmd = d2(start.toISOString());
    const body = { from: start.toISOString(), to: end.toISOString(), warehouseCanonicalIDs: null, crew: null, vehicles: null, statuses: null };
    return fetch("/app/routing/listRoutes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "include" }).then((r) => r.json()).then((routes) => {
      const groups = {}; let chain = Promise.resolve(); const unmatched = {}; const revAcc = {};
      (routes || []).forEach((rt) => { chain = chain.then(() => { const title = (rt.vehicle && rt.vehicle.title) || ""; const tid = truckIdFor(title) || truckFromName(rt.name); if (!tid) { if (title || rt.name) unmatched[title || rt.name] = 1; return; }
        return fetch("/app/routing/getRoute?routeID=" + rt.id + "&includeAttributes=true", { headers: { accept: "application/json" }, credentials: "include" }).then((r) => r.json()).then((full) => {
          const stops = extractStops(full);
          const rdate = d2(rt.startDate) || d2(rt.date) || (stops[0] ? d2(stops[0].eta) : null);
          if (!rdate) return;
          const daysOut = Math.round((Date.parse(rdate + "T00:00:00Z") - Date.parse(todayYmd + "T00:00:00Z")) / 86400000);
          const p = daysOut >= 0 && daysOut <= ENRICH ? attachItems(stops) : Promise.resolve(stops);
          return p.then((st) => { const key = tid + "|" + rdate + "|" + rt.id; if (!groups[key]) groups[key] = { truckId: tid, date: rdate, stops: [], gsRouteId: String(rt.id) }; groups[key].stops = groups[key].stops.concat(st);
            // Stage 3: collect each enriched stop's revenue component breakdown (CENTS), deduped by tx.
            st.forEach((x) => { if (x && x.revComponents && x.revComponents.bookingId) revAcc[x.revComponents.bookingId] = x.revComponents; }); });
        }); }); });
      return chain.then(() => {
        const keys = Object.keys(groups); let totalStops = 0, failed = 0; const days = keys.length; const unm = Object.keys(unmatched);
        const result = () => ({ stops: totalStops, days, failed, unmatched: unm });
        // Stage 3: push the enriched revenue component breakdown to the bookings SoT ingest (components-only
        // POST — no projects[], so it never touches the bookings upsert/prune). Best-effort; never fails the pull.
        const postComponents = () => { const vals = Object.keys(revAcc).map((k) => revAcc[k]); if (!vals.length) return Promise.resolve(); return fetch(API + "/api/gs/projects", { method: "POST", headers: POSTH, body: JSON.stringify({ components: vals }) }).then(() => {}).catch(() => {}); };
        return Promise.all(keys.map((k) => { const g = groups[k]; totalStops += g.stops.length; return fetch(API + "/api/route/import", { method: "POST", headers: POSTH, body: JSON.stringify({ truckId: g.truckId, date: g.date, stops: g.stops, gsRouteId: g.gsRouteId }) }).then((r) => { if (!r.ok) failed++; }).catch(() => { failed++; }); })).then(postComponents).then(() => {
          // Sanitize: after a FULL clean sweep, drop any of OUR routes GS no longer has. Never on a partial pull.
          if (failed !== 0 || keys.length === 0) return result();
          const keepRouteIds = keys.map((k) => { const g = groups[k]; return "R-" + g.date + "-" + g.truckId + "-" + g.gsRouteId; });
          const dset = {}; keys.forEach((k) => { dset[groups[k].date] = 1; });
          return fetch(API + "/api/route/prune", { method: "POST", headers: POSTH, body: JSON.stringify({ dates: Object.keys(dset), keepRouteIds }) }).then(() => result()).catch(() => result());
        });
      });
    }).catch(() => ({ stops: 0, days: 0, failed: 1, unmatched: [] }));
  }

  // ---- Goodshuffle email template renderer: VERBATIM copy of GS_TEMPLATE_JS (src/lib/intake/gsTemplate.ts);
  // a test checks the copy, so change it there and paste it here. ----
  function gsRenderTemplate(html, tags) {
  var vals = {};
  (tags || []).forEach(function (t) { if (t && t.name) vals[String(t.name).replace(/\s+/g, "").toLowerCase()] = t.transactionValue; });
  var FALLBACK = { firstname: "there" };
  var esc = function (s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); };
  var src = String(html || ""), out = "", i = 0, m;
  var re = /<span\b[^>]*class="[^"]*\bmention\b[^"]*"[^>]*>/gi;
  while ((m = re.exec(src))) {
    var open = m[0], start = m.index, j = start + open.length, depth = 1, t;
    var tagRe = /<\/?span\b[^>]*>/gi;
    tagRe.lastIndex = j;
    while (depth > 0 && (t = tagRe.exec(src))) { depth += t[0].charAt(1) === "/" ? -1 : 1; j = tagRe.lastIndex; }
    var km = /data-original="([^"]*)"/i.exec(open) || /data-value="([^"]*)"/i.exec(open);
    var key = km ? km[1].replace(/\s+/g, "").toLowerCase() : "";
    var v = vals[key];
    if (v == null || v === "") v = FALLBACK[key] || "";
    out += src.slice(i, start) + esc(v);
    i = j;
    re.lastIndex = j;
  }
  return out + src.slice(i);
}
function gsTemplateText(html) {
  return String(html || "").replace(/<br\s*\/?>/gi, " ").replace(/<\/(div|p|li)>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function gsTagsWithAmount(tags, amount) {
  var a = String(amount == null ? "" : amount).trim();
  if (!a) return tags || [];
  return (tags || []).map(function (t) {
    var k = t && t.name ? String(t.name).replace(/\s+/g, "").toLowerCase() : "";
    if (k === "paymentamount" && (t.transactionValue == null || t.transactionValue === "")) return { name: t.name, transactionValue: "$" + a };
    return t;
  });
}
function gsFillAmount(html, amount) {
  var a = String(amount == null ? "" : amount).trim();
  if (!a) return String(html || "");
  var safe = a.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return String(html || "").replace(/\$(?=\s|&nbsp;|<|$)/, function () { return "$" + safe; });
}

  // ---- Outbox drain: push queued Dispatch → Goodshuffle writes (photos, note appends) ----
  function ackOp(id, ok, err) { return fetch(API + "/api/gs/outbox", { method: "POST", headers: POSTH, body: JSON.stringify({ id, ok, error: ok ? undefined : err }) }).catch(() => {}); }
  // Sender hold: Goodshuffle sends an email as whoever is signed in, so client emails go out only from the
  // configured sender's session (server's emailSender, e.g. "Jessie Medalla"). Any other session leaves them
  // pending. The signed-in user comes from /app/rms/initHeader (currentUser firstName/lastName/email).
  function gsNorm(s) { return String(s || "").trim().toLowerCase().replace(/\s+/g, " "); }
  function gsSignedInAs(sender) {
    return fetch("/app/rms/initHeader", { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" })
      .then((r) => (r.ok ? r.json() : null)).then((h) => {
        const u = h && h.currentUser; if (!u) return false;
        const want = gsNorm(sender);
        return want.indexOf("@") >= 0 ? gsNorm(u.email) === want : gsNorm((u.firstName || "") + " " + (u.lastName || "")) === want;
      }).catch(() => false);
  }
  // Delivery fee push helpers. Keep these two functions identical in extension/pull-injected.js and
  // src/lib/gsPull.ts (deliveryFeeDrainer.test.ts runs both copies). The base delivery line is inventory item
  // 392868144: newer lines are titled "Delivery fee" (the item's current name), older ones "Standard Delivery".
  // A line with either title on a drop-off or pickup leg also counts, in case the item is ever re-created.
  function zoeFindDeliveryLines(tree) {
    var IDS = { "392868144": 1 }, TITLES = { "delivery fee": 1, "standard delivery": 1 }, out = [], seen = {};
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Object.prototype.toString.call(n) === "[object Array]") { for (var i = 0; i < n.length; i++) walk(n[i]); return; }
      if (n.itemTitle && n.item && n.item.id != null && n.id != null) {
        var mk = n.eventTimeLineMarker, leg = mk === "DROP_OFF" || mk === "PICK_UP";
        var named = TITLES[String(n.item.title || "").trim().toLowerCase()] || TITLES[String(n.itemTitle).trim().toLowerCase()];
        if (IDS[String(n.item.id)] || (named && leg)) { if (!seen[n.id]) { seen[n.id] = 1; out.push(n); } return; }
      }
      for (var k in n) walk(n[k]);
    })(tree);
    return out;
  }
  // Body for POST /app/transactionItemRelation/saveInventoryTrackedLineItemEdit, built the way Goodshuffle's
  // own line editor builds it (captured 2026-11-09 on TEST 1): every field comes from the editor's
  // initAddEditLineItemSection response (dates as "Aug 31 2026", times as 900 / 2000, the line's current tax
  // types), and only the price changes: unitPriceOverridden + unitPrice, mileageFee 0, discount 0.
  function zoeDeliveryFeeBody(init, tx, gid, amount) {
    var r = (init && init.relation) || {}, it = r.item || {}, tl = r.targetLocation || {};
    if (!init || r.id == null || it.id == null || !init.itemStartDate) return null;
    function num(v) { if (v === null || v === undefined || v === "") return null; var x = Number(v); return isFinite(x) ? x : v; }
    function str(v) { return v === null || v === undefined || v === "" ? null : String(v); }
    return {
      inventoryInjection: false, itemID: it.id, fulfillment: null, transactionID: Number(tx) || tx, lineItemGroupID: Number(gid) || gid,
      relationID: r.id, relationType: r.relationType || null, parentRelationID: null,
      inventoryTypeStr: it.inventoryType || "SERVICE", rateType: r.rateType || init.selectedRateType || "FLAT_FEE_WITH_MILEAGE",
      title: r.itemTitle, description: r.lineItemDescription || "", isSubrental: false, internalNotes: r.internalNotes || "",
      showItemDescription: r.showItemDescription !== false, showItemAttributes: r.showItemAttributes !== false, quantity: r.quantity || 1,
      unitPriceOverridden: true, unitPrice: String(amount), mileageFee: 0, distanceToTargetLocation: null, discountDollarAmount: 0, discountPercentage: 0,
      itemStartDate: init.itemStartDate, itemStartTime: num(init.itemStartTime), itemEndDate: init.itemEndDate || init.itemStartDate, itemEndTime: num(init.itemEndTime),
      eventTimeLineMarker: r.eventTimeLineMarker || null, selectedTaxTypes: init.selectedTaxTypes || [],
      venueName: str(tl.venueName), venueAddress: str(tl.streetAddressLine1), venueAddress_line2: str(tl.streetAddressLine2),
      venueAddress_city: str(tl.city), venueAddress_state: str(tl.state), venueAddress_zipCode: str(tl.zipCode),
      venueAddress_county: str(tl.county), venueAddress_country: str(tl.country),
      venueAddress_latitude: str(tl.latitude), venueAddress_longitude: str(tl.longitude), serviceStoreLocationID: null
    };
  }
  function drainOutbox() {
    // senderHold=1 tells the server this copy enforces the sender hold; older copies get no email ops.
    return fetch(API + "/api/gs/outbox?senderHold=1", { headers: POSTH }).then((r) => r.json()).then((j) => {
      const all = (j && j.ops) || [];
      const photoOps = all.filter((o) => o.op === "photo_upload" && o.transactionId && o.payload && o.payload.photoIds && o.payload.photoIds.length);
      const noteOps = all.filter((o) => o.op === "note_append" && o.transactionId && o.payload && o.payload.line);
      const teamOps = all.filter((o) => o.op === "add_team_member" && o.transactionId && o.payload && o.payload.userID);
      const feeOps = all.filter((o) => o.op === "set_delivery_fee" && o.transactionId && o.payload && o.payload.amount != null);
      const emailOps = all.filter((o) => o.op === "email_send" && o.transactionId && o.payload && o.payload.content);
      const tplOps = all.filter((o) => o.op === "email_template" && o.transactionId && o.payload && (o.payload.templateName || o.payload.templateId));
      const taskOps = all.filter((o) => o.op === "create_gs_task" && o.transactionId && o.payload && o.payload.title);
      const provOps = all.filter((o) => (o.op === "provision_user" || o.op === "revoke_user") && o.payload && o.payload.system);
      const esignOps = all.filter((o) => o.op === "disable_esignature" && o.transactionId);
      const lostOps = all.filter((o) => o.op === "mark_lost" && o.transactionId);
      const routeOps = all.filter((o) => (o.op === "gs_status" || o.op === "remove_waypoint") && o.gsRouteId && (o.op === "remove_waypoint" || (o.payload && o.payload.status)));
      // Ops this content-script drainer can't action (e.g. create_project, which needs a popup created
      // from a real user gesture — a timer-driven content script has none, so the office bookmarklet or a
      // Playwright runner drains those). Surfaced in the result so they're VISIBLE, never silently
      // ignored forever. Keep this set in sync with the handlers below + gsPull.ts.
      const HANDLED = { photo_upload: 1, note_append: 1, add_team_member: 1, set_delivery_fee: 1, email_send: 1, email_template: 1, create_gs_task: 1, provision_user: 1, revoke_user: 1, disable_esignature: 1, mark_lost: 1, gs_status: 1, remove_waypoint: 1 };
      const unhandledOps = all.filter((o) => !HANDLED[o.op]);
      const emailSender = (j && j.emailSender) || null;
      let senderOk = !emailSender, emailsHeld = 0;
      let pushed = 0, failed = 0, notes = 0, team = 0, fees = 0, emails = 0, tasks = 0, provisioned = 0, esigns = 0, losts = 0, statuses = 0;
      let chain = (emailSender && (emailOps.length || tplOps.length)) ? gsSignedInAs(emailSender).then((ok) => { senderOk = ok; }) : Promise.resolve();
      // provision_user / revoke_user: People Lifecycle access provisioning via REPLAY. Mirrors
      // src/lib/gsPull.ts — gated on the captured endpoint (src/lib/people/provisioningEndpoints.ts). This
      // content script runs ONLY on pro.goodshuffle.com, so it can replay the GOODSHUFFLE invite/disable once
      // that endpoint is captured; Quo/Slack drain from their own logged-in session. CAPTURE-PENDING: both
      // are null until the internal request is recorded once from a logged-in GSPRO admin session and the
      // endpoint+body are filled in provisioningEndpoints.ts (keep this constant in sync).
      const GS_PROVISION = { provision: null, revoke: null };
      provOps.forEach((o) => { chain = chain.then(() => {
        if (o.payload.system !== "goodshuffle") return; // only Goodshuffle shares this origin; skip others
        const ep = (o.op === "provision_user") ? GS_PROVISION.provision : GS_PROVISION.revoke;
        if (!ep || !ep.path) return; // CAPTURE-PENDING: no-op until the endpoint is captured (leave pending)
        const data = o.payload.data || {}; const headers = { "x-requested-with": "XMLHttpRequest", accept: "application/json" }; let body;
        if (ep.bodyType === "form") { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(data).toString(); }
        else { headers["content-type"] = "application/json"; body = JSON.stringify(data); }
        return fetch(ep.path, { method: ep.method, headers, credentials: "include", body: (ep.method === "DELETE" ? undefined : body) }).then((r) => r.ok).then((ok) => { if (ok) provisioned++; else failed++; return ackOp(o.id, ok, o.op + "_failed"); }).catch(() => { failed++; return ackOp(o.id, false, o.op + "_error"); });
      }); });
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
      // set_delivery_fee: set the project's base delivery line(s) (both legs) to our computed per-leg fee.
      // Same steps as Goodshuffle's line editor: load the contract's groups, find the delivery lines, then per
      // line GET initAddEditLineItemSection and POST saveInventoryTrackedLineItemEdit (zoeDeliveryFeeBody).
      // The old body (ISO dates, null times, empty taxes) got a 500 on every push. On a signed contract the
      // save leaves "Unsigned Changes", exactly as an edit in the Goodshuffle UI does.
      feeOps.forEach((o) => { chain = chain.then(() => {
        const tx = o.transactionId, amount = o.payload.amount;
        const saveLeg = (L) => fetch("/app/transactionItemRelation/initAddEditLineItemSection?inventoryInjection=false&lineItemGroupID=" + L.gid + "&relationID=" + L.id + "&transactionID=" + encodeURIComponent(tx), H)
          .then((r) => { if (!r.ok) throw "init_http_" + r.status; return r.json(); })
          .then((init) => {
            const body = zoeDeliveryFeeBody(init, tx, L.gid, amount); if (!body) throw "bad_line";
            return fetch("/app/transactionItemRelation/saveInventoryTrackedLineItemEdit", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include", body: JSON.stringify(body) });
          })
          .then((r) => { if (!r.ok) throw "http_" + r.status; });
        return fetch("/app/vendorTransaction/initContractView?transactionID=" + encodeURIComponent(tx), H).then((r) => { if (!r.ok) throw "contract_http_" + r.status; return r.json(); }).then((cv) => {
          const groups = (cv && cv.lineItemGroupsToLoad) || []; const legs = []; let loadErr = false; let gchain = Promise.resolve();
          groups.forEach((g) => { gchain = gchain.then(() => fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID=" + g.id + "&transactionID=" + encodeURIComponent(tx), H).then((r) => { if (!r.ok) throw 0; return r.json(); }).then((li) => { zoeFindDeliveryLines(li).forEach((n) => legs.push({ gid: g.id, id: n.id })); }).catch(() => { loadErr = true; })); });
          return gchain.then(() => { if (!legs.length) throw (loadErr ? "load_failed" : "no_delivery_line"); let s = Promise.resolve(); legs.forEach((L) => { s = s.then(() => saveLeg(L)); }); return s; });
        }).then(() => { fees++; return ackOp(o.id, true); }).catch((e) => { failed++; return ackOp(o.id, false, "set_delivery_fee_" + (typeof e === "string" ? e : "error")); });
      }); });
      // email_send: reply into the project's CLIENT email thread (continues it; Goodshuffle appends the
      // signature). Read the thread, take the latest message's id + recipients + subject, POST sendMessage.
      // PARITY with the bookmarklet (gsPull.ts) — without this handler an APPROVED email reply was stamped
      // "executed" upstream but sat in the outbox forever (never actually sent) whenever this extension was
      // the active drainer. Pure fetch, no popup, so it runs fine on the drain timer.
      emailOps.forEach((o) => { chain = chain.then(() => {
        if (!senderOk) { emailsHeld++; return; } // not the sender's session: leave it pending
        return fetch("/app/conversation/getMessagesForTransaction?transactionID=" + encodeURIComponent(o.transactionId), { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" }).then((r) => { if (!r.ok) throw 0; return r.json(); }).then((cv) => {
          const msgs = (cv && cv.client && cv.client.messages) || [];
          if (!msgs.length) throw "no_thread";
          const last = msgs[msgs.length - 1];
          const recips = (last.clientRecipients || []).map((rp) => ({ contactID: rp.contactID, email: rp.email, name: rp.name, phone: rp.phone, isCurrentUser: !!rp.isCurrentUser, isEmailValid: true, deliveryConfirmedDate: null, messageOpenedDate: null, hardBouncedDate: null, droppedMessageDate: null }));
          if (!recips.length) throw "no_recipient";
          let subj = (o.payload.subject || last.subject || "");
          if (!/^re:/i.test(subj)) subj = "Re: " + subj;
          let txID = Number(o.transactionId); if (!txID) txID = o.transactionId;
          const payload = { messageID: last.id, transactionID: txID, content: o.payload.content, recipients: recips, subject: subj, messageType: "CLIENT", attachments: [] };
          return fetch("/app/conversation/sendMessage", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include", body: JSON.stringify(payload) }).then((r) => r.ok);
        }).then((ok) => { if (ok) emails++; else failed++; return ackOp(o.id, ok, "email_send_failed"); }).catch((e) => { failed++; return ackOp(o.id, false, "email_send_" + (typeof e === "string" ? e : "error")); });
      }); });
      // email_template: send a Goodshuffle email TEMPLATE (e.g. the web-lead welcome) as a NEW client email.
      // The template list for this project comes back with every variable filled in (templateTags[].
      // transactionValue); gsRenderTemplate swaps the #variable chips for those values. Recipients are the
      // project's client participants (present even before any message). If an email with the same subject
      // is already in the client thread (an earlier send whose ack was lost), it acks done without sending.
      tplOps.forEach((o) => { chain = chain.then(() => {
        if (!senderOk) { emailsHeld++; return; } // not the sender's session: leave it pending
        const GH = { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" };
        const tx = o.transactionId; let txID = Number(tx); if (!txID) txID = tx;
        let tpl = null;
        return fetch("/app/messageTemplate/list?transactionID=" + encodeURIComponent(tx), GH).then((r) => { if (!r.ok) throw "template_list_" + r.status; return r.json(); }).then((j) => {
          const want = String(o.payload.templateName || "").trim().toLowerCase();
          tpl = ((j && j.templates) || []).filter((t) => (o.payload.templateId && String(t.id) === String(o.payload.templateId)) || (want && String(t.name || "").trim().toLowerCase() === want))[0] || null;
          if (!tpl) throw "template_not_found";
          if (tpl.medium && tpl.medium !== "EMAIL") throw "template_not_email";
          return fetch("/app/conversation/getMessagesForTransaction?transactionID=" + encodeURIComponent(tx), GH);
        }).then((r) => { if (!r.ok) throw "thread_" + r.status; return r.json(); }).then((cv) => {
          // fillAmount (payment confirmation): the amount goes into an empty PaymentAmount chip and the body's bare "$".
          const tags = gsTagsWithAmount(tpl.templateTags, o.payload.fillAmount);
          const subject = gsTemplateText(gsRenderTemplate(tpl.subject, tags));
          const content = gsFillAmount(gsRenderTemplate(tpl.content, tags), o.payload.fillAmount);
          if (!subject || !gsTemplateText(content)) throw "template_empty";
          const msgs = (cv && cv.client && cv.client.messages) || [];
          // sentAfter: a template that can repeat (one per payment) counts as already sent only when the same subject
          // landed after that time; without it, any earlier email with the same subject counts.
          const after = o.payload.sentAfter ? Date.parse(o.payload.sentAfter) : NaN;
          if (msgs.some((m) => gsTemplateText(m.subject) === subject && (!(after > 0) || !(Date.parse(m.date) < after)))) return true; // already sent
          const recips = ((cv && cv.client && cv.client.participants) || []).filter((p) => p && p.email).map((p) => ({ contactID: p.contactID, email: p.email, name: p.name, isCurrentUser: false, isEmailValid: true, deliveryConfirmedDate: null, messageOpenedDate: null, hardBouncedDate: null, droppedMessageDate: null }));
          if (!recips.length) throw "no_recipient";
          const payload = { messageID: null, templateID: tpl.id, transactionID: txID, content, recipients: recips, subject, messageType: "CLIENT", attachments: (tpl.attachments || []).map((a) => a && a.id).filter(Boolean) };
          return fetch("/app/conversation/sendMessage", { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include", body: JSON.stringify(payload) }).then((r) => r.ok);
        }).then((ok) => { if (ok) emails++; else failed++; return ackOp(o.id, ok, "email_template_failed"); }).catch((e) => { failed++; return ackOp(o.id, false, "email_template_" + (typeof e === "string" ? e : "error")); });
      }); });
      // create_gs_task: queue a to-do on the GSPRO project. Form-urlencoded POST /app/task/createTask
      // (captured + verified live in gsPull.ts). On success ack; on FAILURE leave the op PENDING (no ack)
      // so it retries next cycle, mirroring the bookmarklet.
      const GS_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const gsDueStr = () => { const d = new Date(); return GS_MON[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear(); };
      // Optional payload.dueDate (YYYY-MM-DD) and assignee, mirroring the bookmarklet: assigneeUserID wins;
      // else assigneeName (the sales lead) matched to an ACTIVE initProjectSearch.salesEnabledUsers entry;
      // no match → fallbackUserID; none → unassigned.
      const gsDueFrom = (ymd) => { const y = String(ymd || ""); if (y.length === 10 && y.charAt(4) === "-" && y.charAt(7) === "-") { const mi = Number(y.slice(5, 7)) - 1, dd = Number(y.slice(8, 10)); if (mi >= 0 && mi < 12 && dd > 0) return GS_MON[mi] + " " + dd + " " + y.slice(0, 4); } return gsDueStr(); };
      let gsSalesUsersP = null;
      const gsSalesUsers = () => { if (!gsSalesUsersP) gsSalesUsersP = fetch("/app/project/initProjectSearch", { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json" }, credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((j) => (j && j.salesEnabledUsers) || []).catch(() => []); return gsSalesUsersP; };
      const gsTaskAssignee = (p) => { if (p.assigneeUserID) return Promise.resolve(String(p.assigneeUserID)); if (!p.assigneeName && !p.fallbackUserID) return Promise.resolve("");
        return gsSalesUsers().then((us) => { const want = gsNorm(p.assigneeName); const u = want ? us.find((x) => x && x.active && gsNorm(x.fullName) === want) : null; return u ? String(u.id) : (p.fallbackUserID ? String(p.fallbackUserID) : ""); }); };
      taskOps.forEach((o) => { chain = chain.then(() => gsTaskAssignee(o.payload)).then((uid) => {
        let text = String(o.payload.title || ""); if (o.payload.note) text += " — " + String(o.payload.note);
        const body = new URLSearchParams({ taskID: "", taskText: text, taskAssignedTransactionID: String(o.transactionId), taskAssignedUserID: uid || "", taskDueDateStr: gsDueFrom(o.payload.dueDate), fromProjectView: "true" });
        return fetch("/app/task/createTask", { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, credentials: "include", body }).then((r) => r.ok).then((ok) => { if (ok) { tasks++; return ackOp(o.id, true); } /* leave PENDING on failure so it retries */ }).catch(() => { /* leave PENDING; never disrupt the rest of the drain */ });
      }); });
      // disable_esignature: turn OFF online signing on the project N business days before the event, so the
      // contract signs IN PERSON (queued by src/lib/salesos/esignCutoff.ts). CAPTURE-NEEDED: the Goodshuffle
      // internal request that disables online signing has NOT been captured yet. Do the toggle ONCE in the
      // GSPRO UI on a TEST project while recording the browser network tab, then fill GS_DISABLE_ESIGN below
      // (method + path + bodyType "form"|"json" + a body builder from the transactionId). Until then this is
      // a NO-OP that leaves the op PENDING — it NEVER fabricates/guesses a request (honest-when-unobservable).
      // Keep this constant + the body shape in sync with src/lib/gsPull.ts (bookmarklet parity).
      const GS_DISABLE_ESIGN = null; // e.g. { method:"POST", path:"/app/vendorTransaction/…", bodyType:"form", body:(tx)=>({ transactionID:String(tx), /* captured field */ }) }
      esignOps.forEach((o) => { chain = chain.then(() => {
        if (!GS_DISABLE_ESIGN || !GS_DISABLE_ESIGN.path) return; // CAPTURE-PENDING: leave pending, no request
        const ep = GS_DISABLE_ESIGN; const data = ep.body ? ep.body(o.transactionId) : { transactionID: String(o.transactionId) };
        const headers = { "x-requested-with": "XMLHttpRequest", accept: "application/json" }; let body;
        if (ep.bodyType === "json") { headers["content-type"] = "application/json"; body = JSON.stringify(data); }
        else { headers["content-type"] = "application/x-www-form-urlencoded"; body = new URLSearchParams(data).toString(); }
        return fetch(ep.path, { method: ep.method || "POST", headers, credentials: "include", body }).then((r) => r.ok).then((ok) => { if (ok) esigns++; else failed++; return ackOp(o.id, ok, "disable_esignature_failed"); }).catch(() => { failed++; return ackOp(o.id, false, "disable_esignature_error"); });
      }); });
      // mark_lost: an unsigned quote 3 days (or less) before its event (queued by the Sales Bot morning run,
      // src/lib/salesos/markLost.ts). Captured live 2026-11-03 on TEST 3: POST markAsLost then archiveProject,
      // each a form body of just transactionID. Done only when both succeed; a failure acks failed (visible
      // in the outbox health) rather than retrying a half done write forever.
      lostOps.forEach((o) => { chain = chain.then(() => {
        const post = (path) => fetch(path, { method: "POST", headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, credentials: "include", body: new URLSearchParams({ transactionID: String(o.transactionId) }).toString() }).then((r) => r.ok);
        return post("/app/vendorTransaction/markAsLost").then((lostOk) => {
          if (o.payload && o.payload.archive === false) return lostOk ? "" : "lost_failed";
          return post("/app/vendorTransaction/archiveProject").then((archOk) => (lostOk && archOk ? "" : !lostOk ? "lost_failed" : "archive_failed"));
        }).then((err) => { if (!err) losts++; else failed++; return ackOp(o.id, !err, "mark_lost_" + err); }).catch(() => { failed++; return ackOp(o.id, false, "mark_lost_error"); });
      }); });
      // gs_status + remove_waypoint: Dispatch progress and stop removals mirrored onto the Goodshuffle ROUTE
      // (queued by src/lib/dispatch/gsStatusSync.ts and /api/route/stop/remove). Endpoints come from
      // Goodshuffle's own routing app (2026-11-09): updateWaypointStatus {waypointID,status} (SCHEDULED |
      // ARRIVED | COMPLETED), updateRoute {routeID,routeName,color,notes,status} (SCHEDULED | IN_PROGRESS |
      // COMPLETE; name/color/notes echoed so nothing else changes), unscheduleWaypoint {waypointID}. Each route
      // is read once per drain; the stop is matched by transactionID (+ DROP_OFF/PICK_UP when known). A write
      // Goodshuffle already matches is acked without a call. A stop no longer on that route (the office moved
      // it) is acked as done with nothing to write.
      const GJ = { headers: { "x-requested-with": "XMLHttpRequest", accept: "application/json, text/plain, */*" }, credentials: "include" };
      const postJson = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-requested-with": "XMLHttpRequest", accept: "application/json, text/plain, */*" }, credentials: "include", body: JSON.stringify(body) }).then((r) => r.ok);
      const routeCache = {};
      const loadRoute = (id) => (routeCache[id] = routeCache[id] || fetch("/app/routing/getRoute?routeID=" + encodeURIComponent(id) + "&includeAttributes=true", GJ).then((r) => { if (!r.ok) throw "route_" + r.status; return r.json(); }));
      const pickWp = (route, o) => { const want = o.payload && o.payload.waypointType; const c = ((route && route.waypoints) || []).filter((w) => !w.isOriginWarehouse && !w.isDestinationWarehouse && String(w.transactionID) === String(o.transactionId)); return (want && c.filter((w) => w.waypointType === want)[0]) || c[0] || null; };
      routeOps.forEach((o) => { chain = chain.then(() => loadRoute(o.gsRouteId).then((route) => {
        const p = o.payload || {};
        if (o.op === "remove_waypoint") {
          const w = pickWp(route, o); if (!w) return ""; // already off the route
          return postJson("/app/routing/unscheduleWaypoint", { waypointID: w.id }).then((ok) => { if (ok) delete routeCache[o.gsRouteId]; return ok ? "" : "unschedule_failed"; });
        }
        if (p.target === "route") {
          if (route.status === p.status) return "";
          return postJson("/app/routing/updateRoute", { routeID: route.id, routeName: route.name, color: route.color, notes: route.notes, status: p.status }).then((ok) => { if (ok) route.status = p.status; return ok ? "" : "route_status_failed"; });
        }
        const w = pickWp(route, o); if (!w) return ""; // moved off this route in Goodshuffle: nothing to write
        if (w.status === p.status) return "";
        return postJson("/app/routing/updateWaypointStatus", { waypointID: w.id, status: p.status }).then((ok) => { if (ok) w.status = p.status; return ok ? "" : "waypoint_status_failed"; });
      }).then((err) => { if (!err) statuses++; else failed++; return ackOp(o.id, !err, o.op + "_" + err); }).catch((e) => { failed++; return ackOp(o.id, false, o.op + "_" + (typeof e === "string" ? e : "error")); })); });
      return chain.then(() => ({ pushed, failed, notes, team, fees, emails, emailsHeld, emailSender, tasks, provisioned, esigns, losts, statuses, unhandled: unhandledOps.length }));
    }).catch(() => ({ pushed: 0, failed: 0, notes: 0, team: 0, fees: 0, emails: 0, tasks: 0, provisioned: 0, esigns: 0, unhandled: 0 }));
  }

  return loggedInProbe().then((ok) => {
    if (!ok) return { ok: false, loggedIn: false, tier: TIER, stops: 0, bookings: 0, notes: 0, photos: 0, error: "not signed in" };
    // SLOW lane: just the archive-inclusive projects history + prune. Routes/notes/outbox stay on the
    // fast lane, so they are intentionally NOT run here (no double work at the hourly tick).
    if (TIER === "full") {
      return pullProjects("full").then((bk) => {
        bk = bk || { saved: 0, partial: false };
        return { ok: !bk.partial, loggedIn: true, tier: "full", stops: 0, bookings: bk.saved || 0, notes: 0, photos: 0, emails: 0, tasks: 0, unhandled: 0, unmatched: [], partial: !!bk.partial, error: bk.partial ? "history incomplete" : null };
      }).catch((e) => ({ ok: false, loggedIn: true, tier: "full", stops: 0, bookings: 0, notes: 0, photos: 0, error: String(e).slice(0, 120) }));
    }
    // FAST lane: routes + active projects (scope:"active", never prunes) + notes + outbox drain.
    return Promise.all([pullRoutes(), pullProjects("active"), drainOutbox()]).then((res) => {
      const r = res[0] || { stops: 0, failed: 0, unmatched: [] };
      const bk = res[1] || { saved: 0, partial: false, notes: 0 };
      const ph = res[2] || { pushed: 0, failed: 0, emails: 0, tasks: 0, unhandled: 0 };
      return { ok: !r.failed && !bk.partial, loggedIn: true, tier: "active", stops: r.stops || 0, bookings: bk.saved || 0, notes: bk.notes || 0, photos: ph.pushed || 0, emails: ph.emails || 0, emailsHeld: ph.emailsHeld || 0, tasks: ph.tasks || 0, unhandled: ph.unhandled || 0, unmatched: r.unmatched || [], partial: !!bk.partial, error: r.failed ? "routes failed to save" : bk.partial ? "bookings incomplete" : null };
    }).catch((e) => ({ ok: false, loggedIn: true, tier: "active", stops: 0, bookings: 0, notes: 0, photos: 0, error: String(e).slice(0, 120) }));
  });
}
