"""
RouteIQ Bridge Router
=====================
Adds JSON API endpoints so the Next.js frontend can call the production routing
engine without touching any CSV files directly.

Pipeline per generate request
------------------------------
1. Receive jobs JSON from Next.js
2. Geocode any jobs missing lat/lng  (Google Geocoding API)
3. Snap coordinates to nearest road  (Google Roads API)
4. Run OGRouting optimization engine (OSRM + KMeans + 2-opt)
5. Enrich final routes with accurate drive times + traffic (Google Routes API)
6. Return enriched routes JSON to Next.js → saved to Firestore

Endpoints
---------
POST /routeiq/generate   – Full pipeline: jobs → optimized routes
GET  /routeiq/settings   – Routing engine defaults and limits
GET  /routeiq/health     – Quick liveness check
"""

from __future__ import annotations

import csv
import io
import json
import logging
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routing_engine import (
    run_routing,
    get_run_settings_defaults,
    get_run_settings_limits,
)
from google_maps import (
    geocode_batch,
    snap_to_roads,
    compute_route_legs_for_stops,
)

LOGGER = logging.getLogger("routeiq")

router = APIRouter(prefix="/routeiq", tags=["routeiq"])

GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "")
SNAP_TO_ROADS_ENABLED = os.environ.get("SNAP_TO_ROADS_ENABLED", "true").lower() not in {"0", "false", "no"}


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
            "preferredTech": j.preferredTech or "",
            "serviceDue": j.serviceDue or "",
            "schedulingRequest": j.schedulingRequest or "",
            "duration": j.duration or 25,
            "serviceType": j.serviceType or "",
        }
        for j in jobs
    ]


def _dicts_to_csv(jobs: list[dict]) -> str:
    fieldnames = [
        "customerID", "subscriptionID", "preferredTech",
        "lat", "lng", "serviceDue", "schedulingRequest", "duration",
    ]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for job in jobs:
        writer.writerow({
            "customerID": job.get("customerID", ""),
            "subscriptionID": job.get("subscriptionID", ""),
            "preferredTech": job.get("preferredTech", ""),
            "lat": job["lat"] if job.get("lat") is not None else "",
            "lng": job["lng"] if job.get("lng") is not None else "",
            "serviceDue": job.get("serviceDue", ""),
            "schedulingRequest": job.get("schedulingRequest", ""),
            "duration": job.get("duration", 25),
        })
    return buf.getvalue()


def _read_output_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _safe_float(val) -> Optional[float]:
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _safe_int(val) -> Optional[int]:
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _group_stops_into_routes(rows: list[dict]) -> list[dict]:
    """Group flat CSV rows into route objects grouped by routeName."""
    grouped: dict[str, dict] = {}
    for row in rows:
        name = str(row.get("routeName") or "").strip()
        if not name:
            continue
        if name not in grouped:
            grouped[name] = {
                "routeName": name,
                "routeDate": str(row.get("routeDate") or ""),
                "routeIndex": _safe_int(row.get("routeIndex")),
                "fieldRoutesTemplateID": _safe_int(row.get("fieldRoutesTemplateID")),
                "totalDriveMinutes": 0.0,
                "stops": [],
            }
        osrm = _safe_float(row.get("routeDriveMinutesOSRM"))
        matrix = _safe_float(row.get("routeDriveMinutesMatrix"))
        drive = osrm if osrm is not None else matrix
        if drive:
            grouped[name]["totalDriveMinutes"] += drive
        grouped[name]["stops"].append({
            "customerID": str(row.get("customerID") or ""),
            "subscriptionID": str(row.get("subscriptionID") or ""),
            "sequence": _safe_int(row.get("sequence")) or 0,
            "duration": _safe_int(row.get("duration")) or 25,
            "lat": _safe_float(row.get("lat")),
            "lng": _safe_float(row.get("lng")),
            "assignmentReason": str(row.get("assignmentReason") or ""),
            "isRemote": str(row.get("isRemote") or "").lower() in {"true", "1", "yes"},
            "driveMinutesOSRM": osrm,
        })

    for route in grouped.values():
        route["stops"].sort(key=lambda s: s["sequence"])

    return list(grouped.values())


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
    3. Run optimization engine (OGRouting / OSRM)
    4. Enrich with traffic-aware drive times (Google Routes API)
    5. Return routes + stops as JSON
    """
    if not body.jobs:
        raise HTTPException(status_code=400, detail="No jobs provided")

    run_id = str(uuid.uuid4())
    warnings: list[str] = []

    # ── Step 1: Convert to dicts ──────────────────────────────────────────
    jobs = _jobs_to_dicts(body.jobs)

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

    # ── Step 3: Snap to roads ─────────────────────────────────────────────
    if SNAP_TO_ROADS_ENABLED and GOOGLE_MAPS_API_KEY:
        coords = [(j["lat"], j["lng"]) for j in valid_jobs]
        snapped = snap_to_roads(coords, api_key=GOOGLE_MAPS_API_KEY)
        for i, (lat, lng) in enumerate(snapped):
            valid_jobs[i]["lat"] = lat
            valid_jobs[i]["lng"] = lng

    # ── Step 4: Run optimization engine ───────────────────────────────────
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        input_csv = tmp_path / "input.csv"
        input_csv.write_text(_dicts_to_csv(valid_jobs), encoding="utf-8")
        progress_path = str(tmp_path / "progress.json")

        try:
            run_routing(
                input_csv=str(input_csv),
                progress_path=progress_path,
                run_settings=body.runSettings or {},
                run_id=run_id,
            )
        except Exception as exc:
            LOGGER.exception("Routing engine error")
            raise HTTPException(status_code=500, detail=f"Routing engine error: {exc}")

        rows = _read_output_csv(tmp_path / "routing_plan.csv")

        summary: dict[str, Any] = {"runId": run_id, "totalStops": len(rows)}
        progress_file = tmp_path / "progress.json"
        if progress_file.exists():
            try:
                summary.update(json.loads(progress_file.read_text("utf-8")))
            except Exception:
                pass

    # ── Step 5: Group into routes ─────────────────────────────────────────
    routes = _group_stops_into_routes(rows)

    # ── Step 6: Enrich with Google Routes API drive times ─────────────────
    if GOOGLE_MAPS_API_KEY:
        routes = _enrich_routes_with_google(routes, GOOGLE_MAPS_API_KEY)
        summary["driveTimeSource"] = "google_routes"
    else:
        summary["driveTimeSource"] = "osrm"
        warnings.append(
            "Drive times calculated by OSRM (no live traffic). "
            "Set GOOGLE_MAPS_API_KEY for traffic-aware times."
        )

    summary["routeCount"] = len(routes)
    summary["geocodedCount"] = sum(1 for j in valid_jobs if j.get("geocoded"))
    summary["snappedToRoads"] = SNAP_TO_ROADS_ENABLED and bool(GOOGLE_MAPS_API_KEY)

    return {
        "runId": run_id,
        "status": "ok",
        "routes": routes,
        "stops": rows,
        "summary": summary,
        "warnings": warnings,
    }
