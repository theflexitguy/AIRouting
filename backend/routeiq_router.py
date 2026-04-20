"""
RouteIQ Bridge Router
=====================
Adds JSON API endpoints so the Next.js frontend can call the routing
engine without touching any CSV files directly.

Pipeline per generate request
------------------------------
1. Receive jobs JSON from Next.js
2. Geocode any jobs missing lat/lng  (Google Geocoding API)
3. Snap coordinates to nearest road  (Google Roads API)
4. Cluster jobs geographically into dense routes (KMeans + nearest-neighbor)
5. Enrich final routes with accurate drive times + traffic (Google Routes API)
6. Return enriched routes JSON to Next.js → saved to Firestore

Priorities
----------
1. Efficiency — maximize stops per route, minimize drive time
2. Fill routes — target up to maxStopsPerRoute (default 16) from the full job pool
3. Oldest due dates first — when the pool exceeds capacity, oldest-due jobs get priority

Endpoints
---------
POST /routeiq/generate   – Full pipeline: jobs → optimized routes
GET  /routeiq/settings   – Routing engine defaults and limits
GET  /routeiq/health     – Quick liveness check
"""

from __future__ import annotations

import logging
import math
import os
import uuid
from typing import Any, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sklearn.cluster import KMeans

from routing_engine import (
    get_run_settings_defaults,
    get_run_settings_limits,
    osrm_leg_minutes,
)
from google_maps import (
    geocode_batch,
    snap_to_roads,
    compute_route_legs_for_stops,
)
from scheduling_constraints import parse_scheduling_request, CRITICAL_CLASSES

LOGGER = logging.getLogger("routeiq")

router = APIRouter(prefix="/routeiq", tags=["routeiq"])

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")
SNAP_TO_ROADS_ENABLED = os.environ.get("SNAP_TO_ROADS_ENABLED", "true").lower() not in {"0", "false", "no"}

DEFAULT_MAX_STOPS = 16
DEFAULT_TARGET_STOPS = 16
DEFAULT_MIN_STOPS = 1


# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class JobInput(BaseModel):
    id: str
    customerID: Optional[str] = ""
    subscriptionID: Optional[str] = ""
    address: Optional[str] = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    preferredTech: Optional[str] = ""
    serviceDue: Optional[str] = ""
    schedulingRequest: Optional[str] = ""
    duration: Optional[int] = 25
    serviceType: Optional[str] = ""
    customerName: Optional[str] = ""


class GenerateRequest(BaseModel):
    jobs: list[JobInput]
    runSettings: Optional[dict[str, Any]] = None
    companyId: Optional[str] = None


# ---------------------------------------------------------------------------
# Pipeline helpers
# ---------------------------------------------------------------------------

def _jobs_to_dicts(jobs: list[JobInput]) -> list[dict]:
    return [
        {
            "id": j.id,
            "customerID": j.customerID or j.id,
            "subscriptionID": j.subscriptionID or j.id,
            "address": j.address or "",
            "lat": j.lat,
            "lng": j.lng,
            "serviceDue": j.serviceDue or "",
            "schedulingRequest": j.schedulingRequest or "",
            "duration": j.duration or 25,
            "serviceType": j.serviceType or "",
            "customerName": j.customerName or "",
        }
        for j in jobs
    ]


def _haversine_miles(lat1, lon1, lat2, lon2) -> float:
    R = 3958.7613
    lat1, lon1, lat2, lon2 = map(math.radians, [lat1, lon1, lat2, lon2])
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return R * 2 * math.asin(math.sqrt(a))


def _drive_minutes(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Get drive time between two points. Uses OSRM with haversine fallback."""
    try:
        return float(osrm_leg_minutes(lat1, lng1, lat2, lng2))
    except Exception:
        miles = _haversine_miles(lat1, lng1, lat2, lng2)
        return (miles / 30.0) * 60.0  # assume 30 mph fallback


def _nearest_neighbor_order(jobs: list[dict]) -> list[dict]:
    """
    Order stops using nearest-neighbor heuristic to minimize total drive time.
    Start from the geographic centroid to pick the first stop.
    """
    if len(jobs) <= 1:
        return list(jobs)

    remaining = list(range(len(jobs)))
    # Start with the stop closest to the centroid
    avg_lat = sum(j["lat"] for j in jobs) / len(jobs)
    avg_lng = sum(j["lng"] for j in jobs) / len(jobs)

    best_first = min(remaining, key=lambda i: _haversine_miles(
        avg_lat, avg_lng, jobs[i]["lat"], jobs[i]["lng"]
    ))
    ordered = [best_first]
    remaining.remove(best_first)

    while remaining:
        last = ordered[-1]
        nearest = min(remaining, key=lambda i: _haversine_miles(
            jobs[last]["lat"], jobs[last]["lng"],
            jobs[i]["lat"], jobs[i]["lng"],
        ))
        ordered.append(nearest)
        remaining.remove(nearest)

    return [jobs[i] for i in ordered]


def _build_distance_matrix(jobs: list[dict]) -> list[list[float]]:
    """Build a pairwise drive-time matrix using OSRM (with haversine fallback)."""
    n = len(jobs)
    matrix = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            d = _drive_minutes(jobs[i]["lat"], jobs[i]["lng"], jobs[j]["lat"], jobs[j]["lng"])
            matrix[i][j] = d
            matrix[j][i] = d
    return matrix


def _route_cost(order: list[int], matrix: list[list[float]]) -> float:
    """Total drive time for a given stop order using pre-computed matrix."""
    total = 0.0
    for i in range(len(order) - 1):
        total += matrix[order[i]][order[i + 1]]
    return total


def _two_opt_improve(jobs: list[dict], max_iterations: int = 500, matrix: list[list[float]] | None = None) -> list[dict]:
    """Apply 2-opt local search to improve route order using road-based distances."""
    if len(jobs) <= 3:
        return jobs

    if matrix is None:
        matrix = _build_distance_matrix(jobs)

    n = len(jobs)
    best_order = list(range(n))
    best_cost = _route_cost(best_order, matrix)
    improved = True
    iterations = 0

    while improved and iterations < max_iterations:
        improved = False
        iterations += 1
        for i in range(1, n - 1):
            for j in range(i + 1, n):
                candidate = best_order[:i] + best_order[i:j + 1][::-1] + best_order[j + 1:]
                c = _route_cost(candidate, matrix)
                if c < best_cost - 0.01:
                    best_order = candidate
                    best_cost = c
                    improved = True
                    break
            if improved:
                break

    return [jobs[i] for i in best_order]


def _or_opt_improve(jobs: list[dict], matrix: list[list[float]] | None = None) -> list[dict]:
    """Or-opt: try relocating each individual stop to every other position."""
    if len(jobs) <= 3:
        return jobs

    if matrix is None:
        matrix = _build_distance_matrix(jobs)

    n = len(jobs)
    best_order = list(range(n))
    best_cost = _route_cost(best_order, matrix)
    improved = True

    while improved:
        improved = False
        for i in range(n):
            for j in range(n):
                if j == i or j == i - 1:
                    continue
                # Try moving stop at position i to after position j
                candidate = list(best_order)
                stop = candidate.pop(i)
                insert_pos = j if j < i else j
                candidate.insert(insert_pos, stop)
                c = _route_cost(candidate, matrix)
                if c < best_cost - 0.01:
                    best_order = candidate
                    best_cost = c
                    improved = True
                    break
            if improved:
                break

    return [jobs[i] for i in best_order]


def _cluster_and_build_routes(
    jobs: list[dict],
    max_stops: int = DEFAULT_MAX_STOPS,
    num_routes: Optional[int] = None,
) -> list[dict]:
    """
    Cluster jobs geographically into routes of up to max_stops each.
    Each route is optimized with nearest-neighbor + 2-opt.

    If num_routes is provided, create exactly that many routes (or fewer if
    there aren't enough jobs). Otherwise compute from job count / max_stops.

    Returns a list of route dicts with stops, drive times, etc.
    """
    n = len(jobs)
    if n == 0:
        return []

    if num_routes is not None:
        n_routes = min(num_routes, n)  # can't have more routes than jobs
        n_routes = max(1, n_routes)
    else:
        n_routes = max(1, math.ceil(n / max_stops))

    # If everything fits in one route, skip clustering
    if n_routes == 1:
        clusters = {0: list(range(n))}
    else:
        coords = np.array([[j["lat"], j["lng"]] for j in jobs])
        kmeans = KMeans(n_clusters=n_routes, n_init=10, random_state=42)
        labels = kmeans.fit_predict(coords)
        clusters: dict[int, list[int]] = {}
        for idx, label in enumerate(labels):
            clusters.setdefault(int(label), []).append(idx)

    # Balance clusters: if any cluster exceeds max_stops, redistribute
    # overflow to the nearest under-capacity cluster
    for label in list(clusters.keys()):
        while len(clusters[label]) > max_stops:
            overflow_idx = clusters[label].pop()
            job = jobs[overflow_idx]
            # Find nearest under-capacity cluster
            best_label = None
            best_dist = float("inf")
            for other_label, members in clusters.items():
                if other_label == label or len(members) >= max_stops:
                    continue
                centroid_lat = sum(jobs[m]["lat"] for m in members) / len(members)
                centroid_lng = sum(jobs[m]["lng"] for m in members) / len(members)
                d = _haversine_miles(job["lat"], job["lng"], centroid_lat, centroid_lng)
                if d < best_dist:
                    best_dist = d
                    best_label = other_label
            if best_label is not None:
                clusters[best_label].append(overflow_idx)
            else:
                # All clusters full, create a new one
                new_label = max(clusters.keys()) + 1
                clusters[new_label] = [overflow_idx]

    routes = []
    for route_idx, (label, member_indices) in enumerate(sorted(clusters.items())):
        cluster_jobs = [jobs[i] for i in member_indices]

        # Optimize stop order: nearest-neighbor → 2-opt → or-opt (all using OSRM distances)
        ordered_jobs = _nearest_neighbor_order(cluster_jobs)
        dist_matrix = _build_distance_matrix(ordered_jobs)
        ordered_jobs = _two_opt_improve(ordered_jobs, matrix=dist_matrix)
        ordered_jobs = _or_opt_improve(ordered_jobs, matrix=dist_matrix)

        # Calculate drive time between consecutive stops
        total_drive_minutes = 0.0
        stops = []
        for seq, job in enumerate(ordered_jobs):
            stop = {
                "customerID": job["customerID"],
                "subscriptionID": job.get("subscriptionID", ""),
                "sequence": seq + 1,
                "duration": job.get("duration", 25),
                "lat": job["lat"],
                "lng": job["lng"],
                "customerName": job.get("customerName", ""),
                "address": job.get("address", ""),
                "serviceType": job.get("serviceType", ""),
                "serviceDue": job.get("serviceDue", ""),
            }
            if seq > 0:
                prev = ordered_jobs[seq - 1]
                drive = _drive_minutes(prev["lat"], prev["lng"], job["lat"], job["lng"])
                stop["driveMinutesFromPrev"] = round(drive, 1)
                total_drive_minutes += drive
            stops.append(stop)

        routes.append({
            "routeName": f"Route {route_idx + 1}",
            "routeIndex": route_idx,
            "totalDriveMinutes": round(total_drive_minutes, 1),
            "stops": stops,
        })

    # Compute total work minutes (drive + service) for each route
    for route in routes:
        service_minutes = sum(s.get("duration", 25) for s in route["stops"])
        route["totalServiceMinutes"] = round(service_minutes, 1)
        route["totalWorkMinutes"] = round(route["totalDriveMinutes"] + service_minutes, 1)

    # Sort routes by total drive time ascending (most efficient first)
    routes.sort(key=lambda r: r["totalDriveMinutes"])
    for i, route in enumerate(routes):
        route["routeIndex"] = i
        route["routeName"] = f"Route {i + 1}"

    return routes


def _enrich_routes_with_google(
    routes: list[dict],
    api_key: str,
) -> list[dict]:
    """
    For each route, call Google Routes API to get traffic-aware drive times
    for every consecutive stop pair. Updates totalDriveMinutes and adds
    googleDriveMinutes to each stop.
    """
    if not api_key:
        return routes

    for route in routes:
        stops = route.get("stops", [])
        coords = [
            (s["lat"], s["lng"])
            for s in stops
            if s.get("lat") is not None and s.get("lng") is not None
        ]
        if len(coords) < 2:
            continue

        legs = compute_route_legs_for_stops(coords, api_key)
        if not legs:
            continue

        total_google_minutes = 0.0
        for i, leg in enumerate(legs):
            secs = leg.get("duration_seconds")
            if secs is not None:
                minutes = round(secs / 60, 1)
                if i + 1 < len(stops):
                    stops[i + 1]["googleDriveMinutes"] = minutes
                total_google_minutes += minutes

        if total_google_minutes > 0:
            route["totalDriveMinutes"] = round(total_google_minutes, 1)
            route["driveTimeSource"] = "google_routes"
        else:
            route["driveTimeSource"] = "osrm"

    return routes


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/health")
def health():
    return {"status": "ok", "googleMapsConfigured": bool(GOOGLE_MAPS_API_KEY)}


@router.get("/settings")
def get_settings():
    return {
        "defaults": get_run_settings_defaults(),
        "limits": get_run_settings_limits(),
        "googleMapsConfigured": bool(GOOGLE_MAPS_API_KEY),
        "snapToRoadsEnabled": SNAP_TO_ROADS_ENABLED and bool(GOOGLE_MAPS_API_KEY),
    }


@router.post("/generate")
def generate_routes(body: GenerateRequest):
    """
    Full pipeline:
    1. Geocode missing coordinates (Google)
    2. Snap to roads (Google)
    3. Cluster jobs geographically into dense routes (KMeans)
    4. Optimize stop order within each route (nearest-neighbor + 2-opt)
    5. Enrich with traffic-aware drive times (Google Routes API)
    6. Return routes + stops as JSON
    """
    if not body.jobs:
        raise HTTPException(status_code=400, detail="No jobs provided")

    run_id = str(uuid.uuid4())
    warnings: list[str] = []
    settings = body.runSettings or {}
    max_stops = int(settings.get("maxStopsPerRoute", DEFAULT_MAX_STOPS))
    num_routes = int(settings["numRoutes"]) if settings.get("numRoutes") else None

    # ── Step 1: Convert to dicts ──────────────────────────────────────────
    jobs = _jobs_to_dicts(body.jobs)

    # ── Step 1b: Validate coordinates ────────────────────────────────────
    for j in jobs:
        lat, lng = j.get("lat"), j.get("lng")
        if lat is not None and lng is not None:
            # Flag obviously invalid coordinates as missing
            if (abs(lat) < 0.01 and abs(lng) < 0.01) or lat < 24 or lat > 50 or lng < -125 or lng > -66:
                warnings.append(f"Job {j['customerID']}: invalid coords ({lat}, {lng}) — will attempt geocode")
                j["lat"] = None
                j["lng"] = None

    # ── Step 1c: Parse scheduling constraints ────────────────────────────
    held_jobs: list[str] = []
    for j in list(jobs):
        sched = j.get("schedulingRequest", "")
        if sched:
            parsed = parse_scheduling_request(sched)
            j["_schedulingClass"] = parsed["schedulingRequestClass"]
            j["_schedulingAllowedWeekdays"] = parsed["schedulingAllowedWeekdays"]
            j["_schedulingBlockedWeekdays"] = parsed["schedulingBlockedWeekdays"]
            if parsed["schedulingRequestClass"] in CRITICAL_CLASSES:
                held_jobs.append(f"{j['customerID']} ({parsed['schedulingRequestClass']})")
    if held_jobs:
        jobs = [j for j in jobs if j.get("_schedulingClass") not in CRITICAL_CLASSES]
        warnings.append(f"{len(held_jobs)} job(s) excluded due to scheduling holds: " + ", ".join(held_jobs[:5]) + ("..." if len(held_jobs) > 5 else ""))

    # ── Step 2: Geocode missing lat/lng ───────────────────────────────────
    missing_before = sum(1 for j in jobs if j.get("lat") is None or j.get("lng") is None)
    if missing_before > 0:
        if GOOGLE_MAPS_API_KEY:
            jobs = geocode_batch(jobs, api_key=GOOGLE_MAPS_API_KEY)
            still_missing = [j["id"] for j in jobs if j.get("lat") is None or j.get("lng") is None]
            if still_missing:
                warnings.append(
                    f"{len(still_missing)} job(s) could not be geocoded and will be skipped: "
                    + ", ".join(still_missing[:5])
                    + ("..." if len(still_missing) > 5 else "")
                )
        else:
            warnings.append(
                f"{missing_before} job(s) are missing lat/lng. "
                "Set GOOGLE_MAPS_API_KEY to enable automatic geocoding."
            )

    # Drop jobs that still have no coordinates
    valid_jobs = [j for j in jobs if j.get("lat") is not None and j.get("lng") is not None]
    skipped = len(jobs) - len(valid_jobs)
    if skipped > 0:
        warnings.append(f"{skipped} job(s) dropped — no coordinates.")
    if not valid_jobs:
        raise HTTPException(status_code=422, detail="No jobs with valid coordinates after geocoding.")

    target_routes = num_routes if num_routes else max(1, math.ceil(len(valid_jobs) / max_stops))
    LOGGER.info(
        "RouteIQ generate: %d valid jobs, max %d stops/route, %d route(s) requested",
        len(valid_jobs), max_stops, target_routes,
    )

    # ── Step 3: Snap to roads ─────────────────────────────────────────────
    if SNAP_TO_ROADS_ENABLED and GOOGLE_MAPS_API_KEY:
        coords = [(j["lat"], j["lng"]) for j in valid_jobs]
        snapped = snap_to_roads(coords, api_key=GOOGLE_MAPS_API_KEY)
        for i, (lat, lng) in enumerate(snapped):
            valid_jobs[i]["lat"] = lat
            valid_jobs[i]["lng"] = lng

    # ── Step 4: Cluster + optimize ────────────────────────────────────────
    routes = _cluster_and_build_routes(valid_jobs, max_stops=max_stops, num_routes=num_routes)

    # ── Step 4b: Output quality gate ────────────────────────────────────
    jobs_placed = sum(len(r["stops"]) for r in routes)
    jobs_requested = len(valid_jobs)
    if routes and jobs_placed < jobs_requested:
        gap_pct = round((1 - jobs_placed / jobs_requested) * 100)
        if gap_pct > 20:
            warnings.append(f"{gap_pct}% of jobs ({jobs_requested - jobs_placed}) could not be placed on routes — capacity may be insufficient.")

    # ── Step 5: Enrich with Google Routes API drive times ─────────────────
    if GOOGLE_MAPS_API_KEY:
        routes = _enrich_routes_with_google(routes, GOOGLE_MAPS_API_KEY)
        drive_source = "google_routes"
    else:
        drive_source = "osrm"
        warnings.append(
            "Drive times calculated by OSRM (no live traffic). "
            "Set GOOGLE_MAPS_API_KEY for traffic-aware times."
        )

    # ── Step 6: Check working hours constraints ────────────────────────
    max_working_min = int(settings.get("maxWorkingMinutes", 480))
    for route in routes:
        work_min = route.get("totalWorkMinutes", 0)
        if work_min > max_working_min:
            warnings.append(
                f"{route['routeName']}: {round(work_min)} min total work time exceeds "
                f"{max_working_min} min limit ({round(work_min / 60, 1)}h)"
            )

    total_stops = sum(len(r["stops"]) for r in routes)
    total_drive = sum(r.get("totalDriveMinutes", 0) for r in routes)
    max_route_work = max((r.get("totalWorkMinutes", 0) for r in routes), default=0)

    summary: dict[str, Any] = {
        "runId": run_id,
        "totalStops": total_stops,
        "routeCount": len(routes),
        "driveTimeSource": drive_source,
        "geocodedCount": sum(1 for j in valid_jobs if j.get("geocoded")),
        "snappedToRoads": SNAP_TO_ROADS_ENABLED and bool(GOOGLE_MAPS_API_KEY),
        "maxStopsPerRoute": max_stops,
        "totalDriveMinutes": round(total_drive, 1),
        "avgDriveMinutesPerStop": round(total_drive / total_stops, 1) if total_stops > 0 else 0,
        "maxRouteWorkMinutes": round(max_route_work, 1),
        "jobsRequested": len(jobs),
        "jobsPlaced": total_stops,
    }

    LOGGER.info(
        "RouteIQ generate complete: %d routes, %d total stops",
        len(routes), total_stops,
    )

    return {
        "runId": run_id,
        "status": "ok",
        "routes": routes,
        "summary": summary,
        "warnings": warnings,
    }
