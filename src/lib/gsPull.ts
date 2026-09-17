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
export function buildOfficePullScript(apiBase: string, publishToken?: string, autoMs = 0): string {
  const API = JSON.stringify(apiBase.replace(/\/+$/, ""));
  const PUB = JSON.stringify(publishToken ?? "");
  const AUTO = Math.max(0, Math.floor(autoMs)); // >0 → self-repeating auto-pull (no more manual clicks)
  return `(function(){
    var PUB=${PUB}; var AUTO=${AUTO};
    function POSTH(){ return PUB ? {"content-type":"application/json","x-publish-token":PUB} : {"content-type":"application/json"}; }
  function banner(msg,color){ try{ var id="__zoePull"; var e=document.getElementById(id); if(!e){e=document.createElement("div");e.id=id;e.style.cssText="position:fixed;z-index:2147483647;top:14px;right:14px;padding:11px 15px;border-radius:8px;font:600 13px system-ui,sans-serif;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.35);max-width:360px";document.body.appendChild(e);} e.style.background=color; e.textContent=msg; }catch(x){} }
  function done(){ setTimeout(function(){var e=document.getElementById("__zoePull");if(e)e.remove();},7000); }
  try{
    if(location.hostname.indexOf("goodshuffle.com")<0){ alert("Open pro.goodshuffle.com (signed in) first, then click Pull Zoe Routes."); return; }
    var API=${API};
    var H={headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"};

    // ---- Bookings feed (projects) → Sales / Finance / Customer ----
    function pullProjects(){
      var all={}, pErr=false;
      // searchProjects paginates ?page=N (0-indexed). allProjects=true is the archive-inclusive flag
      // the new GS UI uses — it returns the FULL history (won + archived + lost, all years), not just
      // the ~90 active projects. Walk pages until one returns nothing (end), big pageSize to keep it
      // to a handful of requests. A FETCH ERROR (not an empty page) marks the pull partial. We do NOT
      // send totalReported: the count query over-reports vs the paginated set, which would falsely
      // flag every complete pull as partial.
      function fetchPage(pg){ return fetch("/app/project/searchProjects?page="+pg+"&pageSize=500&allProjects=true&sortColumn=logistics_start_date&sortDirection=desc&useV2DateHandling=true",H).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(b){ var ps=b&&b.projectSearch; if(!ps)return {count:0}; var res=ps.results||[]; res.forEach(function(p){ if(p&&p.id!=null&&!all[p.id])all[p.id]=p; }); return {count:res.length}; }).catch(function(){ pErr=true; return {count:0}; }); }
      function loop(pg){ return fetchPage(pg).then(function(r){ if(!pErr && r.count>0 && pg<60) return loop(pg+1); return null; }); }
      return loop(0).then(function(){
        function d2(s){ try{ if(!s) return null; var dt=new Date(s); if(isNaN(dt)) return null; return new Date(dt.getTime()-dt.getTimezoneOffset()*60000).toISOString().slice(0,10); }catch(e){ return null; } }
        var recs=Object.keys(all).map(function(id){ var p=all[id];
          // NB: Goodshuffle's searchProjects field is contract_subtotal (there is no contract_total).
          return { bookingId:String(p.id), eventName:p.eventName||"", eventDate:d2(p.logistics_start_date), statusLabel:p.statusLabel||"", signed:!!p.signed, grandTotalCents:p.grand_total, contractTotalCents:p.contract_subtotal, amountPaidCents:p.amount_paid, amountDueCents:p.amount_due, clientName:p.client_name||"", clientEmail:p.client_email||"", clientPhone:p.client_phone||"", quoteSentDate:d2(p.quote_sent_date), dateCreated:d2(p.date_created), venue:p.venueLabel||"", location:p.cityStateZipCounty||"" }; });
        if(!recs.length) return { saved:0, partial:pErr };
        // OPEN leads (unsigned, not lost, future/undated) get their comms history captured too — the
        // team's call/text/email log lives in each project's internalNotes (via initContractView).
        var todayY=new Date().toISOString().slice(0,10);
        var openIds=Object.keys(all).filter(function(id){ var p=all[id]; if(p.signed) return false; var s=(p.statusLabel||"").toLowerCase(); if(s.indexOf("lost")>=0||s.indexOf("cancel")>=0||s.indexOf("dead")>=0) return false; var d=d2(p.logistics_start_date); return !d || d>=todayY; }).slice(0,80);
        function pullNotes(){
          var notes=[];
          // Collect line-item titles from a project's loaded line-item groups (event-type signal).
          function titlesFrom(lists){ var t=[]; function w(o,d){ if(!o||typeof o!=="object"||d>7)return; if(Object.prototype.toString.call(o)==="[object Array]"){for(var k=0;k<o.length;k++)w(o[k],d+1);return;} if(o.itemTitle)t.push(o.itemTitle); for(var kk in o)w(o[kk],d+1);} (lists||[]).forEach(function(gj){w(gj,0);}); return t; }
          function one(i){ if(i>=openIds.length) return Promise.resolve(); var id=openIds[i];
            return fetch("/app/vendorTransaction/initContractView?transactionID="+id,H).then(function(r){ if(!r.ok) return; return r.json().then(function(j){
              var g=(j&&j.lineItemGroupsToLoad)||[];
              return Promise.all(g.map(function(x){ return fetch("/app/lineItemGroup/loadContractLineItemGroup?lineItemGroupID="+x.id+"&transactionID="+id,H).then(function(r){return r.json();}).catch(function(){return null;}); })).then(function(lists){
                notes.push({ bookingId:String(id), internalNotes:(j.internalNotes||"").trim(), clientNotes:(j.clientVisibleNotes||"").trim(), lastSentDate:null, lineItems:titlesFrom(lists) });
              });
            }); }).catch(function(){}).then(function(){ return one(i+1); }); }
          return one(0).then(function(){ if(!notes.length) return {updated:0}; return fetch(API+"/api/gs/notes",{method:"POST",headers:POSTH(),body:JSON.stringify({notes:notes})}).then(function(r){return r.json();}).catch(function(){return {updated:0};}); });
        }
        return fetch(API+"/api/gs/projects",{method:"POST",headers:POSTH(),body:JSON.stringify({projects:recs,partial:pErr})}).then(function(r){return r.json();}).then(function(j){ return pullNotes().then(function(nj){ return { saved:(j&&j.saved)||recs.length, partial:pErr||!!(j&&j.partial), notes:(nj&&nj.updated)||0 }; }); }).catch(function(){ return { saved:0, partial:true }; });
      });
    }

    // ---- Routes feed (today's logistics) → Dispatch / day-of risk ----
    function truckIdFor(title){ var t=(title||"").toLowerCase();
      if(t.indexOf("ford")>=0||t.indexOf("e450")>=0||t.indexOf("e-450")>=0) return "E450";
      if(t.indexOf("isuzu")>=0||t.indexOf("npr")>=0) return t.indexOf("2")>=0?"NPR-2":"NPR-1";
      if(t.indexOf("2")>=0) return "NPR-2";
      if(t.indexOf("1")>=0) return "NPR-1";
      return null; }
    // Fallback for a route with no vehicle assigned: read the truck from the route NAME, but ONLY when
    // it names an actual truck word (ford/e450/isuzu/npr) + number — never the bare 1/2 (a date digit
    // must not match). Lets "9/9 - FORD DELIVERY" load onto E450 even when the vehicle field is empty.
    function truckFromName(name){ var t=(name||"").toLowerCase();
      if(t.indexOf("ford")>=0||t.indexOf("e450")>=0||t.indexOf("e-450")>=0) return "E450";
      if(t.indexOf("isuzu")>=0||t.indexOf("npr")>=0){ if(t.indexOf("2")>=0) return "NPR-2"; if(t.indexOf("1")>=0) return "NPR-1"; return null; }
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
    // Multi-week route pull: fetch the next ~3 weeks of routes and import each per (truck, DATE), so
    // the dispatch calendar + risk engine stay populated ahead of time. Near-term routes (<= ENRICH
    // days out) get full per-event enrichment (line items → tent/crew rules); farther-out routes import
    // bare stops (names/addresses/windows) to keep the pull fast — a closer pull enriches them later.
    function rymd(s){ try{ if(!s) return null; var dt=new Date(s); if(isNaN(dt)) return null; return new Date(dt.getTime()-dt.getTimezoneOffset()*60000).toISOString().slice(0,10); }catch(e){ return null; } }
    function pullRoutes(){
      var HORIZON=21, ENRICH=8;
      var now=new Date(); var start=new Date(now.getFullYear(),now.getMonth(),now.getDate(),0,0,0); var end=new Date(start.getTime()+(HORIZON+1)*24*3600*1000); var todayYmd=rymd(start.toISOString());
      var body={from:start.toISOString(),to:end.toISOString(),warehouseCanonicalIDs:null,crew:null,vehicles:null,statuses:null};
      return fetch("/app/routing/listRoutes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),credentials:"include"}).then(function(r){return r.json();}).then(function(routes){
        var groups={},chain=Promise.resolve(),unmatched={};
        (routes||[]).forEach(function(rt){ chain=chain.then(function(){ var title=(rt.vehicle&&rt.vehicle.title)||""; var tid=truckIdFor(title)||truckFromName(rt.name); if(!tid){ if(title||rt.name)unmatched[title||rt.name]=1; return; }
          return fetch("/app/routing/getRoute?routeID="+rt.id+"&includeAttributes=true",{headers:{accept:"application/json"},credentials:"include"}).then(function(r){return r.json();}).then(function(full){
            var stops=extractStops(full);
            var rdate=rymd(rt.startDate)||rymd(rt.date)||(stops[0]?rymd(stops[0].eta):null);
            if(!rdate) return;
            var daysOut=Math.round((Date.parse(rdate+"T00:00:00Z")-Date.parse(todayYmd+"T00:00:00Z"))/86400000);
            var p=(daysOut>=0&&daysOut<=ENRICH)?attachItems(stops):Promise.resolve(stops);
            return p.then(function(st){ var key=tid+"|"+rdate; if(!groups[key])groups[key]={truckId:tid,date:rdate,stops:[],gsRouteId:String(rt.id)}; groups[key].stops=groups[key].stops.concat(st); });
          }); }); });
        return chain.then(function(){
          var keys=Object.keys(groups); var totalStops=0,failed=0,days=keys.length; var unm=Object.keys(unmatched);
          return Promise.all(keys.map(function(k){ var g=groups[k]; totalStops+=g.stops.length; return fetch(API+"/api/route/import",{method:"POST",headers:POSTH(),body:JSON.stringify({truckId:g.truckId,date:g.date,stops:g.stops,gsRouteId:g.gsRouteId})}).then(function(r){ if(!r.ok)failed++; }).catch(function(){failed++;}); })).then(function(){ return {stops:totalStops,days:days,failed:failed,unmatched:unm}; });
        });
      }).catch(function(){ return {stops:0,days:0,failed:1,unmatched:[]}; });
    }

    // ---- Outbox drain: push queued DISPATCH → GOODSHUFFLE writes (delivery photos → Files tab) ----
    // Delivery photos are captured in the driver app and stored on our volume; this replays each as a
    // multipart upload to the project's Files tab (POST /app/files/uploadFileToProject?transactionID=…)
    // from THIS logged-in session, then acks so it's never pushed twice.
    function ackOp(id,ok,err){ return fetch(API+"/api/gs/outbox",{method:"POST",headers:POSTH(),body:JSON.stringify({id:id, ok:ok, error:ok?undefined:err})}).catch(function(){}); }
    function drainOutbox(){
      return fetch(API+"/api/gs/outbox",{headers:POSTH()}).then(function(r){return r.json();}).then(function(j){
        var all=((j&&j.ops)||[]);
        var photoOps=all.filter(function(o){ return o.op==="photo_upload" && o.transactionId && o.payload && o.payload.photoIds && o.payload.photoIds.length; });
        var noteOps=all.filter(function(o){ return o.op==="note_append" && o.transactionId && o.payload && o.payload.line; });
        var teamOps=all.filter(function(o){ return o.op==="add_team_member" && o.transactionId && o.payload && o.payload.userID; });
        var emailOps=all.filter(function(o){ return o.op==="email_send" && o.transactionId && o.payload && o.payload.content; });
        var createOps=all.filter(function(o){ return o.op==="create_project" && o.payload && o.payload.intakeId; });
        var pushed=0, failed=0, notes=0, team=0, emails=0, created=0, chain=Promise.resolve();
        // add_team_member: add a GSPRO user (Warehouse Desktop) to the project team on a signed project.
        teamOps.forEach(function(o){ chain=chain.then(function(){
          var body=new URLSearchParams({ transactionID:String(o.transactionId), userID:String(o.payload.userID), linkType:String(o.payload.linkType||"OTHER") });
          return fetch("/app/project/addNewTeamMember",{method:"POST",headers:{"x-requested-with":"XMLHttpRequest","content-type":"application/x-www-form-urlencoded",accept:"application/json"},credentials:"include",body:body}).then(function(r){ return r.ok; }).then(function(ok){ if(ok)team++; else failed++; return ackOp(o.id,ok,"add_team_member_failed"); }).catch(function(){ failed++; return ackOp(o.id,false,"add_team_member_error"); });
        }); });
        photoOps.forEach(function(o){
          chain=chain.then(function(){
            var ok=Promise.resolve(true);
            o.payload.photoIds.forEach(function(pid){
              ok=ok.then(function(soFar){ if(!soFar) return false;
                return fetch(API+"/api/pod/"+encodeURIComponent(pid)).then(function(r){ if(!r.ok) throw 0; return r.blob(); }).then(function(blob){
                  var fd=new FormData(); fd.append("file", blob, pid);
                  return fetch("/app/files/uploadFileToProject?transactionID="+encodeURIComponent(o.transactionId),{method:"POST",body:fd,credentials:"include"}).then(function(r){ return r.ok; });
                }).catch(function(){ return false; });
              });
            });
            return ok.then(function(done){ if(done)pushed++; else failed++; return ackOp(o.id,done,"photo_upload_failed"); });
          });
        });
        // note_append: read the project's current notes, append our line to internalNotes, save it back.
        noteOps.forEach(function(o){
          chain=chain.then(function(){
            return fetch("/app/vendorTransaction/initContractView?transactionID="+encodeURIComponent(o.transactionId),{headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"}).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(cv){
              var cur=(cv.internalNotes||"");
              var newInt=(cur ? cur+"\n\n" : "")+o.payload.line;
              var body=new URLSearchParams({ transactionID:String(o.transactionId), clientVisibleNotes:(cv.clientVisibleNotes||""), internalNotes:newInt, fulfillmentNotes:(cv.fulfillmentNotes||"") });
              return fetch("/app/vendorTransaction/saveEventNotes",{method:"POST",headers:{"x-requested-with":"XMLHttpRequest","content-type":"application/x-www-form-urlencoded",accept:"application/json"},credentials:"include",body:body}).then(function(r){ return r.ok; });
            }).then(function(ok){ if(ok)notes++; else failed++; return ackOp(o.id,ok,"note_append_failed"); }).catch(function(){ failed++; return ackOp(o.id,false,"note_append_error"); });
          });
        });
        // email_send: reply into the project's CLIENT email thread (continues it; Goodshuffle appends the
        // signature). Read the thread, take the latest message's id + recipients + subject, POST sendMessage.
        emailOps.forEach(function(o){
          chain=chain.then(function(){
            return fetch("/app/conversation/getMessagesForTransaction?transactionID="+encodeURIComponent(o.transactionId),{headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"}).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(cv){
              var msgs=(cv&&cv.client&&cv.client.messages)||[];
              if(!msgs.length) throw "no_thread";
              var last=msgs[msgs.length-1];
              var recips=(last.clientRecipients||[]).map(function(rp){ return {contactID:rp.contactID, email:rp.email, name:rp.name, phone:rp.phone, isCurrentUser:!!rp.isCurrentUser, isEmailValid:true, deliveryConfirmedDate:null, messageOpenedDate:null, hardBouncedDate:null, droppedMessageDate:null}; });
              if(!recips.length) throw "no_recipient";
              var subj=(o.payload.subject||last.subject||"");
              if(!/^re:/i.test(subj)) subj="Re: "+subj;
              var txID=Number(o.transactionId); if(!txID) txID=o.transactionId;
              var payload={ messageID:last.id, transactionID:txID, content:o.payload.content, recipients:recips, subject:subj, messageType:"CLIENT", attachments:[] };
              return fetch("/app/conversation/sendMessage",{method:"POST",headers:{"content-type":"application/json","x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include",body:JSON.stringify(payload)}).then(function(r){ return r.ok; });
            }).then(function(ok){ if(ok)emails++; else failed++; return ackOp(o.id,ok,"email_send_failed"); }).catch(function(e){ failed++; return ackOp(o.id,false,"email_send_"+(typeof e==="string"?e:"error")); });
          });
        });
        // create_project: create a NEW Goodshuffle project shell for a guided-intake record. createNewProject
        // makes a blank draft and redirects to /app/project/detail?id=<newId>; stash the structured intake in
        // the project's internal notes (saveEventNotes), then post the new id back so our app + the success
        // screen update. No inventory, no pricing — the salesperson adds those in Goodshuffle.
        createOps.forEach(function(o){
          chain=chain.then(function(){
            var GH={"x-requested-with":"XMLHttpRequest","content-type":"application/x-www-form-urlencoded",accept:"application/json"};
            var pid=null;
            return fetch("/app/project/createNewProject",{headers:{accept:"text/html"},credentials:"include"}).then(function(r){
              var m=String(r.url||"").match(/[?&]id=(\d+)/); pid=m?m[1]:null;
              if(!pid) throw "no_id";
              // Set name / date / times / event type / head count in one call (saveEventDetails). Best-effort:
              // the shell exists either way, so a details hiccup never loses the project.
              var d=o.payload.details||{};
              var det=new URLSearchParams({ transactionID:String(pid), eventName:String(d.eventName||""), fromDateStr:String(d.fromDateStr||""), fromTimeStr:String(d.fromTimeStr||""), toDateStr:String(d.toDateStr||""), toTimeStr:String(d.toTimeStr||""), eventType:String(d.eventType||""), headCount:String(d.headCount||"") });
              return fetch("/app/vendorTransaction/saveEventDetails",{method:"POST",headers:GH,credentials:"include",body:det}).catch(function(){});
            }).then(function(){
              // Stash the full structured intake into the project's internal notes.
              var nb=new URLSearchParams({ transactionID:String(pid), clientVisibleNotes:"", internalNotes:String(o.payload.notes||""), fulfillmentNotes:"" });
              return fetch("/app/vendorTransaction/saveEventNotes",{method:"POST",headers:GH,credentials:"include",body:nb}).catch(function(){});
            }).then(function(){
              // Set the delivery location (venue) from the geocoded intake address, if we have one. Besides
              // showing the venue, this is what lets the logistics legs below add (Goodshuffle rejects
              // delivery items on a shell with no delivery location). Best-effort.
              var loc=o.payload.location;
              if(!loc) return;
              var lb=new URLSearchParams({ transactionID:String(pid), venueName:String(loc.venueName||""), venuePhoneNumber:"", venueAddress:String(loc.address||""), venueAddress_line2:String(loc.line2||""), venueCity:String(loc.city||""), venueCounty:String(loc.county||""), venueState:String(loc.state||""), venueZipCode:String(loc.zip||""), venueCountry:String(loc.country||"US"), venueLatitude:String(loc.latitude||""), venueLongitude:String(loc.longitude||""), venueNotes:"" });
              return fetch("/app/vendorTransaction/saveDefaultEventLocation",{method:"POST",headers:GH,credentials:"include",body:lb}).catch(function(){});
            }).then(function(){
              // Auto-add line items: SIMPLE services (damage waiver, delivery time-window upgrade) go in the
              // Rental group; LOGISTICS legs (base delivery, Event Readiness) go in the Logistics group with
              // the delivery address embedded (or Goodshuffle rejects them). One contract-view fetch gives us
              // both group ids. All best-effort per item.
              var items=(o.payload.addItems||[]);
              var legs=(o.payload.logisticsLegs||[]);
              var loc=o.payload.location;
              if(!items.length && !(legs.length && loc)) return;
              var JH={"content-type":"application/json","x-requested-with":"XMLHttpRequest",accept:"application/json"};
              return fetch("/app/vendorTransaction/initContractView?transactionID="+encodeURIComponent(pid),{headers:{"x-requested-with":"XMLHttpRequest",accept:"application/json"},credentials:"include"}).then(function(r){ return r.json(); }).then(function(cv){
                var groups=(cv&&cv.lineItemGroupsToLoad)||[];
                var rentalGrp=null, logiGrp=null;
                for(var i=0;i<groups.length;i++){ if(groups[i].logisticsContainer){ if(logiGrp==null) logiGrp=groups[i].id; } else if(rentalGrp==null){ rentalGrp=groups[i].id; } }
                if(rentalGrp==null && groups.length) rentalGrp=groups[0].id;
                var addChain=Promise.resolve();
                if(rentalGrp!=null){ items.forEach(function(it){ addChain=addChain.then(function(){
                  var body=JSON.stringify({ transactionID:Number(pid), lineItemGroupID:rentalGrp, parentRelationID:null, relationType:null, fulfillment:false, inventoryTypeStr:it.inventoryTypeStr, rateType:it.rateType, itemID:it.itemID, unitPrice:(it.unitPrice||0), quantity:(it.quantity||1) });
                  return fetch("/app/transactionItemRelation/addInventoryItemToContract",{method:"POST",headers:JH,credentials:"include",body:body}).catch(function(){});
                }); }); }
                if(logiGrp!=null && loc){ var evDate=(o.payload.details&&o.payload.details.fromDateStr)||""; legs.forEach(function(lg){ addChain=addChain.then(function(){
                  var body=JSON.stringify({ inventoryInjection:true, itemID:lg.itemID, fulfillment:false, transactionID:Number(pid), lineItemGroupID:logiGrp, relationID:null, relationType:null, parentRelationID:null, inventoryTypeStr:"SERVICE", rateType:lg.rateType, title:lg.title, description:null, isSubrental:false, internalNotes:"", showItemDescription:true, showItemAttributes:true, quantity:1, unitPriceOverridden:false, unitPrice:0, mileageFee:0, discountDollarAmount:0, discountPercentage:0, itemStartDate:evDate, itemStartTime:null, itemEndDate:evDate, itemEndTime:null, itemHoursRented:null, eventTimeLineMarker:lg.eventTimeLineMarker, selectedTaxTypes:[], serviceStoreLocationID:null, venueName:loc.venueName, venueAddress:loc.address, venueAddress_line2:loc.line2, venueAddress_city:loc.city, venueAddress_state:loc.state, venueAddress_zipCode:loc.zip, venueAddress_county:loc.county, venueAddress_country:loc.country, venueAddress_latitude:loc.latitude, venueAddress_longitude:loc.longitude });
                  return fetch("/app/transactionItemRelation/addInventoryItemToContract",{method:"POST",headers:JH,credentials:"include",body:body}).catch(function(){});
                }); }); }
                return addChain;
              }).catch(function(){});
            }).then(function(){
              created++;
              var url="https://pro.goodshuffle.com/app/project/detail?id="+pid;
              return fetch(API+"/api/gs/intake-result",{method:"POST",headers:POSTH(),body:JSON.stringify({intakeId:o.payload.intakeId, projectId:pid, url:url, ok:true})}).catch(function(){}).then(function(){ return ackOp(o.id,true); });
            }).catch(function(e){
              failed++;
              var reason=(typeof e==="string"?e:"error");
              fetch(API+"/api/gs/intake-result",{method:"POST",headers:POSTH(),body:JSON.stringify({intakeId:o.payload.intakeId, ok:false, error:"create_project_"+reason})}).catch(function(){});
              return ackOp(o.id,false,"create_project_"+reason);
            });
          });
        });
        return chain.then(function(){ return {pushed:pushed, failed:failed, notes:notes, team:team, emails:emails, created:created}; });
      }).catch(function(){ return {pushed:0, failed:0, notes:0, emails:0, created:0}; });
    }

    // Finish a cycle: one-shot fades the banner; auto keeps a persistent status with the last-run time.
    function fin(msg,color){ if(AUTO){ var t=new Date().toLocaleTimeString([],{hour:"numeric",minute:"2-digit"}); banner(msg+" · auto every "+Math.round(AUTO/60000)+"m (last "+t+")",color); } else { banner(msg,color); done(); } }
    function runOnce(){
      try{
        var pth=location.pathname.toLowerCase();
        if(pth.indexOf("auth")>=0||pth.indexOf("login")>=0||pth.indexOf("signin")>=0){ banner("Signed out of Goodshuffle — sign in to resume"+(AUTO?" (auto-pull paused).":", then click again."),"#b45309"); return; }
        banner(AUTO?"Auto-pull: syncing…":"Pulling Zoe data…","#334155");
        Promise.all([pullRoutes(), pullProjects(), drainOutbox()]).then(function(res){
          var r=res[0]||{stops:0,failed:0}, bk=res[1]||{saved:0,partial:false}, ph=res[2]||{pushed:0,failed:0};
          var unm=(r.unmatched&&r.unmatched.length)?" · ⚠ unrecognized truck(s): "+r.unmatched.join(", "):"";
          var photoNote=ph.pushed?" · "+ph.pushed+" photo"+(ph.pushed===1?"":"s")+"→GS":"";
          var photoErr=ph.failed?" · ⚠ "+ph.failed+" photo push(es) failed":"";
          if(r.failed) fin("⚠️ Bookings synced ("+bk.saved+"), but routes failed to save."+unm,"#b91c1c");
          else if(bk.partial) fin("⚠️ Routes synced ("+r.stops+"), but bookings INCOMPLETE ("+bk.saved+" saved) — will retry."+unm,"#b45309");
          else if(unm||photoErr) fin("✅ Synced "+r.stops+" stops"+(r.days?" ("+r.days+" day"+(r.days===1?"":"s")+")":"")+" + "+bk.saved+" bookings"+photoNote+unm+photoErr,"#b45309");
          else fin("✅ Synced "+r.stops+" route stops"+(r.days?" across "+r.days+" day"+(r.days===1?"":"s"):"")+" + "+bk.saved+" bookings"+photoNote+" → Zoe Ops","#15803d");
        }).catch(function(e){ fin("⚠️ Pull failed: "+String(e).slice(0,90),"#b91c1c"); });
      }catch(e){ banner("⚠️ "+String(e).slice(0,110),"#b91c1c"); }
    }
    // Auto mode: install a single self-repeating timer (re-arming replaces any prior one), then run now.
    if(AUTO){ if(window.__zoeAutoTimer){clearInterval(window.__zoeAutoTimer);} window.__zoeAutoTimer=setInterval(runOnce,AUTO); }
    runOnce();
  }catch(e){ banner("⚠️ "+String(e).slice(0,110),"#b91c1c"); }
})();`;
}
