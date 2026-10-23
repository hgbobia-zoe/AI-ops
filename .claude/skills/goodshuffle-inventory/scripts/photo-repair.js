/* ===========================================================================
   Zoe <- Staging Design : PHOTO REPAIR
   The 37 imported items were created correctly (category, tags, description,
   on the website) but their photos didn't ATTACH — the save needed extra
   image-URL fields. This attaches the Staging photos to those items IN PLACE
   (no re-creating). Run in the DevTools Console of a logged-in
   pro.goodshuffle.com tab.

   SAFE: DRY_RUN=true only previews. Set DRY_RUN=false to attach.
   Idempotent: it skips any item that already has a photo, so it only touches
   the photoless imports and is safe to re-run.
   =========================================================================== */
(async () => {
  const DRY_RUN = true;   // <-- set false to actually attach photos
  const LIMIT   = 1;      // <-- 1 = repair just the FIRST photoless item as a test; 0 = all

  const STAGING = "fuEHaRKBUIx6FjSFoniRdvWRBi6ESA";
  const DATA = (t) => `https://data.goodshuffle.com/vendor/${t}/inventory`;
  const GROUPS = ["sofa-rentals settee-rentals", "stools-rentals"];

  const H = { "Accept-version": "v3.2", "X-Requested-With": "XMLHttpRequest", "Accept": "application/json, text/plain, */*" };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let GAP = Number(window.__GS_GAP) || 1500, _last = 0, _c429 = 0;
  async function gs(path, init, tries = 8) {
    init = init || {}; init.headers = Object.assign({}, H, init.headers || {});
    const w = GAP - (Date.now() - _last); if (w > 0) await sleep(w); _last = Date.now();
    const r = await fetch(path, init);
    if (r.status === 429) { if (++_c429 >= 12) throw new Error("RATE_LIMIT_ABORT"); GAP = Math.min(Math.round(GAP * 1.6), 20000); const ra = Number(r.headers.get("retry-after")); await sleep(ra > 0 ? ra * 1000 : GAP); if (tries > 0) return gs(path, init, tries - 1); } else _c429 = 0;
    return r;
  }
  const log = (...a) => console.log("%c[photo-repair]", "color:#2a7", ...a);

  const UNPRICED = { flatFeesByGeo: [], rateType: "UNPRICED", unpriced: true, flatFee: null, dailyPriceVisibleOnECommerce: true, hourlyPriceVisibleOnECommerce: true, flatFeePriceVisibleOnECommerce: true, purchasePriceVisibleOnECommerce: true };
  let TAX = [];
  const norm = (s) => (s || "").trim().toLowerCase().replace(/\s+/g, " ");
  const ctForName = (n) => { const e = (n.split(".").pop() || "").toLowerCase(); return e === "png" ? "image/png" : e === "webp" ? "image/webp" : e === "gif" ? "image/gif" : e === "heic" ? "image/heic" : "image/jpeg"; };
  const dims = async (b) => { try { const im = await createImageBitmap(b); const d = { w: im.width, h: im.height }; im.close && im.close(); return d; } catch { return { w: null, h: null }; } };
  const CF = (w, h, u) => `https://pro.goodshuffle.com/cdn-cgi/image/width=${w},height=${h},quality=85,fit=pad,background=white,format=auto/${u}`;
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const dateStr = (d) => `${MON[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;

  const pull = async (token, groups) => (await (await fetch(DATA(token) + "?categories=furniture-rentals&groups=" + encodeURIComponent(groups) + "&size=200")).json()).items || [];

  // POST search (the app's real endpoint) -> the Zoe item for an exact title (incl. internal numeric id).
  async function findZoe(title) {
    const body = { countOnly: false, searchMode: "QUERY", inventoryTypes: ["PRODUCT"], categoryIDs: [], tags: [], taxTypes: [], searchText: title, availabilityFromDate: dateStr(new Date()), availabilityToDate: dateStr(new Date(Date.now() + 30 * 864e5)) };
    const r = await gs("/app/inventory/searchInventoryItems", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) return null;
    const items = (await r.json()).items || [];
    return items.find((it) => norm(it.title) === norm(title)) || null;
  }

  // Upload one source image and return BOTH entries the app sends: an `images` entry AND a `temporaryImages`
  // entry. The temporaryImages entry (with croppedNoPaddingPath) is what tells the server to relocate the
  // freshly-uploaded tmp file and actually attach it — WITHOUT it the photo is silently dropped.
  async function uploadImage(src, viewOrder) {
    const fileName = src.fileName || ("image-" + viewOrder + ".jpg");
    const srcUrl = src.rawImagePath || src.imagePath || src.croppedNoPaddingPath; if (!srcUrl) return null;
    const blob = await (await fetch(srcUrl)).blob(); const { w, h } = await dims(blob);
    const pres = await (await gs("/app/image/getPresignedUploadURL?fileName=" + encodeURIComponent(fileName), { credentials: "include" })).json();
    const put = await fetch(pres.presignedUrl, { method: "PUT", body: blob, headers: { "Content-Type": ctForName(fileName), "x-amz-acl": "public-read" } });
    if (!put.ok) throw new Error("image PUT HTTP " + put.status);
    const u = pres.s3Url;
    return {
      image: { id: null, cloudflareUrl: CF(760, 428, u), cloudflareThumbUrl: CF(280, 158, u), s3Path: pres.s3Path, originalS3Path: u, caption: "", viewOrder, fileName, isAnimatedGIF: false, rawWidth: w, rawHeight: h },
      temp: { id: null, originalS3Path: u, s3Path: pres.s3Path, cloudflareUrl: CF(760, 428, u), cloudflareThumbUrl: CF(280, 158, u), croppedNoPaddingPath: u, caption: "", isAnimatedGIF: false, viewOrder, rawWidth: w, rawHeight: h },
    };
  }

  function updateBody(zoe, src, entries) {
    const desc = src.description || "";
    const baseTag = /stool/i.test(zoe.primaryCategoryName || "") ? "Barstool" : "Sofa";
    const tags = [baseTag].concat((src.tags || []).filter((t) => !/^(group |event\s*rental)/i.test(t)).map((t) => (/^bar\s*stool$/i.test(t) ? "Barstool" : t)));
    return {
      attributes: [], selected: false, id: zoe.id, uuid: zoe.uuid, title: zoe.title,
      primaryCategoryID: zoe.primaryCategoryID, primaryCategoryName: zoe.primaryCategoryName,
      rootGroupID: zoe.rootGroupID, rootGroupName: zoe.rootGroupName,
      contract_description: desc || null, web_description: desc || null, useContractDescriptionForWeb: false,
      internal_notes: "Subrent from Staging Design DC.", tags: [...new Set(tags)].join(","),
      marketplace_visible: true, website_wishlist_visible: true, quantityTracked: false,
      pricingMap: UNPRICED, inventoryType: { name: "PRODUCT" }, originalInventoryType: "PRODUCT",
      poolMembers: [], packageContents: [], associatedServices: [], accessoryItems: [], alternateItems: [],
      parentItems: [], parentPackages: [],
      images: entries.map((e) => e.image), temporaryImages: entries.map((e) => e.temp), // temporaryImages = the attach trigger
      applied_tax_types: TAX,
    };
  }

  // ---- tax (live, with the selected:true the create requires) -----------------
  try { const tt = await (await gs("/app/taxType/list", { credentials: "include" })).json(); TAX = ((tt.taxTypes) || []).filter((t) => t && t.autoAppliedToProducts).map((t) => Object.assign({}, t, { selected: true, translatedAutoAppliedString: t.translatedAutoAppliedString || t.autoAppliedString || "" })); } catch (e) { log("tax load failed", e.message || e); }

  // ---- gather Staging items ---------------------------------------------------
  let src = []; for (const g of GROUPS) src = src.concat(await pull(STAGING, g));
  log(`${src.length} Staging items to check against your inventory.`);

  let repaired = 0, skipped = 0, notfound = 0, fail = 0, previewed = 0;
  const run = LIMIT > 0 ? src.slice(0, src.length) : src; // we filter to photoless below; LIMIT caps actual writes
  let writes = 0;
  for (const it of run) {
    try {
      const zoe = await findZoe(it.title);
      if (!zoe) { notfound++; log("not in your inventory (skip):", it.title); continue; }
      if (zoe.thumbImagePath) { skipped++; continue; } // already has a photo
      const srcImgs = (it.images || []).slice().sort((a, b) => (a.viewOrder || 0) - (b.viewOrder || 0));
      if (DRY_RUN) { previewed++; log(`[dry] would attach ${srcImgs.length} photos -> ${it.title} (id ${zoe.id})`); continue; }
      if (LIMIT > 0 && writes >= LIMIT) { log(`LIMIT ${LIMIT} reached — stopping. Set LIMIT=0 to do the rest.`); break; }
      const imgs = []; for (let k = 0; k < srcImgs.length; k++) { try { const e = await uploadImage(srcImgs[k], k); if (e) imgs.push(e); } catch (ie) { console.warn("  photo failed:", it.title, ie.message); } }
      if (!imgs.length) { fail++; console.warn("no photos uploaded for:", it.title); continue; }
      const r = await gs("/app/inventory/saveRegularItem", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updateBody(zoe, it, imgs)) });
      if (!r.ok) throw new Error("save HTTP " + r.status);
      repaired++; writes++; log(`attached ${imgs.length} photos: ${it.title}`);
    } catch (e) {
      if ((e.message || "") === "RATE_LIMIT_ABORT") { console.warn("Rate-limited. Wait a few min and re-run (it skips items already repaired)."); break; }
      fail++; console.warn("FAILED:", it.title, e.message || e);
    }
  }
  log(`DONE. ${DRY_RUN ? "(dry run) would repair " + previewed : "repaired " + repaired}, skipped(has photo) ${skipped}, not found ${notfound}, failed ${fail}.`);
})();
