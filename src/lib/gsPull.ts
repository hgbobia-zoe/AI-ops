// Office web pull — the tablet-independent way to refresh Goodshuffle data into Zoe Ops. Runs
// INSIDE a logged-in Goodshuffle tab (as a bookmarklet), using the operator's own full-access
// session, and pulls TWO feeds:
//   • Routes (listRoutes/getRoute) → today's delivery logistics → Dispatch + day-of risk.
//   • Bookings (searchProjects) → the commercial pipeline (dates + revenue + client) → Sales,
//     Finance, Customer. This is the feed that was missing — routes only exist near delivery day,
//     so the forward pipeline lives in projects, not routes.
// The office account has financial access the driver/tablet account lacks, so this path also
// captures contract totals (revenue) + customer identity. Shows an on-page banner (a human clicks it).

/** Build the office pull IIFE. `apiBase` is the absolute Zoe Ops origin (e.g. https://zoe-dispatch.fly.dev).
 *  `publishToken` (when the KIOSK_PUBLISH_TOKEN secret is set) is sent as x-publish-token so the
 *  now-gated ingest endpoints accept the write — only logged-in users can see /admin/pull, so the
 *  token isn't exposed publicly. */
export function buildOfficePullScript(apiBase: string, publishToken?: string): string {
  const API = JSON.stringify(apiBase.replace(/\/+$/, ""));
  const PUB = JSON.stringify(publishToken ?? "");
  return `(function(){
    var PUB=${PUB};
    function POSTH(){ return PUB ? {"content-type":"application/json","x-publish-token":PUB} : {"content-type":"application/json"}; }
  function banner(msg,color){ try{ var id="__zoePull"; var e=document.getElementById(id); if(!e){e=document.createElement("div");e.id=id;e.style.cssText="position:fixed;z-index:2147483647;top:14px;right:14px;padding:11px 15px;border-radius:8px;font:600 13px system-ui,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:360px";document.body.appendChild(e);} e.style.background=color; e.textContent=msg; }catch(x){} }
  function done(){ setTimeout(function(){var e=document.getElementById("__zoePull");if(e)e.remove();},7000); }
  try{
    if(location.hostname.indexOf("goodshuffle.com")<0){ alert("Open pro.goodshuffle.com (signed in) first, then click Pull Zoe Routes."); return; }
    var pth=location.pathname.toLowerCase();
    if(pth.indexOf("auth")>=0||pth.indexOf("login")>=0||pth.indexOf("signin")>=0){ banner("Sign in to Goodshuffle first, then click again.","#b45309"); return; }
    var API=${API};
    var H={headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"};
    banner("Pulling Zoe data…","#334155");

    // ---- Bookings feed (projects) → Sales / Finance / Customer ----
    function pullProjects(){
      var all={}, total=0, pErr=false;
      // searchProjects paginates ?page=N, 0-indexed (no param == page 0). Walk pages until one
      // returns nothing (end), with a safety cap. A FETCH ERROR (not an empty page) marks the pull
      // partial so the server won't treat a truncated pipeline as complete/fresh.
      function fetchPage(pg){ return fetch("/app/project/searchProjects?page="+pg,H).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(b){ var ps=b&&b.projectSearch; if(!ps)return {count:0}; if(ps.totalResultCount)total=ps.totalResultCount; var res=ps.results||[]; res.forEach(function(p){ if(p&&p.id!=null&&!all[p.id])all[p.id]=p; }); return {count:res.length}; }).catch(function(){ pErr=true; return {count:0}; }); }
      function loop(pg){ return fetchPage(pg).then(function(r){ if(!pErr && r.count>0 && pg<40) return loop(pg+1); return null; }); }
      return loop(0).then(function(){
        var recs=Object.keys(all).map(function(id){ var p=all[id]; var d=null; try{ if(p.logistics_start_date){ var dt=new Date(p.logistics_start_date); if(!isNaN(dt)) d=new Date(dt.getTime()-dt.getTimezoneOffset()*60000).toISOString().slice(0,10); } }catch(e){}
          return { bookingId:String(p.id), eventName:p.eventName||"", eventDate:d, statusLabel:p.statusLabel||"", signed:!!p.signed, grandTotalCents:p.grand_total, contractTotalCents:p.contract_total, amountPaidCents:p.amount_paid, amountDueCents:p.amount_due, clientName:p.client_name||"", clientEmail:p.client_email||"" }; });
        if(!recs.length) return { saved:0, partial:pErr };
        return fetch(API+"/api/gs/projects",{method:"POST",headers:POSTH(),body:JSON.stringify({projects:recs,partial:pErr,totalReported:total})}).then(function(r){return r.json();}).then(function(j){ return { saved:(j&&j.saved)||recs.length, partial:pErr||!!(j&&j.partial) }; }).catch(function(){ return { saved:0, partial:true }; });
      });
    }

    // ---- Routes feed (today's logistics) → Dispatch / day-of risk ----
    function truckIdFor(title){ var t=(title||"").toLowerCase();
      if(t.indexOf("ford")>=0||t.indexOf("e450")>=0||t.indexOf("e-450")>=0) return "E450";
      if(t.indexOf("isuzu")>=0||t.indexOf("npr")>=0) return t.indexOf("2")>=0?"NPR-2":"NPR-1";
      if(t.indexOf("2")>=0) return "NPR-2";
      if(t.indexOf("1")>=0) return "NPR-1";
      return null; }
    function fetchEvent(txID){ var out={items:undefined,contactId:undefined,grandTotalCents:undefined,paidCents:undefined};
      var pI=fetch("/app/vendorTransaction/initContractView?transactionID="+txID,H).then(function(r){return r.json();})
        .then(function(cv){ if(cv&&cv.contactID!=null)out.contactId=String(cv.contactID); var g=(cv&&cv.lineItemGroupsToLoad)||[]; return Promise.all(g.map(function(x){ return fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID="+x.id+"&transactionID="+txID,H).then(function(r){return r.json();}).catch(function(){return null;}); })); })
        .then(function(lists){ var items=[]; function w(o,d){ if(!o||typeof o!=="object"||d>7)return; if(Object.prototype.toString.call(o)==="[object Array]"){for(var i=0;i<o.length;i++)w(o[i],d+1);return;} if(o.itemTitle)items.push({name:o.itemTitle,quantity:o.quantityBooked}); for(var k in o)w(o[k],d+1);} (lists||[]).forEach(function(gj){w(gj,0);}); if(items.length)out.items=items; })
        .catch(function(){});
      var pR=fetch("/app/vendorPayment/loadPaymentHistoryAndContractTotals?transactionID="+txID,H).then(function(r){return r.json();})
        .then(function(pt){ if(pt&&typeof pt.grandTotal==="number")out.grandTotalCents=pt.grandTotal; var ph=pt&&pt.paymentHistory; if(ph&&typeof ph.totalContractApplicablePaid==="number")out.paidCents=ph.totalContractApplicablePaid; })
        .catch(function(){});
      return Promise.all([pI,pR]).then(function(){return out;}); }
    function extractStops(route){ var wps=(route.waypoints||[]).filter(function(w){return !w.isOriginWarehouse&&!w.isDestinationWarehouse;}); wps.sort(function(a,b){return (a.waypointIndex||0)-(b.waypointIndex||0);});
      return wps.map(function(w){ var tl=(w.logisticRelation&&w.logisticRelation.targetLocation)||{}; var tx=w.transaction||{}; var line=[tl.streetAddressLine1,tl.streetAddressLine2].filter(Boolean).join(" "); var cs=[tl.city,tl.state].filter(Boolean).join(", "); var address=[line,cs,tl.zipCode].filter(Boolean).join(", "); var r=tx.renter||{}; var sv=r.smsValidation||{}; var name=tl.contactName||(tx.eventName?String(tx.eventName).split(" - ")[0].trim():"")||r.name; var doc=tx.dayOfContact||null;
        var s={custName:name||"",custFirstName:r.firstName||undefined,custLastName:r.lastName||undefined,kind:(w.waypointType==="PICK_UP"?"pickup":"delivery"),custPhone:sv.e164PhoneNumber||r.phone||tl.contactPhoneNumber||"",address:address,plannedWindow:w.scheduledArrivalTime||undefined,eta:w.scheduledArrivalTime||undefined};
        if(doc){s.dayOfName=doc.name||doc.fullName||undefined;s.dayOfPhone=doc.phoneNumber||doc.phone||undefined;}
        s._txID=w.transactionID||(tx&&tx.id)||null; if(s._txID)s.txId=String(s._txID); return s; }); }
    function attachItems(stops){ return Promise.all(stops.map(function(s){ if(!s._txID){delete s._txID;return Promise.resolve();} return fetchEvent(s._txID).then(function(ev){ if(ev){ if(ev.items&&ev.items.length)s.items=ev.items; if(ev.contactId)s.contactId=ev.contactId; if(ev.grandTotalCents!=null)s.grandTotalCents=ev.grandTotalCents; if(ev.paidCents!=null)s.paidCents=ev.paidCents; } delete s._txID; }); })).then(function(){return stops;}); }
    function pullRoutes(){
      var now=new Date(); var start=new Date(now.getFullYear(),now.getMonth(),now.getDate(),0,0,0); var end=new Date(start.getTime()+24*3600*1000);
      var body={from:start.toISOString(),to:end.toISOString(),warehouseCanonicalIDs:null,crew:null,vehicles:null,statuses:null};
      return fetch("/app/routing/listRoutes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),credentials:"include"}).then(function(r){return r.json();}).then(function(routes){
        var byTruck={},gsBy={},chain=Promise.resolve(),unmatched={};
        (routes||[]).forEach(function(rt){ chain=chain.then(function(){ var title=(rt.vehicle&&rt.vehicle.title)||""; var tid=truckIdFor(title); if(!tid){ if(title)unmatched[title]=1; return; }
          return fetch("/app/routing/getRoute?routeID="+rt.id+"&includeAttributes=true",{headers:{accept:"application/json"},credentials:"include"}).then(function(r){return r.json();}).then(function(full){ return attachItems(extractStops(full)).then(function(stops){ byTruck[tid]=(byTruck[tid]||[]).concat(stops); if(!gsBy[tid])gsBy[tid]=String(rt.id); }); }); }); });
        return chain.then(function(){
          var trucks=Object.keys(byTruck).filter(function(t){return byTruck[t].length;}); var totalStops=0,failed=0; var unm=Object.keys(unmatched);
          return Promise.all(trucks.map(function(tid){ var st=byTruck[tid]; totalStops+=st.length; return fetch(API+"/api/route/import",{method:"POST",headers:POSTH(),body:JSON.stringify({truckId:tid,stops:st,gsRouteId:gsBy[tid]})}).then(function(r){ if(!r.ok)failed++; }).catch(function(){failed++;}); })).then(function(){ return {stops:totalStops,failed:failed,unmatched:unm}; });
        });
      }).catch(function(){ return {stops:0,failed:1,unmatched:[]}; });
    }

    Promise.all([pullRoutes(), pullProjects()]).then(function(res){
      var r=res[0]||{stops:0,failed:0}, bk=res[1]||{saved:0,partial:false};
      var unm=(r.unmatched&&r.unmatched.length)?" · ⚠ unrecognized truck(s): "+r.unmatched.join(", "):"";
      if(r.failed) banner("⚠️ Bookings synced ("+bk.saved+"), but routes failed to save."+unm,"#b91c1c");
      else if(bk.partial) banner("⚠️ Routes synced ("+r.stops+"), but bookings were INCOMPLETE ("+bk.saved+" saved) — a page failed. Try again."+unm,"#b45309");
      else if(unm) banner("✅ Synced "+r.stops+" stops + "+bk.saved+" bookings"+unm,"#b45309");
      else banner("✅ Synced "+r.stops+" route stops + "+bk.saved+" bookings → Zoe Ops","#15803d");
      done();
    }).catch(function(e){ banner("⚠️ Pull failed: "+String(e).slice(0,90),"#b91c1c"); done(); });
  }catch(e){ banner("⚠️ "+String(e).slice(0,110),"#b91c1c"); }
})();`;
}
