// Bookmarklet builders for the Inventory Automation WRITE path.
//
// WHY A BOOKMARKLET: Goodshuffle Pro has no public write API and Cloudflare blocks server-side calls, so
// every write must run from a logged-in pro.goodshuffle.com browser tab (same-origin fetch, credentials
// included). A direct mutating fetch from automation is blocked by a security classifier; the importer is
// run BY THE OPERATOR in their own GSPRO tab, so it executes as the user — the intended, unaffected path.
//
// The real write endpoints were captured live (see scratchpad gspro-inventory-write-spec.md), so the
// importer is built DIRECTLY against them — no heuristic parsing of a pasted capture needed:
//   • Create: POST /app/inventory/saveRegularItem (JSON). id:null + a client uuid = create.
//   • Image:  GET /app/image/getPresignedUploadURL?fileName=… → {presignedUrl,s3Path,s3Url};
//             PUT the image Blob to presignedUrl; then add an images[] entry on saveRegularItem.
// Exact-shape gotchas baked in (buildSaveItemBody): `tags` is a COMMA-SEPARATED STRING; UNPRICED is a
// full pricingMap with unpriced:true / rateType:"UNPRICED"; untracked is quantityTracked:false +
// quantityPosted:null; website visibility = website_wishlist_visible + marketplace_visible.
//
// THE ONE PER-TARGET UNKNOWN is the numeric Goodshuffle category/group IDs for Zoe's Sofas and Barstools
// (primaryCategoryID / rootGroupID …). Those can't be guessed, so the capture step is REPURPOSED: the
// operator creates ONE item in each target group through the normal UI (with the capture tool running) and
// pastes the result; parseCapture() reads the exact {primaryCategoryID, primaryCategoryName, rootGroupID,
// rootGroupName, applied_tax_types} off each real saveRegularItem body, and those IDs are reused for every
// item of that group. The importer FAILS CLOSED (stops with a clear message) if any target group's IDs are
// unresolved — it never invents an ID.
//
// TODO (fast-follow, OUT of scope): stage item_create / item_image_upload ops on the gs_outbox
// (src/lib/gsPull.ts drainer) so the office Auto-Pull runs the plan hands-off.

import type { PlannedItem } from "./importPlan";

/** One write request mirrored by the capture tool (the shape it copies to the clipboard). */
export interface CapturedRequest {
  at?: string;
  method?: string;
  url?: string;
  contentType?: string | null;
  bodyText?: string | null;
  formFields?: string[];
}

/** The resolved Goodshuffle category + group ID set for one target group (read from a real item save). */
export interface GroupIdSet {
  primaryCategoryID: number;
  primaryCategoryName: string;
  rootGroupID: number; //       the storefront GROUP — this is what lands the item under /sofas/ etc.
  rootGroupName: string;
  appliedTaxTypes: unknown[]; // the account default tax types, carried verbatim from the sample save
  sampleTitle: string; //       the captured sample item's title (for UI display only)
}

/** An entry in a saved item's images[] (after the Blob has been PUT to its presigned S3 URL). */
export interface ItemImageEntry {
  id: null;
  s3Path: string;
  fileName: string;
  viewOrder: number;
  caption: null;
  isAnimatedGIF: boolean;
  rawWidth: number | null;
  rawHeight: number | null;
}

export interface ImporterConfig {
  plan: PlannedItem[];
  groupIds: Record<string, GroupIdSet>; // keyed by zoeGroup; every group used by the plan must be present
  zoeToken: string; //                    Zoe's public storefront token, for the run-time idempotency re-check
}

// ── Pure builders (unit-tested, and serialized verbatim into the importer so there is one source of truth) ──

/**
 * Build the exact `saveRegularItem` request body for one planned item. PURE. Bakes in the captured
 * contract: tags as a CSV string, an UNPRICED pricingMap, untracked quantity, and website visibility.
 * Written with plain ES2017 (no spread / optional-chaining) so Function.toString() yields self-contained
 * JS the importer can run as-is.
 */
export function buildSaveItemBody(
  item: PlannedItem,
  ids: GroupIdSet,
  uuid: string,
  images: ItemImageEntry[],
): Record<string, unknown> {
  return {
    inventoryType: { name: "PRODUCT" },
    originalInventoryType: "PRODUCT",
    uuid: uuid,
    id: null, //                              null + uuid = create (vs a numeric id = update)
    title: item.title,
    primaryCategoryID: ids.primaryCategoryID,
    primaryCategoryName: ids.primaryCategoryName,
    rootGroupID: ids.rootGroupID,
    rootGroupName: ids.rootGroupName,
    contract_description: item.descriptionHtml || null,
    web_description: item.descriptionHtml || null, // show the Staging HTML as the website copy…
    useContractDescriptionForWeb: false, //         …rather than reusing the contract description
    internal_notes: null,
    tags: (item.tags || []).join(","), //     COMMA-SEPARATED STRING, not an array
    marketplace_visible: true, //             list on Goodshuffle.com Marketplace
    website_wishlist_visible: true, //        surface on zoeeventsdmv.com (Website Integration)
    quantityTracked: item.trackQuantity === true, // v1: false (untracked / "on request")
    quantityPosted: null,
    quantitySetAside: null,
    pricingMap: {
      numberOfRates: 0,
      baseRate: null,
      pricedDaily: false,
      dailyPrice: null,
      threeDayPrice: null,
      weeklyPrice: null,
      monthlyPrice: null,
      pricedForPurchase: false,
      purchasePrice: null,
      pricedFlatFee: false,
      flatFee: null,
      pricedHourly: false,
      baseHourlyRate: null,
      flatFeesByGeo: [],
      unpriced: true,
      rateType: "UNPRICED",
    },
    applied_tax_types: Array.isArray(ids.appliedTaxTypes) ? ids.appliedTaxTypes : [],
    images: images,
    // Pass-through structural fields that default empty / false.
    attributes: [],
    poolMembers: [],
    packageContents: [],
    associatedServices: [],
    accessoryItems: [],
    alternateItems: [],
    parentItems: [],
    parentPackages: [],
    poolID: null,
    qrCode: null,
    routingEligible: false,
    isDeliveryRequired: false,
    thumbImagePath: null,
    selected: false,
    dateCreated: null,
  };
}

/** Build one images[] entry for a copied image after its Blob has been PUT to S3. PURE. */
export function buildImageEntry(
  s3Path: string,
  fileName: string,
  viewOrder: number,
  rawWidth: number | null,
  rawHeight: number | null,
): ItemImageEntry {
  return {
    id: null,
    s3Path: s3Path,
    fileName: fileName,
    viewOrder: viewOrder,
    caption: null,
    isAnimatedGIF: false,
    rawWidth: rawWidth,
    rawHeight: rawHeight,
  };
}

/**
 * Return the distinct zoeGroups used by the plan that have NO valid resolved ID set. PURE. The importer
 * (and the blade) fail closed when this is non-empty — an unresolved group's items are never created with
 * a guessed category/group ID.
 */
export function findMissingGroupIds(plan: PlannedItem[], groupIds: Record<string, GroupIdSet>): string[] {
  const seen: Record<string, boolean> = {};
  const missing: string[] = [];
  for (const item of plan) {
    const g = groupIds[item.zoeGroup];
    const ok = !!g && typeof g.rootGroupID === "number" && typeof g.primaryCategoryID === "number";
    if (!ok && !seen[item.zoeGroup]) {
      seen[item.zoeGroup] = true;
      missing.push(item.zoeGroup);
    }
  }
  return missing;
}

const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Read the resolved category/group ID sets out of a capture. Accepts the capture tool's output (an array
 * of CapturedRequest, or { requests: [...] }), or a pasted saveRegularItem body (object or array). For each
 * real `saveRegularItem` body it reads the exact IDs + the account default applied_tax_types. Deduped by
 * rootGroupID. Returns a friendly error, never throws.
 */
export function parseCapture(text: string): { ok: boolean; sets?: GroupIdSet[]; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste the captured item save(s) first." };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "That is not valid JSON. Use the capture tool's Copy button and paste the result here." };
  }

  // Gather candidate item bodies from whatever shape was pasted.
  const bodies: Record<string, unknown>[] = [];
  const pushBody = (obj: unknown): void => {
    if (obj && typeof obj === "object") bodies.push(obj as Record<string, unknown>);
  };
  const fromRequest = (r: CapturedRequest): void => {
    if (!r || typeof r.url !== "string" || !/saveRegularItem/i.test(r.url)) return;
    if (typeof r.bodyText !== "string" || !r.bodyText.trim()) return;
    try {
      pushBody(JSON.parse(r.bodyText));
    } catch {
      /* ignore an unparseable body */
    }
  };

  if (Array.isArray(data)) {
    for (const el of data) {
      if (el && typeof el === "object" && "rootGroupID" in (el as object)) pushBody(el); // raw item object
      else fromRequest(el as CapturedRequest); // captured request
    }
  } else if (data && typeof data === "object") {
    const o = data as { requests?: unknown[]; rootGroupID?: unknown };
    if (Array.isArray(o.requests)) for (const el of o.requests) fromRequest(el as CapturedRequest);
    else if ("rootGroupID" in o) pushBody(data); // a single pasted item body
  }

  const byGroup = new Map<number, GroupIdSet>();
  for (const b of bodies) {
    const rootGroupID = numOrNull(b.rootGroupID);
    const primaryCategoryID = numOrNull(b.primaryCategoryID);
    if (rootGroupID === null || primaryCategoryID === null) continue;
    if (byGroup.has(rootGroupID)) continue;
    byGroup.set(rootGroupID, {
      primaryCategoryID,
      primaryCategoryName: typeof b.primaryCategoryName === "string" ? b.primaryCategoryName : "",
      rootGroupID,
      rootGroupName: typeof b.rootGroupName === "string" ? b.rootGroupName : "",
      appliedTaxTypes: Array.isArray(b.applied_tax_types) ? b.applied_tax_types : [],
      sampleTitle: typeof b.title === "string" ? b.title : "",
    });
  }

  const sets = Array.from(byGroup.values());
  if (sets.length === 0) {
    return {
      ok: false,
      error:
        "No saved inventory item found in the capture. With the capture tool running, create ONE item in each target Goodshuffle group (Sofas / Barstools) through the normal UI, then click Copy captured and paste again.",
    };
  }
  return { ok: true, sets };
}

// ── The embedded browser runtimes ─────────────────────────────────────────────────────────────────────
// Authored as plain JS strings (they run in the GSPRO tab, not our app). Messages stay single-line.

const CAPTURE_JS = `(function(){
  var KEY="zoe_gs_capture_v1", HOST="pro.goodshuffle.com";
  function load(){ try{ return JSON.parse(localStorage.getItem(KEY)||"[]"); }catch(e){ return []; } }
  function save(a){ try{ localStorage.setItem(KEY, JSON.stringify(a.slice(-50))); }catch(e){} }
  function isTarget(u){ try{ return (new URL(u, location.href)).host.indexOf(HOST)!==-1; }catch(e){ return false; } }
  function describe(body){
    if(body==null) return {bodyText:null,contentType:null,formFields:[]};
    if(typeof body==="string") return {bodyText:body,contentType:null,formFields:[]};
    if(typeof URLSearchParams!=="undefined"&&body instanceof URLSearchParams) return {bodyText:body.toString(),contentType:"application/x-www-form-urlencoded",formFields:[]};
    if(typeof FormData!=="undefined"&&body instanceof FormData){ var f=[]; try{ body.forEach(function(v,k){ f.push(k); }); }catch(e){} return {bodyText:null,contentType:"multipart/form-data",formFields:f}; }
    return {bodyText:null,contentType:null,formFields:[]};
  }
  function ctFrom(headers, fallback){
    try{
      if(headers&&typeof headers.get==="function") return headers.get("content-type")||fallback;
      if(headers&&typeof headers==="object"){ for(var k in headers){ if(String(k).toLowerCase()==="content-type") return headers[k]; } }
    }catch(e){}
    return fallback;
  }
  function record(method,url,headers,body){
    if(!isTarget(url)) return;
    var m=(method||"GET").toUpperCase();
    if(m==="GET"||m==="HEAD") return;
    var d=describe(body);
    var arr=load();
    arr.push({at:new Date().toISOString(),method:m,url:(new URL(url,location.href)).href,contentType:ctFrom(headers,d.contentType),bodyText:d.bodyText,formFields:d.formFields});
    save(arr); paint();
  }
  if(!window.__zoeCapHooked){
    window.__zoeCapHooked=true;
    var of=window.fetch;
    window.fetch=function(input,init){
      try{
        var url=typeof input==="string"?input:(input&&input.url)||"";
        var method=(init&&init.method)||(input&&typeof input==="object"&&input.method)||"GET";
        var headers=(init&&init.headers)||(input&&typeof input==="object"&&input.headers);
        record(method,url,headers,init&&init.body);
      }catch(e){}
      return of.apply(this,arguments);
    };
    var ox=XMLHttpRequest.prototype.open, osend=XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open=function(m,u){ this.__zm=m; this.__zu=u; return ox.apply(this,arguments); };
    XMLHttpRequest.prototype.send=function(b){ try{ record(this.__zm,this.__zu,null,b); }catch(e){} return osend.apply(this,arguments); };
  }
  function paint(){
    var n=load().length, el=document.getElementById("zoeCapPanel");
    if(!el){ el=document.createElement("div"); el.id="zoeCapPanel"; el.style.cssText="position:fixed;bottom:16px;right:16px;z-index:2147483647;background:#111;color:#fff;font:12px system-ui,sans-serif;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.4);min-width:190px"; document.body.appendChild(el); }
    el.innerHTML="<div style='font-weight:600;margin-bottom:6px'>Zoe capture: "+n+" write(s)</div>";
    var copy=document.createElement("button"); copy.textContent="Copy captured"; copy.style.cssText="margin-right:6px;padding:4px 8px;border:0;border-radius:4px;background:#d4af37;color:#111;font-weight:600;cursor:pointer";
    copy.onclick=function(){ var t=JSON.stringify(load(),null,2); if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(t).then(function(){ copy.textContent="Copied!"; setTimeout(function(){ copy.textContent="Copy captured"; },1200); },function(){ window.prompt("Copy the captured JSON:",t); }); } else { window.prompt("Copy the captured JSON:",t); } };
    var clr=document.createElement("button"); clr.textContent="Clear"; clr.style.cssText="padding:4px 8px;border:0;border-radius:4px;background:#333;color:#fff;cursor:pointer";
    clr.onclick=function(){ save([]); paint(); };
    el.appendChild(copy); el.appendChild(clr);
  }
  paint();
})();void 0`;

// The importer runtime. Runs AFTER the injected CFG + the serialized pure builders
// (buildSaveItemBody / buildImageEntry / findMissingGroupIds) are in scope. Known endpoints are hardcoded.
const IMPORTER_RUNTIME_JS = `
  var plan=(CFG&&CFG.plan)||[], groupIds=(CFG&&CFG.groupIds)||{}, zoeToken=(CFG&&CFG.zoeToken)||"";
  function log(){ try{ console.log.apply(console,["[zoe-import]"].concat([].slice.call(arguments))); }catch(e){} }
  function norm(t){ return String(t||"").trim().toLowerCase().replace(/\\s+/g," "); }
  function uuid(){ try{ if(window.crypto&&crypto.randomUUID) return crypto.randomUUID(); }catch(e){} return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var r=Math.random()*16|0;return (c==="x"?r:(r&0x3|0x8)).toString(16);}); }

  var missing=findMissingGroupIds(plan, groupIds);
  if(missing.length){ alert("Cannot import. Missing Goodshuffle category/group IDs for group(s): "+missing.join(", ")+". Capture a sample item saved in each of those groups, assign them in the blade, then regenerate the importer."); return; }
  if(!plan.length){ alert("The plan is empty - nothing to import."); return; }
  if(!confirm("Zoe inventory importer. "+plan.length+" item(s) planned. This creates items in your logged-in Goodshuffle account. Continue?")){ log("cancelled"); return; }
  var dryRun=confirm("Dry run first? OK = simulate only (no writes). Cancel = create for real now.");
  log(dryRun?"DRY RUN (no writes)":"LIVE RUN");

  function existingTitles(){
    return fetch("https://data.goodshuffle.com/vendor/"+encodeURIComponent(zoeToken)+"/inventory?size=500",{cache:"no-store"})
      .then(function(r){ return r.json(); })
      .then(function(j){ var s={}; ((j&&j.items)||[]).forEach(function(it){ if(it&&it.title) s[norm(it.title)]=1; }); log("re-checked Zoe catalog: "+Object.keys(s).length+" existing titles"); return s; })
      .catch(function(e){ log("could not re-fetch Zoe catalog ("+e+"); using in-run dedup only"); return null; });
  }
  function fileNameFromUrl(u,i){ try{ var p=(new URL(u,location.href)).pathname.split("/").pop(); p=decodeURIComponent(p||""); if(p&&/\\.(jpe?g|png|gif|webp)$/i.test(p)) return p; }catch(e){} return "image-"+(i+1)+".jpg"; }
  function imageDims(blob){
    function dom(){ return new Promise(function(res){ try{ var u=URL.createObjectURL(blob); var im=new Image(); im.onload=function(){ res({w:im.naturalWidth,h:im.naturalHeight}); URL.revokeObjectURL(u); }; im.onerror=function(){ res({w:null,h:null}); URL.revokeObjectURL(u); }; im.src=u; }catch(e){ res({w:null,h:null}); } }); }
    if(typeof createImageBitmap!=="undefined"){ return createImageBitmap(blob).then(function(b){ var d={w:b.width,h:b.height}; if(b.close)b.close(); return d; }).catch(dom); }
    return dom();
  }
  // 3-step image copy: presign -> fetch source Blob -> PUT to S3 -> build the images[] entry.
  function uploadImage(url,i){
    var fileName=fileNameFromUrl(url,i);
    return fetch("/app/image/getPresignedUploadURL?fileName="+encodeURIComponent(fileName),{credentials:"include"})
      .then(function(r){ if(!r.ok) throw new Error("presign "+r.status); return r.json(); })
      .then(function(pres){
        return fetch(url).then(function(r){ if(!r.ok) throw new Error("source "+r.status); return r.blob(); })
          .then(function(blob){ return imageDims(blob).then(function(d){
            return fetch(pres.presignedUrl,{method:"PUT",body:blob,headers:{"content-type":blob.type||"image/jpeg"}})
              .then(function(pr){ if(!pr.ok) throw new Error("s3 PUT "+pr.status); return buildImageEntry(pres.s3Path, fileName, i, d.w, d.h); });
          }); });
      });
  }
  function createOne(item){
    var ids=groupIds[item.zoeGroup];
    log("CREATE", item.title, "-> "+ids.rootGroupName+" (#"+ids.rootGroupID+")", "images:"+item.imageUrls.length);
    if(dryRun){ log("  [dry run] body:", JSON.stringify(buildSaveItemBody(item, ids, uuid(), []))); return Promise.resolve(null); }
    var entries=[];
    return item.imageUrls.reduce(function(chain,url,i){ return chain.then(function(){
      return uploadImage(url,i).then(function(e){ entries.push(e); log("  image uploaded:", e.fileName); }).catch(function(err){ log("  image FAILED (skipped):", url, String(err)); });
    }); }, Promise.resolve()).then(function(){
      var body=buildSaveItemBody(item, ids, uuid(), entries);
      return fetch("/app/inventory/saveRegularItem",{method:"POST",credentials:"include",headers:{"content-type":"application/json"},body:JSON.stringify(body)})
        .then(function(r){ if(!r.ok) throw new Error("save "+r.status); return r.json().catch(function(){ return {}; }); })
        .then(function(j){ log("  created id:", j&&j.id); return j&&j.id; });
    });
  }
  existingTitles().then(function(have){
    var created=0, skipped=0, failed=0, seen={};
    return plan.reduce(function(chain,item){ return chain.then(function(){
      var n=norm(item.title);
      if((have&&have[n])||seen[n]){ skipped++; log("SKIP (exists):", item.title); return; }
      seen[n]=1;
      return createOne(item).then(function(){ created++; }).catch(function(err){ failed++; log("CREATE FAILED:", item.title, String(err)); });
    }); }, Promise.resolve()).then(function(){
      var msg="Done. "+(dryRun?"[dry run] would create ":"created ")+created+", skipped "+skipped+(failed?(", failed "+failed):"")+".";
      log(msg); alert(msg);
    });
  });`;

/** The capture bookmarklet — a static `javascript:` string. Run once in a logged-in GSPRO tab. */
export function buildCaptureBookmarklet(): string {
  return "javascript:" + CAPTURE_JS;
}

/**
 * The importer bookmarklet — a self-contained `javascript:` string built against the KNOWN endpoints. The
 * confirmed plan + the resolved per-group ID sets are embedded as JSON; the pure builders are serialized in
 * verbatim (one source of truth with the unit tests). It confirm-gates, offers a dry run, re-checks Zoe's
 * live catalog at run time (skips existing titles), and FAILS CLOSED if any target group's IDs are missing.
 */
export function buildImporterBookmarklet(cfg: ImporterConfig): string {
  return (
    "javascript:(function(){" +
    "var CFG=" + JSON.stringify(cfg) + ";" +
    "var buildSaveItemBody=" + buildSaveItemBody.toString() + ";" +
    "var buildImageEntry=" + buildImageEntry.toString() + ";" +
    "var findMissingGroupIds=" + findMissingGroupIds.toString() + ";" +
    IMPORTER_RUNTIME_JS +
    "})();void 0"
  );
}
