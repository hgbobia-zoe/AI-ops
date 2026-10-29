import { describe, expect, it } from "vitest";
import {
  summarizePlan,
  executionState,
  deriveSteps,
  SKIP_DUPLICATE_IN_ZOE,
  SKIP_DUPLICATE_IN_BATCH,
  SKIP_NO_TITLE,
  type ExecutionState,
} from "./viewModel";
import type { PlanResponse, PlanGroupSummary } from "./service";
import type { PlannedItem, SkippedItem } from "./importPlan";

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────────
const item = (over: Partial<PlannedItem> = {}): PlannedItem => ({
  sourceId: over.sourceId ?? Math.random().toString(36).slice(2),
  title: over.title ?? "Velvet Sofa",
  descriptionHtml: over.descriptionHtml ?? "<p>comfy</p>",
  tags: over.tags ?? ["Subrental"],
  zoeGroup: over.zoeGroup ?? "Sofas",
  imageUrls: over.imageUrls ?? ["https://img/a.jpg"],
  unpriced: over.unpriced ?? true,
  trackQuantity: over.trackQuantity ?? false,
});

const group = (over: Partial<PlanGroupSummary> = {}): PlanGroupSummary => ({
  key: over.key ?? "sofas",
  label: over.label ?? "Sofas",
  targetCategory: over.targetCategory ?? "Sofas",
  sourceCount: over.sourceCount ?? 3,
  sourceOk: over.sourceOk ?? true,
  alreadyInZoeCount: over.alreadyInZoeCount ?? 0,
  zoeOk: over.zoeOk ?? true,
  categoryResolved: over.categoryResolved ?? true,
});

const plan = (over: Partial<PlanResponse> = {}): PlanResponse => ({
  ok: true,
  partnerLabel: over.partnerLabel ?? "Staging Design DC",
  policy: over.policy ?? { unpriced: true, trackQuantity: false, addTags: ["Subrental"] },
  groups: over.groups ?? [group()],
  plan: over.plan ?? { toCreate: [item()], skipped: [], warnings: [] },
  warnings: over.warnings ?? [],
  categories: over.categories ?? {},
  unresolvedCategories: over.unresolvedCategories ?? [],
  internalNotes: over.internalNotes ?? "Subrent from Staging Design DC.",
  zoeToken: over.zoeToken ?? "zoe-token",
  backfillItems: over.backfillItems ?? [],
});

// ── summarizePlan ──────────────────────────────────────────────────────────────────────────────────
describe("summarizePlan", () => {
  it("classifies skip reasons into duplicates vs no-title (and leaves others uncounted)", () => {
    const skipped: SkippedItem[] = [
      { title: "A", reason: SKIP_DUPLICATE_IN_ZOE },
      { title: "B", reason: SKIP_DUPLICATE_IN_BATCH },
      { title: "(untitled)", reason: SKIP_NO_TITLE },
      { title: "C", reason: "some other reason" },
    ];
    const s = summarizePlan(plan({ plan: { toCreate: [], skipped, warnings: [] } }));
    expect(s.skippedTotal).toBe(4);
    expect(s.skippedDuplicates).toBe(2);
    expect(s.skippedNoTitle).toBe(1);
  });

  it("counts photos and items missing photos honestly", () => {
    const s = summarizePlan(
      plan({
        plan: {
          toCreate: [
            item({ imageUrls: ["a", "b"] }),
            item({ imageUrls: [] }),
            item({ imageUrls: ["c"] }),
          ],
          skipped: [],
          warnings: [],
        },
      }),
    );
    expect(s.toCreate).toBe(3);
    expect(s.totalPhotos).toBe(3);
    expect(s.itemsWithPhotos).toBe(2);
    expect(s.itemsMissingPhotos).toBe(1);
  });

  it("sums already-in-Zoe across groups and flags a partial read when a catalog fetch failed", () => {
    const s = summarizePlan(
      plan({
        groups: [
          group({ alreadyInZoeCount: 2, sourceOk: true, zoeOk: true }),
          group({ key: "chairs", alreadyInZoeCount: 1, sourceOk: false, zoeOk: true }),
        ],
      }),
    );
    expect(s.alreadyInZoe).toBe(3);
    expect(s.partialRead).toBe(true);
    expect(s.groupsCount).toBe(2);
  });

  it("combines service-level and item-level warnings", () => {
    const s = summarizePlan(
      plan({ warnings: ["catalog partial"], plan: { toCreate: [item()], skipped: [], warnings: ["no images: X", "no images: Y"] } }),
    );
    expect(s.warningsCount).toBe(3);
  });
});

// ── executionState ─────────────────────────────────────────────────────────────────────────────────
describe("executionState", () => {
  it("is 'no-plan' before a preview", () => {
    expect(executionState(null).status).toBe("no-plan");
  });

  it("is 'nothing' when the plan creates no items", () => {
    const e = executionState(plan({ plan: { toCreate: [], skipped: [], warnings: [] } }));
    expect(e.status).toBe("nothing");
    expect(e.count).toBe(0);
  });

  it("is 'blocked' (not ready) when a target category is unresolved, naming the categories", () => {
    const e = executionState(plan({ unresolvedCategories: ["Barstools", "Linens"] }));
    expect(e.status).toBe("blocked");
    expect(e.reason).toContain("Barstools");
    expect(e.reason).toContain("Linens");
  });

  it("blocked wins even when there are items to create (fails closed)", () => {
    const e = executionState(plan({ plan: { toCreate: [item(), item()], skipped: [], warnings: [] }, unresolvedCategories: ["X"] }));
    expect(e.status).toBe("blocked");
    expect(e.count).toBe(2);
  });

  it("is 'ready' with the item count when there is a clean, fully-resolved plan", () => {
    const e = executionState(plan({ plan: { toCreate: [item(), item()], skipped: [], warnings: [] } }));
    expect(e.status).toBe("ready");
    expect(e.count).toBe(2);
    expect(e.reason).toContain("2 items");
  });
});

// ── deriveSteps ────────────────────────────────────────────────────────────────────────────────────
describe("deriveSteps", () => {
  const noPlanExec: ExecutionState = { status: "no-plan", count: 0, unresolved: [], reason: "r" };

  it("always returns four ordered, consecutively-numbered steps", () => {
    const steps = deriveSteps({ hasPartner: false, selectedGroups: 0, hasPlan: false, exec: noPlanExec });
    expect(steps.map((s) => s.index)).toEqual([1, 2, 3, 4]);
    expect(steps.map((s) => s.key)).toEqual(["partner", "configure", "preview", "execute"]);
  });

  it("locks configure/preview/execute until a partner is chosen, explaining why", () => {
    const steps = deriveSteps({ hasPartner: false, selectedGroups: 0, hasPlan: false, exec: noPlanExec });
    expect(steps[0].state).toBe("current"); // partner
    expect(steps[1].state).toBe("locked"); // configure
    expect(steps[2].state).toBe("locked"); // preview
    expect(steps[2].detail).toMatch(/select a partner/i);
    expect(steps[3].state).toBe("locked"); // execute
  });

  it("tells the operator to pick a group when a partner is chosen but none are selected", () => {
    const steps = deriveSteps({ hasPartner: true, selectedGroups: 0, hasPlan: false, exec: noPlanExec });
    expect(steps[0].state).toBe("done");
    expect(steps[2].state).toBe("current");
    expect(steps[2].detail).toMatch(/at least one group/i);
  });

  it("marks configure + preview done once a plan exists and opens execute when ready", () => {
    const exec: ExecutionState = { status: "ready", count: 5, unresolved: [], reason: "Ready" };
    const steps = deriveSteps({ hasPartner: true, selectedGroups: 2, hasPlan: true, exec });
    expect(steps[1].state).toBe("done");
    expect(steps[2].state).toBe("done");
    expect(steps[3].state).toBe("current");
    expect(steps[3].detail).toBeUndefined();
  });

  it("keeps execute locked and surfaces the block reason when the plan is blocked", () => {
    const exec: ExecutionState = { status: "blocked", count: 3, unresolved: ["X"], reason: "No Goodshuffle category id for X." };
    const steps = deriveSteps({ hasPartner: true, selectedGroups: 1, hasPlan: true, exec });
    expect(steps[3].state).toBe("locked");
    expect(steps[3].detail).toContain("No Goodshuffle category id for X.");
  });
});
