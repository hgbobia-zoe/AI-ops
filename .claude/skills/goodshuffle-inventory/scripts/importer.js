/* ===========================================================================
   Zoe <- Staging Design DC : bulk inventory importer   (v2 - verified payloads)
   Run in the DevTools Console of a logged-in pro.goodshuffle.com tab.
   Creates the partner's sofas + barstools in YOUR inventory: UNPRICED, UNTRACKED,
   listed on the website, in the Sofas / Stools categories (so they appear on
   zoeeventsdmv.com automatically), with photos + descriptions + matched tags.

   SAFE: DRY_RUN = true only previews. Review it, then set DRY_RUN = false and
   run again to create. Idempotent: skips titles you already have.
   =========================================================================== */
(async () => {
  const DRY_RUN = true;                        // <-- set to false to actually create
  const LIMIT   = 0;                           // <-- set to 1 to create just the FIRST item as a test; 0 = all

  const STAGING = "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA";   // partner (source)
  const ZOE     = "y2lcwfwX40RpfPiD6jorw7ipHI6gUK";   // your storefront (de-dupe)
  const DATA = (t) => `https://data.goodshuffle.com/vendor/${t}/inventory`;

  // Resolved from your live catalog. Server derives the root group from the category, so we only send category.
  const TARGETS = {
    sofas:  { srcGroups: "sofa-rentals settee-rentals", zoeDedupeGroup: "sofa-rentals",
              primaryCategoryID: 657, primaryCategoryName: "Sofas",  baseTag: "Sofa" },
    stools: { srcGroups: "stools-rentals",              zoeDedupeGroup: "stools-rentals",
              primaryCategoryID: 661, primaryCategoryName: "Stools", baseTag: "Barstool" },
  };
  // Tax types are fetched live from the account (below) so the exact object (incl. taxRates) is correct.
  let TAX = [];
  // The EXACT unpriced pricingMap the app sends on create (captured from a real 200 create) - minimal.
  const UNPRICED = { flatFeesByGeo: [], rateType: "UNPRICED", unpriced: true, flatFee: null,
    dailyPriceVisibleOnECommerce: true, hourlyPriceVisibleOnECommerce: true,
    flatFeePriceVisibleOnECommerce: true, purchasePriceVisibleOnECommerce: true };

  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const log = (...a) => console.log("%c[import]", "color:#2a7", ...a);
  const DROP_TAG = /^(group\s|event\s*rental)/i;
  const tagsFor = (srcTags, baseTag) => {
    const out = new Set([baseTag]);
    for (const t of (srcTags || [])) { const v = String(t).trim(); if (!v || DROP_TAG.test(v)) continue; out.add(/^bar\s*stool$/i.test(v) ? "Barstool" : v); }
    return [...out].join(",");
  };
  const ctForName = (n) => { const e = (n.split(".").pop() || "").toLowerCase(); return e === "png" ? "image/png" : e === "webp" ? "image/webp" : e === "gif" ? "image/gif" : e === "heic" ? "image/heic" : "image/jpeg"; };
  const dims = async (blob) => { try { const b = await createImageBitmap(blob); const d = { w: b.width, h: b.height }; b.close && b.close(); return d; } catch { return { w: null, h: null }; } };

  // Pace every call to pro.goodshuffle.com (Cloudflare 429s scripted write bursts). SELF-TUNING: start with a
  // gap, and on each 429 grow the gap (and honor Retry-After) so the run settles under the real limit. After
  // too many 429s in a row, ABORT cleanly so we stop poking an active cooldown (wait a few min, then re-run).
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let GS_GAP = Number(window.__GS_GAP) || 1500; // ms between goodshuffle requests (override via window.__GS_GAP)
  let _lastGs = 0, _consec429 = 0;
  // The app's own XHR sends these on every /app/ call. Accept-version in particular makes the server validate
  // the request against the SAME schema the app uses — WITHOUT it, saveRegularItem 400s no matter the body.
  const GS_HEADERS = { "Accept-version": "v3.2", "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/plain, */*" };
  async function gsFetch(path, init, tries = 8) {
    init = init || {};
    init.headers = Object.assign({}, GS_HEADERS, init.headers || {});
    const gap = GS_GAP - (Date.now() - _lastGs);
    if (gap > 0) await sleep(gap);
    _lastGs = Date.now();
    const r = await fetch(path, init);
    if (r.status === 429) {
      if (++_consec429 >= 12) throw new Error("RATE_LIMIT_ABORT");
      GS_GAP = Math.min(Math.round(GS_GAP * 1.6), 20000); // self-slow
      const ra = Number(r.headers.get("retry-after"));
      await sleep(ra > 0 ? ra * 1000 : GS_GAP);
      if (tries > 0) return gsFetch(path, init, tries - 1);
    } else { _consec429 = 0; }
    return r;
  }
  async function post(path, obj) {
    const r = await gsFetch(path, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(obj) });
    if (!r.ok) throw new Error("POST " + path + " -> HTTP " + r.status);
    return r.json();
  }
  async function pull(token, groups) {
    const url = DATA(token) + "?categories=furniture-rentals&groups=" + encodeURIComponent(groups) + "&size=200";
    return (await (await fetch(url)).json()).items || [];
  }

  const CF = (w, h, u) => `https://pro.goodshuffle.com/cdn-cgi/image/width=${w},height=${h},quality=85,fit=pad,background=white,format=auto/${u}`;
  // Upload one source image. Returns BOTH entries the save needs: an `images` entry AND a `temporaryImages`
  // entry. temporaryImages (with croppedNoPaddingPath) is what makes the server relocate the tmp upload and
  // ACTUALLY attach the photo — without it the save 200s but the photo is silently dropped.
  async function uploadImage(src, viewOrder) {
    const fileName = src.fileName || ("image-" + viewOrder + ".jpg");
    const srcUrl = src.rawImagePath || src.imagePath || src.croppedNoPaddingPath;
    if (!srcUrl) return null;
    const blob = await (await fetch(srcUrl)).blob();
    const { w, h } = await dims(blob);
    const pres = await (await gsFetch("/app/image/getPresignedUploadURL?fileName=" + encodeURIComponent(fileName), { credentials: "include" })).json();
    const put = await fetch(pres.presignedUrl, { method: "PUT", body: blob, headers: { "Content-Type": ctForName(fileName), "x-amz-acl": "public-read" } }); // S3 (not rate-limited)
    if (!put.ok) throw new Error("image PUT HTTP " + put.status);
    const u = pres.s3Url;
    return {
      image: { id: null, cloudflareUrl: CF(760, 428, u), cloudflareThumbUrl: CF(280, 158, u), s3Path: pres.s3Path, originalS3Path: u, caption: "", viewOrder, fileName, isAnimatedGIF: false, rawWidth: w, rawHeight: h },
      temp: { id: null, originalS3Path: u, s3Path: pres.s3Path, cloudflareUrl: CF(760, 428, u), cloudflareThumbUrl: CF(280, 158, u), croppedNoPaddingPath: u, caption: "", isAnimatedGIF: false, viewOrder, rawWidth: w, rawHeight: h },
    };
  }

  // The verified MINIMAL create body, byte-matched to a real 200 create. UNTRACKED = quantityTracked:false
  // and NO quantityPosted key at all (sending quantityPosted:null is what the server 400'd on). No id, no
  // uuid, no rootGroup - the server assigns those.
  const createBody = (item, T) => ({
    attributes: [], selected: false, title: item.title,
    primaryCategoryID: T.primaryCategoryID, primaryCategoryName: T.primaryCategoryName,
    quantityTracked: false,
    marketplace_visible: true, website_wishlist_visible: true, useContractDescriptionForWeb: true,
    pricingMap: UNPRICED, inventoryType: { name: "PRODUCT" }, originalInventoryType: "PRODUCT",
    poolMembers: [], packageContents: [], associatedServices: [], accessoryItems: [], alternateItems: [],
    parentItems: [], parentPackages: [], images: [], applied_tax_types: TAX,
  });

  // ---- Tax types (live, so the exact object incl. taxRates is correct) --------
  try {
    const tt = await (await gsFetch("/app/taxType/list", { credentials: "include" })).json();
    const all = Array.isArray(tt) ? tt : (tt.taxTypes || tt.data || []);
    // The ones GSPRO auto-applies to products. CRITICAL: the app's own create tags each applied tax with
    // `selected:true` + `translatedAutoAppliedString`; /app/taxType/list omits them and the create 400s
    // without them — so add them to match exactly.
    TAX = all.filter((t) => t && t.autoAppliedToProducts).map((t) => ({ ...t, selected: true, translatedAutoAppliedString: t.translatedAutoAppliedString ?? t.autoAppliedString ?? "" }));
    log(`tax types: ${TAX.map((t) => t.name).join(", ") || "(none auto-applied)"}`);
  } catch (e) { log("could not load tax types; proceeding with none", e.message || e); }

  // ---- Plan -------------------------------------------------------------------
  const existing = new Set();
  for (const key of ["sofas", "stools"]) for (const it of await pull(ZOE, TARGETS[key].zoeDedupeGroup)) existing.add(norm(it.title));
  const plan = [];
  for (const key of ["sofas", "stools"]) {
    const T = TARGETS[key];
    for (const it of await pull(STAGING, T.srcGroups)) {
      if (existing.has(norm(it.title))) { log("skip (already have):", it.title); continue; }
      plan.push({ item: it, T });
    }
  }
  log(`PLAN: ${plan.length} to create (${plan.filter(p => p.T.baseTag === "Sofa").length} sofas, ${plan.filter(p => p.T.baseTag === "Barstool").length} barstools).`);
  console.table(plan.map(p => ({ title: p.item.title, category: p.T.primaryCategoryName, photos: (p.item.images || []).length, tags: tagsFor(p.item.tags, p.T.baseTag) })));
  if (DRY_RUN) { log("DRY_RUN is on - nothing created. Set DRY_RUN = false and run again."); return; }
  const run = LIMIT > 0 ? plan.slice(0, LIMIT) : plan;
  if (!confirm(`Create ${run.length} item(s) (unpriced, untracked, listed on website) in your Goodshuffle inventory?`)) { log("cancelled."); return; }

  // ---- Execute: create (minimal) -> upload photos -> update with content ------
  let ok = 0, fail = 0;
  for (let i = 0; i < run.length; i++) {
    const { item, T } = run[i];
    try {
      const created = (await post("/app/inventory/saveRegularItem", createBody(item, T))).inventoryItem;
      const imgs = [];
      const srcImgs = (item.images || []).slice().sort((a, b) => (a.viewOrder || 0) - (b.viewOrder || 0));
      for (let k = 0; k < srcImgs.length; k++) { try { const e = await uploadImage(srcImgs[k], k); if (e) imgs.push(e); } catch (ie) { console.warn("  photo failed:", item.title, ie.message); } }
      const descHtml = item.description || "";
      const upd = Object.assign({}, created, {
        contract_description: descHtml || null, web_description: descHtml || null, useContractDescriptionForWeb: false,
        internal_notes: "Subrent from Staging Design DC.", tags: tagsFor(item.tags, T.baseTag),
        images: imgs.map((e) => e.image), temporaryImages: imgs.map((e) => e.temp), // temporaryImages = the attach trigger
        marketplace_visible: true, website_wishlist_visible: true, quantityTracked: false, pricingMap: UNPRICED,
      });
      delete upd.quantityPosted; delete upd.quantitySetAside; // untracked: these keys must be absent, not null
      await post("/app/inventory/saveRegularItem", upd);
      ok++; log(`(${i + 1}/${run.length}) created: ${item.title}  [${imgs.length} photos]`);
    } catch (e) {
      if ((e.message || "") === "RATE_LIMIT_ABORT") {
        console.warn(`%cStopped: the write endpoint is rate-limited (cooldown still active). Created ${ok} so far. Wait ~10-15 min with NO attempts, then re-run - it skips the ${ok} already made.`, "color:#c33");
        break;
      }
      fail++; console.warn(`(${i + 1}/${run.length}) FAILED: ${item.title}`, e.message || e);
    }
  }
  log(`DONE. Created ${ok}, failed ${fail}. Reload inventory to see them; they appear on the website on the next storefront refresh.`);
})();
