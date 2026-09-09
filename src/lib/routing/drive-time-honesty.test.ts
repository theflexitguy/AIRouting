import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  driveTimeSourceBadgeLabel,
  driveTimeSourceKind,
  horizonGuidance,
  isBedBugServiceType,
  isTrustedDriveTimeSource,
  isoWeekKey,
  polylineRenderMode,
  sensaiMaxStopsForDate,
  slinkyWeekWarning,
  weekdayLabelForIsoDate,
} from "./drive-time-honesty.ts";

describe("drive-time honesty", () => {
  it("treats only Routes API sources as road times", () => {
    assert.equal(isTrustedDriveTimeSource("routes_api_polyline"), true);
    assert.equal(isTrustedDriveTimeSource("routes_api_matrix"), true);
    assert.equal(isTrustedDriveTimeSource("routes_api_matrix,routes_api_polyline"), true);
    assert.equal(isTrustedDriveTimeSource("haversine_fallback"), false);
    assert.equal(isTrustedDriveTimeSource("routes_api_polyline,haversine_fallback"), false);
    assert.equal(isTrustedDriveTimeSource(""), false);
    assert.equal(isTrustedDriveTimeSource(undefined), false);
    assert.equal(driveTimeSourceKind("haversine_fallback"), "estimate");
    assert.equal(driveTimeSourceBadgeLabel("haversine_fallback"), "ESTIMATE");
    assert.equal(driveTimeSourceBadgeLabel("routes_api_polyline"), "ROAD");
    assert.equal(polylineRenderMode("haversine_fallback"), "estimate");
    assert.equal(polylineRenderMode("routes_api_polyline"), "road");
  });

  it("applies Tuesday and Saturday SensAI stop caps", () => {
    assert.equal(weekdayLabelForIsoDate("2026-09-08"), "TUE");
    assert.equal(weekdayLabelForIsoDate("2026-09-12"), "SAT");
    assert.equal(sensaiMaxStopsForDate(16, "2026-09-08"), 13);
    assert.equal(sensaiMaxStopsForDate(16, "2026-09-12"), 8);
    assert.equal(sensaiMaxStopsForDate(16, "2026-09-09"), 16);
  });

  it("flags horizon too soon, prefer-week, and too far", () => {
    assert.equal(horizonGuidance("2026-09-09", "2026-09-09").level, "too_soon");
    assert.equal(horizonGuidance("2026-09-10", "2026-09-09").level, "too_soon");
    assert.equal(horizonGuidance("2026-09-11", "2026-09-09").level, "prefer_week");
    assert.equal(horizonGuidance("2026-09-16", "2026-09-09").level, "ok");
    assert.equal(horizonGuidance("2026-09-24", "2026-09-09").level, "too_far");
  });

  it("warns when one week is piled (slinky)", () => {
    assert.equal(isoWeekKey("2026-09-09"), "2026-W37");
    assert.equal(
      slinkyWeekWarning({ "2026-W37": 40, "2026-W38": 12 }),
      "Week 2026-W37 looks piled (40 stops vs ~26 average). Slinky risk — spread work so no week carries what two weeks should share.",
    );
    assert.equal(slinkyWeekWarning({ "2026-W37": 16, "2026-W38": 14 }), null);
    assert.equal(slinkyWeekWarning({ "2026-W37": 20 }), null);
  });

  it("detects bed bug specialty labels", () => {
    assert.equal(isBedBugServiceType("Bed Bugs"), true);
    assert.equal(isBedBugServiceType("bed bug follow-up"), true);
    assert.equal(isBedBugServiceType("General Pest"), false);
  });
});
