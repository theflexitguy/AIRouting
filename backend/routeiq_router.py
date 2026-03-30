"""
RouteIQ Bridge Router
=====================
Adds JSON API endpoints so the Next.js frontend can call the production routing
engine without touching any CSV files directly.

Endpoints
---------
POST /routeiq/generate   – Accept jobs JSON → run routing → return routes JSON
GET  /routeiq/settings   – Return current run-settings defaults and limits
POST /routeiq/validate   – Dry-run validation (check input, return warnings)
"""

from __future__ import annotations

import csv
import io
import json
import os
import tempfile
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from routing_engine import (
    run_routing,
    get_run_settings_defaults,
    get_run_settings_limits,
)

router = APIRouter(prefix="/routeiq", tags=["routeiq"])

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class JobInput(BaseModel):
    """A single field-service job from Firestore / FieldRoutes."""
    id: str
    customerID: Optional[str] = ""
    subscriptionID: Optional[str] = ""
    address: Optional[str] = ""
    lat: Optional[float] = None
    lng: Optional[float] = None
    preferredTech: Optional[str] = ""
    serviceDue: Optional[str] = ""           # YYYY-MM-DD
    schedulingRequest: Optional[str] = ""    # e.g. "MON", "TUE-THU"
    duration: Optional[int] = 25
    serviceType: Optional[str] = ""          # "specialty" | "lawn" | "" (regular)


class GenerateRequest(BaseModel):
    jobs: List[JobInput]
    runSettings: Optional[Dict[str, Any]] = None
    companyId: Optional[str] = None


class RouteStop(BaseModel):
    jobId: str
    customerID: str
    subscriptionID: str
    sequence: int
    routeName: str
    routeDate: str
    routeIndex: int
    duration: int
    lat: Optional[float]
    lng: Optional[float]
    driveMinutes: Optional[float]
    assignmentReason: str
    fieldRoutesTemplateID: Optional[int]


class GenerateResponse(BaseModel):
    runId: str
    status: str                         # "ok" | "error"
    routes: List[Dict[str, Any]]        # grouped by routeName
    stops: List[Dict[str, Any]]         # flat list
    summary: Dict[str, Any]
    warnings: List[str]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _jobs_to_csv(jobs: List[JobInput]) -> str:
    """Serialize job list to CSV string that the routing engine accepts."""
    fieldnames = [
        "customerID", "subscriptionID", "preferredTech",
        "lat", "lng", "serviceDue", "schedulingRequest", "duration",
    ]
    buf = io.StringIO()
    writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
    writer.writeheader()
    for job in jobs:
        writer.writerow({
            "customerID": job.customerID or job.id,
            "subscriptionID": job.subscriptionID or job.id,
            "preferredTech": job.preferredTech or "",
            "lat": job.lat if job.lat is not None else "",
            "lng": job.lng if job.lng is not None else "",
            "serviceDue": job.serviceDue or "",
            "schedulingRequest": job.schedulingRequest or "",
            "duration": job.duration or 25,
        })
    return buf.getvalue()


def _read_output_csv(path: Path) -> List[Dict[str, Any]]:
    """Read routing_plan.csv and return list of row dicts."""
    if not path.exists():
        return []
    rows = []
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(dict(row))
    return rows


def _rows_to_routes(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Group flat stop rows by routeName for the frontend."""
    grouped: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        name = str(row.get("routeName") or "")
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
        drive = _safe_float(row.get("routeDriveMinutesOSRM") or row.get("routeDriveMinutesMatrix"))
        grouped[name]["totalDriveMinutes"] = (
            grouped[name]["totalDriveMinutes"] + (drive or 0.0)
        )
        grouped[name]["stops"].append({
            "customerID": str(row.get("customerID") or ""),
            "subscriptionID": str(row.get("subscriptionID") or ""),
            "sequence": _safe_int(row.get("sequence")) or 0,
            "duration": _safe_int(row.get("duration")) or 25,
            "lat": _safe_float(row.get("lat")),
            "lng": _safe_float(row.get("lng")),
            "assignmentReason": str(row.get("assignmentReason") or ""),
            "isRemote": str(row.get("isRemote") or "").lower() in {"true", "1", "yes"},
        })
    # Sort stops within each route
    for route in grouped.values():
        route["stops"].sort(key=lambda s: s["sequence"])
    return list(grouped.values())


def _safe_int(val) -> Optional[int]:
    try:
        return int(val)
    except (TypeError, ValueError):
        return None


def _safe_float(val) -> Optional[float]:
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.get("/settings")
def get_settings():
    """Return routing engine defaults and limits for the frontend settings panel."""
    return {
        "defaults": get_run_settings_defaults(),
        "limits": get_run_settings_limits(),
    }


@router.post("/generate", response_model=None)
def generate_routes(body: GenerateRequest):
    """
    Accept jobs from Firestore, run the production routing engine, return routes.

    The engine writes CSV/HTML to a temp directory; we read the CSV and convert
    to JSON for the frontend.
    """
    if not body.jobs:
        raise HTTPException(status_code=400, detail="No jobs provided")

    run_id = str(uuid.uuid4())
    warnings: List[str] = []

    # Check that jobs have coordinates
    missing_coords = [j.id for j in body.jobs if j.lat is None or j.lng is None]
    if missing_coords:
        warnings.append(
            f"{len(missing_coords)} job(s) missing lat/lng — they will be skipped by the engine: "
            + ", ".join(missing_coords[:5])
            + ("..." if len(missing_coords) > 5 else "")
        )

    # Write jobs to a temp CSV
    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir)
        input_csv = tmp_path / "input.csv"
        input_csv.write_text(_jobs_to_csv(body.jobs), encoding="utf-8")

        progress_path = str(tmp_path / "progress.json")

        try:
            run_routing(
                input_csv=str(input_csv),
                progress_path=progress_path,
                run_settings=body.runSettings or {},
                run_id=run_id,
            )
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Routing engine error: {str(exc)}",
            )

        output_csv = tmp_path / "routing_plan.csv"
        rows = _read_output_csv(output_csv)

        # Read progress/summary if available
        summary: Dict[str, Any] = {"runId": run_id, "totalStops": len(rows)}
        progress_file = tmp_path / "progress.json"
        if progress_file.exists():
            try:
                prog = json.loads(progress_file.read_text(encoding="utf-8"))
                summary.update(prog)
            except Exception:
                pass

    routes = _rows_to_routes(rows)

    return {
        "runId": run_id,
        "status": "ok",
        "routes": routes,
        "stops": rows,
        "summary": summary,
        "warnings": warnings,
    }
