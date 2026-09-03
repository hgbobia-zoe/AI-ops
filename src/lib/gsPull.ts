// Office web pull — the tablet-independent way to pull Goodshuffle routes into Zoe Ops.
// It runs INSIDE a logged-in Goodshuffle tab (as a bookmarklet), using the operator's own
// full-access session, and POSTs each truck's stops to /api/route/import (CORS-allowed for
// pro.goodshuffle.com). Because the office account has financial access, this path also
// captures contract totals (revenue) + the client contactID — which the driver/tablet account
// cannot see. Unlike the silent kiosk pull, it shows an on-page banner so the person clicking
// it knows it worked.

/** Build the office pull IIFE. `apiBase` is the absolute Zoe Ops origin (e.g. https://zoe-dispatch.fly.dev). */
export function buildOfficePullScript(apiBase: string): string {
  const API = JSON.stringify(apiBase.replace(/\/+$/, ""));
  return `(function(){
  function banner(msg,color){ try{ var id="__zoePull"; var e=document.getElementById(id); if(!e){e=document.createElement("div");e.id=id;e.style.cssText="position:fixed;z-index:2147483647;top:14px;right:14px;padding:11px 15px;border-radius:8px;font:600 13px system-ui,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:340px";document.body.appendChild(e);} e.style.background=color; e.textContent=msg; }catch(x){} }
  try{
    if(location.hostname.indexOf("goodshuffle.com")<0){ alert("Open pro.goodshuffle.com (signed in) first, then click Pull Zoe Routes."); return; }
    var pth=location.pathname.toLowerCase();
    if(pth.indexOf("auth")>=0||pth.indexOf("login")>=0||pth.indexOf("signin")>=0){ banner("Sign in to Goodshuffle first, then click again.","#b45309"); return; }
    var API=${API};
    banner("Pulling Zoe routes…","#334155");
    function truckIdFor(title){ var t=(title||"").toLowerCase();
      if(t.indexOf("ford")>=0||t.indexOf("e450")>=0||t.indexOf("e-450")>=0) return "E450";
      if(t.indexOf("isuzu")>=0||t.indexOf("npr")>=0) return t.indexOf("2")>=0?"NPR-2":"NPR-1";
      if(t.indexOf("2")>=0) return "NPR-2";
      if(t.indexOf("1")>=0) return "NPR-1";
      return null; }
    function fetchEvent(txID){ var H={headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"}; var out={items:undefined,contactId:undefined,grandTotalCents:undefined,paidCents:undefined};
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
    var now=new Date(); var start=new Date(now.getFullYear(),now.getMonth(),now.getDate(),0,0,0); var end=new Date(start.getTime()+24*3600*1000);
    var body={from:start.toISOString(),to:end.toISOString(),warehouseCanonicalIDs:null,crew:null,vehicles:null,statuses:null};
    fetch("/app/routing/listRoutes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),credentials:"include"}).then(function(r){return r.json();}).then(function(routes){
      var byTruck={},gsBy={},chain=Promise.resolve();
      (routes||[]).forEach(function(rt){ chain=chain.then(function(){ var tid=truckIdFor(rt.vehicle&&rt.vehicle.title); if(!tid)return;
        return fetch("/app/routing/getRoute?routeID="+rt.id+"&includeAttributes=true",{headers:{accept:"application/json"},credentials:"include"}).then(function(r){return r.json();}).then(function(full){ return attachItems(extractStops(full)).then(function(stops){ byTruck[tid]=(byTruck[tid]||[]).concat(stops); if(!gsBy[tid])gsBy[tid]=String(rt.id); }); }); }); });
      chain.then(function(){
        var trucks=Object.keys(byTruck).filter(function(t){return byTruck[t].length;});
        if(!trucks.length){ banner("No routes found for today.","#b45309"); setTimeout(function(){var e=document.getElementById("__zoePull");if(e)e.remove();},6000); return; }
        var totalStops=0,ok=0,failed=0;
        Promise.all(trucks.map(function(tid){ var st=byTruck[tid]; totalStops+=st.length; return fetch(API+"/api/route/import",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({truckId:tid,stops:st,gsRouteId:gsBy[tid]})}).then(function(r){ if(r.ok)ok++; else failed++; }).catch(function(){failed++;}); })).then(function(){
          if(failed) banner("⚠️ Pulled "+totalStops+" stops; "+failed+" truck(s) failed to save.","#b91c1c");
          else banner("✅ Pulled "+totalStops+" stops across "+ok+" truck(s) → Zoe Ops","#15803d");
          setTimeout(function(){var e=document.getElementById("__zoePull");if(e)e.remove();},7000);
        });
      });
    }).catch(function(e){ banner("⚠️ Pull failed: "+String(e).slice(0,90),"#b91c1c"); });
  }catch(e){ banner("⚠️ "+String(e).slice(0,110),"#b91c1c"); }
})();`;
}
