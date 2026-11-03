import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

// KV as JSON strings, like the real settings table, so saved state is a snapshot and not a live reference.
const store = new Map<string, string>();
vi.mock("@/lib/kv", () => ({
  getJson: (k: string, d: unknown) => (store.has(k) ? JSON.parse(store.get(k)!) : d),
  setJson: (k: string, v: unknown) => void store.set(k, JSON.stringify(v)),
}));
vi.mock("@/lib/comms/openphone", () => ({ openphoneApiKey: () => "test-key" }));

import {
  addParticipant,
  aggregate,
  deriveState,
  finalize,
  inSalesHours,
  localParts,
  newAcc,
  STALE_MS,
  type Checkpoint,
  type HoursAcc,
  type QuoEvent,
  type RunState,
} from "./quoHours";

describe("quoHours", () => {
  it("buckets in Eastern time", () => {
    // 2026-07-06 is a Monday; 14:30Z = 10:30 EDT
    expect(localParts("2026-07-06T14:30:00Z")).toMatchObject({ dow: 1, hour: 10, month: 7 });
  });

  it("knows the posted hours", () => {
    expect(inSalesHours(1, 9)).toBe(false);
    expect(inSalesHours(1, 17)).toBe(true);
    expect(inSalesHours(6, 13)).toBe(false);
    expect(inSalesHours(0, 12)).toBe(false);
  });

  it("counts calls, misses, after-hours and reply time", () => {
    const ev: QuoEvent[] = [
      { kind: "call", dir: "in", at: "2026-07-06T23:00:00Z", missed: true, who: "a" }, // Mon 7pm, after hours
      { kind: "text", dir: "out", at: "2026-07-07T14:00:00Z", who: "a" }, // reply next day 10am (15h)
      { kind: "text", dir: "in", at: "2026-07-07T15:00:00Z", who: "b" }, // Tue 11am
      { kind: "text", dir: "out", at: "2026-07-07T15:10:00Z", who: "b" }, // 10 min reply
    ];
    const r = aggregate(ev, "2026-07-01T00:00:00Z", "2026-07-31T00:00:00Z", 2);
    expect(r.totals).toMatchObject({ callsIn: 1, callsMissed: 1, textsIn: 1, textsOut: 2 });
    expect(r.afterHours).toMatchObject({ inbound: 1, missedCalls: 1, share: 50 });
    expect(r.grid.all[1][19]).toMatchObject({ callsIn: 1, callsMissed: 1, medianReplyMins: 900 });
    expect(r.grid.all[2][11].medianReplyMins).toBe(10);
    expect(r.grid.off[2][11].textsIn).toBe(0);
    expect(r.grid.peak[2][11].textsIn).toBe(1);
  });

  it("gives the same report when the totals are saved and reloaded part way", () => {
    const from = "2026-01-01T00:00:00Z";
    const to = "2026-12-31T00:00:00Z";
    const people: QuoEvent[][] = Array.from({ length: 6 }, (_, i) => [
      { kind: "text", dir: "in", at: `2026-0${i + 1}-10T15:00:00Z`, who: `p${i}` },
      { kind: "call", dir: "in", at: `2026-0${i + 1}-10T23:00:00Z`, missed: true, who: `p${i}` },
      { kind: "text", dir: "out", at: `2026-0${i + 1}-11T14:${String(i).padStart(2, "0")}:00Z`, who: `p${i}` },
    ]);
    const oneGo = aggregate(people.flat(), from, to, 6);

    let acc = newAcc();
    people.slice(0, 3).forEach((ev) => addParticipant(acc, ev, from, to));
    acc = JSON.parse(JSON.stringify(acc)) as HoursAcc; // what a restart would read back from KV
    people.slice(3).forEach((ev) => addParticipant(acc, ev, from, to));
    const resumed = finalize(acc, from, to, 6);

    expect({ ...resumed, generatedAt: "" }).toEqual({ ...oneGo, generatedAt: "" });
  });
});

describe("deriveState", () => {
  const now = Date.parse("2026-11-03T03:00:00Z");
  const ck = (over: Partial<Checkpoint> = {}): Checkpoint => ({
    v: 1,
    days: 365,
    from: "2025-11-02T23:00:00Z",
    to: "2026-11-02T23:00:00Z",
    startedAt: "2026-11-02T23:00:00Z",
    updatedAt: "2026-11-02T23:40:00Z",
    resumes: 0,
    salt: "s",
    processed: ["a"],
    acc: newAcc(),
    ...over,
  });
  const running: RunState = {
    status: "running",
    startedAt: "2026-11-02T23:00:00Z",
    updatedAt: "2026-11-02T23:40:00Z",
    days: 365,
    progress: { conversations: 7489, done: 1600, requests: 9000 },
  };

  it("calls a run nobody in this process is running interrupted, and offers to resume", () => {
    const s = deriveState(running, { live: false, now, checkpoint: ck() });
    expect(s.status).toBe("interrupted");
    expect(s.resumable).toBe(true);
    expect(s.note).toContain("1600 of 7489");
    expect(s.note).not.toMatch(/[-–—]/); // house rule: no dashes in user facing text
  });

  it("handles the old state shape (no updatedAt, no checkpoint) left by the 2026-11-02 restart", () => {
    const legacy: RunState = { status: "running", startedAt: "2026-11-02T22:00:00Z", progress: { conversations: 7489, done: 1600, requests: 1 } };
    const s = deriveState(legacy, { live: false, now, checkpoint: null });
    expect(s).toMatchObject({ status: "interrupted", resumable: false });
    expect(s.note).toContain("start over");
  });

  it("flags a live run that has not saved progress for a while as stale", () => {
    const fresh = deriveState({ ...running, updatedAt: new Date(now - 60_000).toISOString() }, { live: true, now, checkpoint: ck() });
    expect(fresh.status).toBe("running");
    const hung = deriveState({ ...running, updatedAt: new Date(now - STALE_MS - 60_000).toISOString() }, { live: true, now, checkpoint: ck() });
    expect(hung.status).toBe("stale");
    expect(hung.note).not.toMatch(/[-–—]/);
  });

  it("will not resume a checkpoint for a different window or one that is too old", () => {
    expect(deriveState(running, { live: false, now, checkpoint: ck({ days: 90 }) }).resumable).toBe(false);
    expect(deriveState(running, { live: false, now, checkpoint: ck({ startedAt: "2026-10-30T00:00:00Z" }) }).resumable).toBe(false);
  });

  it("leaves done and idle states alone", () => {
    expect(deriveState({ status: "done", progress: running.progress }, { live: false, now, checkpoint: null }).status).toBe("done");
    expect(deriveState({ status: "idle" }, { live: false, now, checkpoint: null }).status).toBe("idle");
  });
});

// ── Runner: restart in the middle, then resume ────────────────────────────────────────────────────────

const N = 40; // participants; checkpoints land at 25
const phone = (i: number) => `+1555000${String(i).padStart(4, "0")}`;

/** Fake Quo: one of our numbers, N single participant conversations, one missed call + one reply each.
 *  `hangAt` makes that participant's calls request never answer (until released), like a dead process. */
function fakeQuo(opts: { hangAt?: number } = {}) {
  const base = Date.now() - 20 * 86400000;
  const callFetches = new Map<string, number>();
  let release: (() => void) | null = null;
  const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
  const fetchImpl = vi.fn(async (input: string | URL | Request) => {
    const u = new URL(String(input));
    const who = u.searchParams.get("participants") ?? "";
    const i = who ? Number(who.slice(-4)) : -1;
    const at = (mins: number) => new Date(base + i * 3600_000 + mins * 60_000).toISOString();
    if (u.pathname.endsWith("/phone-numbers")) return json([{ id: "PN1" }]);
    if (u.pathname.endsWith("/conversations")) return json(Array.from({ length: N }, (_, k) => ({ participants: [phone(k)] })));
    if (u.pathname.endsWith("/calls")) {
      callFetches.set(who, (callFetches.get(who) ?? 0) + 1);
      if (opts.hangAt === i) {
        opts.hangAt = undefined; // only the first request hangs; a resumed run gets an answer
        await new Promise<void>((r) => (release = r));
      }
      return json([{ createdAt: at(0), direction: "incoming", answeredAt: null }]);
    }
    if (u.pathname.endsWith("/messages")) return json([{ createdAt: at(30), direction: "outgoing" }]);
    return new Response("{}", { status: 404 });
  });
  return { fetchImpl, callFetches, release: () => release?.() };
}

async function until(cond: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 2));
  }
}

const kvState = () => JSON.parse(store.get("analytics.quoHours") ?? "{}") as RunState;
const kvCheckpoint = () => JSON.parse(store.get("analytics.quoHours.checkpoint") ?? "null") as Checkpoint | null;

/** A fresh copy of the module: what the process looks like after a deploy restarts the machine. */
async function freshProcess() {
  vi.resetModules();
  const m = await import("./quoHours");
  m.setPaceScaleForTests(0);
  return m;
}

describe("startRun resume after a restart", () => {
  beforeEach(() => store.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("picks up from the checkpoint instead of redoing finished conversations", async () => {
    // Reference: one uninterrupted run.
    const ref = fakeQuo();
    vi.stubGlobal("fetch", ref.fetchImpl);
    let m = await freshProcess();
    m.startRun(365);
    await until(() => kvState().status === "done");
    const expected = kvState().report!;
    expect(expected.totals).toMatchObject({ callsIn: N, callsMissed: N, textsOut: N, conversations: N });
    store.clear();

    // Run 1 dies at participant 30, after the checkpoint at 25.
    const q = fakeQuo({ hangAt: 30 });
    vi.stubGlobal("fetch", q.fetchImpl);
    m = await freshProcess();
    m.startRun(365);
    await until(() => (kvCheckpoint()?.processed.length ?? 0) === 25 && q.callFetches.has(phone(30)));

    // Restart: the KV still says running, but nobody is.
    m = await freshProcess();
    const dead = m.getRunState();
    expect(dead.status).toBe("interrupted");
    expect(dead.resumable).toBe(true);
    expect(dead.progress).toMatchObject({ done: 25, conversations: N });

    const resumed = m.startRun(365);
    expect(resumed.status).toBe("running");
    expect(resumed.resumes).toBe(1);
    await until(() => kvState().status === "done");

    // Conversations 0..24 were fetched once (before the restart); the rest picked up after it.
    for (let i = 0; i < 25; i++) expect(q.callFetches.get(phone(i))).toBe(1);
    for (let i = 31; i < N; i++) expect(q.callFetches.get(phone(i))).toBe(1);
    expect(q.callFetches.get(phone(30))).toBe(2); // the one in flight when it died is redone

    const got = kvState();
    expect(got.resumes).toBe(1);
    expect({ ...got.report!, generatedAt: "" }).toEqual({ ...expected, generatedAt: "", from: got.report!.from, to: got.report!.to, daysPerDow: got.report!.daysPerDow });
    expect(kvCheckpoint()).toBeNull(); // cleared once done
  });

  it("supersedes a stale run in the same process without double counting", async () => {
    const q = fakeQuo({ hangAt: 30 });
    vi.stubGlobal("fetch", q.fetchImpl);
    const m = await freshProcess();
    m.startRun(365);
    await until(() => (kvCheckpoint()?.processed.length ?? 0) === 25 && q.callFetches.has(phone(30)));
    expect(m.getRunState().status).toBe("running");

    // Twenty minutes with no progress: stale, and a new POST takes over.
    const later = Date.now() + STALE_MS + 5 * 60_000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(later);
    expect(m.getRunState().status).toBe("stale");
    const again = m.startRun(365);
    spy.mockRestore();
    expect(again.resumes).toBe(1);
    await until(() => kvState().status === "done");

    // The old loop wakes up late; it must not write anything.
    const doneSnapshot = store.get("analytics.quoHours");
    q.release();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.get("analytics.quoHours")).toBe(doneSnapshot);
    expect(kvState().report!.totals).toMatchObject({ callsIn: N, callsMissed: N, textsOut: N, conversations: N });
  });

  it("starts over when asked for a fresh run", async () => {
    const q = fakeQuo({ hangAt: 30 });
    vi.stubGlobal("fetch", q.fetchImpl);
    let m = await freshProcess();
    m.startRun(365);
    await until(() => (kvCheckpoint()?.processed.length ?? 0) === 25 && q.callFetches.has(phone(30)));

    m = await freshProcess();
    const s = m.startRun(365, { fresh: true });
    expect(s.resumes).toBe(0);
    await until(() => kvState().status === "done");
    expect(q.callFetches.get(phone(0))).toBe(2);
    expect(kvState().report!.totals.callsIn).toBe(N);
  });

  it("keeps customer numbers out of everything it stores or returns", async () => {
    const q = fakeQuo({ hangAt: 30 });
    vi.stubGlobal("fetch", q.fetchImpl);
    let m = await freshProcess();
    m.startRun(365);
    await until(() => (kvCheckpoint()?.processed.length ?? 0) === 25 && q.callFetches.has(phone(30)));
    m = await freshProcess();
    const seen = [store.get("analytics.quoHours"), store.get("analytics.quoHours.checkpoint"), JSON.stringify(m.getRunState())].join("\n");
    expect(seen).not.toContain("+1555");
    expect(seen).not.toContain("15550000");
    expect(JSON.stringify(m.getRunState())).not.toContain("processed"); // checkpoint never rides along on GET
  });
});
