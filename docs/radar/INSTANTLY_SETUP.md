# Instantly setup for Radar cold email

Owner decision (2026-11-08): Radar Tier B email goes through **Instantly** instead of Smartlead.
Main reasons: the API is included on Instantly's cheapest plan (Smartlead charges $94 for it), and
Instantly sells warmed sending inboxes as an add-on. Smartlead is still supported as a second option in
the same settings panel.

Zoe never sends email itself. A person reviews and approves each batch in Zoe. Instantly then sends from
its warmed inboxes, handles unsubscribes, and stops when someone replies.

## 1. Account and plan (owner)

1. Create the account at instantly.ai. Pick **Growth** (about $47/month, or $37.60/month billed yearly):
   1,000 contacts and 5,000 emails a month, with unlimited inboxes and warm-up.
2. Before paying, check on the live pricing page that Growth includes **API access**. The official page
   says every plan does; some third-party reviews disagree.
3. Skip the CRM and AI credit add-ons. Zoe does not use them.

## 2. Sending domains and inboxes

Never send cold email from zoeeventsdmv.com.

- Buy 2 branded lookalike domains (for example getzoeevents.com and tryzoeevents.com, about $15/year each).
- Add 2 Google inboxes per domain, 4 in total, sending as Hermann Gbobia (about $5/month each, done-for-you).
- Have each outreach domain redirect to zoeeventsdmv.com.
- Turn on warm-up for every inbox and wait **about 3 weeks** before the first real send.
- Keep each inbox to 20 to 30 sends a day.

Before paying, review the checkout line by line. One review site quotes a Trustpilot complaint about how
Instantly presents its done-for-you add-ons.

## 3. Campaign

Create one campaign named "Radar Tier B":

- Step 1 subject: `{{intro_subject}}`
- Step 1 body: `{{intro_body}}`. Zoe writes the personalized intro and already ends it with the mailing
  address and a "reply remove" line.
- Steps 2 and 3: short follow-ups in house style (no dashes, natural, short).
- Settings: **Stop on reply ON**, unsubscribe link ON, text-only, sending window weekdays 9 to 5 Eastern,
  send from all 4 outreach inboxes.
- Leave the campaign **paused** until warm-up is finished.

Each lead also arrives with these variables: `{{opportunity}}`, `{{event_date}}`, `{{jurisdiction}}`,
`{{location}}`, plus `{{companyName}}`.

## 4. Connect Zoe (owner pastes the key; never share it in chat)

1. In Instantly, go to Settings → Integrations → API keys. Create a key with the **leads** and **campaigns**
   scopes.
2. In Zoe, go to Radar → Outreach → Cold email → Settings and pick **Instantly**.
3. Paste the key.
4. Paste the campaign id. It is the long id in the campaign URL, for example
   `app.instantly.ai/app/campaign/1a2b3c4d-.../...`.
5. Click **Save and test**. Zoe reads the campaign back and shows its name and status. "draft" or "paused"
   is expected until warm-up ends.

## 5. Day to day

- **Push a batch:** in Radar → Outreach, click **Review email push**. Untick anyone you don't want,
  then click **Approve and push**. Only ticked, eligible leads go to Instantly.
- **Who never gets pushed:** anyone on the do-not-contact list, anyone Sales OS owns (an open quote or a
  recent customer), and anyone already in the Instantly workspace.
- **Replies:** Instantly stops the sequence. Handle the reply in Instantly's inbox (Unibox) for now. If
  the reply shows intent, convert the opportunity to Goodshuffle from Radar (intent only).

## Not built yet

- **Pulling replies back into Zoe automatically.** The webhook needs Instantly's Hypergrowth plan.
  Polling the API on Growth works too; build that once there is real reply volume.
- **Pausing or removing a lead in Instantly from Zoe.** Do it in Instantly for now.

## Code

- `src/lib/prospecting/instantly.ts`: the API v2 calls (`POST /api/v2/leads/add`, `GET /api/v2/campaigns/{id}`).
- `src/lib/prospecting/sequencer.ts`: chooses the tool, stores keys per tool, keeps the Smartlead path,
  and holds the compliance footer.
- `src/lib/prospecting/service.ts` `pushApproved`: the approve-then-push flow, shared by both tools.
- `/api/prospecting/provider`: settings (keys are write-only). `/api/prospecting/push`: review and approve.
