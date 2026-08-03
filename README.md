# Zoe Dispatch — AI Operations Platform (Module 1)

Tablet-first web app for delivery drivers. Each truck's tablet selects its truck
(no login) and captures driver actions as discrete events. Everything slow — SMS,
Slack, route scraping, tracking links — happens asynchronously in the backend, so
the tablet stays sub-second.

Dispatch is the first module of a deliberately modular AI Operations Platform
(Fleet, Warehouse, Inventory, AI Ops Manager…). Clean seams now; those modules later.

## Architecture in one paragraph

The tablet renders state-aware buttons from a shared **state machine**
(`src/lib/stateMachine.ts`) and fires **one webhook per action** at a thin intake
(`/api/action`) that validates the transition, dedupes on an idempotency key, and
forwards the event to **Zapier** for fan-out. **Zapier Tables** is the v1 system of
record (viable because one stop is only ever touched by one tablet). Actions taken
offline are queued and replayed on reconnect. The data source sits behind our own API
routes, so swapping mock → Zapier Tables → Supabase never touches the client.

## Run locally

```bash
npm install
npm run dev
```

Runs on mock data — the full driver flow works with **no backend wired up**. Open on a
tablet viewport.

## Wiring up real backends

See [SETUP.md](SETUP.md) for the Zapier Tables schema, Zaps, integrations, Vercel deploy,
and the M2 Goodshuffle (Anthropic Computer Use) ingestion.

## Status

- **M0 Foundations** — ✅ scaffold, state machine, PWA
- **M1 Tablet shell + action pipeline** — ✅ truck select, state walk, checklist,
  exceptions, offline queue, intake (validate/dedupe/forward)
- **M2 Route ingestion** → **M6 AI Ops Manager** — see SETUP.md / the plan
