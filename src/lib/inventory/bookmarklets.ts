// Bookmarklet builder for the Inventory Automation WRITE path.
//
// WHY A BOOKMARKLET: Goodshuffle Pro has no public write API and Cloudflare blocks server-side calls, so
// every write must run from a logged-in pro.goodshuffle.com browser tab (same-origin fetch, credentials
// included). A direct mutating fetch from automation is blocked by a security classifier; the importer is
// run BY THE OPERATOR in their own GSPRO tab, so it executes as the user — the intended, unaffected path.
//
// GROUND TRUTH: the payloads below were iterated LIVE against Goodshuffle until every call returned 200
// (reference importer, scratchpad gspro-importer.js). The verified contract, baked in here:
//   • Create is a MINIMAL body: NO id, NO uuid, NO rootGroup (the server derives the root group — Furniture
//     — from the category). For an UNTRACKED item it sets quantityTracked:false and OMITS quantityPosted
//     ENTIRELY (sending quantityPosted:null is what returns HTTP 400).
//   • Two-step per item: POST /app/inventory/saveRegularItem (create) → the response is
//     {inventoryItem:{…full item incl. id,uuid,rootGroup}} → upload images → POST saveRegularItem AGAIN with
//     Object.assign({}, created, {contract_description, web_description, useContractDescriptionForWeb:false,
//     internal_notes, tags, images}) and then delete quantityPosted / quantitySetAside (untracked).
//   • pricingMap is the MINIMAL unpriced map captured from a 200 (see UNPRICED_PRICING_MAP).
//   • applied_tax_types is fetched LIVE at run time from GET /app/taxType/list (filter
//     autoAppliedToProducts) — it has a nested taxRates[] so it must never be hardcoded.
//   • Images: GET /app/image/getPresignedUploadURL?fileName=… → {presignedUrl,s3Path,s3Url}; fetch the
//     source blob; PUT it to presignedUrl with headers {Content-Type:<mime by extension>,
//     x-amz-acl:"public-read"} (the x-amz-acl header is REQUIRED or S3 returns 403); then an images[] entry.
//   • Rate limits: pro.goodshuffle.com (Cloudflare) 429s scripted bursts, so every GSPRO request is paced
//     through a self-tuning throttle (start ~1500ms, grow the gap on each 429, honor Retry-After, abort
//     cleanly after ~12 consecutive 429s). Image PUTs go to S3 and are not throttled.
//   • tags is a COMMA-SEPARATED STRING: a base tag per group, "Bar stool"→"Barstool", dropping the
//     partner's Staging-internal grouping tags (/^(group |event rental)/i).
//
// The resolved per-group categories come from the partner preset (src/lib/inventory/partners.ts), so a
// known partner needs NO capture step at all — the operator just previews a plan and generates the importer.
//
// TODO (fast-follow, OUT of scope): stage item_create / item_image_upload ops on the gs_outbox
// (src/lib/gsPull.ts drainer) so the office Auto-Pull runs the plan hands-off.

import type { PlannedItem } from "./importPlan";

/** The resolved Goodshuffle category for one target group. Baked into the preset — no capture needed. */
export interface GroupCategory {
  primaryCategoryID: number; //  Goodshuffle category id (server derives the root group from this)
  primaryCategoryName: string; //Goodshuffle category name
  baseTag: string; //            base tag every copied item of this group carries ("Sofa" / "Barstool")
}

/**
 * An entry in a saved item's `images[]` (after the Blob has been PUT to its presigned S3 URL). This is the
 * VERIFIED shape (gspro-importer.js / gspro-photo-repair.js): it carries the Cloudflare image URLs derived
 * from the presign `s3Url`, plus `originalS3Path`. Sending this ALONE is NOT enough to attach a freshly
 * uploaded photo — Goodshuffle only relocates the tmp S3 upload when the SAME image is ALSO sent in the
 * `temporaryImages[]` array (see TemporaryImageEntry). Without it the save 200s but the photo is dropped.
 */
export interface ItemImageEntry {
  id: null;
  cloudflareUrl: string; //      cdn-cgi/image 760x428 derivation of s3Url
  cloudflareThumbUrl: string; // cdn-cgi/image 280x158 derivation of s3Url
  s3Path: string; //             the presign s3Path (the final storage key)
  originalS3Path: string; //     the presign s3Url (the uploaded tmp object URL)
  caption: string;
  viewOrder: number;
  fileName: string;
  isAnimatedGIF: boolean;
  rawWidth: number | null;
  rawHeight: number | null;
}

/**
 * The matching `temporaryImages[]` entry for a freshly uploaded photo — THE attach trigger. Same as
 * ItemImageEntry minus `fileName`, PLUS `croppedNoPaddingPath` (= s3Url). Goodshuffle uses this array to
 * relocate the tmp upload and actually attach it to the item; omitting it silently drops the photo.
 */
export interface TemporaryImageEntry {
  id: null;
  originalS3Path: string;
  s3Path: string;
  cloudflareUrl: string;
  cloudflareThumbUrl: string;
  croppedNoPaddingPath: string; // = s3Url
  caption: string;
  isAnimatedGIF: boolean;
  viewOrder: number;
  rawWidth: number | null;
  rawHeight: number | null;
}

/** Both entries one uploaded photo produces: the `images[]` entry AND the `temporaryImages[]` trigger. */
export interface ImageEntryPair {
  image: ItemImageEntry;
  temporaryImage: TemporaryImageEntry;
}

export interface ImporterConfig {
  plan: PlannedItem[];
  categories: Record<string, GroupCategory>; // keyed by zoeGroup; every group used by the plan must be present
  zoeToken: string; //                         Zoe's public storefront token, for the run-time idempotency re-check
  internalNotes: string; //                    internal note stamped on every copied item (provenance)
}

// The EXACT minimal unpriced pricingMap the app sends on create (captured from a real 200). Exported so the
// unit tests pin the shape; injected verbatim into the importer so there is one source of truth. It is
// referenced ONLY from the hand-written runtime string (never from inside a serialized builder), so the
// bundler can never rename the reference out from under the injected `var`.
export const UNPRICED_PRICING_MAP = {
  flatFeesByGeo: [] as unknown[],
  rateType: "UNPRICED",
  unpriced: true,
  flatFee: null,
  dailyPriceVisibleOnECommerce: true,
  hourlyPriceVisibleOnECommerce: true,
  flatFeePriceVisibleOnECommerce: true,
  purchasePriceVisibleOnECommerce: true,
};

// ── Pure builders (unit-tested, and serialized verbatim into the importer so there is one source of truth) ──
//
// Each is SELF-CONTAINED: it references no module-level identifier and calls no other builder, so
// Function.toString() yields runnable JS even after the production bundler minifies this module. External
// data (tax types, the pricing map, the computed tags CSV) is passed IN as arguments by the runtime.

/**
 * Build the MINIMAL `saveRegularItem` CREATE body for one planned item. PURE. No id, no uuid, no rootGroup
 * (the server derives the root group from the category). UNTRACKED: quantityTracked:false and NO
 * quantityPosted key at all. `taxTypes` is the live, auto-applied tax-type list; `pricingMap` is the
 * verified unpriced map. `images` is empty on create — photos are attached on the second (update) save.
 */
export function buildCreateBody(
  item: PlannedItem,
  cat: GroupCategory,
  taxTypes: unknown[],
  pricingMap: Record<string, unknown>,
): Record<string, unknown> {
  return {
    attributes: [],
    selected: false,
    title: item.title,
    primaryCategoryID: cat.primaryCategoryID,
    primaryCategoryName: cat.primaryCategoryName,
    quantityTracked: false, //                 UNTRACKED — and note: NO quantityPosted key (null 400s)
    marketplace_visible: true, //              list on Goodshuffle.com Marketplace
    website_wishlist_visible: true, //         surface on zoeeventsdmv.com (Website Integration)
    useContractDescriptionForWeb: true, //     create blank; the update save sets the real web copy
    pricingMap: pricingMap,
    inventoryType: { name: "PRODUCT" },
    originalInventoryType: "PRODUCT",
    poolMembers: [],
    packageContents: [],
    associatedServices: [],
    accessoryItems: [],
    alternateItems: [],
    parentItems: [],
    parentPackages: [],
    images: [],
    applied_tax_types: Array.isArray(taxTypes) ? taxTypes : [],
  };
}

/**
 * Build the second-step UPDATE body: the server's created item with the real content merged on. PURE.
 * Starts from `created` (which carries the real id, uuid and rootGroup the server assigned), sets the
 * website copy + tags + photos, re-asserts untracked/unpriced, and DELETES quantityPosted / quantitySetAside
 * (for an untracked item those keys must be ABSENT, not null). `tagsCsv` is the pre-computed comma string.
 * `entries` are the uploaded-photo pairs: every one is sent in BOTH `images` AND `temporaryImages` — the
 * latter is the trigger that makes Goodshuffle actually attach the freshly uploaded photo (without it the
 * save 200s but the photo is silently dropped).
 */
export function buildUpdateBody(
  created: Record<string, unknown>,
  item: PlannedItem,
  entries: ImageEntryPair[],
  tagsCsv: string,
  internalNotes: string,
  pricingMap: Record<string, unknown>,
): Record<string, unknown> {
  const desc = item.descriptionHtml || null;
  const pairs = Array.isArray(entries) ? entries : [];
  const body = Object.assign({}, created, {
    contract_description: desc,
    web_description: desc, //                  show the Staging HTML as the website copy…
    useContractDescriptionForWeb: false, //    …rather than reusing the contract description
    internal_notes: internalNotes || null,
    tags: tagsCsv, //                           COMMA-SEPARATED STRING, not an array
    images: pairs.map((e) => e.image),
    temporaryImages: pairs.map((e) => e.temporaryImage), // temporaryImages = the attach trigger
    marketplace_visible: true,
    website_wishlist_visible: true,
    quantityTracked: false,
    pricingMap: pricingMap,
  });
  delete body.quantityPosted; //               untracked: these keys must be absent, not null
  delete body.quantitySetAside;
  return body;
}

/**
 * Build the COMMA-SEPARATED tag string for a copied item. PURE and self-contained. Always starts with the
 * group's base tag; normalizes "Bar stool" → "Barstool"; DROPS the partner's Staging-internal grouping tags
 * (/^(group |event rental)/i); de-dupes case-insensitively, preserving first-seen casing.
 */
export function buildTags(tags: string[], baseTag: string): string {
  const drop = /^(group\s|event\s*rental)/i;
  const out: string[] = [baseTag];
  const seen: Record<string, boolean> = {};
  seen[String(baseTag).toLowerCase()] = true;
  const list = Array.isArray(tags) ? tags : [];
  for (let i = 0; i < list.length; i++) {
    const v = String(list[i] == null ? "" : list[i]).trim();
    if (!v || drop.test(v)) continue;
    const normed = /^bar\s*stool$/i.test(v) ? "Barstool" : v;
    const k = normed.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(normed);
  }
  return out.join(",");
}

/**
 * Build BOTH entries for one copied image after its Blob has been PUT to S3 — the `images[]` entry AND the
 * matching `temporaryImages[]` trigger. PURE and self-contained (serialized into the bookmarklet). All URL
 * fields derive from the presign `s3Url`: originalS3Path == croppedNoPaddingPath == s3Url; the Cloudflare
 * URLs are the cdn-cgi/image 760x428 and 280x158 derivations of s3Url. Sending the image WITHOUT its
 * temporaryImages twin makes the save 200 but silently drops the photo.
 */
export function buildImageEntry(
  s3Path: string,
  s3Url: string,
  fileName: string,
  viewOrder: number,
  rawWidth: number | null,
  rawHeight: number | null,
): ImageEntryPair {
  const cfBase = "https://pro.goodshuffle.com/cdn-cgi/image/";
  const cloudflareUrl = cfBase + "width=760,height=428,quality=85,fit=pad,background=white,format=auto/" + s3Url;
  const cloudflareThumbUrl = cfBase + "width=280,height=158,quality=85,fit=pad,background=white,format=auto/" + s3Url;
  return {
    image: {
      id: null,
      cloudflareUrl: cloudflareUrl,
      cloudflareThumbUrl: cloudflareThumbUrl,
      s3Path: s3Path,
      originalS3Path: s3Url,
      caption: "",
      viewOrder: viewOrder,
      fileName: fileName,
      isAnimatedGIF: false,
      rawWidth: rawWidth,
      rawHeight: rawHeight,
    },
    temporaryImage: {
      id: null,
      originalS3Path: s3Url,
      s3Path: s3Path,
      cloudflareUrl: cloudflareUrl,
      cloudflareThumbUrl: cloudflareThumbUrl,
      croppedNoPaddingPath: s3Url,
      caption: "",
      isAnimatedGIF: false,
      viewOrder: viewOrder,
      rawWidth: rawWidth,
      rawHeight: rawHeight,
    },
  };
}

/**
 * Return the distinct zoeGroups used by the plan that have NO valid resolved category. PURE. The importer
 * (and the blade) fail closed when this is non-empty — an item is never created with a guessed category.
 */
export function findMissingCategories(plan: PlannedItem[], categories: Record<string, GroupCategory>): string[] {
  const seen: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const item of plan) {
    const c = categories[item.zoeGroup];
    const ok = !!c && typeof c.primaryCategoryID === "number" && typeof c.primaryCategoryName === "string";
    if (!ok && !seen[item.zoeGroup]) {
      seen[item.zoeGroup] = true;
      missing.push(item.zoeGroup);
    }
  }
  return missing;
}

// ── The embedded importer runtime ─────────────────────────────────────────────────────────────────────
// Authored as a plain JS string (it runs in the GSPRO tab, not our app). It runs AFTER the injected CFG,
// the injected UNPRICED_PRICING_MAP, and the serialized pure builders are in scope. Every GSPRO endpoint is
// hardcoded. Identifier names here are hand-written string text (never minified), so they match the vars
// that buildImporterBookmarklet injects. Messages stay single-line.
const IMPORTER_RUNTIME_JS = `
  var plan=(CFG&&CFG.plan)||[], categories=(CFG&&CFG.categories)||{}, zoeToken=(CFG&&CFG.zoeToken)||"", internalNotes=(CFG&&CFG.internalNotes)||"";
  function log(){ try{ console.log.apply(console,["[zoe-import]"].concat([].slice.call(arguments))); }catch(e){} }
  function norm(t){ return String(t||"").trim().toLowerCase().replace(/\\s+/g," "); }

  var missing=findMissingCategories(plan, categories);
  if(missing.length){ alert("Cannot import. Missing Goodshuffle category for group(s): "+missing.join(", ")+". This should not happen for a known partner preset."); return; }
  if(!plan.length){ alert("The plan is empty - nothing to import."); return; }
  if(!confirm("Zoe inventory importer. "+plan.length+" item(s) planned. This creates UNPRICED, UNTRACKED, website-visible items in your logged-in Goodshuffle account. Continue?")){ log("cancelled"); return; }
  var dryRun=confirm("Dry run first? OK = simulate only (no writes). Cancel = create for real now.");
  log(dryRun?"DRY RUN (no writes)":"LIVE RUN");

  // Self-tuning throttle for pro.goodshuffle.com (Cloudflare 429s scripted write bursts). Start with a gap,
  // grow it on each 429 (honor Retry-After), and ABORT after too many 429s in a row so we stop poking an
  // active cooldown. Image PUTs go to S3 and skip this (plain fetch).
  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  var GS_GAP=1500, _lastGs=0, _consec429=0;
  function gsFetch(path,init,tries){
    if(tries===undefined) tries=8;
    var wait=GS_GAP-(Date.now()-_lastGs);
    return (wait>0?sleep(wait):Promise.resolve()).then(function(){
      _lastGs=Date.now();
      return fetch(path,init).then(function(r){
        if(r.status===429){
          if(++_consec429>=12) throw new Error("RATE_LIMIT_ABORT");
          GS_GAP=Math.min(Math.round(GS_GAP*1.6),20000);
          var ra=Number(r.headers.get("retry-after"));
          return sleep(ra>0?ra*1000:GS_GAP).then(function(){ return tries>0?gsFetch(path,init,tries-1):r; });
        }
        _consec429=0; return r;
      });
    });
  }
  function gsPost(path,obj){
    return gsFetch(path,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify(obj)})
      .then(function(r){ if(!r.ok) throw new Error("POST "+path+" -> HTTP "+r.status); return r.json(); });
  }

  // Live tax types: the exact objects (incl. nested taxRates[]) the account auto-applies to products. The
  // app's OWN create tags each applied tax with selected:true + translatedAutoAppliedString, but
  // /app/taxType/list omits both — and the create 400s without selected — so we add them back (verified
  // against a real 200 create).
  function loadTax(){
    return gsFetch("/app/taxType/list",{credentials:"include"}).then(function(r){ return r.json(); }).then(function(tt){
      var all=Array.isArray(tt)?tt:((tt&&tt.taxTypes)||(tt&&tt.data)||[]);
      var tax=all.filter(function(t){ return t&&t.autoAppliedToProducts; })
        .map(function(t){ return Object.assign({}, t, { selected: true, translatedAutoAppliedString: t.translatedAutoAppliedString || t.autoAppliedString || "" }); });
      log("tax types: "+(tax.map(function(t){return t.name;}).join(", ")||"(none auto-applied)"));
      return tax;
    }).catch(function(e){ log("could not load tax types; proceeding with none",String(e)); return []; });
  }

  function ctForName(n){ var e=String(n||"").split(".").pop().toLowerCase(); return e==="png"?"image/png":e==="webp"?"image/webp":e==="gif"?"image/gif":e==="heic"?"image/heic":"image/jpeg"; }
  function fileNameFromUrl(u,i){ try{ var p=(new URL(u,location.href)).pathname.split("/").pop(); p=decodeURIComponent(p||""); if(p&&/\\.(jpe?g|png|gif|webp|heic)$/i.test(p)) return p; }catch(e){} return "image-"+(i+1)+".jpg"; }
  function imageDims(blob){
    function dom(){ return new Promise(function(res){ try{ var u=URL.createObjectURL(blob); var im=new Image(); im.onload=function(){ res({w:im.naturalWidth,h:im.naturalHeight}); URL.revokeObjectURL(u); }; im.onerror=function(){ res({w:null,h:null}); URL.revokeObjectURL(u); }; im.src=u; }catch(e){ res({w:null,h:null}); } }); }
    if(typeof createImageBitmap!=="undefined"){ return createImageBitmap(blob).then(function(b){ var d={w:b.width,h:b.height}; if(b.close)b.close(); return d; }).catch(dom); }
    return dom();
  }
  // 3-step image copy: presign (throttled) -> fetch source Blob -> PUT to S3 (x-amz-acl REQUIRED) -> entry
  // PAIR (images[] + temporaryImages[]). The presign s3Url is what every attach-URL field derives from.
  function uploadImage(url,i){
    var fileName=fileNameFromUrl(url,i);
    return gsFetch("/app/image/getPresignedUploadURL?fileName="+encodeURIComponent(fileName),{credentials:"include"})
      .then(function(r){ if(!r.ok) throw new Error("presign "+r.status); return r.json(); })
      .then(function(pres){
        return fetch(url).then(function(r){ if(!r.ok) throw new Error("source "+r.status); return r.blob(); })
          .then(function(blob){ return imageDims(blob).then(function(d){
            return fetch(pres.presignedUrl,{method:"PUT",body:blob,headers:{"Content-Type":ctForName(fileName),"x-amz-acl":"public-read"}})
              .then(function(pr){ if(!pr.ok) throw new Error("s3 PUT "+pr.status); return buildImageEntry(pres.s3Path, pres.s3Url, fileName, i, d.w, d.h); });
          }); });
      });
  }

  // Two-step create: minimal create -> upload photos -> update with content.
  function createOne(item,tax){
    var cat=categories[item.zoeGroup];
    log("CREATE", item.title, "-> "+cat.primaryCategoryName+" (#"+cat.primaryCategoryID+")", "images:"+(item.imageUrls||[]).length);
    if(dryRun){ log("  [dry run] create body:", JSON.stringify(buildCreateBody(item, cat, tax, UNPRICED_PRICING_MAP))); return Promise.resolve(null); }
    return gsPost("/app/inventory/saveRegularItem", buildCreateBody(item, cat, tax, UNPRICED_PRICING_MAP)).then(function(res){
      var created=res&&res.inventoryItem;
      if(!created) throw new Error("create response had no inventoryItem");
      var entries=[];
      var srcImgs=item.imageUrls||[];
      return srcImgs.reduce(function(chain,url,i){ return chain.then(function(){
        return uploadImage(url,i).then(function(e){ entries.push(e); log("  image uploaded:", e.image.fileName); }).catch(function(err){ log("  image FAILED (skipped):", url, String(err)); });
      }); }, Promise.resolve()).then(function(){
        var tagsCsv=buildTags(item.tags, cat.baseTag);
        return gsPost("/app/inventory/saveRegularItem", buildUpdateBody(created, item, entries, tagsCsv, internalNotes, UNPRICED_PRICING_MAP))
          .then(function(){ log("  created id:", created.id, "["+entries.length+" photos]"); return created.id; });
      });
    });
  }

  function existingTitles(){
    return fetch("https://data.goodshuffle.com/vendor/"+encodeURIComponent(zoeToken)+"/inventory?size=500",{cache:"no-store"})
      .then(function(r){ return r.json(); })
      .then(function(j){ var s={}; ((j&&j.items)||[]).forEach(function(it){ if(it&&it.title) s[norm(it.title)]=1; }); log("re-checked Zoe catalog: "+Object.keys(s).length+" existing titles"); return s; })
      .catch(function(e){ log("could not re-fetch Zoe catalog ("+e+"); using in-run dedup only"); return null; });
  }

  Promise.all([loadTax(), existingTitles()]).then(function(r){
    var tax=r[0], have=r[1];
    var created=0, skipped=0, failed=0, seen={}, aborted=false;
    return plan.reduce(function(chain,item){ return chain.then(function(){
      if(aborted) return;
      var n=norm(item.title);
      if((have&&have[n])||seen[n]){ skipped++; log("SKIP (exists):", item.title); return; }
      seen[n]=1;
      return createOne(item,tax).then(function(){ created++; }).catch(function(err){
        if(String((err&&err.message)||err)==="RATE_LIMIT_ABORT"){ aborted=true; log("Stopped: the write endpoint is rate-limited (cooldown active). Created "+created+" so far. Wait ~10-15 min with NO attempts, then re-run - it skips the ones already made."); return; }
        failed++; log("CREATE FAILED:", item.title, String(err));
      });
    }); }, Promise.resolve()).then(function(){
      var msg="Done. "+(dryRun?"[dry run] would create ":"created ")+created+", skipped "+skipped+(failed?(", failed "+failed):"")+(aborted?" (ABORTED on rate limit - wait, then re-run to continue)":"")+".";
      log(msg); alert(msg);
    });
  });`;

/**
 * The importer bookmarklet — a self-contained `javascript:` string built against the KNOWN endpoints and the
 * VERIFIED payloads. The confirmed plan + the resolved per-group categories are embedded as JSON; the pure
 * builders and the unpriced pricing map are serialized in verbatim (one source of truth with the unit
 * tests). It confirm-gates, offers a dry run, fetches the live tax types, paces every GSPRO request through
 * the 429 throttle, re-checks Zoe's live catalog at run time (skips existing titles), and fails closed if a
 * group's category is missing.
 */
export function buildImporterBookmarklet(cfg: ImporterConfig): string {
  return (
    "javascript:(function(){" +
    "var CFG=" + JSON.stringify(cfg) + ";" +
    "var UNPRICED_PRICING_MAP=" + JSON.stringify(UNPRICED_PRICING_MAP) + ";" +
    "var buildCreateBody=" + buildCreateBody.toString() + ";" +
    "var buildUpdateBody=" + buildUpdateBody.toString() + ";" +
    "var buildTags=" + buildTags.toString() + ";" +
    "var buildImageEntry=" + buildImageEntry.toString() + ";" +
    "var findMissingCategories=" + findMissingCategories.toString() + ";" +
    IMPORTER_RUNTIME_JS +
    "})();void 0"
  );
}

// ══ PHOTO BACKFILL ═══════════════════════════════════════════════════════════════════════════════════════
//
// Attaches a partner's photos to items that ALREADY exist in Zoe's inventory but have NO photo (e.g. items
// created before the temporaryImages attach-trigger fix). Ported verbatim from the live-verified
// scratchpad/gspro-photo-repair.js. It does NOT create items. For each source item it:
//   1) POST /app/inventory/searchInventoryItems (GET 400s — it MUST be a POST) with the verified QUERY body
//      → the Zoe item for an exact (normalized) title, carrying the numeric id/uuid, primaryCategory*,
//        rootGroup* and thumbImagePath.
//   2) IDEMPOTENT skip: a non-null thumbImagePath means the item already has a photo — leave it alone, so the
//      backfill is safe to re-run and only ever touches photoless items.
//   3) Upload the partner's photos (same presign → S3 PUT → images[]+temporaryImages[] pair as the importer)
//      and POST /app/inventory/saveRegularItem with the item rebuilt from the SEARCH result (so the server's
//      category + root group are preserved) plus the photos.

/** One source item the backfill tries to attach photos to (matched to Zoe by title at run time). */
export interface BackfillItem {
  title: string; //           source title (exact-matched, normalized, against Zoe's catalog)
  descriptionHtml: string; // source description HTML (re-stamped as the website copy)
  tags: string[]; //          merged source + job tags (buildTags adds the base tag + normalizes at run time)
  imageUrls: string[]; //     full-resolution source image URLs to copy, primary first
  baseTag: string; //         the mapping's base tag ("Sofa" / "Barstool")
}

export interface BackfillConfig {
  items: BackfillItem[];
  internalNotes: string; //   provenance note stamped on every repaired item
}

/** Format a Date as Goodshuffle's search availability date, e.g. "Jan 1 2026". PURE + self-contained. */
export function gsSearchDate(d: Date): string {
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return MON[d.getMonth()] + " " + d.getDate() + " " + d.getFullYear();
}

/**
 * Build the verified `searchInventoryItems` body. PURE. It is a POST (a GET 400s): QUERY mode over PRODUCTs,
 * no category/tag/tax filters, `searchText` = the title, with an availability window (the app always sends
 * one). The exact-title match is picked from the results by pickZoeMatch.
 */
export function buildSearchBody(
  searchText: string,
  availabilityFromDate: string,
  availabilityToDate: string,
): Record<string, unknown> {
  return {
    countOnly: false,
    searchMode: "QUERY",
    inventoryTypes: ["PRODUCT"],
    categoryIDs: [],
    tags: [],
    taxTypes: [],
    searchText: searchText,
    availabilityFromDate: availabilityFromDate,
    availabilityToDate: availabilityToDate,
  };
}

/** Pick the EXACT (normalized) title match from a searchInventoryItems result, or null. PURE + self-contained. */
export function pickZoeMatch(items: unknown, title: string): Record<string, unknown> | null {
  const want = String(title == null ? "" : title).trim().toLowerCase().replace(/\s+/g, " ");
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i] as Record<string, unknown>;
    if (it && String(it.title == null ? "" : it.title).trim().toLowerCase().replace(/\s+/g, " ") === want) return it;
  }
  return null;
}

/** True when a matched Zoe item has NO photo yet (null/empty thumbImagePath). PURE. The idempotency gate. */
export function needsPhotos(zoe: Record<string, unknown> | null | undefined): boolean {
  return !!zoe && !zoe.thumbImagePath;
}

/**
 * Build the backfill `saveRegularItem` body: the matched Zoe item rebuilt (so its server-assigned id, uuid,
 * category and root group are preserved) with the website copy, tags, photos and tax merged on. PURE. Every
 * uploaded photo is sent in BOTH `images` AND `temporaryImages` (the attach trigger). Untracked + unpriced.
 */
export function buildBackfillBody(
  zoe: Record<string, unknown>,
  item: BackfillItem,
  entries: ImageEntryPair[],
  tagsCsv: string,
  internalNotes: string,
  pricingMap: Record<string, unknown>,
  taxTypes: unknown[],
): Record<string, unknown> {
  const desc = item.descriptionHtml || null;
  const pairs = Array.isArray(entries) ? entries : [];
  return {
    attributes: [],
    selected: false,
    id: zoe.id,
    uuid: zoe.uuid,
    title: zoe.title,
    primaryCategoryID: zoe.primaryCategoryID,
    primaryCategoryName: zoe.primaryCategoryName,
    rootGroupID: zoe.rootGroupID,
    rootGroupName: zoe.rootGroupName,
    contract_description: desc,
    web_description: desc,
    useContractDescriptionForWeb: false,
    internal_notes: internalNotes || null,
    tags: tagsCsv,
    marketplace_visible: true,
    website_wishlist_visible: true,
    quantityTracked: false,
    pricingMap: pricingMap,
    inventoryType: { name: "PRODUCT" },
    originalInventoryType: "PRODUCT",
    poolMembers: [],
    packageContents: [],
    associatedServices: [],
    accessoryItems: [],
    alternateItems: [],
    parentItems: [],
    parentPackages: [],
    images: pairs.map(function (e) {
      return e.image;
    }),
    temporaryImages: pairs.map(function (e) {
      return e.temporaryImage;
    }),
    applied_tax_types: Array.isArray(taxTypes) ? taxTypes : [],
  };
}

// ── The embedded backfill runtime ─────────────────────────────────────────────────────────────────────────
// Same conventions as IMPORTER_RUNTIME_JS: a plain JS string that runs in the GSPRO tab after CFG, the
// unpriced map and the serialized pure builders are in scope. Same self-tuning 429 throttle and image copy.
const BACKFILL_RUNTIME_JS = `
  var items=(CFG&&CFG.items)||[], internalNotes=(CFG&&CFG.internalNotes)||"";
  function log(){ try{ console.log.apply(console,["[zoe-photo-backfill]"].concat([].slice.call(arguments))); }catch(e){} }

  if(!items.length){ alert("Nothing to backfill - the plan has no source items."); return; }
  if(!confirm("Zoe photo backfill. "+items.length+" source item(s) to check. For each one that EXISTS in your Goodshuffle inventory but has NO photo, this uploads the partner's photos and attaches them. It never creates items. Continue?")){ log("cancelled"); return; }
  var dryRun=confirm("Dry run first? OK = simulate only (search + report, no writes). Cancel = attach photos for real now.");
  log(dryRun?"DRY RUN (no writes)":"LIVE RUN");

  function sleep(ms){ return new Promise(function(r){ setTimeout(r,ms); }); }
  var GS_GAP=1500, _lastGs=0, _consec429=0;
  function gsFetch(path,init,tries){
    if(tries===undefined) tries=8;
    var wait=GS_GAP-(Date.now()-_lastGs);
    return (wait>0?sleep(wait):Promise.resolve()).then(function(){
      _lastGs=Date.now();
      return fetch(path,init).then(function(r){
        if(r.status===429){
          if(++_consec429>=12) throw new Error("RATE_LIMIT_ABORT");
          GS_GAP=Math.min(Math.round(GS_GAP*1.6),20000);
          var ra=Number(r.headers.get("retry-after"));
          return sleep(ra>0?ra*1000:GS_GAP).then(function(){ return tries>0?gsFetch(path,init,tries-1):r; });
        }
        _consec429=0; return r;
      });
    });
  }
  function gsPostJson(path,obj){
    return gsFetch(path,{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify(obj)});
  }

  function loadTax(){
    return gsFetch("/app/taxType/list",{credentials:"include"}).then(function(r){ return r.json(); }).then(function(tt){
      var all=Array.isArray(tt)?tt:((tt&&tt.taxTypes)||(tt&&tt.data)||[]);
      var tax=all.filter(function(t){ return t&&t.autoAppliedToProducts; })
        .map(function(t){ return Object.assign({}, t, { selected: true, translatedAutoAppliedString: t.translatedAutoAppliedString || t.autoAppliedString || "" }); });
      log("tax types: "+(tax.map(function(t){return t.name;}).join(", ")||"(none auto-applied)"));
      return tax;
    }).catch(function(e){ log("could not load tax types; proceeding with none",String(e)); return []; });
  }

  function ctForName(n){ var e=String(n||"").split(".").pop().toLowerCase(); return e==="png"?"image/png":e==="webp"?"image/webp":e==="gif"?"image/gif":e==="heic"?"image/heic":"image/jpeg"; }
  function fileNameFromUrl(u,i){ try{ var p=(new URL(u,location.href)).pathname.split("/").pop(); p=decodeURIComponent(p||""); if(p&&/\\.(jpe?g|png|gif|webp|heic)$/i.test(p)) return p; }catch(e){} return "image-"+(i+1)+".jpg"; }
  function imageDims(blob){
    function dom(){ return new Promise(function(res){ try{ var u=URL.createObjectURL(blob); var im=new Image(); im.onload=function(){ res({w:im.naturalWidth,h:im.naturalHeight}); URL.revokeObjectURL(u); }; im.onerror=function(){ res({w:null,h:null}); URL.revokeObjectURL(u); }; im.src=u; }catch(e){ res({w:null,h:null}); } }); }
    if(typeof createImageBitmap!=="undefined"){ return createImageBitmap(blob).then(function(b){ var d={w:b.width,h:b.height}; if(b.close)b.close(); return d; }).catch(dom); }
    return dom();
  }
  function uploadImage(url,i){
    var fileName=fileNameFromUrl(url,i);
    return gsFetch("/app/image/getPresignedUploadURL?fileName="+encodeURIComponent(fileName),{credentials:"include"})
      .then(function(r){ if(!r.ok) throw new Error("presign "+r.status); return r.json(); })
      .then(function(pres){
        return fetch(url).then(function(r){ if(!r.ok) throw new Error("source "+r.status); return r.blob(); })
          .then(function(blob){ return imageDims(blob).then(function(d){
            return fetch(pres.presignedUrl,{method:"PUT",body:blob,headers:{"Content-Type":ctForName(fileName),"x-amz-acl":"public-read"}})
              .then(function(pr){ if(!pr.ok) throw new Error("s3 PUT "+pr.status); return buildImageEntry(pres.s3Path, pres.s3Url, fileName, i, d.w, d.h); });
          }); });
      });
  }

  var now=new Date();
  var fromDate=gsSearchDate(now), toDate=gsSearchDate(new Date(now.getTime()+30*864e5));

  function findZoe(title){
    return gsPostJson("/app/inventory/searchInventoryItems", buildSearchBody(title, fromDate, toDate))
      .then(function(r){ if(!r.ok) return null; return r.json(); })
      .then(function(j){ return j ? pickZoeMatch((j&&j.items)||[], title) : null; });
  }

  function backfillOne(item,tax){
    return findZoe(item.title).then(function(zoe){
      if(!zoe){ log("NOT in your inventory (skip):", item.title); return "notfound"; }
      if(!needsPhotos(zoe)){ log("already has a photo (skip):", item.title); return "hasphoto"; }
      var srcImgs=item.imageUrls||[];
      if(dryRun){ log("  [dry run] would attach "+srcImgs.length+" photos ->", item.title, "(id "+zoe.id+")"); return "would"; }
      var entries=[];
      return srcImgs.reduce(function(chain,url,i){ return chain.then(function(){
        return uploadImage(url,i).then(function(e){ entries.push(e); log("  image uploaded:", e.image.fileName); }).catch(function(err){ log("  image FAILED (skipped):", url, String(err)); });
      }); }, Promise.resolve()).then(function(){
        if(!entries.length){ log("  no photos uploaded (skip):", item.title); return "noimgs"; }
        var tagsCsv=buildTags(item.tags, item.baseTag);
        return gsPostJson("/app/inventory/saveRegularItem", buildBackfillBody(zoe, item, entries, tagsCsv, internalNotes, UNPRICED_PRICING_MAP, tax))
          .then(function(r){ if(!r.ok) throw new Error("save HTTP "+r.status); log("  attached "+entries.length+" photos:", item.title); return "repaired"; });
      });
    });
  }

  loadTax().then(function(tax){
    var repaired=0, skipped=0, notfound=0, would=0, failed=0, aborted=false;
    return items.reduce(function(chain,item){ return chain.then(function(){
      if(aborted) return;
      return backfillOne(item,tax).then(function(outcome){
        if(outcome==="repaired") repaired++;
        else if(outcome==="would") would++;
        else if(outcome==="notfound") notfound++;
        else if(outcome==="hasphoto") skipped++;
      }).catch(function(err){
        if(String((err&&err.message)||err)==="RATE_LIMIT_ABORT"){ aborted=true; log("Stopped: the write endpoint is rate-limited (cooldown active). Repaired "+repaired+" so far. Wait ~10-15 min with NO attempts, then re-run - it skips items that already have a photo."); return; }
        failed++; log("BACKFILL FAILED:", item.title, String(err));
      });
    }); }, Promise.resolve()).then(function(){
      var msg="Done. "+(dryRun?("[dry run] would attach photos to "+would):("attached photos to "+repaired))+", already had a photo "+skipped+", not in your inventory "+notfound+(failed?(", failed "+failed):"")+(aborted?" (ABORTED on rate limit - wait, then re-run to continue)":"")+".";
      log(msg); alert(msg);
    });
  });`;

/**
 * The photo-backfill bookmarklet — a self-contained `javascript:` string built against the KNOWN endpoints
 * and the VERIFIED payloads (scratchpad gspro-photo-repair.js). The source items are embedded as JSON; the
 * pure builders and the unpriced pricing map are serialized in verbatim (one source of truth with the unit
 * tests). It confirm-gates, offers a dry run, fetches the live tax types, paces every GSPRO request through
 * the 429 throttle, is IDEMPOTENT (skips any item that already has a photo) and never creates items.
 */
export function buildBackfillBookmarklet(cfg: BackfillConfig): string {
  return (
    "javascript:(function(){" +
    "var CFG=" + JSON.stringify(cfg) + ";" +
    "var UNPRICED_PRICING_MAP=" + JSON.stringify(UNPRICED_PRICING_MAP) + ";" +
    "var gsSearchDate=" + gsSearchDate.toString() + ";" +
    "var buildSearchBody=" + buildSearchBody.toString() + ";" +
    "var pickZoeMatch=" + pickZoeMatch.toString() + ";" +
    "var needsPhotos=" + needsPhotos.toString() + ";" +
    "var buildBackfillBody=" + buildBackfillBody.toString() + ";" +
    "var buildTags=" + buildTags.toString() + ";" +
    "var buildImageEntry=" + buildImageEntry.toString() + ";" +
    BACKFILL_RUNTIME_JS +
    "})();void 0"
  );
}
