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

1. In Instantly, go to Settings → Integrations → API keys. Create a key with the **leads**, **campaigns**
   and **email verifications** scopes (or "all").
2. Buy email verification credits in Instantly. Zoe checks every address before it goes into a campaign,
   and each check uses 1 credit.
3. In Zoe, go to Radar → Outreach → Cold email → Settings and pick **Instantly**.
4. Paste the key.
5. Paste the campaign id. It is the long id in the campaign URL, for example
   `app.instantly.ai/app/campaign/1a2b3c4d-.../...`.
6. Click **Save and test**. Zoe reads the campaign back and shows its name and status. "draft" or "paused"
   is expected until warm-up ends.

## 5. Day to day

- **Push a batch:** in Radar → Outreach, click **Review email push**. Untick anyone you don't want,
  then click **Approve and push**. Zoe checks each address first and sends only the ones that pass.
- **Email check (bounce protection):** nothing goes into a campaign unless its address passed. First a
  free check: a domain with no mail server is dropped without spending a credit. Then Instantly's verifier
  (1 credit per address). Results are kept for 90 days and shared across lists and Radar, so nobody is
  checked twice. Catch-all addresses (the domain accepts anything, so the person can't be confirmed) are
  held back unless a list turns them on.
- **Who never gets pushed:** anyone on the do-not-contact list, anyone Sales OS owns (an open quote or a
  recent customer), and anyone already in the Instantly workspace.
- **Replies:** Instantly stops the sequence. Handle the reply in Instantly's inbox (Unibox) for now. If
  the reply shows intent, convert the opportunity to Goodshuffle from Radar (intent only).

## 6. Purchased lists (venues, planners, corporate, associations)

Besides the contacts Radar finds, Zoe buys lists to cold email. In Zoe these live at **Radar → Lists**
(owner and admin only).

1. **Import:** export a CSV from the list seller (Apollo, ZoomInfo, a broker) and import it. Only an
   email column is required; names, title, company, website, phone, city and state are picked up when
   present. Enter what the list cost so Zoe can show cost per reply and cost per interested lead.
2. **One campaign per segment:** in Instantly, create one campaign per type of buyer (for example
   "Venues partner" and "Planners"), each with copy written for that audience. Put that campaign's id on
   the list (Edit list). A list without its own campaign uses the default one.
   Each lead arrives with `{{firstName}}`, `{{companyName}}`, `{{title}}`, `{{city}}`, `{{segment}}`
   and `{{list}}`.
3. **Screening:** each list shows who is Ready and who can't be sent, with the reason. The same rules apply
   as for Radar: the do-not-contact list, Sales OS customers and open quotes, anyone already emailed from
   another list or from Radar outreach, and Zoe's own addresses.
4. **Check emails:** click **Check N emails**, then **Yes, check them**. Dead domains are removed for
   free, then Instantly verifies the rest. Contacts move to Ready (passed) or Can't send (would bounce,
   no mail server, catch-all). To send catch-all addresses too, tick it in Edit list.
5. **Send:** click **Review and send**, then **Approve and send**. Only Ready contacts go, at most 500 per
   push. Start with a few hundred and keep the bounce rate under about 3% before sending more.
6. **Replies:** log them on the contact (Log reply). Not interested, bounced and unsubscribed go on the
   do-not-contact list automatically. **Interested** creates a Radar opportunity at stage Engaged, linked
   to the contact. Convert it to Goodshuffle from there once they ask for a quote (intent only).
7. **Lists you scrape yourself (Apify Google Maps Scraper):** export the run as CSV and import it as is.
   Zoe reads the place name as the company and takes the first good email per place. Emails exist only
   when the run had the **Company contacts enrichment** add-on on (it reads emails off each business
   website), so places without a website come in empty and are left out. These are mostly shared inboxes
   (events@, info@) with no person's name, so write the venue copy to read well without `{{firstName}}`.
8. **Deleting a list:** a list can be deleted only if nobody on it was emailed yet. Once anyone was sent,
   the list is kept as the record of who was emailed.

## Not built yet

- **Pulling replies back into Zoe automatically.** The webhook needs Instantly's Hypergrowth plan.
  Polling the API on Growth works too; build that once there is real reply volume.
- **Pausing or removing a lead in Instantly from Zoe.** Do it in Instantly for now.

## Code

- `src/lib/prospecting/verify.ts`: the email check (domain check, `POST /api/v2/email-verification`,
  saved results in `email_verifications`), used by lists and Radar before any push.
- `src/lib/prospecting/instantly.ts`: the API v2 calls (`POST /api/v2/leads/add`, `GET /api/v2/campaigns/{id}`).
- `src/lib/prospecting/sequencer.ts`: chooses the tool, stores keys per tool, keeps the Smartlead path,
  and holds the compliance footer.
- `src/lib/prospecting/service.ts` `pushApproved`: the approve-then-push flow, shared by both tools.
- `/api/prospecting/provider`: settings (keys are write-only). `/api/prospecting/push`: review and approve.
