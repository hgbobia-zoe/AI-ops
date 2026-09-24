# Creative Engine ⇄ n8n integration contract

This is the **authoritative contract** the n8n workflow is built against. Zoe Tower (the Creative Engine)
is the **control plane**; n8n is the **orchestration/execution plane**; the AI image + vision models are the
**generation/vision services** n8n calls. Build the workflow strictly to what is written here — the app
already emits and accepts exactly these shapes.

| Plane | Owns |
| --- | --- |
| **Tower (Creative Engine)** | Creative Jobs, Visual DNA, the Image Brief, PRESERVE/TRANSFORM, asset metadata, job + generation state, generation history, human approval/rejection/feedback, final asset persistence, provider configuration, business rules, the attempt cap. |
| **n8n** | Orchestration, model selection + invocation, image download, image generation/editing, **vision QA**, the internal regeneration loop, temporary processing, and the callback to Tower. |
| **Models** | Image generation/editing (first production model: OpenAI image, model configurable) and vision QA scoring. |

Tower never calls a model directly in production; it hands the Brief to n8n and waits for a callback. Human
approval always gates publishing, regardless of what QA returns.

---

## 1. Webhook — purpose

**Tower → n8n**, one HTTP `POST` per generation **attempt** (one handoff).

- URL: configured in Tower at **Creative → provider config** (`creative.n8n.webhookUrl`, KV).
- Auth token: optional `creative.n8n.authToken` secret, sent as `Authorization: Bearer <token>`.
- The webhook **kicks off** an async run. n8n should respond immediately (2xx). Tower does **not** block on
  the image; the result returns later via the callback (§3). n8n may return `{ "executionId": "..." }` (or
  `runId`/`id`) in the immediate response — Tower stores it as the generation's `externalRef` for display.
- The request tells n8n everything it needs: the composed Brief, the aspect ratio, the PRESERVE/TRANSFORM
  split, signed URLs for any source/reference images, the model hint, the attempt number, the attempt cap,
  and the callback URL + per-generation token to answer with.

## 2. Request schema (Tower → n8n)

```jsonc
{
  "generationId": "CG-8f0c…",      // echo back on the callback (identifies the attempt)
  "jobId": "CJ-2a11…",             // the Creative Job
  "attempt": 1,                     // Nth handoff for this job
  "maxAttempts": 3,                 // Tower's cap; bound the INTERNAL regeneration loop to this
  "provider": "n8n",
  "model": "gpt-image-1",           // configured model hint; null = n8n chooses. Echo the ACTUAL model back.
  "callbackUrl": "https://app.example.com/api/creative/callback",
  "callbackToken": "b3c1…",         // opaque; echo verbatim as `token` on the callback
  "aspectRatio": "3:2",             // one of 16:9 | 4:3 | 3:2 | 1:1 | 4:5 | 9:16
  "preserve": [ "Tent structure and framing", "Furniture (tables, chairs, lounge)", "Inventory count (no added equipment)" ],
  "transform": [ "Lighting and atmosphere", "Weather and sky", "Background and surroundings" ],
  "source": { "url": "https://app.example.com/api/creative/image/CI-77…?exp=1750000000000&sig=Ab12…" },
  "references": [ { "url": "https://app.example.com/api/creative/image/CI-88…?exp=1750000000000&sig=Cd34…" } ],
  "brief": {
    "creativeConcept": "Premium commercial event photography for a hero asset…",
    "subject": "40x60 frame tent at a manicured estate, autumn",
    "environment": "an elevated DMV event venue. Refined tented environments.",
    "camera": "Full-frame perspective, natural depth of field",
    "lens": "24mm architectural wide",
    "lighting": "Natural daylight, golden hour warmth",
    "composition": "Architectural wide establishing shot",
    "colorGrade": "Deep blacks, warm-neutral whites, restrained gold accents",
    "peopleDirection": "Natural, candid guests… the rentals remain the hero.",
    "preserve": [ "Tent structure and framing", "…" ],
    "transform": [ "Lighting and atmosphere", "…" ],
    "negativeConstraints": [
      "Neon / obviously-AI color casts",
      "Distorted or warped architecture",
      "Invented rental equipment not in the source",
      "Do not add, remove, or alter any rental equipment present in the source photo.",
      "Do not change the physical configuration, counts, or proportions of the setup."
    ],
    "imagePrompt": "…the full composed prompt string the model should receive…",
    "briefSource": "rules",         // or "ai_refined"
    "dnaVersion": "dna_1a2b3c4d",   // which Visual DNA produced this brief
    "builtAt": "2026-09-24T12:00:00.000Z"
  },
  "meta": { "mode": "edit", "briefSource": "rules", "dnaVersion": "dna_1a2b3c4d" }
}
```

Notes:
- **`mode`**: `edit` = reference-first (a `source` image anchors it; PRESERVE it). `generate` = from scratch.
  Tower sets `edit` whenever the job is reference-first **and** a source image is attached.
- **`imagePrompt`** is already fully composed from the Brief + Visual DNA. Prefer it. Do not re-inject raw
  user text; the negative constraints and PRESERVE clauses in it are load-bearing.
- **Do not exceed `maxAttempts`** internal regenerations. Tower also refuses to hand off again past the cap.

## 3. Callback schema (n8n → Tower)

**n8n → `POST {callbackUrl}`** (`/api/creative/callback`), when the run finishes (success or failure).

```jsonc
{
  "generationId": "CG-8f0c…",       // REQUIRED — from the request
  "token": "b3c1…",                 // REQUIRED — the callbackToken from the request, verbatim
  "status": "succeeded",            // REQUIRED — "succeeded" | "failed"

  // On success, provide the final image ONE of two ways:
  "imageUrl": "https://cdn.example.com/out/final.png",   // Tower downloads it (30s timeout), OR
  "imageBase64": "data:image/png;base64,iVBORw0KGgo…",   // inline (data: URI or bare base64)
  "mime": "image/png",

  "model": "gpt-image-1",           // the model actually used, OR:
  "modelChain": ["gpt-image-1", "gpt-image-1-edit"],  // stored joined as "a → b"

  "qa": {                            // n8n's VISION QA — primary quality signal (see §7)
    "decision": "PASS",             // "PASS" | "FAIL" | "HUMAN_REVIEW"
    "score": 88,                    // overall 0..100
    "dimensions": {
      "productAccuracy": 92, "referenceFidelity": 90, "photographicQuality": 86,
      "architecturalRealism": 88, "humanRealism": 84, "brandAlignment": 90,
      "composition": 87, "webUsability": 89
    },
    "hardFailures": [],             // any entry → Tower forces FAIL (see §7)
    "issues": ["Slight banding in the sky"],
    "recommendedChanges": ["Warm the grade a touch on the next pass"],
    "note": "Clean reference-first edit; equipment preserved.",
    "checks": [ { "label": "Equipment matches source", "pass": true, "note": "" } ]
  },

  "error": null,                     // string when status = "failed"
  "meta": { "processingMs": 42000, "usage": { "images": 3 }, "cost": { "usd": 0.36 } }
}
```

**Response** from Tower: `200 { ok: true, already: <bool>, status: <jobStatus> }`. Errors: `400`
(`missing_fields` / `bad_status` / `invalid_json`), `401` (`unauthorized`), `422` (`no_image`).

## 4. Authentication

- **Webhook (Tower → n8n):** optional `Authorization: Bearer <creative.n8n.authToken>`. Configure the token in
  n8n so it rejects unauthenticated callers.
- **Callback (n8n → Tower):** the route is public (no session) and authenticates on the **per-generation
  callback token**. Tower mints `HMAC(callbackSecret, generationId:nonce)` at handoff, stores it on the
  generation row, and constant-time-compares the `token` you echo back. A missing generation and a wrong
  token both return `401` (the token *is* the credential; existence is not revealed).
- **Source/reference image URLs** are **signed and short-lived** (§6). They are not public.

## 5. Status lifecycle

**Job status** (`creative_jobs.status`) — always visible in the UI:

```
draft → queued → generating → qa → (needs_revision ↺) → awaiting_approval → approved → published
                                                     └────────────→ rejected (terminal)
```

Mapping to the conceptual flow (`QUEUED → PROCESSING → QA → AWAITING_APPROVAL / HUMAN_REVIEW → APPROVED / REJECTED`):

| Concept | Tower status |
| --- | --- |
| QUEUED | `queued` (Brief built, ready) |
| PROCESSING | `generating` (handed to n8n; awaiting callback) |
| QA | `qa` (sync path) / evaluated inline on the callback |
| AWAITING_APPROVAL | `awaiting_approval` (QA PASS → human review) |
| HUMAN_REVIEW | `needs_revision` (QA FAIL/HUMAN_REVIEW, or attempt cap hit — a human decides) |
| APPROVED | `approved` → `published` (saved asset) |
| REJECTED | `rejected` (terminal) |

**Generation status** (`creative_generations.status`): `generating → pass | fail | error` (async), then
`approved | rejected` on human action. A generation stays `generating` until its callback resolves it.

The frontend **polls** `GET /api/creative/jobs/{id}` every 4s while the job is `generating`, so the callback
result appears without a reload. Do not expect Tower to hold the HTTP connection open — it is fully async.

## 6. Image + reference handling

- **Source of truth vs creative latitude is explicit** in every request: `preserve[]` (must survive) vs
  `transform[]` (free to change), also embedded in `brief`. Reference-first jobs additionally carry hard
  negative clauses forbidding invented/altered equipment.
- **Source/reference URLs are signed, expiring links** to Tower's own asset route:
  `/api/creative/image/<id>?exp=<epoch_ms>&sig=<hmac>`. The proxy admits a GET **only** with a valid,
  unexpired signature — so n8n can download the bytes it needs, but private customer/event imagery is **not**
  publicly enumerable. Default TTL **6 hours** (`SOURCE_URL_TTL_MS`); fetch the source early in the run. An
  expired or tampered URL returns `401`.
- n8n returns the **final** image to Tower either as a downloadable `imageUrl` (Tower fetches within 30s) or
  inline `imageBase64`. Tower persists the bytes to its own volume and serves them from a new
  `creative_images` row — n8n's temporary output URL does not need to stay alive.
- Supported mimes: png, jpeg, webp, gif, svg, avif. Unknown/missing mime defaults to png.

## 7. QA schema

n8n runs the **vision QA** and its result is primary. Tower layers only a light **reference-first constraint
check** (was a required source photo attached?) and records everything; **human approval still gates**.

- **`decision`** ∈ `PASS | FAIL | HUMAN_REVIEW`. Preferred over the legacy binary `verdict`.
- **`score`**: overall 0..100.
- **`dimensions`** (each 0..100): `productAccuracy`, `referenceFidelity`, `photographicQuality`,
  `architecturalRealism`, `humanRealism`, `brandAlignment`, `composition`, `webUsability`. Send **all eight**
  or omit `dimensions` entirely — Tower drops a partial scorecard rather than store half-fabricated numbers.
- **`hardFailures[]`**, **`issues[]`**, **`recommendedChanges[]`**: string lists.
- **Hard-failure rule (non-negotiable):** if `hardFailures` is non-empty, Tower **forces FAIL regardless of
  the numeric scores**. A beautiful image with the wrong Zoe equipment must fail. Report a hard failure for:
  materially incorrect/misrepresented rental equipment, distorted tent structure, impossible architecture,
  obvious major AI artifacts, severe human-anatomy problems, or failure to preserve a required source element.
  Suggested codes: `incorrect_equipment`, `distorted_structure`, `impossible_architecture`, `major_ai_artifact`,
  `severe_anatomy`, `preserve_violation` (free-text also accepted).
- Routing: `PASS` → job `awaiting_approval`. `FAIL`/`HUMAN_REVIEW` (or a failed reference check) → job
  `needs_revision`. The full report (`decision`, `dimensions`, `hardFailures`, `issues`,
  `recommendedChanges`, per-check list) is stored on the generation and shown to the reviewer.

## 8. Retry behavior

- **Two loops.** n8n owns the **internal** regeneration loop within one handoff (attempt 1 → QA → fail →
  revised generation → QA → …), bounded by `maxAttempts`. Tower owns the **outer** cap on handoffs.
- **Default max = 3** (`DEFAULT_MAX_ATTEMPTS`, overridable via `CREATIVE_MAX_ATTEMPTS`). Sent as `maxAttempts`.
- **No infinite loops.** Once a job's attempt number would exceed the cap, Tower **refuses to hand off** and
  parks the job in `needs_revision` (human review) with a `max_attempts` audit event.
- A human can always request another pass from `needs_revision` (which starts a fresh handoff, subject to the
  cap) or reject the job.

## 9. Failure behavior

- **n8n unavailable / webhook non-2xx / network error:** the handoff fails immediately. The generation is
  marked `error` and the job parks in `needs_revision` with a `handoff_failed` event. Nothing is fabricated.
- **Callback `status: "failed"`:** generation → `error`, job → `needs_revision` (`n8n_failed`), `error` logged.
- **Callback succeeded but no usable image:** generation → `error`, job → `needs_revision` (`n8n_no_image`),
  Tower responds `422 no_image`.
- **Callback never arrives:** the generation stays `generating` and the UI keeps showing "waiting for result";
  no timeout auto-fails it. The reviewer can regenerate (new handoff) at any time. (There is no server-side
  reaper today — a stuck attempt is resolved by a human regenerating, within the attempt cap.)

## 10. Idempotency rules

- **`generationId` is the idempotency key.** The callback route **atomically claims** the pending generation
  (`UPDATE … WHERE status='generating' AND callback_claimed_at IS NULL`). Only the **first** callback wins.
- A **duplicate or concurrent** callback for the same generation returns `200 { already: true }` and is a
  **no-op**: it does **not** create a second generation record, does not re-download the image, and does not
  overwrite a later state (e.g. a human approval that already happened).
- Therefore n8n may safely retry the callback on a network timeout — at most one takes effect.
- New generation records are only ever created by an explicit Tower handoff (a human/queued action), never by
  a callback.

---

### Environment / config checklist

- `creative.n8n.webhookUrl` (KV) — set at Creative → provider config; select provider `n8n`.
- `creative.n8n.authToken` (secret, optional) — bearer token Tower sends to the webhook.
- `creative.n8n.callbackSecret` (secret) — auto-minted; derives per-generation callback tokens.
- `PUBLIC_BASE_URL` (env, set on Fly) — the public origin Tower puts in `callbackUrl` and signed image URLs.
- `APP_SESSION_TOKEN` (env) — also signs the short-lived image URLs; when unset, the auth gate (and URL
  signing) is disabled for local dev.
- `CREATIVE_MAX_ATTEMPTS` (env, optional) — overrides the default attempt cap of 3.
