// Bookmarklet builders for the Inventory Automation WRITE path.
//
// WHY A BOOKMARKLET: Goodshuffle Pro has no public write API, and Cloudflare blocks server-side calls, so
// every write must run from a logged-in pro.goodshuffle.com browser tab (same-origin fetch, credentials
// included). The exact create-inventory-item and upload-item-image endpoints have NOT been captured yet
// (we've only proven project-level writes), so the write path is a two-step, human-in-the-loop flow:
//
//   1) CAPTURE  — run buildCaptureBookmarklet() in a logged-in GSPRO tab. It hooks fetch + XHR and mirrors
//      every write request to pro.goodshuffle.com into localStorage (surviving the SPA navigation that
//      creating an item triggers), with a small floating panel + a "Copy captured" button. The user then
//      manually creates ONE item and adds ONE photo, and copies the capture back into the blade.
//   2) IMPORT   — parseCapture() turns that paste into a CaptureSpec {createUrl, createBody, imageUploadUrl,
//      ...}; buildImporterBookmarklet() then emits a second, self-contained bookmarklet that replays the
//      captured create + image-upload requests for every planned item: confirm-gated, dry-run first,
//      idempotent (re-fetches Zoe's catalog at run time and skips titles that already exist), and logged.
//
// HONEST BY DESIGN: because the captured shape is user-supplied and the endpoints are not yet pinned down,
// the importer parameterizes cleanly over the parsed spec and overrides fields by NAME heuristics (title /
// description / group / price / quantity). It never invents an endpoint — no capture, no importer.
//
// TODO (fast-follow, OUT of scope for v1): stage item_create / item_image_upload ops on the gs_outbox
// (src/lib/gsPull.ts drainer) so the office Auto-Pull executes these hands-off, replacing the manual
// bookmarklet run. See CLAUDE.md "Highest-value next write".

import type { PlannedItem } from "./importPlan";

/** One write request mirrored by the capture tool (the shape it copies to the clipboard). */
export interface CapturedRequest {
  at?: string;
  method?: string;
  url?: string;
  contentType?: string | null;
  bodyText?: string | null; // string / urlencoded bodies (multipart can't be stringified → null)
  formFields?: string[]; //    field names, when the body was FormData (multipart)
}

/** The parsed endpoint contract the importer replays over. */
export interface CaptureSpec {
  createUrl: string;
  createMethod: string;
  createContentType: string | null;
  createBody: string; //        the captured create body, verbatim (template the importer edits by field name)
  imageUploadUrl: string | null;
  imageUploadMethod: string;
  imageFieldName: string; //    the multipart field name for the file (default "file")
}

export interface ImporterConfig {
  plan: PlannedItem[];
  spec: CaptureSpec;
  zoeToken: string; //          Zoe's public storefront token, for the run-time idempotency re-check
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

function looksLikeUpload(r: CapturedRequest): boolean {
  return (
    /multipart/i.test(str(r.contentType)) ||
    (Array.isArray(r.formFields) && r.formFields.length > 0) ||
    /upload|\/files?\b|image|photo|attachment/i.test(str(r.url))
  );
}

/**
 * Parse a pasted capture into a CaptureSpec. Accepts a JSON array of CapturedRequest, or { requests: [...] }.
 * Classifies the image-upload request (multipart / "upload"-ish url) vs. the create-item request (the other
 * write, preferring an "inventory"/"item"/"product" url). Returns a friendly error, never throws.
 */
export function parseCapture(text: string): { ok: boolean; spec?: CaptureSpec; error?: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Paste the captured requests first." };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: "That is not valid JSON. Use the capture tool's Copy button and paste the result here." };
  }
  let list: unknown[] = [];
  if (Array.isArray(data)) list = data;
  else if (data && typeof data === "object" && Array.isArray((data as { requests?: unknown[] }).requests)) {
    list = (data as { requests: unknown[] }).requests;
  }
  const reqs = list.filter((r): r is CapturedRequest => !!r && typeof r === "object" && typeof (r as CapturedRequest).url === "string");
  if (reqs.length === 0) {
    return { ok: false, error: "No captured write requests found. Create one item (and add a photo) in Goodshuffle while the capture tool runs, then copy again." };
  }
  const upload = reqs.find(looksLikeUpload) ?? null;
  const create =
    reqs.find((r) => !looksLikeUpload(r) && /inventory|item|product/i.test(str(r.url))) ??
    reqs.find((r) => !looksLikeUpload(r)) ??
    null;
  if (!create) {
    return { ok: false, error: "Could not identify a create-item request in the capture (only an upload was found). Create ONE item in Goodshuffle, then copy again." };
  }
  return {
    ok: true,
    spec: {
      createUrl: str(create.url),
      createMethod: (str(create.method) || "POST").toUpperCase(),
      createContentType: create.contentType ?? null,
      createBody: str(create.bodyText),
      imageUploadUrl: upload ? str(upload.url) : null,
      imageUploadMethod: (str(upload?.method) || "POST").toUpperCase(),
      imageFieldName: (upload?.formFields && upload.formFields[0]) || "file",
    },
  };
}

// ── The embedded browser runtimes ─────────────────────────────────────────────────────────────────────
// Authored as plain JS strings (not TS functions): this code runs in the GSPRO tab, not in our app, so it
// is deliberately kept out of the app's type/lint surface. Messages stay single-line (no "\n") to avoid
// any escaping pitfalls when the string is pasted into a browser as a `javascript:` URL.

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

// The importer takes its config as the single argument CFG (injected as JSON by buildImporterBookmarklet).
const IMPORTER_FN = `function(CFG){
  var plan=(CFG&&CFG.plan)||[], spec=(CFG&&CFG.spec)||{}, zoeToken=(CFG&&CFG.zoeToken)||"";
  function log(){ try{ console.log.apply(console,["[zoe-import]"].concat([].slice.call(arguments))); }catch(e){} }
  function norm(t){ return String(t||"").trim().toLowerCase().replace(/\\s+/g," "); }
  if(!spec.createUrl){ alert("This importer has no captured create endpoint. Paste a capture into the blade first."); return; }
  if(!confirm("Zoe inventory importer. "+plan.length+" item(s) planned. This writes to your logged-in Goodshuffle account. Continue?")){ log("cancelled"); return; }
  var dryRun=confirm("Dry run first? OK = simulate only (no writes). Cancel = write for real now.");
  log(dryRun?"DRY RUN (no writes)":"LIVE RUN");
  function existingTitles(){
    return fetch("https://data.goodshuffle.com/vendor/"+encodeURIComponent(zoeToken)+"/inventory?size=500",{cache:"no-store"})
      .then(function(r){ return r.json(); })
      .then(function(j){ var s={}; ((j&&j.items)||[]).forEach(function(it){ if(it&&it.title) s[norm(it.title)]=1; }); log("re-checked Zoe catalog: "+Object.keys(s).length+" existing titles"); return s; })
      .catch(function(e){ log("could not re-fetch Zoe catalog ("+e+"); using in-run dedup only"); return null; });
  }
  function setField(o,re,val){ var hit=false; Object.keys(o).forEach(function(k){ if(re.test(k)){ o[k]=val; hit=true; } }); return hit; }
  function buildBody(item){
    var ct=spec.createContentType||"", raw=spec.createBody||"";
    if(/json/i.test(ct)||raw.charAt(0)==="{"){
      var o; try{ o=JSON.parse(raw); }catch(e){ o={}; }
      setField(o,/title|name/i,item.title);
      setField(o,/desc/i,item.descriptionHtml);
      setField(o,/group/i,item.zoeGroup);
      if(!setField(o,/^tags?$|tag_list/i,item.tags)) o.tags=item.tags;
      if(item.unpriced) setField(o,/price|rate/i,null);
      setField(o,/track.*quant|quantity.*track|is_?tracked/i,!!item.trackQuantity);
      return {body:JSON.stringify(o),contentType:ct||"application/json"};
    }
    var p=new URLSearchParams(raw);
    p.set("title",item.title); p.set("eventName",item.title);
    p.set("description",item.descriptionHtml); p.set("group",item.zoeGroup);
    return {body:p.toString(),contentType:ct||"application/x-www-form-urlencoded"};
  }
  function withId(url,id){
    try{ var u=new URL(url,location.href), replaced=false;
      u.searchParams.forEach(function(v,k){ if(/id$|item|transaction|product/i.test(k)){ u.searchParams.set(k,id); replaced=true; } });
      if(!replaced) u.pathname=u.pathname.replace(/\\/\\d+(?=\\/?$)/,"/"+id);
      return u.href;
    }catch(e){ return url; }
  }
  function extractId(j){ try{ if(j&&typeof j==="object"){ if(j.id) return j.id; if(j.transactionID) return j.transactionID; if(j.item&&j.item.id) return j.item.id; } }catch(e){} return null; }
  function createOne(item){
    var b=buildBody(item);
    log("CREATE",item.title,"-> group",item.zoeGroup,"(images:"+item.imageUrls.length+")");
    if(dryRun) return Promise.resolve(null);
    return fetch(spec.createUrl,{method:spec.createMethod||"POST",credentials:"include",headers:{"content-type":b.contentType},body:b.body})
      .then(function(r){ return r.json().catch(function(){ return {}; }); })
      .then(function(j){ var id=extractId(j); log("  created id:",id); return id; });
  }
  function uploadImages(item,id){
    if(!spec.imageUploadUrl||!id||!item.imageUrls.length) return Promise.resolve();
    var field=spec.imageFieldName||"file";
    return item.imageUrls.reduce(function(chain,url,i){
      return chain.then(function(){
        log("  image "+(i+1)+"/"+item.imageUrls.length,url);
        if(dryRun) return;
        return fetch(url).then(function(r){ return r.blob(); }).then(function(blob){
          var fd=new FormData(); fd.append(field,blob,"image-"+(i+1)+".jpg");
          return fetch(withId(spec.imageUploadUrl,id),{method:spec.imageUploadMethod||"POST",credentials:"include",body:fd});
        }).then(function(){ log("    uploaded"); }).catch(function(e){ log("    image failed:",e); });
      });
    },Promise.resolve());
  }
  existingTitles().then(function(have){
    var created=0, skipped=0, seen={};
    return plan.reduce(function(chain,item){
      return chain.then(function(){
        var n=norm(item.title);
        if((have&&have[n])||seen[n]){ skipped++; log("SKIP (exists):",item.title); return; }
        seen[n]=1;
        return createOne(item).then(function(id){ return uploadImages(item,id); }).then(function(){ created++; });
      });
    },Promise.resolve()).then(function(){ var msg="Done. "+(dryRun?"[dry run] would create ":"created ")+created+", skipped "+skipped+"."; log(msg); alert(msg); });
  });
}`;

/** The capture bookmarklet — a static `javascript:` string. Run once in a logged-in GSPRO tab. */
export function buildCaptureBookmarklet(): string {
  return "javascript:" + CAPTURE_JS;
}

/**
 * The importer bookmarklet — a self-contained `javascript:` string that replays the captured create +
 * image-upload requests for every planned item. The confirmed plan + parsed spec are embedded as JSON, so
 * the user just runs it in their logged-in GSPRO tab. Idempotency is enforced at RUN time (it re-fetches
 * Zoe's live catalog and skips existing titles), so a confirmed plan stays safe even if the catalog moved.
 */
export function buildImporterBookmarklet(cfg: ImporterConfig): string {
  return "javascript:(" + IMPORTER_FN + ")(" + JSON.stringify(cfg) + ");void 0";
}
