import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHARED_GENERATE_ROUTE_CLASS,
  clampGenerateMaxDriveMinutes,
  clampGenerateMaxStops,
  displayDriveTimeSource,
  driveTimeSourceBadgeLabel,
  driveTimeSourceKind,
  generateRouteClass,
  horizonGuidance,
  isBedBugServiceType,
  isTrustedDriveTimeSource,
  isoWeekKey,
  outsideSensaiStandard,
  polylineRenderMode,
  publicRouteGeometryPayload,
  routingStatusSummaryKeys,
  routingStatusSummaryPayload,
  sensaiMaxStopsForDate,
  slinkyWeekWarning,
  trustedRoadMinutes,
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

  it("forces ESTIMATE for stored road sources while paused", () => {
    assert.equal(displayDriveTimeSource("routes_api_polyline", true), "haversine_fallback");
    assert.equal(driveTimeSourceKind("routes_api_polyline", true), "estimate");
    assert.equal(driveTimeSourceBadgeLabel("routes_api_polyline", true), "ESTIMATE");
    assert.equal(polylineRenderMode("routes_api_polyline", true), "estimate");
    assert.equal(trustedRoadMinutes(42, "routes_api_polyline", true), undefined);
    assert.equal(trustedRoadMinutes(42, "routes_api_polyline", false), 42);
    assert.equal(trustedRoadMinutes(42, undefined, false), undefined);
    assert.equal(trustedRoadMinutes(42, "haversine_fallback", false), undefined);
  });

  it("strips geometry path when estimate or paused", () => {
    const road = publicRouteGeometryPayload({
      driveTimeSource: "routes_api_polyline",
      polylineSource: "routes_api_polyline",
      encodedPolyline: "abc",
      path: [{ lat: 1, lng: 2 }],
      driveMinutes: 12.34,
      distanceMeters: 1000,
      status: "OK",
      failedSegments: 0,
      paused: false,
    });
    assert.equal(road.estimate, false);
    assert.deepEqual(road.path, [{ lat: 1, lng: 2 }]);

    const pausedStoredRoad = publicRouteGeometryPayload({
      driveTimeSource: "routes_api_polyline",
      polylineSource: "routes_api_polyline",
      encodedPolyline: "abc",
      path: [{ lat: 1, lng: 2 }],
      driveMinutes: 12.34,
      status: "OK",
      failedSegments: 0,
      paused: true,
    });
    assert.equal(pausedStoredRoad.estimate, true);
    assert.equal(pausedStoredRoad.paused, true);
    assert.deepEqual(pausedStoredRoad.path, []);
    assert.equal(pausedStoredRoad.encodedPolyline, undefined);
    assert.equal(pausedStoredRoad.driveTimeSource, "haversine_fallback");
  });

  it("keeps routing-status summary to four public fields", () => {
    const payload = routingStatusSummaryPayload(true);
    assert.deepEqual(Object.keys(payload).sort(), routingStatusSummaryKeys());
    assert.equal(payload.paused, true);
    assert.equal(payload.probed, false);
    assert.equal(payload.generateRefused, true);
    assert.equal("recentRoutes" in payload, false);
    assert.equal("serviceAccountEmail" in payload, false);
    assert.equal("projectId" in payload, false);
  });

  it("hard-caps generate stops/drive at 18/90", () => {
    assert.equal(clampGenerateMaxStops(30), 18);
    assert.equal(clampGenerateMaxStops(16), 16);
    assert.equal(clampGenerateMaxStops(undefined), 16);
    assert.equal(clampGenerateMaxDriveMinutes(600), 90);
    assert.equal(clampGenerateMaxDriveMinutes(60), 60);
    assert.equal(clampGenerateMaxDriveMinutes(undefined), 60);
    assert.equal(outsideSensaiStandard(16, 60), false);
    assert.equal(outsideSensaiStandard(17, 60), true);
    assert.equal(outsideSensaiStandard(16, 75), true);
  });

  it("classes commercial and bed bugs off shared GPC", () => {
    assert.equal(generateRouteClass({ serviceLine: "general" }), SHARED_GENERATE_ROUTE_CLASS);
    assert.equal(generateRouteClass({ serviceLine: "mosquito" }), SHARED_GENERATE_ROUTE_CLASS);
    assert.equal(generateRouteClass({ serviceLine: "commercial" }), "commercial");
    assert.equal(generateRouteClass({ serviceType: "Bed Bugs", serviceLine: "general" }), "bed_bugs");
    assert.equal(generateRouteClass({ serviceLine: "termite" }), "termite");
    assert.equal(generateRouteClass({ serviceLine: "gr" }), "gr");
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
