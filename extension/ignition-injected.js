// Zoe Auto-Pull — Ignition in-page (MAIN WORLD) mint script. Injected by ignition.js into the page's
// own JS context on ignition.zonarsystems.com, so our appsync fetch runs with the SAME origin + session
// as the Ignition app's own calls (the page already calls this endpoint successfully). It:
//   1. reads the Cognito IdToken from the logged-in session's localStorage (NOT minted/refreshed by us),
//   2. resolves the Ignition unitId by truck label via searchUnits (falls back to the request's hint),
//   3. POSTs createEtaLink with the exact captured shape (android/IGNITION_ETALINK.md),
//   4. posts the resulting { code } (or an honest error) back to ignition.js via window.postMessage.
//
// It NEVER fabricates a link. The token value stays in this page context — it is only ever sent as the
// appsync `authorization` header, exactly as the Ignition app does; it is never posted to our server.
//
// ⚠️ NOTIFY-LINE RULE (hard): sharedWith.sms is HARDCODED to the Zoe main line here — the customer's
// number can never reach Zonar, regardless of what the request carries. Mirrors
// src/lib/eta/etaLinkMint.ts ETA_NOTIFY_PHONE_E164.

(function () {
  var APPSYNC = "https://wrfalckup5gc3flo7bizcsfmiq.appsync-api.us-east-1.amazonaws.com/graphql";
  var NOTIFY_SMS = "+13012915296"; // Zoe main line — NEVER the customer

  function idToken() {
    try {
      return localStorage.getItem("IdToken") || "";
    } catch (e) {
      return "";
    }
  }

  function headers(tok) {
    return {
      authorization: tok,
      "app-id": "px-cloud",
      "app-version": "1.0.160",
      "package-name": "cloud-react",
      "content-type": "application/json",
      accept: "*/*",
    };
  }

  function gql(tok, query, variables) {
    return fetch(APPSYNC, {
      method: "POST",
      headers: headers(tok),
      body: JSON.stringify({ query: query, variables: variables || {} }),
    }).then(function (r) {
      return r.json();
    });
  }

  var SEARCH_UNITS =
    "query ($limit: Int, $offset: Int) { result: searchUnits(limit: $limit, offset: $offset) { items { id label } total } }";

  var CREATE_ETA =
    "mutation createEtaLink($unitId: Int!, $entityId: Int!, $entityName: String!, $landmarkId: Int, $address: String!, $latitude: Float!, $longitude: Float!, $sharedWith: SharedWithInput!, $eta: String, $scheduleSnapshot: Boolean, $dateRange: AWSDateTimeRange!, $notes: String) { etaLink: createEtaLink(unitId: $unitId, entityId: $entityId, entityName: $entityName, landmarkId: $landmarkId, address: $address, latitude: $latitude, longitude: $longitude, sharedWith: $sharedWith, eta: $eta, scheduleSnapshot: $scheduleSnapshot, dateRange: $dateRange, notes: $notes) { id code status __typename } }";

  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  }

  // Resolve the Ignition unitId for a truck label at runtime; fall back to the request's hint.
  function resolveUnitId(tok, label, hint) {
    var want = norm(label);
    return gql(tok, SEARCH_UNITS, { limit: 100, offset: 0 })
      .then(function (j) {
        var items = (j && j.data && j.data.result && j.data.result.items) || [];
        if (want) {
          for (var i = 0; i < items.length; i++) {
            var l = norm(items[i].label);
            if (l && (l === want || l.indexOf(want) >= 0 || want.indexOf(l) >= 0)) return Number(items[i].id);
          }
        }
        return hint != null ? Number(hint) : null;
      })
      .catch(function () {
        return hint != null ? Number(hint) : null;
      });
  }

  function mint(req) {
    var tok = idToken();
    if (!tok) return Promise.resolve({ error: "no_id_token" });
    return resolveUnitId(tok, req.truckLabel, req.unitIdHint)
      .then(function (unitId) {
        if (unitId == null) return { error: "no_unit_for_" + (req.truckLabel || "?") };
        var vars = {
          unitId: unitId,
          entityId: unitId,
          entityName: "Unit",
          landmarkId: null,
          address: req.address,
          latitude: req.latitude,
          longitude: req.longitude,
          sharedWith: { contacts: [], emails: [], sms: [NOTIFY_SMS] }, // HARD RULE: Zoe line only
          eta: req.etaHours != null ? String(req.etaHours) : null,
          scheduleSnapshot: false,
          dateRange: { start: req.startISO, end: req.endISO },
          notes: null,
        };
        return gql(tok, CREATE_ETA, vars).then(function (j) {
          var el = j && j.data && j.data.etaLink;
          if (el && el.code) return { code: el.code };
          var err = (j && j.errors && j.errors[0] && j.errors[0].message) || "no_code";
          return { error: String(err).slice(0, 200) };
        });
      })
      .catch(function (e) {
        return { error: String(e).slice(0, 200) };
      });
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__zoe !== "eta-mint-req" || !d.id || !d.req) return;
    mint(d.req).then(function (res) {
      window.postMessage({ __zoe: "eta-mint-res", id: d.id, res: res }, "*");
    });
  });

  // Announce readiness so the content script knows the page bridge is live.
  try {
    window.postMessage({ __zoe: "eta-inject-ready" }, "*");
  } catch (e) {
    /* no-op */
  }
})();
