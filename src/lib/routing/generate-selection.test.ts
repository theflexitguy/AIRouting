import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addDaysIso,
  defaultGenerateHorizon,
  validateGenerateHorizon,
} from "./drive-time-honesty.ts";
import {
  SHARED_ROUTE_CLASS,
  canScheduleJobOnDate,
  compareJobsForGenerate,
  fillDaysByRouteClass,
  homeTechForJob,
  jobMatchesPreferredWeekday,
  pickRouteClassForDay,
  placeJobOnTech,
  routeClassOf,
  techHasRequiredSkills,
  type SelectionJob,
  type SelectionTech,
} from "./generate-selection.ts";

function job(partial: Partial<SelectionJob> & { docId: string }): SelectionJob {
  return { customerName: partial.docId, ...partial };
}

function tech(partial: Partial<SelectionTech> & { id: string }): SelectionTech {
  return { name: partial.id, ...partial };
}

describe("generate horizon defaults + validation", () => {
  it("defaults to today+2 through today+7, capped at +14", () => {
    const horizon = defaultGenerateHorizon("2026-09-09");
    assert.equal(horizon.startDate, "2026-09-11");
    assert.equal(horizon.endDate, "2026-09-16");
    assert.equal(addDaysIso("2026-09-09", 14), "2026-09-23");
  });

  it("rejects too soon and too far, allows the default window", () => {
    const today = "2026-09-09";
    assert.equal(validateGenerateHorizon("2026-09-09", "2026-09-09", today).ok, false);
    assert.equal(validateGenerateHorizon("2026-09-10", "2026-09-10", today).ok, false);
    const ok = validateGenerateHorizon("2026-09-11", "2026-09-16", today);
    assert.equal(ok.ok, true);
    assert.equal(ok.warnings.length > 0, true);
    assert.equal(validateGenerateHorizon("2026-09-11", "2026-09-24", today).ok, false);
  });
});

describe("GPC vs specialty segregation", () => {
  it("keeps GR, termite, bed bugs, commercial, wildlife, and lawn off GPC/mosquito", () => {
    assert.equal(routeClassOf(job({ docId: "gpc", serviceLine: "general" })), SHARED_ROUTE_CLASS);
    assert.equal(routeClassOf(job({ docId: "mos", serviceLine: "mosquito" })), SHARED_ROUTE_CLASS);
    assert.equal(routeClassOf(job({ docId: "gr", serviceLine: "gr" })), "gr");
    assert.equal(routeClassOf(job({ docId: "t", serviceLine: "termite" })), "termite");
    assert.equal(routeClassOf(job({ docId: "bb", serviceType: "Bed Bugs" })), "bed_bugs");
    assert.equal(routeClassOf(job({ docId: "c", serviceLine: "commercial" })), "commercial");
    assert.equal(routeClassOf(job({ docId: "w", serviceLine: "wildlife" })), "wildlife");
    assert.equal(routeClassOf(job({ docId: "l", serviceLine: "lawn" })), "lawn");
  });

  it("prefers a GPC class that can fill 14–16 over a 2-stop specialty class", () => {
    const remaining = new Map<string, { length: number }>([
      [SHARED_ROUTE_CLASS, { length: 20 }],
      ["termite", { length: 2 }],
    ]);
    assert.equal(pickRouteClassForDay(remaining, 16), SHARED_ROUTE_CLASS);
  });

  it("still schedules a specialty day when GPC cannot fill the target", () => {
    const remaining = new Map<string, { length: number }>([
      [SHARED_ROUTE_CLASS, { length: 2 }],
      ["termite", { length: 16 }],
    ]);
    assert.equal(pickRouteClassForDay(remaining, 16), "termite");
  });
});

describe("skills + preferred tech placement", () => {
  const alex = tech({ id: "alex", name: "Alex", skillNames: ["General Pest"] });
  const sam = tech({ id: "sam", name: "Sam", skillNames: ["Termite", "General Pest"] });

  it("never places a job on a tech missing required skills", () => {
    const termiteJob = job({
      docId: "t1",
      preferredTech: "Alex",
      requiredSkills: ["Termite"],
      serviceLine: "termite",
    });
    assert.equal(techHasRequiredSkills(alex, termiteJob), false);
    const placed = placeJobOnTech({
      job: termiteJob,
      techs: [alex, sam],
      loadByTechId: new Map([
        ["alex", 0],
        ["sam", 0],
      ]),
      perTechCapacity: 16,
      nearestDriveMinutes: () => 5,
    });
    assert.equal(placed.kind, "place");
    if (placed.kind === "place") {
      assert.equal(placed.techId, "sam");
      assert.equal(placed.spill?.kind, "preferred_tech_spill");
    }
  });

  it("lists skill-blocked jobs as exceptions instead of dropping them", () => {
    const wildlife = job({
      docId: "w1",
      customerName: "Wildlife Co",
      requiredSkills: ["Wildlife"],
      serviceLine: "wildlife",
    });
    const placed = placeJobOnTech({
      job: wildlife,
      techs: [alex, sam],
      loadByTechId: new Map([
        ["alex", 0],
        ["sam", 0],
      ]),
      perTechCapacity: 16,
      nearestDriveMinutes: () => 0,
    });
    assert.equal(placed.kind, "skill_blocked");
    if (placed.kind === "skill_blocked") {
      assert.equal(placed.exception.kind, "skill_blocked");
      assert.match(placed.exception.reason, /Wildlife/);
    }
  });

  it("keeps the preferred tech when they have skills and room, even if another tech is closer", () => {
    const gpc = job({
      docId: "g1",
      preferredTech: "Alex",
      serviceLine: "general",
    });
    assert.equal(homeTechForJob(gpc, [alex, sam])?.id, "alex");
    const placed = placeJobOnTech({
      job: gpc,
      techs: [alex, sam],
      loadByTechId: new Map([
        ["alex", 2],
        ["sam", 0],
      ]),
      perTechCapacity: 16,
      nearestDriveMinutes: (id) => (id === "alex" ? 40 : 1),
    });
    assert.equal(placed.kind, "place");
    if (placed.kind === "place") {
      assert.equal(placed.techId, "alex");
      assert.equal(placed.spill, undefined);
    }
  });

  it("spills to the nearest skilled tech only when preferred is at capacity", () => {
    const gpc = job({
      docId: "g2",
      preferredTech: "Alex",
      serviceLine: "general",
    });
    const placed = placeJobOnTech({
      job: gpc,
      techs: [alex, sam],
      loadByTechId: new Map([
        ["alex", 16],
        ["sam", 4],
      ]),
      perTechCapacity: 16,
      nearestDriveMinutes: () => 8,
    });
    assert.equal(placed.kind, "place");
    if (placed.kind === "place") {
      assert.equal(placed.techId, "sam");
      assert.equal(placed.spill?.kind, "preferred_tech_spill");
      assert.match(placed.spill?.reason || "", /capacity/);
    }
  });
});

describe("priority: preferred weekday then oldest due when behind", () => {
  it("ranks preferred-weekday matches first for the slot", () => {
    const wednesdayPref = job({
      docId: "w",
      schedulingRequest: "Wednesdays only",
      scheduledDate: "2026-09-20",
    });
    const noPref = job({
      docId: "n",
      scheduledDate: "2026-08-01",
      overdueActionable: true,
    });
    // 2026-09-16 is a Wednesday
    assert.equal(jobMatchesPreferredWeekday(wednesdayPref, "2026-09-16"), true);
    assert.equal(
      compareJobsForGenerate(wednesdayPref, noPref, { slotDate: "2026-09-16", poolBehind: true }) < 0,
      true,
    );
  });

  it("when behind, prefers oldest due dates after weekday match", () => {
    const older = job({ docId: "old", scheduledDate: "2026-07-01", overdueActionable: true });
    const newer = job({ docId: "new", scheduledDate: "2026-08-15", overdueActionable: true });
    assert.equal(compareJobsForGenerate(older, newer, { poolBehind: true }) < 0, true);
  });
});

describe("day fill toward 14–16 and weekday-aware selection", () => {
  it("fills a GPC day toward the cap instead of taking a 2-stop mixed leftover", () => {
    const jobs: SelectionJob[] = [
      job({ docId: "t1", serviceLine: "termite", scheduledDate: "2026-09-01", overdueActionable: true }),
      job({ docId: "t2", serviceLine: "termite", scheduledDate: "2026-09-02" }),
      ...Array.from({ length: 16 }, (_, i) =>
        job({ docId: `g${i}`, serviceLine: "general", scheduledDate: "2026-09-10" }),
      ),
    ];
    const result = fillDaysByRouteClass({
      techId: "alex",
      jobs,
      dates: ["2026-09-16"],
      pinnedSlotByJobId: new Map(),
      isProtected: () => false,
      capForDate: () => 16,
      poolBehind: true,
    });
    assert.equal(result.selected.length, 16);
    assert.equal(result.selected.every((j) => routeClassOf(j) === SHARED_ROUTE_CLASS), true);
    assert.equal(result.exceptions.some((e) => e.kind === "specialty_review"), true);
  });

  it("does not consume a day's cap with jobs that cannot land on that weekday", () => {
    const mondayOnly = job({
      docId: "mon",
      serviceLine: "general",
      schedulingRequest: "Mondays only",
    });
    const open = Array.from({ length: 14 }, (_, i) =>
      job({ docId: `g${i}`, serviceLine: "general" }),
    );
    const result = fillDaysByRouteClass({
      techId: "alex",
      jobs: [mondayOnly, ...open],
      dates: ["2026-09-16"], // Wednesday
      pinnedSlotByJobId: new Map(),
      isProtected: () => false,
      capForDate: () => 16,
      poolBehind: false,
    });
    assert.equal(canScheduleJobOnDate(mondayOnly, "2026-09-16"), false);
    assert.equal(result.selected.some((j) => j.docId === "mon"), false);
    assert.equal(result.selected.length, 14);
    assert.equal(result.exceptions.some((e) => e.kind === "preferred_day_conflict" && e.jobId === "mon"), true);
  });
});
