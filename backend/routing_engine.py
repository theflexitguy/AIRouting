import pandas as pd
import numpy as np
import math
import hashlib
import json
import re
from sklearn.cluster import KMeans
from scipy.optimize import linear_sum_assignment
from datetime import datetime, timedelta
import holidays
import requests
from functools import lru_cache
import os
import time
from pathlib import Path
from copy import deepcopy
from typing import Any, Dict, Optional, Tuple

ROUTING_MODE = "GLOBAL_CHAIN_ZONE_BLOCKS"
DRIVE_TIME_MODEL = "OSRM_MATRIX_STRICT"
TARGET_STOPS_PER_DAY = 12
MIN_STOPS_PER_DAY = 8
MAX_STOPS_PER_DAY = 14
ALLOW_SATURDAY_OVERFLOW = True
ALLOW_SUNDAY_OVERFLOW = False
FORCE_SATURDAY_OVERFLOW = True
ALLOW_MONTH_SPILL = False
MATRIX_ALGO_VERSION = "v4"
MATRIX_CACHE_SCHEMA_VERSION = 2
MATRIX_CACHE_DIR = Path(os.environ.get("MATRIX_CACHE_DIR", "./data/cache/osrm_matrix")).expanduser().resolve()
OSRM_TABLE_BLOCK_SIZE = 24

STOPS_PER_ROUTE = TARGET_STOPS_PER_DAY
MAX_STOPS_PER_ROUTE = MAX_STOPS_PER_DAY  # overflow rule: never exceed max policy
MIN_STOPS_PER_ROUTE = MIN_STOPS_PER_DAY  # avoid tiny routes unless hard-cap forced
DEFAULT_DURATION = 25
MAX_WORKING_DAYS = 22     # cap distinct working days per tech per month
MAX_ROUTE_DRIVE_MIN = 60  # hard max total drive minutes per daily route (stop-to-stop driving)
OSRM_DRIVE_CAP_TOLERANCE_MIN = 1.0  # absorb tiny OSRM jitter instead of overflowing whole routes
SLICE_DRIVE_BUFFER_MIN = 18.0  # planning-only slack to avoid over-fragmented initial slices
ASSUMED_AVG_MPH_FALLBACK = 27  # conservative fallback speed for unresolved OSRM legs
PRODUCTION_HANDS_OFF_MODE = True
STRICT_OSRM_FOR_OPTIMIZATION = True
OSRM_UNAVAILABLE_PENALTY_MIN = 10000.0
FAIL_FAST_IF_OSRM_UNAVAILABLE = True
REMOTE_STOP_CAP = 14  # use denser remote buckets first; hard 60-min gate still applies
MAX_OPT_SECONDS_PER_TECH = 240
MAX_DRIVE_ITERS = 260
MAX_VERIFY_ITERS = 6
MAX_HARD_ITERS = 450
MAX_QUALITY_ITERS = 70
MAX_COMPACT_ITERS = 140
MAX_SIZE_REBALANCE_ITERS = 220
PRECOMPUTE_OSRM_FOR_HTML = False
REMOTE_RULES_ENABLED = True
REMOTE_STRICT = True
REMOTE_OUTLIER_MIN_MILES = 12.0
REMOTE_OUTLIER_QUANTILE = 0.93
BEAVER_LAKE_SPLIT_LAT = 36.30
SOUTH_PRAIRIE_SPLIT_LNG = -94.1800
MAX_ROUTE_ANGLE_SPAN_DEG = 165.0
MIN_LOOP_OPEN_RATIO = 0.30
MAX_ROUTE_SELF_INTERSECTIONS = 0
SOFT_GEOMETRY_SELF_CROSS_TOLERANCE = 2
ROUTE_BUILD_VARIANTS = 3
MISFIT_PASS_ENABLED = True
MISFIT_GAIN_THRESHOLD_MI = 1.4
MISFIT_MAX_ITERS_PER_TECH = 80
MISFIT_MAX_CANDIDATES_PER_ITER = 60
MISFIT_MAX_SWAP_CANDIDATES = 12
SEVERE_MISFIT_GAIN_MI = 3.5
SEVERE_MISFIT_MAX_ITERS = 20
SEVERE_MISFIT_MAX_DRIVE_DELTA = 24.0
SEVERE_MISFIT_MAX_DEST_CANDIDATES = 5
SEVERE_CHAIN_MAX_SWAP_CANDIDATES = 8
SEVERE_CHAIN_MAX_RECEIVER_CANDIDATES = 8
SLOT_REASSIGN_ENABLED = True
SLOT_REASSIGN_ITERS = 3
SLOT_REASSIGN_INFEASIBLE_COST = 1e6
SLOT_REASSIGN_NEAREST_PENALTY = 2.40
SLOT_REASSIGN_ANGLE_PENALTY = 0.14
SLOT_REASSIGN_ANGLE_GRACE_DEG = 28.0
ENDPOINT_CLEANUP_ENABLED = True
ENDPOINT_CLEANUP_ITERS = 16
ENDPOINT_NEAR_SAME_MIN_MI = 2.2
ENDPOINT_GAIN_MIN_MI = 0.3
ENDPOINT_BENEFIT_MIN = 0.0
PAIR_BALANCED_REPARTITION = False
PREFERRED_ROUTE_DRIVE_MIN_LOCAL = 35.0
PREFERRED_ROUTE_DRIVE_MIN_REMOTE = 40.0
MAX_ROUTE_DIAMETER_MI_LOCAL = 12.0
MAX_ROUTE_DIAMETER_MI_REMOTE = 20.0
PLANNING_HORIZON_MONTHS = 1
PRODUCTION_GATES_ENABLED = True
QUALITY_GATES_HARD_FAIL = True
FIELDROUTES_ROUTE_TEMPLATE_ID_SPECIALTY = 35
FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR = 34
FIELDROUTES_ROUTE_TEMPLATE_ID_LAWN = 38
FIELDROUTES_ROUTE_TEMPLATE_ID_TUESDAY = 26
FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT = FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR
FIELDROUTES_TUESDAY_OVERRIDE = True
MIN_OSRM_MATRIX_COVERAGE = 0.98
MAX_ASSIGNED_FALLBACK_ROUTES = 0
MAX_ASSIGNED_MISSING_OSRM_ROUTE_METRICS = 0
MAX_ASSIGNED_UNDER_MIN_ROUTES = 4
MAX_ASSIGNED_SINGLE_STOP_ROUTES = 1
MAX_ASSIGNED_UNDER_MIN_NON_HARD_SPLIT = 0
REMOTE_ZONES = {
    # Approximate static boundaries for NW Arkansas / border behavior.
    # These are intentionally deterministic and can be tuned without API calls.
    "MISSOURI": {"lat_min": 36.5000},           # AR/MO border area
    "SOUTH_OF_PRAIRIE_GROVE": {"lat_max": 35.9750},
    "EAST_OF_PEA_RIDGE": {"lng_min": -94.0700},
    "EAST_OF_BEAVER_LAKE": {"lng_min": -94.0000},
}

US_HOLIDAYS = holidays.US()

RUN_SETTINGS_LIMITS = {
    "planningHorizonMonths": {"type": "int", "min": 1, "max": 6, "step": 1},
    "targetStopsPerRoute": {"type": "int", "min": 4, "max": 30, "step": 1},
    "minStopsPerRoute": {"type": "int", "min": 1, "max": 30, "step": 1},
    "maxStopsPerRoute": {"type": "int", "min": 1, "max": 40, "step": 1},
    "maxRouteDriveMinutes": {"type": "float", "min": 15.0, "max": 180.0, "step": 1.0},
    "defaultStopDurationMinutes": {"type": "int", "min": 5, "max": 180, "step": 1},
    "allowSaturdayOverflow": {"type": "bool"},
    "remoteStrict": {"type": "bool"},
    "preferredRouteDriveMinLocal": {"type": "float", "min": 5.0, "max": 180.0, "step": 1.0},
    "preferredRouteDriveMinRemote": {"type": "float", "min": 5.0, "max": 180.0, "step": 1.0},
    "maxRouteDiameterMiLocal": {"type": "float", "min": 1.0, "max": 100.0, "step": 0.5},
    "maxRouteDiameterMiRemote": {"type": "float", "min": 1.0, "max": 100.0, "step": 0.5},
    "qualityGateHardFail": {"type": "bool"},
    "fieldRoutesTemplateIdSpecialty": {"type": "int", "min": 1, "max": 9999, "step": 1},
    "fieldRoutesTemplateIdRegular": {"type": "int", "min": 1, "max": 9999, "step": 1},
    "fieldRoutesTemplateIdLawn": {"type": "int", "min": 1, "max": 9999, "step": 1},
    "fieldRoutesTemplateIdTuesday": {"type": "int", "min": 1, "max": 9999, "step": 1},
    "fieldRoutesTemplateIdDefault": {"type": "int", "min": 1, "max": 9999, "step": 1},
    "fieldRoutesTuesdayOverride": {"type": "bool"},
}

RUN_SETTINGS_UI_HINTS = {
    "persistenceKey": "flexRouting.runSettings.v1",
    "alwaysVisibleKeys": [
        "planningHorizonMonths",
        "targetStopsPerRoute",
        "minStopsPerRoute",
        "maxStopsPerRoute",
        "maxRouteDriveMinutes",
        "defaultStopDurationMinutes",
        "allowSaturdayOverflow",
    ],
    "advancedKeys": [
        "remoteStrict",
        "preferredRouteDriveMinLocal",
        "preferredRouteDriveMinRemote",
        "maxRouteDiameterMiLocal",
        "maxRouteDiameterMiRemote",
        "qualityGateHardFail",
        "fieldRoutesTemplateIdSpecialty",
        "fieldRoutesTemplateIdRegular",
        "fieldRoutesTemplateIdLawn",
        "fieldRoutesTemplateIdTuesday",
        "fieldRoutesTemplateIdDefault",
        "fieldRoutesTuesdayOverride",
    ],
}

RUN_SETTINGS_NON_EXPOSED_NOTES = [
    "ALLOW_MONTH_SPILL is declared but currently unused by the active routing path.",
    "ALLOW_SUNDAY_OVERFLOW is effectively no-op in current date builder logic.",
    "Saturday overflow is forced on in the active routing path regardless of allowSaturdayOverflow input.",
    "windowStart/windowEnd buffers are written but not consumed in the current solver path.",
    "STRICT_OSRM_FOR_OPTIMIZATION and FAIL_FAST_IF_OSRM_UNAVAILABLE remain locked in strict mode.",
]

SCHEDULING_REQUEST_COLUMN_ALIASES = [
    "Scheduling Requests",
    "Scheduling Request",
    "Schduling Requests",
    "Special Scheduling",
    "Special Scheduling Notes",
]

INPUT_COLUMN_ALIASES = {
    "customerID": ["customerID", "Customer ID", "CustomerID"],
    "subscriptionID": ["subscriptionID", "Subscription ID", "SubscriptionID"],
    "preferredTech": ["preferredTech", "Preferred Tech", "PreferredTech"],
    "lat": ["lat", "latitude", "Latitude", "Lat", "Customer Latitude", "GPS Latitude"],
    "lng": ["lng", "longitude", "Longitude", "Long", "Lng", "Customer Longitude", "GPS Longitude"],
    "serviceDue": ["serviceDue", "Service Due", "Initial Service", "Initial Service Date", "Due Date"],
}

COORDINATE_CACHE_CANDIDATE_FILES = [
    "routing_plan.edited.csv",
    "routing_plan.csv",
]

_WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
_WEEKDAY_INDEX_BY_TOKEN = {
    "mon": 0,
    "monday": 0,
    "mondays": 0,
    "tue": 1,
    "tues": 1,
    "tuesday": 1,
    "tuesdays": 1,
    "wed": 2,
    "weds": 2,
    "wednesday": 2,
    "wednesdays": 2,
    "thu": 3,
    "thur": 3,
    "thurs": 3,
    "thursday": 3,
    "thursdays": 3,
    "fri": 4,
    "friday": 4,
    "fridays": 4,
    "sat": 5,
    "saturday": 5,
    "saturdays": 5,
    "sun": 6,
    "sunday": 6,
    "sundays": 6,
}

_PHONE_CONFIRM_PATTERN = re.compile(
    r"\b(call|contact|phone|text|speak|confirm|week\s*notice|week'?s?\s+notice)\b",
    flags=re.IGNORECASE,
)
_DO_NOT_SCHEDULE_PATTERN = re.compile(
    r"\b(do\s*not\s*schedule|don't\s*schedule|dont\s*schedule|do\s*not\s*scheduel|do\s*not\s*book)\b",
    flags=re.IGNORECASE,
)
_PAYMENT_HOLD_PATTERN = re.compile(
    r"\b(payment|past\s*due|collections?|account\s*hold|hold\s*account|declined|nsf)\b",
    flags=re.IGNORECASE,
)
_MOVE_ADDRESS_HOLD_PATTERN = re.compile(
    r"\b(moved?|move[d]?\s*out|wrong\s*address|invalid\s*address|vacant|foreclosure|out\s*of\s*state)\b",
    flags=re.IGNORECASE,
)
_TIME_WINDOW_PATTERN = re.compile(
    r"\b(before|after|morning|afternoon|evening|am|pm|time\s*window|between)\b",
    flags=re.IGNORECASE,
)
_ONLY_WEEKDAY_PATTERN = re.compile(
    r"\b(?:only|must|strictly|schedule\s+only|only\s+schedule\s+on|only\s+on)\b",
    flags=re.IGNORECASE,
)
_BLOCKED_WEEKDAY_PATTERN = re.compile(
    r"\b(no|not\s+on|except)\s+([a-z,\s/&-]+)",
    flags=re.IGNORECASE,
)
_ASSIGNED_ROUTE_NUMBER_PATTERN = re.compile(r"Route\s+(\d+)\s*$", flags=re.IGNORECASE)


def _normalize_sched_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return ""
    return text


def _extract_weekday_indices(text: str) -> set:
    out = set()
    for token in re.findall(r"\b[a-z]{3,10}\b", str(text or "").lower()):
        idx = _WEEKDAY_INDEX_BY_TOKEN.get(token)
        if idx is not None:
            out.add(int(idx))
    return out


def _serialize_weekdays(values: set) -> str:
    ordered = [int(v) for v in sorted(set(values)) if 0 <= int(v) <= 6]
    return ",".join([_WEEKDAY_LABELS[v] for v in ordered])


def _deserialize_weekdays(value: Any) -> set:
    text = _normalize_sched_text(value)
    if not text:
        return set()
    out = set()
    for tok in text.split(","):
        t = tok.strip().upper()
        if t in _WEEKDAY_LABELS:
            out.add(_WEEKDAY_LABELS.index(t))
    return out


def _append_sched_reason(existing_reason: Any, sched_reason: str) -> str:
    base = _normalize_sched_text(existing_reason)
    if not base:
        return str(sched_reason)
    if base == str(sched_reason) or base.startswith(f"{sched_reason}|"):
        return base
    return f"{sched_reason}|{base}"


def _weekday_ok_for_date(route_date_val: Any, allowed: set, blocked: set) -> bool:
    if route_date_val is None or (isinstance(route_date_val, float) and np.isnan(route_date_val)):
        return False
    try:
        ts = pd.to_datetime(route_date_val, errors="coerce")
    except Exception:
        ts = pd.NaT
    if ts is pd.NaT or pd.isna(ts):
        return False
    wd = int(ts.dayofweek)
    if allowed and wd not in allowed:
        return False
    if blocked and wd in blocked:
        return False
    return True


def _route_sequence_indices(df: pd.DataFrame, route_name: str) -> list:
    idxs = df.index[df["routeName"].astype(str) == str(route_name)].tolist()
    if not idxs:
        return []
    ordered = df.loc[idxs].sort_values("sequence")
    return ordered.index.to_list()


def _best_insert_index_by_distance(route_points: list, lat: float, lng: float) -> int:
    if len(route_points) <= 0:
        return 0
    if len(route_points) == 1:
        return 1

    candidate = (float(lat), float(lng))
    best_idx = len(route_points)
    best_gain = None
    for ins in range(len(route_points) + 1):
        if ins == 0:
            gain = float(_haversine_miles(candidate[0], candidate[1], route_points[0][0], route_points[0][1]))
        elif ins == len(route_points):
            gain = float(_haversine_miles(route_points[-1][0], route_points[-1][1], candidate[0], candidate[1]))
        else:
            prev_pt = route_points[ins - 1]
            next_pt = route_points[ins]
            gain = (
                float(_haversine_miles(prev_pt[0], prev_pt[1], candidate[0], candidate[1]))
                + float(_haversine_miles(candidate[0], candidate[1], next_pt[0], next_pt[1]))
                - float(_haversine_miles(prev_pt[0], prev_pt[1], next_pt[0], next_pt[1]))
            )
        if best_gain is None or gain < best_gain:
            best_gain = gain
            best_idx = ins
    return int(best_idx)


def _resequence_route(df: pd.DataFrame, route_name: str) -> None:
    idxs = _route_sequence_indices(df, route_name)
    if not idxs:
        return
    df.loc[idxs, "sequence"] = np.arange(1, len(idxs) + 1)


def _recompute_route_drive_minutes(df: pd.DataFrame, route_name: str) -> None:
    idxs = _route_sequence_indices(df, route_name)
    if not idxs:
        return
    g = df.loc[idxs].sort_values("sequence")
    pts = list(zip(g["lat"].astype(float), g["lng"].astype(float)))
    mins = float(route_drive_minutes_from_points_fast(pts)) if len(pts) >= 2 else 0.0
    df.loc[idxs, "routeDriveMinutesMatrix"] = mins


def _extract_route_number(route_name: str, fallback: int = 1) -> int:
    m = _ASSIGNED_ROUTE_NUMBER_PATTERN.search(str(route_name or ""))
    if m:
        try:
            return int(m.group(1))
        except Exception:
            pass
    try:
        return max(1, int(fallback))
    except Exception:
        return 1


def _format_assigned_route_name(tech: str, route_date: Any, route_index: Any, route_num: int) -> str:
    try:
        dt = pd.to_datetime(route_date, errors="coerce")
    except Exception:
        dt = pd.NaT
    if dt is pd.NaT or pd.isna(dt):
        date_text = "UNASSIGNED"
    else:
        date_text = str(dt.date())

    try:
        idx_text = f"Working Day {int(float(route_index))}"
    except Exception:
        idx_text = "Working Day ?"

    return f"{str(tech)} — {date_text} ({idx_text}) — Route {int(route_num)}"


def _refresh_assigned_route_names(df: pd.DataFrame) -> None:
    if "routeName" not in df.columns:
        return
    for route_name, g in df.groupby("routeName", sort=False):
        idxs = g.index.to_list()
        if not idxs:
            continue
        route_name_str = str(route_name)
        route_date = g["routeDate"].iloc[0] if "routeDate" in g.columns else None
        try:
            route_dt = pd.to_datetime(route_date, errors="coerce")
        except Exception:
            route_dt = pd.NaT
        is_unassigned = ("UNASSIGNED" in route_name_str.upper()) or pd.isna(route_dt)
        if is_unassigned:
            continue
        tech = str(g["preferredTech"].iloc[0]) if "preferredTech" in g.columns else ""
        route_idx = g["routeIndex"].iloc[0] if "routeIndex" in g.columns else None
        route_num = _extract_route_number(route_name_str)
        df.loc[idxs, "routeName"] = _format_assigned_route_name(tech, route_dt, route_idx, route_num)


def _build_route_scaffold_payload(
    df: pd.DataFrame,
    *,
    planning_start: Any,
    planning_end: Any,
    run_id: Optional[str] = None,
) -> Dict[str, Any]:
    try:
        start_date = pd.to_datetime(planning_start, errors="coerce").date()
    except Exception:
        start_date = pd.Timestamp.utcnow().date()
    try:
        end_date = pd.to_datetime(planning_end, errors="coerce").date()
    except Exception:
        end_date = start_date
    if end_date < start_date:
        end_date = start_date

    weekdays = generate_valid_dates(start_date, end_date)
    saturdays = generate_saturday_dates(start_date, end_date)
    if not ALLOW_SUNDAY_OVERFLOW:
        saturdays = [d for d in saturdays if int(d.weekday()) == 5]
    day_dates = list(weekdays) + list(saturdays)

    scaffolds = []
    if len(day_dates) == 0 or "preferredTech" not in df.columns:
        return {
            "runId": (None if run_id is None else str(run_id)),
            "generatedAt": datetime.utcnow().isoformat() + "Z",
            "planningStart": str(start_date),
            "planningEnd": str(end_date),
            "saturdayOverflowForced": bool(FORCE_SATURDAY_OVERFLOW),
            "routeCount": 0,
            "routes": [],
        }

    techs = sorted(
        {
            str(v).strip()
            for v in df["preferredTech"].fillna("").astype(str).tolist()
            if str(v).strip()
        }
    )

    for tech in techs:
        tech_mask = df["preferredTech"].fillna("").astype(str).str.strip() == str(tech)
        if not bool(tech_mask.any()):
            continue
        tech_df = df.loc[tech_mask].copy()

        assigned_dates = set()
        used_route_nums = set()
        used_route_names = set()

        for route_name, g in tech_df.groupby("routeName", sort=False):
            route_name_s = str(route_name or "").strip()
            if not route_name_s:
                continue
            used_route_names.add(route_name_s)
            used_route_nums.add(_extract_route_number(route_name_s, fallback=1))

            route_date_val = g["routeDate"].iloc[0] if "routeDate" in g.columns else None
            route_dt = pd.to_datetime(route_date_val, errors="coerce")
            if route_dt is pd.NaT or pd.isna(route_dt):
                continue
            if "UNASSIGNED" in route_name_s.upper():
                continue
            assigned_dates.add(route_dt.date())

        next_route_num = max(used_route_nums) + 1 if used_route_nums else 1
        for day_idx, day_date in enumerate(day_dates, start=1):
            if day_date in assigned_dates:
                continue

            route_num = int(next_route_num)
            route_name_new = _format_assigned_route_name(str(tech), day_date, day_idx, route_num)
            while route_name_new in used_route_names:
                route_num += 1
                route_name_new = _format_assigned_route_name(str(tech), day_date, day_idx, route_num)
            next_route_num = int(route_num + 1)
            used_route_names.add(route_name_new)

            scaffolds.append(
                {
                    "routeName": str(route_name_new),
                    "routeIndex": int(day_idx),
                    "tech": str(tech),
                    "date": str(day_date),
                    "dayType": ("SATURDAY_OVERFLOW" if int(day_date.weekday()) == 5 else "WEEKDAY"),
                    "sequenceStrategy": "SCAFFOLD_EMPTY_ROUTE",
                    "driveModel": "SCAFFOLD_EMPTY_ROUTE",
                    "fieldRoutesTemplateID": "",
                    "fieldRoutesTemplateSource": "scaffold",
                    "isScaffoldRoute": True,
                }
            )

    return {
        "runId": (None if run_id is None else str(run_id)),
        "generatedAt": datetime.utcnow().isoformat() + "Z",
        "planningStart": str(start_date),
        "planningEnd": str(end_date),
        "saturdayOverflowForced": bool(FORCE_SATURDAY_OVERFLOW),
        "routeCount": int(len(scaffolds)),
        "routes": list(scaffolds),
    }


def _resolve_fieldroutes_template_for_route_group(route_name: str, group_df: pd.DataFrame) -> Tuple[Optional[int], str]:
    route_date_val = group_df["routeDate"].iloc[0] if "routeDate" in group_df.columns else None
    if bool(FIELDROUTES_TUESDAY_OVERRIDE):
        try:
            ts = pd.to_datetime(route_date_val, errors="coerce")
            if ts is not pd.NaT and not pd.isna(ts) and int(ts.dayofweek) == 1:
                return int(FIELDROUTES_ROUTE_TEMPLATE_ID_TUESDAY), "tuesday_override"
        except Exception:
            pass

    text_parts = [str(route_name or "")]
    for col in ("dayType", "assignmentReason", "capacityReason", "schedulingRequestClass"):
        if col not in group_df.columns:
            continue
        vals = [str(v).strip() for v in group_df[col].dropna().astype(str).tolist() if str(v).strip()]
        if vals:
            text_parts.extend(vals)
    blob = " ".join(text_parts).lower()
    if ("specialty" in blob) or ("speciality" in blob):
        return int(FIELDROUTES_ROUTE_TEMPLATE_ID_SPECIALTY), "specialty_match"
    if "lawn" in blob:
        return int(FIELDROUTES_ROUTE_TEMPLATE_ID_LAWN), "lawn_match"
    if "regular" in blob:
        return int(FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR), "regular_match"
    return int(FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT), "default"


def _apply_fieldroutes_template_ids(df: pd.DataFrame) -> Dict[str, Any]:
    if "routeName" not in df.columns:
        df["fieldRoutesTemplateID"] = ""
        df["fieldRoutesTemplateSource"] = ""
        return {"routesTagged": 0, "sources": {}}

    source_counts: Dict[str, int] = {}
    routes_tagged = 0
    for route_name, g in df.groupby("routeName", sort=False):
        idxs = g.index.to_list()
        if not idxs:
            continue
        template_id, source = _resolve_fieldroutes_template_for_route_group(str(route_name), g)
        df.loc[idxs, "fieldRoutesTemplateID"] = (int(template_id) if template_id is not None else "")
        df.loc[idxs, "fieldRoutesTemplateSource"] = str(source or "")
        routes_tagged += 1
        source_counts[str(source or "unknown")] = int(source_counts.get(str(source or "unknown"), 0) + 1)
    return {"routesTagged": int(routes_tagged), "sources": source_counts}


def _is_assigned_route_row(route_name: Any, route_date: Any) -> bool:
    route_name_str = str(route_name or "")
    if "UNASSIGNED" in route_name_str.upper():
        return False
    try:
        route_dt = pd.to_datetime(route_date, errors="coerce")
    except Exception:
        route_dt = pd.NaT
    return not (route_dt is pd.NaT or pd.isna(route_dt))


def _infer_month_token_for_tech(df: pd.DataFrame, tech_name: str) -> Optional[str]:
    if "preferredTech" not in df.columns:
        return None
    tech_mask = df["preferredTech"].astype(str).str.strip() == str(tech_name).strip()
    if not bool(tech_mask.any()):
        return None
    tech_df = df.loc[tech_mask]
    if "targetMonth" in tech_df.columns:
        month_vals = tech_df["targetMonth"].fillna("").astype(str).str.strip()
        month_vals = month_vals[month_vals.str.match(r"^\d{4}-\d{2}$", na=False)]
        if len(month_vals) > 0:
            try:
                return str(month_vals.mode().iloc[0])
            except Exception:
                return str(month_vals.iloc[0])

    base_ts = pd.NaT
    if "serviceDue" in tech_df.columns:
        due_vals = pd.to_datetime(tech_df["serviceDue"], errors="coerce").dropna()
        if len(due_vals) > 0:
            base_ts = due_vals.min()
    if (base_ts is pd.NaT or pd.isna(base_ts)) and ("routeDate" in tech_df.columns):
        route_vals = pd.to_datetime(tech_df["routeDate"], errors="coerce").dropna()
        if len(route_vals) > 0:
            base_ts = route_vals.min()
    if base_ts is pd.NaT or pd.isna(base_ts):
        base_ts = pd.Timestamp.utcnow()
    return f"{int(base_ts.year):04d}-{int(base_ts.month):02d}"


def _day_dates_for_tech(df: pd.DataFrame, tech_name: str) -> list:
    month_token = _infer_month_token_for_tech(df, tech_name)
    if not month_token:
        return []
    try:
        month_start = pd.Timestamp(f"{month_token}-01").date()
        month_end = (pd.Timestamp(month_start) + pd.offsets.MonthEnd(0)).date()
    except Exception:
        return []
    weekdays, saturdays = _build_dates_for_month(month_start, month_end)
    day_dates = list(weekdays) + list(saturdays)
    if len(day_dates) == 0:
        day_dates = [month_start]
    try:
        # Preserve historical weekday cap while still including Saturday overflow days.
        max_days = max(1, int(MAX_WORKING_DAYS) + int(len(saturdays)))
        day_dates = day_dates[:max_days]
    except Exception:
        pass
    return day_dates


def _tech_used_dates_and_index_map(df: pd.DataFrame, tech_name: str):
    used_dates = set()
    date_to_index = {}
    if "preferredTech" not in df.columns:
        return used_dates, date_to_index
    tech_mask = df["preferredTech"].astype(str).str.strip() == str(tech_name).strip()
    if not bool(tech_mask.any()):
        return used_dates, date_to_index
    tech_df = df.loc[tech_mask].copy()
    route_dates = pd.to_datetime(tech_df.get("routeDate", pd.Series(dtype=object)), errors="coerce")
    route_names = tech_df.get("routeName", pd.Series(dtype=object)).fillna("").astype(str)
    assigned_mask = route_dates.notna() & (~route_names.str.upper().str.contains("UNASSIGNED"))
    if not bool(assigned_mask.any()):
        return used_dates, date_to_index
    assigned_df = tech_df.loc[assigned_mask].copy()
    assigned_dates = pd.to_datetime(assigned_df.get("routeDate", pd.Series(dtype=object)), errors="coerce")
    for idx, dval in assigned_dates.items():
        if dval is pd.NaT or pd.isna(dval):
            continue
        d = dval.date()
        used_dates.add(d)
        if d in date_to_index:
            continue
        try:
            ridx_val = assigned_df.loc[idx, "routeIndex"]
            ridx = int(float(ridx_val))
            if ridx > 0:
                date_to_index[d] = ridx
        except Exception:
            continue
    return used_dates, date_to_index


def _next_route_number_for_tech(df: pd.DataFrame, tech_name: str) -> int:
    if "preferredTech" not in df.columns or "routeName" not in df.columns:
        return 1
    tech_mask = df["preferredTech"].astype(str).str.strip() == str(tech_name).strip()
    if not bool(tech_mask.any()):
        return 1
    max_num = 0
    for route_name in df.loc[tech_mask, "routeName"].fillna("").astype(str).tolist():
        rn = _extract_route_number(route_name, fallback=1)
        if rn > max_num:
            max_num = rn
    return int(max_num + 1)


def _route_drive_minutes_fast_from_df(df_route: pd.DataFrame) -> float:
    if len(df_route) <= 1:
        return 0.0
    pts = list(zip(df_route["lat"].astype(float), df_route["lng"].astype(float)))
    return float(route_drive_minutes_from_points_fast(pts))


def _route_drive_minutes_osrm_from_df(df_route: pd.DataFrame) -> Optional[float]:
    if len(df_route) <= 1:
        return 0.0
    pts = list(zip(df_route["lat"].astype(float), df_route["lng"].astype(float)))
    val = route_drive_minutes_from_points_osrm_only(pts)
    if val is None:
        return None
    try:
        f = float(val)
    except Exception:
        return None
    if not np.isfinite(f):
        return None
    return float(f)


def _best_contiguous_split_index_for_drive(df_route: pd.DataFrame, max_drive: float) -> Optional[int]:
    n = int(len(df_route))
    if n <= 1:
        return None
    best_cut = None
    best_key = None
    for cut in range(1, n):
        left = df_route.iloc[:cut]
        right = df_route.iloc[cut:]
        d_left = _route_drive_minutes_fast_from_df(left)
        d_right = _route_drive_minutes_fast_from_df(right)
        over_left = max(0.0, float(d_left) - float(max_drive))
        over_right = max(0.0, float(d_right) - float(max_drive))
        over_stops = max(0, int(len(left)) - int(MAX_STOPS_PER_ROUTE)) + max(0, int(len(right)) - int(MAX_STOPS_PER_ROUTE))
        key = (
            int((over_left > 1e-6) or (over_right > 1e-6)),
            float(over_left + over_right),
            int(over_stops),
            float(max(d_left, d_right)),
            abs(int(len(left)) - int(len(right))),
        )
        if best_key is None or key < best_key:
            best_key = key
            best_cut = int(cut)
    return best_cut


def _split_route_contiguous_for_constraints(df_route: pd.DataFrame, max_drive: float, tolerance: float) -> list:
    if len(df_route) <= 1:
        return [df_route.copy()]
    pending = [df_route.copy()]
    out = []
    max_iters = 40
    iters = 0
    while pending and iters < max_iters:
        iters += 1
        chunk = pending.pop(0).copy()
        if len(chunk) <= 1:
            out.append(chunk)
            continue
        d_fast = _route_drive_minutes_fast_from_df(chunk)
        too_many_stops = int(len(chunk)) > int(MAX_STOPS_PER_ROUTE)
        over_drive = float(d_fast) > (float(max_drive) + float(tolerance) + 1e-6)
        if not too_many_stops and not over_drive:
            out.append(chunk)
            continue
        cut = _best_contiguous_split_index_for_drive(chunk, max_drive=max_drive)
        if cut is None or cut <= 0 or cut >= len(chunk):
            out.append(chunk)
            continue
        left = chunk.iloc[:cut].copy()
        right = chunk.iloc[cut:].copy()
        pending = [left, right] + pending
    if pending:
        out.extend(pending)
    out = sorted(out, key=lambda x: float(x["sequence"].min()) if len(x) > 0 else 0.0)
    return [x.copy() for x in out if len(x) > 0]


def _attempt_split_assigned_route_into_unused_days(
    df: pd.DataFrame,
    route_name: str,
    idxs: list,
    max_drive_min: float,
    tolerance_min: float,
    require_osrm: bool = False,
) -> bool:
    if not idxs:
        return False
    g = df.loc[idxs].copy().sort_values("sequence")
    if len(g) <= 1:
        return False
    tech_name = str(g["preferredTech"].iloc[0]) if "preferredTech" in g.columns else ""
    if not tech_name:
        return False

    current_route_date_ts = pd.to_datetime(g["routeDate"].iloc[0], errors="coerce")
    if current_route_date_ts is pd.NaT or pd.isna(current_route_date_ts):
        return False
    current_route_date = current_route_date_ts.date()

    try:
        current_route_idx = int(float(g["routeIndex"].iloc[0]))
    except Exception:
        current_route_idx = None

    day_dates = _day_dates_for_tech(df, tech_name)
    if not day_dates:
        return False

    used_dates, date_to_index = _tech_used_dates_and_index_map(df, tech_name)
    unused_dates = [d for d in day_dates if (d not in used_dates and d != current_route_date)]
    if len(unused_dates) <= 0:
        return False

    chunks = _split_route_contiguous_for_constraints(g, max_drive=float(max_drive_min), tolerance=float(tolerance_min))
    if len(chunks) <= 1:
        return False

    extra_needed = int(len(chunks) - 1)
    if len(unused_dates) < extra_needed:
        return False

    # Keep first chunk on the original route date; spill remaining chunks to nearest open dates.
    unused_dates = sorted(unused_dates, key=lambda d: abs((d - current_route_date).days))
    route_num_base = _extract_route_number(str(route_name), fallback=1)
    next_route_num = max(route_num_base + 1, _next_route_number_for_tech(df, tech_name))

    assignments = []
    for ci, chunk in enumerate(chunks):
        if ci == 0:
            assign_date = current_route_date
            assign_idx = current_route_idx
            if assign_idx is None:
                assign_idx = date_to_index.get(assign_date)
            if assign_idx is None:
                try:
                    assign_idx = int(day_dates.index(assign_date)) + 1
                except Exception:
                    assign_idx = 1
            assign_num = route_num_base
        else:
            assign_date = unused_dates[ci - 1]
            assign_idx = date_to_index.get(assign_date)
            if assign_idx is None:
                try:
                    assign_idx = int(day_dates.index(assign_date)) + 1
                except Exception:
                    assign_idx = int((current_route_idx or 0) + ci)
            assign_num = int(next_route_num)
            next_route_num += 1

        osrm_min = _route_drive_minutes_osrm_from_df(chunk)
        fast_min = _route_drive_minutes_fast_from_df(chunk)
        if require_osrm and len(chunk) > 1 and osrm_min is None:
            return False
        eval_min = float(osrm_min if (osrm_min is not None and np.isfinite(float(osrm_min))) else fast_min)
        if eval_min > float(max_drive_min) + float(tolerance_min) + 1e-6:
            return False
        assignments.append(
            {
                "idxs": chunk.index.to_list(),
                "routeDate": assign_date,
                "routeIndex": int(assign_idx),
                "routeNum": int(assign_num),
                "driveMatrix": float(fast_min),
                "driveOSRM": None if osrm_min is None else float(osrm_min),
            }
        )

    for assn in assignments:
        idx_list = assn["idxs"]
        route_num = int(assn["routeNum"])
        route_date = assn["routeDate"]
        route_idx = int(assn["routeIndex"])
        route_name_new = _format_assigned_route_name(tech_name, route_date, route_idx, route_num)
        df.loc[idx_list, "routeDate"] = pd.Timestamp(route_date)
        df.loc[idx_list, "routeIndex"] = route_idx
        df.loc[idx_list, "routeName"] = route_name_new
        df.loc[idx_list, "sequence"] = np.arange(1, len(idx_list) + 1)
        df.loc[idx_list, "assignmentReason"] = "QUALITY_OVERFLOW_OSRM_ROUTE_SPLIT"
        if "capacityReason" not in df.columns:
            df["capacityReason"] = ""
        cap_vals = df.loc[idx_list, "capacityReason"].fillna("").astype(str).str.strip()
        empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
        if bool(empty_cap.any()):
            fill_idx = cap_vals.index[empty_cap.to_numpy()]
            df.loc[fill_idx, "capacityReason"] = "QUALITY_OVERFLOW_OSRM_ROUTE_SPLIT"
        df.loc[idx_list, "routeDriveMinutesMatrix"] = float(assn["driveMatrix"])
        if assn["driveOSRM"] is not None:
            df.loc[idx_list, "routeDriveMinutesOSRM"] = float(assn["driveOSRM"])

    return True


def _current_unassigned_mask(df: pd.DataFrame) -> pd.Series:
    route_names = df.get("routeName", pd.Series(dtype=object)).fillna("").astype(str)
    route_dates = pd.to_datetime(df.get("routeDate", pd.Series(dtype=object)), errors="coerce")
    return route_dates.isna() | route_names.str.upper().str.contains("UNASSIGNED", na=False)


def _recover_high_unassigned_fraction(df: pd.DataFrame) -> Dict[str, Any]:
    summary = {
        "triggered": False,
        "before": 0,
        "moved": 0,
        "remaining": 0,
        "techsTouched": 0,
    }
    if len(df) == 0:
        return summary
    required_cols = {"preferredTech", "lat", "lng", "routeName", "routeDate", "sequence"}
    if not required_cols.issubset(set(df.columns)):
        return summary

    un_mask = _current_unassigned_mask(df)
    before = int(un_mask.sum())
    summary["before"] = int(before)
    if before <= 0:
        return summary

    trigger_threshold = max(40, int(round(0.20 * float(len(df)))))
    if before < trigger_threshold:
        summary["remaining"] = int(before)
        return summary

    summary["triggered"] = True
    moved_total = 0
    techs_touched = 0
    max_stops = int(MAX_STOPS_PER_ROUTE)

    for tech_name in sorted(df.loc[un_mask, "preferredTech"].astype(str).str.strip().unique().tolist()):
        if not tech_name:
            continue
        tech_mask = df["preferredTech"].astype(str).str.strip() == str(tech_name)
        tech_un_mask = tech_mask & _current_unassigned_mask(df)
        if not bool(tech_un_mask.any()):
            continue

        day_dates = _day_dates_for_tech(df, tech_name)
        if len(day_dates) == 0:
            continue

        techs_touched += 1

        # 1) Fill existing assigned routes with nearest unassigned stops up to MAX_STOPS_PER_ROUTE.
        assigned_route_names = []
        tech_df = df.loc[tech_mask]
        for route_name, g in tech_df.groupby("routeName", sort=False):
            route_date_val = g["routeDate"].iloc[0] if "routeDate" in g.columns else None
            if _is_assigned_route_row(route_name, route_date_val):
                assigned_route_names.append(str(route_name))

        for route_name in assigned_route_names:
            ridxs = _route_sequence_indices(df, route_name)
            if len(ridxs) == 0:
                continue
            slots = int(max(0, max_stops - len(ridxs)))
            if slots <= 0:
                continue

            route_template = df.loc[ridxs[0]]
            for _ in range(slots):
                tech_un_mask = tech_mask & _current_unassigned_mask(df)
                candidate_idxs = df.index[tech_un_mask].tolist()
                if len(candidate_idxs) == 0:
                    break

                route_df = df.loc[ridxs].copy().sort_values("sequence")
                if len(route_df) == 0:
                    break
                c_lat = float(route_df["lat"].astype(float).mean())
                c_lng = float(route_df["lng"].astype(float).mean())

                best_idx = None
                best_dist = None
                for cidx in candidate_idxs:
                    row = df.loc[cidx]
                    if not _row_can_join_route(row, route_df):
                        continue
                    d = float(_haversine_miles(float(row["lat"]), float(row["lng"]), c_lat, c_lng))
                    if best_dist is None or d < best_dist:
                        best_dist = d
                        best_idx = int(cidx)
                if best_idx is None:
                    break

                df.loc[best_idx, "routeDate"] = route_template.get("routeDate")
                df.loc[best_idx, "routeIndex"] = route_template.get("routeIndex")
                df.loc[best_idx, "routeName"] = str(route_name)
                if "dayType" in df.columns:
                    df.loc[best_idx, "dayType"] = str(route_template.get("dayType", "WEEKDAY"))
                if "assignmentReason" in df.columns:
                    df.loc[best_idx, "assignmentReason"] = "RECOVERY_ASSIGN_EXISTING"
                if "capacityReason" in df.columns:
                    cur_cap = str(df.loc[best_idx, "capacityReason"] if best_idx in df.index else "").strip()
                    if not cur_cap or cur_cap == "nan":
                        df.loc[best_idx, "capacityReason"] = "RECOVERY_ASSIGN_EXISTING"

                seq_vals = pd.to_numeric(df.loc[ridxs, "sequence"], errors="coerce")
                next_seq = int(seq_vals.max()) + 1 if len(seq_vals.dropna()) > 0 else (len(ridxs) + 1)
                df.loc[best_idx, "sequence"] = int(next_seq)
                ridxs.append(int(best_idx))
                _resequence_route(df, route_name)
                moved_total += 1

        # 2) Create new assigned routes on unused work dates for remaining unassigned.
        tech_un_mask = tech_mask & _current_unassigned_mask(df)
        remaining_idxs = df.index[tech_un_mask].tolist()
        if len(remaining_idxs) == 0:
            continue

        used_dates, _ = _tech_used_dates_and_index_map(df, tech_name)
        unused_dates = [d for d in day_dates if d not in used_dates]
        if len(unused_dates) == 0:
            continue

        rem_df = df.loc[remaining_idxs].copy()
        hub_lat = float(df.loc[tech_mask, "lat"].astype(float).mean())
        hub_lng = float(df.loc[tech_mask, "lng"].astype(float).mean())
        rem_df["__ang"] = np.array(
            [
                math.atan2(float(r["lat"]) - hub_lat, float(r["lng"]) - hub_lng)
                for _, r in rem_df.iterrows()
            ],
            dtype=float,
        )
        rem_df["__ang"] = np.where(rem_df["__ang"].to_numpy() < 0.0, rem_df["__ang"].to_numpy() + (2.0 * math.pi), rem_df["__ang"].to_numpy())
        rem_df["__dist"] = rem_df.apply(
            lambda r: _haversine_miles(float(r["lat"]), float(r["lng"]), hub_lat, hub_lng),
            axis=1,
        )
        rem_df = rem_df.sort_values(["__ang", "__dist"], ascending=[True, False])
        ordered_idxs = rem_df.index.tolist()

        next_route_num = _next_route_number_for_tech(df, tech_name)
        for day_date in unused_dates:
            if len(ordered_idxs) == 0:
                break
            take = min(max_stops, len(ordered_idxs))
            chunk_idxs = ordered_idxs[:take]
            ordered_idxs = ordered_idxs[take:]
            if len(chunk_idxs) == 0:
                continue
            try:
                day_idx = int(day_dates.index(day_date)) + 1
            except Exception:
                day_idx = int(len(used_dates) + 1)

            route_name_new = _format_assigned_route_name(str(tech_name), day_date, day_idx, int(next_route_num))
            next_route_num += 1
            df.loc[chunk_idxs, "routeDate"] = pd.Timestamp(day_date)
            df.loc[chunk_idxs, "routeIndex"] = int(day_idx)
            df.loc[chunk_idxs, "routeName"] = str(route_name_new)
            if "dayType" in df.columns:
                df.loc[chunk_idxs, "dayType"] = ("SATURDAY_OVERFLOW" if int(day_date.weekday()) == 5 else "WEEKDAY")
            if "assignmentReason" in df.columns:
                df.loc[chunk_idxs, "assignmentReason"] = "RECOVERY_ASSIGN_NEW_ROUTE"
            if "capacityReason" in df.columns:
                cap_vals = df.loc[chunk_idxs, "capacityReason"].fillna("").astype(str).str.strip()
                empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                if bool(empty_cap.any()):
                    fill_idx = cap_vals.index[empty_cap.to_numpy()]
                    df.loc[fill_idx, "capacityReason"] = "RECOVERY_ASSIGN_NEW_ROUTE"
            df.loc[chunk_idxs, "sequence"] = np.arange(1, len(chunk_idxs) + 1)
            moved_total += int(len(chunk_idxs))

    summary["moved"] = int(moved_total)
    summary["techsTouched"] = int(techs_touched)
    summary["remaining"] = int(_current_unassigned_mask(df).sum())
    return summary


def parse_scheduling_request(value: Any) -> Dict[str, Any]:
    raw = _normalize_sched_text(value)
    result = {
        "schedulingRequestRaw": raw,
        "schedulingRequestClass": "",
        "schedulingAllowedWeekdays": "",
        "schedulingBlockedWeekdays": "",
        "schedulingRequiresPhoneConfirm": False,
        "schedulingCritical": False,
        "schedulingConstraintStatus": "",
        "schedulingConstraintNote": "",
    }
    if not raw:
        return result

    txt = str(raw)
    lowered = txt.lower()
    all_weekdays = _extract_weekday_indices(lowered)
    blocked = set()
    allowed = set()

    for m in _BLOCKED_WEEKDAY_PATTERN.finditer(lowered):
        blocked |= _extract_weekday_indices(m.group(2))
    if _ONLY_WEEKDAY_PATTERN.search(lowered) and all_weekdays:
        allowed |= set(all_weekdays)
    # Handle "Fridays only" / "Monday or Fridays only"
    if ("only" in lowered) and all_weekdays and not allowed:
        allowed |= set(all_weekdays)

    requires_phone = bool(_PHONE_CONFIRM_PATTERN.search(txt))
    do_not_schedule = bool(_DO_NOT_SCHEDULE_PATTERN.search(txt))
    payment_hold = bool(_PAYMENT_HOLD_PATTERN.search(txt))
    move_hold = bool(_MOVE_ADDRESS_HOLD_PATTERN.search(txt))
    time_window = bool(_TIME_WINDOW_PATTERN.search(txt))
    critical = bool(do_not_schedule or payment_hold or move_hold)

    class_name = "FREE_TEXT"
    if do_not_schedule:
        class_name = "DO_NOT_SCHEDULE"
    elif payment_hold:
        class_name = "PAYMENT_OR_ACCOUNT_HOLD"
    elif move_hold:
        class_name = "MOVE_OR_ADDRESS_HOLD"
    elif allowed:
        class_name = "HARD_WEEKDAY_ONLY"
    elif blocked:
        class_name = "HARD_WEEKDAY_EXCLUDE"
    elif requires_phone:
        class_name = "CALL_REQUIRED"
    elif all_weekdays:
        class_name = "SOFT_WEEKDAY_PREFERENCE"
    elif time_window:
        class_name = "TIME_WINDOW_REQUEST"

    note_parts = []
    if allowed:
        note_parts.append(f"only {_serialize_weekdays(allowed)}")
    if blocked:
        note_parts.append(f"avoid {_serialize_weekdays(blocked)}")
    if requires_phone:
        note_parts.append("phone confirm")
    if critical:
        note_parts.append("critical request")

    result["schedulingRequestClass"] = class_name
    result["schedulingAllowedWeekdays"] = _serialize_weekdays(allowed)
    result["schedulingBlockedWeekdays"] = _serialize_weekdays(blocked)
    result["schedulingRequiresPhoneConfirm"] = bool(requires_phone)
    result["schedulingCritical"] = bool(critical)
    result["schedulingConstraintStatus"] = (
        "PENDING"
        if class_name in {"HARD_WEEKDAY_ONLY", "HARD_WEEKDAY_EXCLUDE"}
        else "OK"
    )
    result["schedulingConstraintNote"] = "; ".join(note_parts)
    return result

ROUTING_PLAN_EXPORT_COLUMNS = [
    "planStopId",
    "customerID",
    "subscriptionID",
    "preferredTech",
    "routeDate",
    "routeName",
    "routeIndex",
    "sequence",
    "duration",
    "isRemote",
    "remoteZone",
    "assignmentReason",
    "sequenceStrategy",
    "driveModel",
    "dayType",
    "fieldRoutesTemplateID",
    "fieldRoutesTemplateSource",
    "capacityReason",
    "routeDriveMinutesMatrix",
    "routeDriveMinutesOSRM",
    "lat",
    "lng",
    "schedulingRequestRaw",
    "schedulingRequestClass",
    "schedulingAllowedWeekdays",
    "schedulingBlockedWeekdays",
    "schedulingRequiresPhoneConfirm",
    "schedulingCritical",
    "schedulingConstraintStatus",
    "schedulingConstraintNote",
]

_RUN_SETTINGS_DEFAULTS_BASE = {
    "planningHorizonMonths": int(PLANNING_HORIZON_MONTHS),
    "targetStopsPerRoute": int(TARGET_STOPS_PER_DAY),
    "minStopsPerRoute": int(MIN_STOPS_PER_DAY),
    "maxStopsPerRoute": int(MAX_STOPS_PER_DAY),
    "maxRouteDriveMinutes": float(MAX_ROUTE_DRIVE_MIN),
    "defaultStopDurationMinutes": int(DEFAULT_DURATION),
    "allowSaturdayOverflow": bool(ALLOW_SATURDAY_OVERFLOW),
    "remoteStrict": bool(REMOTE_STRICT),
    "preferredRouteDriveMinLocal": float(PREFERRED_ROUTE_DRIVE_MIN_LOCAL),
    "preferredRouteDriveMinRemote": float(PREFERRED_ROUTE_DRIVE_MIN_REMOTE),
    "maxRouteDiameterMiLocal": float(MAX_ROUTE_DIAMETER_MI_LOCAL),
    "maxRouteDiameterMiRemote": float(MAX_ROUTE_DIAMETER_MI_REMOTE),
    "qualityGateHardFail": bool(QUALITY_GATES_HARD_FAIL),
    "fieldRoutesTemplateIdSpecialty": int(FIELDROUTES_ROUTE_TEMPLATE_ID_SPECIALTY),
    "fieldRoutesTemplateIdRegular": int(FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR),
    "fieldRoutesTemplateIdLawn": int(FIELDROUTES_ROUTE_TEMPLATE_ID_LAWN),
    "fieldRoutesTemplateIdTuesday": int(FIELDROUTES_ROUTE_TEMPLATE_ID_TUESDAY),
    "fieldRoutesTemplateIdDefault": int(FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT),
    "fieldRoutesTuesdayOverride": bool(FIELDROUTES_TUESDAY_OVERRIDE),
}


def get_run_settings_defaults() -> Dict[str, Any]:
    return deepcopy(_RUN_SETTINGS_DEFAULTS_BASE)


def get_run_settings_limits() -> Dict[str, Any]:
    return deepcopy(RUN_SETTINGS_LIMITS)


def get_run_settings_ui_hints() -> Dict[str, Any]:
    return deepcopy(RUN_SETTINGS_UI_HINTS)


def get_non_exposed_run_settings_notes():
    return list(RUN_SETTINGS_NON_EXPOSED_NOTES)


def _parse_run_setting_bool(key: str, value: Any) -> bool:
    if isinstance(value, bool):
        return bool(value)
    if isinstance(value, (int, float)) and value in (0, 1):
        return bool(int(value))
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "1", "yes", "on"}:
            return True
        if lowered in {"false", "0", "no", "off"}:
            return False
    raise ValueError(f"Invalid boolean value for '{key}'.")


def _parse_run_setting_number(key: str, value: Any, want_type: str) -> float:
    if value is None:
        raise ValueError(f"Missing numeric value for '{key}'.")
    if isinstance(value, bool):
        raise ValueError(f"Invalid numeric value for '{key}'.")
    try:
        num = float(value)
    except Exception as e:
        raise ValueError(f"Invalid numeric value for '{key}'.") from e
    if not np.isfinite(num):
        raise ValueError(f"Invalid numeric value for '{key}'.")
    if want_type == "int":
        return float(int(num))
    return float(num)


def normalize_run_settings(raw: Optional[dict]) -> Dict[str, Any]:
    defaults = get_run_settings_defaults()
    limits = get_run_settings_limits()
    effective = deepcopy(defaults)
    corrections = []
    unknown_keys = []

    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise ValueError("Run settings must be a JSON object.")

    for key, value in raw.items():
        if key not in limits:
            unknown_keys.append(str(key))
            continue
        spec = limits[key]
        typ = str(spec.get("type"))
        if typ == "bool":
            effective[key] = _parse_run_setting_bool(key, value)
            continue

        num = _parse_run_setting_number(key, value, typ)
        min_v = float(spec.get("min", num))
        max_v = float(spec.get("max", num))
        clamped = min(max(num, min_v), max_v)
        if abs(clamped - num) > 1e-9:
            corrections.append(f"{key} clamped to [{min_v:g}, {max_v:g}]")
        if typ == "int":
            effective[key] = int(clamped)
        else:
            effective[key] = float(clamped)

    min_stops = int(effective["minStopsPerRoute"])
    target_stops = int(effective["targetStopsPerRoute"])
    max_stops = int(effective["maxStopsPerRoute"])

    if min_stops > target_stops:
        target_stops = int(min_stops)
        corrections.append("targetStopsPerRoute raised to minStopsPerRoute")
    if target_stops > max_stops:
        max_stops = int(target_stops)
        corrections.append("maxStopsPerRoute raised to targetStopsPerRoute")
    if min_stops > max_stops:
        max_stops = int(min_stops)
        target_stops = int(min_stops)
        corrections.append("maxStopsPerRoute and targetStopsPerRoute raised to minStopsPerRoute")

    effective["minStopsPerRoute"] = int(min_stops)
    effective["targetStopsPerRoute"] = int(target_stops)
    effective["maxStopsPerRoute"] = int(max_stops)

    local_pref = float(effective["preferredRouteDriveMinLocal"])
    remote_pref = float(effective["preferredRouteDriveMinRemote"])
    if local_pref > remote_pref:
        effective["preferredRouteDriveMinRemote"] = float(local_pref)
        corrections.append("preferredRouteDriveMinRemote raised to preferredRouteDriveMinLocal")

    local_diam = float(effective["maxRouteDiameterMiLocal"])
    remote_diam = float(effective["maxRouteDiameterMiRemote"])
    if local_diam > remote_diam:
        effective["maxRouteDiameterMiRemote"] = float(local_diam)
        corrections.append("maxRouteDiameterMiRemote raised to maxRouteDiameterMiLocal")

    return {
        "requested": deepcopy(raw),
        "effective": deepcopy(effective),
        "defaults": defaults,
        "limits": limits,
        "unknownKeys": sorted(set(unknown_keys)),
        "corrections": corrections,
    }


def _coerce_run_settings_bundle(run_settings: Optional[dict]) -> Dict[str, Any]:
    if isinstance(run_settings, dict) and isinstance(run_settings.get("effective"), dict):
        bundle = normalize_run_settings(run_settings.get("effective"))
        # Preserve caller-observed normalization metadata.
        prev_unknown = run_settings.get("unknownKeys", [])
        if isinstance(prev_unknown, list):
            bundle["unknownKeys"] = sorted(set(bundle["unknownKeys"] + [str(x) for x in prev_unknown]))
        prev_corrections = run_settings.get("corrections", [])
        if isinstance(prev_corrections, list):
            bundle["corrections"] = list(dict.fromkeys(bundle["corrections"] + [str(x) for x in prev_corrections]))
        return bundle
    return normalize_run_settings(run_settings)


def _run_settings_to_constant_overrides(effective: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "PLANNING_HORIZON_MONTHS": int(effective["planningHorizonMonths"]),
        "TARGET_STOPS_PER_DAY": int(effective["targetStopsPerRoute"]),
        "MIN_STOPS_PER_DAY": int(effective["minStopsPerRoute"]),
        "MAX_STOPS_PER_DAY": int(effective["maxStopsPerRoute"]),
        "STOPS_PER_ROUTE": int(effective["targetStopsPerRoute"]),
        "MIN_STOPS_PER_ROUTE": int(effective["minStopsPerRoute"]),
        "MAX_STOPS_PER_ROUTE": int(effective["maxStopsPerRoute"]),
        "MAX_ROUTE_DRIVE_MIN": float(effective["maxRouteDriveMinutes"]),
        "DEFAULT_DURATION": int(effective["defaultStopDurationMinutes"]),
        "ALLOW_SATURDAY_OVERFLOW": bool(effective["allowSaturdayOverflow"]),
        "REMOTE_STRICT": bool(effective["remoteStrict"]),
        "PREFERRED_ROUTE_DRIVE_MIN_LOCAL": float(effective["preferredRouteDriveMinLocal"]),
        "PREFERRED_ROUTE_DRIVE_MIN_REMOTE": float(effective["preferredRouteDriveMinRemote"]),
        "MAX_ROUTE_DIAMETER_MI_LOCAL": float(effective["maxRouteDiameterMiLocal"]),
        "MAX_ROUTE_DIAMETER_MI_REMOTE": float(effective["maxRouteDiameterMiRemote"]),
        "QUALITY_GATES_HARD_FAIL": bool(effective["qualityGateHardFail"]),
        "FIELDROUTES_ROUTE_TEMPLATE_ID_SPECIALTY": int(effective["fieldRoutesTemplateIdSpecialty"]),
        "FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR": int(effective["fieldRoutesTemplateIdRegular"]),
        "FIELDROUTES_ROUTE_TEMPLATE_ID_LAWN": int(effective["fieldRoutesTemplateIdLawn"]),
        "FIELDROUTES_ROUTE_TEMPLATE_ID_TUESDAY": int(effective["fieldRoutesTemplateIdTuesday"]),
        "FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT": int(effective["fieldRoutesTemplateIdDefault"]),
        "FIELDROUTES_TUESDAY_OVERRIDE": bool(effective["fieldRoutesTuesdayOverride"]),
    }


def _apply_run_settings_overrides(effective: Dict[str, Any]):
    previous = {}
    overrides = _run_settings_to_constant_overrides(effective)
    for const_name, const_value in overrides.items():
        previous[const_name] = globals().get(const_name)
        globals()[const_name] = const_value

    def _restore():
        for const_name, prev_value in previous.items():
            globals()[const_name] = prev_value

    return _restore


def summarize_run_settings(effective: Dict[str, Any]) -> str:
    horizon_months = int(effective["planningHorizonMonths"])
    stops = f"{int(effective['targetStopsPerRoute'])} (min {int(effective['minStopsPerRoute'])}, max {int(effective['maxStopsPerRoute'])})"
    drive = f"{float(effective['maxRouteDriveMinutes']):g}m"
    sat_req = "on" if bool(effective["allowSaturdayOverflow"]) else "off"
    sat = f"forced-on (requested {sat_req})"
    hard_fail = "on" if bool(effective["qualityGateHardFail"]) else "off"
    tpl = (
        f"R/S/L/T={int(effective['fieldRoutesTemplateIdRegular'])}/"
        f"{int(effective['fieldRoutesTemplateIdSpecialty'])}/"
        f"{int(effective['fieldRoutesTemplateIdLawn'])}/"
        f"{int(effective['fieldRoutesTemplateIdTuesday'])}"
    )
    tuesday = "on" if bool(effective["fieldRoutesTuesdayOverride"]) else "off"
    return (
        f"horizon={horizon_months}mo; stops={stops}; maxDrive={drive}; saturdayOverflow={sat}; qualityHardFail={hard_fail}; "
        f"frTemplates({tpl}, tueOverride={tuesday})"
    )


def render_route_preview_html(
    routes,
    center_lat: float,
    center_lng: float,
    manual_draft_edited: bool = False,
    run_id: Optional[str] = None,
) -> str:
    """Render preview HTML from the live editor file so generated previews stay in sync.

    The generated map inherits the current tested editor UX from route_preview.html,
    with only the embedded data block replaced per run.
    """
    base_dir = Path(__file__).resolve().parent
    template_candidates = [
        (base_dir / "templates" / "route_preview.template.html").resolve(),
        (base_dir / "route_preview.html").resolve(),
    ]

    html_template = ""
    for template_path in template_candidates:
        try:
            if template_path.exists():
                html_template = template_path.read_text(encoding="utf-8")
                if html_template.strip():
                    break
        except Exception:
            continue

    if not html_template.strip():
        # Minimal fallback if template file is unavailable.
        html_template = "<!doctype html><html><body><script>const ROUTES = []; const MANUAL_DRAFT_EDITED = false; const DEFAULT_CENTER_LAT = 0; const DEFAULT_CENTER_LNG = 0; const RUN_ID = null;</script></body></html>"

    routes_json = json.dumps(routes)
    manual_flag = "true" if bool(manual_draft_edited) else "false"
    center_lat_s = str(float(center_lat))
    center_lng_s = str(float(center_lng))
    run_id_s = ("null" if run_id is None else json.dumps(str(run_id)))

    data_block = (
        f"const ROUTES = {routes_json};\n"
        f"    const MANUAL_DRAFT_EDITED = {manual_flag};\n"
        f"    const DEFAULT_CENTER_LAT = {center_lat_s};\n"
        f"    const DEFAULT_CENTER_LNG = {center_lng_s};\n"
        f"    const RUN_ID = {run_id_s};"
    )

    if "__ROUTES_JSON__" in html_template:
        return (
            html_template
            .replace("__ROUTES_JSON__", routes_json)
            .replace("__MANUAL_DRAFT_EDITED__", manual_flag)
            .replace("__CENTER_LAT__", center_lat_s)
            .replace("__CENTER_LNG__", center_lng_s)
            .replace("__RUN_ID__", run_id_s)
        )

    pattern = re.compile(
        r"const ROUTES = [\s\S]*?;\n\s*const MANUAL_DRAFT_EDITED = [^;]*;\n\s*const DEFAULT_CENTER_LAT = [^;]*;\n\s*const DEFAULT_CENTER_LNG = [^;]*;(?:\n\s*const RUN_ID = [^;]*;)?",
        flags=re.MULTILINE,
    )
    replaced = pattern.sub(lambda _m: data_block, html_template, count=1)
    if replaced == html_template:
        # Last-resort append in case the source file drifted unexpectedly.
        inject = (
            "<script>"
            + data_block
            + "</script>"
        )
        if "</body>" in html_template:
            replaced = html_template.replace("</body>", f"{inject}</body>")
        else:
            replaced = html_template + inject
    return replaced

# --- Progress reporting (for UI polling) ---

def _atomic_write_json(path: str, payload: dict):
    """Write JSON atomically so the UI never reads a partial file."""
    import json

    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f)
    os.replace(tmp, p)


def _progress_update(progress_path: Optional[str], payload: dict):
    if not progress_path:
        return
    try:
        payload = dict(payload)
        payload.setdefault("updatedAt", int(time.time()))
        _atomic_write_json(progress_path, payload)
    except Exception:
        # never let progress reporting break routing
        pass

# --- OSRM road routing helpers ---
OSRM_BASE_URL = os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org").strip() or "https://router.project-osrm.org"
OSRM_HEALTHCHECK_TIMEOUT_SEC = 2.5
OSRM_HEALTHCHECK_TTL_OK_SEC = 300.0
OSRM_HEALTHCHECK_TTL_FAIL_SEC = 12.0


def _normalize_osrm_base_url(url: str) -> str:
    return str(url or "").strip().rstrip("/")


def _build_osrm_base_candidates():
    primary = _normalize_osrm_base_url(OSRM_BASE_URL)
    env_fallback_raw = str(os.environ.get("OSRM_FALLBACK_BASE_URLS", "") or "")
    env_fallback = [
        _normalize_osrm_base_url(u)
        for u in env_fallback_raw.split(",")
        if _normalize_osrm_base_url(u)
    ]
    defaults = [
        "http://127.0.0.1:5000",
        "http://localhost:5000",
        "http://5.148.170.168/routed-car",
        "https://router.project-osrm.org",
        "https://routing.openstreetmap.de/routed-car",
    ]
    out = []
    seen = set()
    for u in [primary] + env_fallback + defaults:
        nu = _normalize_osrm_base_url(u)
        if not nu or nu in seen:
            continue
        seen.add(nu)
        out.append(nu)
    return out or [primary]


OSRM_BASE_CANDIDATES = _build_osrm_base_candidates()
_OSRM_HEALTH_STATE = {"ok": None, "checkedAt": 0.0, "activeBaseUrl": str(OSRM_BASE_CANDIDATES[0])}


def get_osrm_base_url() -> str:
    try:
        cur = _normalize_osrm_base_url(str(_OSRM_HEALTH_STATE.get("activeBaseUrl", "") or ""))
        if cur:
            return cur
    except Exception:
        pass
    return str(OSRM_BASE_CANDIDATES[0])


def _probe_osrm_base(base_url: str) -> bool:
    base = _normalize_osrm_base_url(base_url)
    if not base:
        return False
    headers = {"User-Agent": "flex-routing/1.0 (contact: ops@flex)"}
    timeout = float(OSRM_HEALTHCHECK_TIMEOUT_SEC)

    core_ok = False
    core_probes = [
        (f"{base}/nearest/v1/driving/-94.1185,36.3320", {"number": 1}),
        (
            f"{base}/route/v1/driving/-94.1185,36.3320;-94.1135,36.3360",
            {"overview": "false", "steps": "false", "annotations": "false"},
        ),
    ]
    for url, params in core_probes:
        try:
            r = requests.get(url, params=params, headers=headers, timeout=timeout)
            if not r.ok:
                continue
            data = r.json()
            if isinstance(data, dict):
                if data.get("code") == "Ok":
                    core_ok = True
                    break
                if data.get("waypoints"):
                    core_ok = True
                    break
        except Exception:
            continue
    if not core_ok:
        return False

    # Strict mode requires matrix optimization. Validate table endpoint too.
    table_url = f"{base}/table/v1/driving/-94.1185,36.3320;-94.1135,36.3360"
    table_params = {"annotations": "duration", "sources": "0;1", "destinations": "0;1"}
    try:
        r = requests.get(table_url, params=table_params, headers=headers, timeout=timeout)
        if not r.ok:
            return False
        data = r.json()
        if not isinstance(data, dict) or data.get("code") != "Ok":
            return False
        durations = data.get("durations")
        if not isinstance(durations, list) or len(durations) == 0:
            return False
        for row in durations:
            if not isinstance(row, list):
                continue
            for sec in row:
                if sec is None:
                    continue
                try:
                    if np.isfinite(float(sec)):
                        return True
                except Exception:
                    continue
    except Exception:
        return False
    return False


def is_valid_workday(date):
    return date.weekday() < 5 and date not in US_HOLIDAYS


def generate_valid_dates(start_date, end_date):
    dates = []
    current = start_date
    while current <= end_date:
        if is_valid_workday(current):
            dates.append(current)
        current += timedelta(days=1)
    return dates


def _osrm_service_available(force_refresh: bool = False) -> bool:
    now = float(time.time())
    try:
        last_ok = _OSRM_HEALTH_STATE.get("ok", None)
        last_t = float(_OSRM_HEALTH_STATE.get("checkedAt", 0.0) or 0.0)
        ttl = float(OSRM_HEALTHCHECK_TTL_OK_SEC) if bool(last_ok) else float(OSRM_HEALTHCHECK_TTL_FAIL_SEC)
        if (not force_refresh) and (last_ok is not None) and ((now - last_t) <= ttl):
            return bool(last_ok)
    except Exception:
        pass

    cur = get_osrm_base_url()
    candidates = [cur] + [u for u in OSRM_BASE_CANDIDATES if _normalize_osrm_base_url(u) != _normalize_osrm_base_url(cur)]
    ok = False
    chosen = cur
    for base in candidates:
        if _probe_osrm_base(base):
            ok = True
            chosen = _normalize_osrm_base_url(base)
            break

    try:
        _OSRM_HEALTH_STATE["ok"] = bool(ok)
        _OSRM_HEALTH_STATE["checkedAt"] = now
        _OSRM_HEALTH_STATE["activeBaseUrl"] = str(chosen)
    except Exception:
        pass
    return bool(ok)


def generate_saturday_dates(start_date, end_date):
    dates = []
    current = start_date
    while current <= end_date:
        if current.weekday() == 5:
            dates.append(current)
        current += timedelta(days=1)
    return dates


def _planning_horizon_bounds(months: int, service_due_series: Optional[pd.Series] = None) -> Tuple[pd.Timestamp, pd.Timestamp]:
    horizon_months = max(1, int(months))
    start_month = pd.Timestamp.today().normalize().replace(day=1)
    if service_due_series is not None:
        try:
            due_vals = pd.to_datetime(service_due_series, errors="coerce").dropna()
            if len(due_vals) > 0:
                start_month = pd.Timestamp(due_vals.min()).normalize().replace(day=1)
        except Exception:
            pass
    end_month = (start_month + pd.offsets.MonthEnd(horizon_months)).normalize()
    return start_month, end_month


def classify_remote_zone(lat: float, lng: float) -> Optional[str]:
    if not REMOTE_RULES_ENABLED:
        return None
    try:
        latf = float(lat)
        lngf = float(lng)
    except Exception:
        return None

    # Priority order: border/state and major geography first.
    if latf >= float(REMOTE_ZONES["MISSOURI"]["lat_min"]):
        return "MISSOURI"
    if lngf >= float(REMOTE_ZONES["EAST_OF_BEAVER_LAKE"]["lng_min"]):
        return "EAST_OF_BEAVER_LAKE"
    if latf <= float(REMOTE_ZONES["SOUTH_OF_PRAIRIE_GROVE"]["lat_max"]):
        return "SOUTH_OF_PRAIRIE_GROVE"
    if lngf >= float(REMOTE_ZONES["EAST_OF_PEA_RIDGE"]["lng_min"]):
        return "EAST_OF_PEA_RIDGE"
    return None


def is_remote_stop(lat: float, lng: float) -> bool:
    return classify_remote_zone(lat, lng) is not None


def remote_zone_priority(zone: Optional[str]) -> int:
    order = {
        "MISSOURI": 0,
        "EAST_OF_BEAVER_LAKE": 1,
        "EAST_OF_BEAVER_LAKE_NORTH": 1,
        "EAST_OF_BEAVER_LAKE_SOUTH": 1,
        "SOUTH_OF_PRAIRIE_GROVE": 2,
        "SOUTH_OF_PRAIRIE_GROVE_WEST": 2,
        "SOUTH_OF_PRAIRIE_GROVE_EAST": 2,
        "EAST_OF_PEA_RIDGE": 3,
        "FAR_OUTLIER": 4,
        None: 99,
    }
    return int(order.get(zone, 98))


def remote_bucket(zone: Optional[str], lat: float, lng: float) -> Optional[str]:
    """Optional sub-zoning for hard geography constraints."""
    if zone is None:
        return None
    if zone == "EAST_OF_BEAVER_LAKE":
        try:
            return "EAST_OF_BEAVER_LAKE_NORTH" if float(lat) >= float(BEAVER_LAKE_SPLIT_LAT) else "EAST_OF_BEAVER_LAKE_SOUTH"
        except Exception:
            return zone
    if zone == "SOUTH_OF_PRAIRIE_GROVE":
        try:
            return "SOUTH_OF_PRAIRIE_GROVE_EAST" if float(lng) >= float(SOUTH_PRAIRIE_SPLIT_LNG) else "SOUTH_OF_PRAIRIE_GROVE_WEST"
        except Exception:
            return zone
    return zone


def _round_ll(lat: float, lng: float, ndigits: int = 5):
    return (round(float(lat), ndigits), round(float(lng), ndigits))


def _clean_latlngs(latlngs):
    """Ensure we have finite float lat/lng pairs."""
    cleaned = []
    for lat, lng in (latlngs or []):
        try:
            latf = float(lat)
            lngf = float(lng)
            if not np.isfinite(latf) or not np.isfinite(lngf):
                continue
            cleaned.append(_round_ll(latf, lngf))
        except Exception:
            continue

    # de-dupe consecutive identical points
    deduped = []
    for p in cleaned:
        if not deduped or deduped[-1] != p:
            deduped.append(p)
    return deduped


def _segments_intersect(a, b, c, d) -> bool:
    """Return True when two non-adjacent segments intersect."""
    eps = 1e-12

    def _orient(p, q, r):
        return ((q[1] - p[1]) * (r[0] - q[0])) - ((q[0] - p[0]) * (r[1] - q[1]))

    def _on_seg(p, q, r):
        return (
            (min(p[0], r[0]) - eps) <= q[0] <= (max(p[0], r[0]) + eps)
            and (min(p[1], r[1]) - eps) <= q[1] <= (max(p[1], r[1]) + eps)
        )

    o1 = _orient(a, b, c)
    o2 = _orient(a, b, d)
    o3 = _orient(c, d, a)
    o4 = _orient(c, d, b)

    if (o1 * o2 < -eps) and (o3 * o4 < -eps):
        return True
    if abs(o1) <= eps and _on_seg(a, c, b):
        return True
    if abs(o2) <= eps and _on_seg(a, d, b):
        return True
    if abs(o3) <= eps and _on_seg(c, a, d):
        return True
    if abs(o4) <= eps and _on_seg(c, b, d):
        return True
    return False


def _polyline_self_intersections(latlngs) -> int:
    """Count self-intersections in an open polyline."""
    pts = _clean_latlngs(latlngs)
    n = len(pts)
    if n < 4:
        return 0

    c = 0
    for i in range(n - 1):
        a = pts[i]
        b = pts[i + 1]
        for j in range(i + 2, n - 1):
            c0 = pts[j]
            d0 = pts[j + 1]
            # skip segment pairs sharing explicit endpoints
            if a == c0 or a == d0 or b == c0 or b == d0:
                continue
            if _segments_intersect(a, b, c0, d0):
                c += 1
    return int(c)


def _uncross_polyline_2opt(latlngs, max_iters: int = 120):
    """Eliminate geometric crossings with 2-opt style reversals."""
    path = list(_clean_latlngs(latlngs))
    n = len(path)
    if n < 4:
        return path

    iters = 0
    changed = True
    while changed and iters < max(1, int(max_iters)):
        iters += 1
        changed = False
        for i in range(n - 3):
            a = path[i]
            b = path[i + 1]
            for j in range(i + 2, n - 1):
                c = path[j]
                d = path[j + 1]
                if a == c or a == d or b == c or b == d:
                    continue
                if _segments_intersect(a, b, c, d):
                    path = path[: i + 1] + list(reversed(path[i + 1 : j + 1])) + path[j + 1 :]
                    changed = True
                    break
            if changed:
                break
    return path


@lru_cache(maxsize=20000)
def _osrm_route_multi_cached(key: str):
    """Memoize multi-waypoint OSRM routes by a stable key: 'lon,lat;lon,lat;...'"""
    if not _osrm_service_available():
        if not _osrm_service_available(force_refresh=True):
            raise RuntimeError("OSRM unavailable")
    url = f"{get_osrm_base_url()}/route/v1/driving/{key}"
    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
        "annotations": "false",
        "continue_straight": "false",
    }
    headers = {"User-Agent": "flex-routing/1.0 (contact: ops@flex)"}

    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            # brief backoff to avoid rapid-fire retries / throttling
            time.sleep(0.35 * (attempt + 1))
            continue

    raise last_err  # type: ignore


@lru_cache(maxsize=50000)
def _osrm_route_leg_cached(lon1: float, lat1: float, lon2: float, lat2: float):
    """Memoize 2-point OSRM routes (one leg) to make road-lines reliable."""
    if not _osrm_service_available():
        if not _osrm_service_available(force_refresh=True):
            raise RuntimeError("OSRM unavailable")
    url = f"{get_osrm_base_url()}/route/v1/driving/{lon1},{lat1};{lon2},{lat2}"
    params = {
        "overview": "full",
        "geometries": "geojson",
        "steps": "false",
        "annotations": "false",
        "continue_straight": "false",
    }
    headers = {"User-Agent": "flex-routing/1.0 (contact: ops@flex)"}

    last_err = None
    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=20)
            r.raise_for_status()
            return r.json()
        except Exception as e:
            last_err = e
            time.sleep(0.35 * (attempt + 1))
            continue

    raise last_err  # type: ignore


def _safe_slug(text: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", str(text or "").strip())
    return s.strip("_") or "unknown"


def _osrm_table_block_minutes(latlngs, src_indices, dst_indices, _depth: int = 0):
    """Fetch OSRM table block; returns minutes matrix [len(src)][len(dst)] or None."""
    if not src_indices or not dst_indices:
        return None
    if not _osrm_service_available():
        if not _osrm_service_available(force_refresh=True):
            return None

    src_indices = [int(i) for i in src_indices]
    dst_indices = [int(i) for i in dst_indices]
    uniq = sorted(set(src_indices + dst_indices))
    pos = {orig: i for i, orig in enumerate(uniq)}

    coords = ";".join([f"{float(latlngs[i][1])},{float(latlngs[i][0])}" for i in uniq])
    src_rel = ";".join([str(pos[i]) for i in src_indices])
    dst_rel = ";".join([str(pos[i]) for i in dst_indices])
    url = f"{get_osrm_base_url()}/table/v1/driving/{coords}"
    params = {
        "annotations": "duration",
        "sources": src_rel,
        "destinations": dst_rel,
    }
    headers = {"User-Agent": "flex-routing/1.0 (contact: ops@flex)"}

    for attempt in range(3):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=25)
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(0.6 * (attempt + 1))
                continue
            r.raise_for_status()
            data = r.json()
            durs = data.get("durations")
            if not durs:
                return None
            out = []
            for row in durs:
                row_out = []
                for sec in row:
                    if sec is None:
                        row_out.append(float("nan"))
                    else:
                        row_out.append(float(sec) / 60.0)
                out.append(row_out)
            return out
        except Exception:
            time.sleep(0.35 * (attempt + 1))
    if int(_depth) >= 2:
        return None

    src_indices = [int(i) for i in src_indices]
    dst_indices = [int(i) for i in dst_indices]
    if len(src_indices) <= 8 and len(dst_indices) <= 8:
        return None

    src_parts = [src_indices]
    dst_parts = [dst_indices]
    if len(src_indices) > 8:
        mid = max(1, len(src_indices) // 2)
        src_parts = [src_indices[:mid], src_indices[mid:]]
    if len(dst_indices) > 8:
        mid = max(1, len(dst_indices) // 2)
        dst_parts = [dst_indices[:mid], dst_indices[mid:]]

    src_pos = {int(v): i for i, v in enumerate(src_indices)}
    dst_pos = {int(v): i for i, v in enumerate(dst_indices)}
    merged = [[float("nan")] * len(dst_indices) for _ in range(len(src_indices))]

    for sp in src_parts:
        for dp in dst_parts:
            sub = _osrm_table_block_minutes(latlngs, sp, dp, _depth=int(_depth) + 1)
            if sub is None:
                return None
            for si, s_orig in enumerate(sp):
                for dj, d_orig in enumerate(dp):
                    merged[src_pos[int(s_orig)]][dst_pos[int(d_orig)]] = float(sub[si][dj])
    return merged


def _fallback_multiplier_for_pair(
    crow_miles: float,
    z_i: Optional[str],
    z_j: Optional[str],
    b_i: Optional[str],
    b_j: Optional[str],
) -> float:
    """Conservative fallback multiplier when OSRM matrix pairs are unavailable."""
    mult = 1.45
    any_remote = (z_i is not None) or (z_j is not None)

    if any_remote:
        mult *= 1.25

    east_i = z_i == "EAST_OF_BEAVER_LAKE"
    east_j = z_j == "EAST_OF_BEAVER_LAKE"
    if east_i or east_j:
        # East-lake roads are highly circuitous.
        mult *= 2.10
        if east_i and east_j:
            mult *= 1.25
        if (crow_miles > 3.5) and (east_i and east_j):
            mult *= 1.0 + min(1.8, (float(crow_miles) - 3.5) * 0.15)

    if (east_i != east_j):
        # Crossing lake-side boundaries often requires long bridge detours.
        mult *= 2.20

    if (
        (b_i == "EAST_OF_BEAVER_LAKE_NORTH" and b_j == "EAST_OF_BEAVER_LAKE_SOUTH")
        or (b_i == "EAST_OF_BEAVER_LAKE_SOUTH" and b_j == "EAST_OF_BEAVER_LAKE_NORTH")
    ):
        mult *= 1.75

    if (z_i == "MISSOURI") != (z_j == "MISSOURI"):
        mult *= 1.80
    if (z_i == "EAST_OF_PEA_RIDGE") != (z_j == "EAST_OF_PEA_RIDGE"):
        mult *= 1.45

    if (z_i is None) != (z_j is None):
        mult *= 1.35
    if (z_i is not None) and (z_j is not None) and (z_i != z_j):
        mult *= 1.30

    # Longer crow-flight legs are usually under-estimated in road minutes.
    if crow_miles > 4.0:
        mult *= 1.0 + min(0.70, (float(crow_miles) - 4.0) * 0.05)
    if crow_miles > 10.0:
        mult *= 1.0 + min(1.60, (float(crow_miles) - 10.0) * 0.09)
    if crow_miles > 18.0:
        mult *= 1.35

    return float(mult)


def _parse_osrm_route(data):
    routes = data.get("routes") or []
    if not routes:
        return None, None, None
    best = routes[0]
    geom = best.get("geometry", {})
    coords = geom.get("coordinates") or []
    # geojson coords are [lon,lat]
    road_line = [(float(lat), float(lon)) for (lon, lat) in coords]

    meters = best.get("distance")
    seconds = best.get("duration")
    miles = (float(meters) / 1609.344) if meters is not None else None
    minutes = (float(seconds) / 60.0) if seconds is not None else None
    return road_line, miles, minutes


# --- Drive time helpers ---
def _haversine_miles(lat1, lon1, lat2, lon2):
    R = 3958.7613  # miles
    lat1 = np.radians(lat1)
    lon1 = np.radians(lon1)
    lat2 = np.radians(lat2)
    lon2 = np.radians(lon2)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    a = np.sin(dlat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(dlon / 2) ** 2
    c = 2 * np.arcsin(np.sqrt(a))
    return float(R * c)


def osrm_leg_minutes(lat1: float, lng1: float, lat2: float, lng2: float):
    """Return driving minutes between two points using OSRM; fallback to haversine."""
    try:
        data = _osrm_route_leg_cached(float(lng1), float(lat1), float(lng2), float(lat2))
        _, _, minutes = _parse_osrm_route(data)
        if minutes is not None and np.isfinite(minutes):
            return float(minutes)
    except Exception:
        pass

    miles = _haversine_miles(float(lat1), float(lng1), float(lat2), float(lng2))
    return float((miles / max(1.0, float(ASSUMED_AVG_MPH_FALLBACK))) * 60.0)


def approx_leg_minutes(lat1: float, lng1: float, lat2: float, lng2: float):
    """Fast, offline drive-time estimate using haversine + ASSUMED_AVG_MPH_FALLBACK.

    This avoids OSRM network calls. Used for drive-time enforcement so routing finishes reliably.
    """
    miles = _haversine_miles(float(lat1), float(lng1), float(lat2), float(lng2))
    return float((miles / max(1.0, float(ASSUMED_AVG_MPH_FALLBACK))) * 60.0)


def route_drive_minutes_from_points_fast(latlngs):
    """Total *estimated* drive minutes for an ordered stop list (no OSRM calls)."""
    pts = _clean_latlngs(latlngs)
    if len(pts) < 2:
        return 0.0
    total = 0.0
    for i in range(len(pts) - 1):
        lat1, lng1 = pts[i]
        lat2, lng2 = pts[i + 1]
        total += float(approx_leg_minutes(lat1, lng1, lat2, lng2))
    return float(total)


# --- Fast, single-call OSRM drive-minutes for a route (with fallback) ---
def route_drive_minutes_from_points_osrm_multi(latlngs):
    """Total drive minutes for an ordered stop list using a single OSRM multi-waypoint route.

    This is far cheaper than summing per-leg OSRM calls.
    Falls back to fast estimate if OSRM fails.
    """
    pts = _clean_latlngs(latlngs)
    if len(pts) < 2:
        return 0.0

    try:
        coords = [f"{lng},{lat}" for (lat, lng) in pts]
        key = ";".join(coords)
        data = _osrm_route_multi_cached(key)
        _, _, minutes = _parse_osrm_route(data)
        if minutes is not None and np.isfinite(minutes):
            return float(minutes)
    except Exception:
        pass

    # fallback: offline estimate
    return float(route_drive_minutes_from_points_fast(pts))


def route_drive_minutes_from_points(latlngs):
    """Total drive minutes for an ordered stop list.

    Prefer a single OSRM multi-waypoint call; fall back to per-leg OSRM; finally fall back to offline estimate.
    """
    pts = _clean_latlngs(latlngs)
    if len(pts) < 2:
        return 0.0

    # Fast path: one OSRM call for the whole route
    try:
        mins = route_drive_minutes_from_points_osrm_multi(pts)
        if mins is not None and np.isfinite(mins):
            return float(mins)
    except Exception:
        pass

    # Fallback: sum legs (cached), then offline estimate
    total = 0.0
    try:
        for i in range(len(pts) - 1):
            lat1, lng1 = pts[i]
            lat2, lng2 = pts[i + 1]
            total += float(osrm_leg_minutes(lat1, lng1, lat2, lng2))
        if np.isfinite(total):
            return float(total)
    except Exception:
        pass

    return float(route_drive_minutes_from_points_fast(pts))


def route_drive_minutes_from_points_osrm_only(latlngs):
    """Total drive minutes using OSRM data only.

    Returns None when OSRM data is unavailable for the route.
    """
    if not _osrm_service_available():
        return None
    pts = _clean_latlngs(latlngs)
    if len(pts) < 2:
        return 0.0

    # First try multi-waypoint route
    try:
        coords = [f"{lng},{lat}" for (lat, lng) in pts]
        key = ";".join(coords)
        data = _osrm_route_multi_cached(key)
        _, _, minutes = _parse_osrm_route(data)
        if minutes is not None and np.isfinite(minutes):
            return float(minutes)
    except Exception:
        pass

    # Then strict per-leg OSRM (no haversine fallback)
    total = 0.0
    try:
        for i in range(len(pts) - 1):
            lat1, lng1 = pts[i]
            lat2, lng2 = pts[i + 1]
            data = _osrm_route_leg_cached(float(lng1), float(lat1), float(lng2), float(lat2))
            _, _, minutes = _parse_osrm_route(data)
            if minutes is None or not np.isfinite(minutes):
                return None
            total += float(minutes)
        if np.isfinite(total):
            return float(total)
    except Exception:
        return None

    return None


def route_drive_metrics_for_display(latlngs):
    """Drive metrics for UI display.

    Returns road_line, miles, minutes, source where source is:
    - "osrm" when OSRM returned route metrics
    - "pending" when OSRM metrics are unavailable and browser should refresh
    """
    pts = _clean_latlngs(latlngs)
    if len(pts) < 2:
        return pts, 0.0, 0.0, "osrm"

    # Keep backend generation fast; browser upgrades road lines/metrics on demand.
    if not PRECOMPUTE_OSRM_FOR_HTML:
        return pts, None, None, "pending"

    road_line, miles, minutes = osrm_route(pts)
    if miles is not None and minutes is not None and np.isfinite(miles) and np.isfinite(minutes):
        return road_line, float(miles), float(minutes), "osrm"

    # Keep line fallback for map rendering, but avoid mixing estimated minutes
    # with OSRM miles from browser refresh.
    line = road_line if road_line and len(road_line) >= 2 else pts
    return line, None, None, "pending"


def matrix_leg_minutes(matrix_minutes: np.ndarray, i: int, j: int) -> float:
    try:
        return float(matrix_minutes[int(i), int(j)])
    except Exception:
        return float("inf")


def build_or_load_tech_matrix(tech_df: pd.DataFrame, target_month: str, tech_name: str):
    """Build/load OSRM matrix for one tech-month. Returns matrix + fallback mask + metadata."""
    pts = list(zip(tech_df["lat"].astype(float), tech_df["lng"].astype(float)))
    n = int(len(pts))
    n_pairs = int(max(0, n * (n - 1)))
    if n == 0:
        return {
            "matrix": np.zeros((0, 0), dtype=float),
            "fallback_mask": np.zeros((0, 0), dtype=bool),
            "cache_used": False,
            "unresolved_pairs": 0,
            "cache_file": "",
            "build_sec": 0.0,
        }
    if n == 1:
        return {
            "matrix": np.array([[0.0]], dtype=float),
            "fallback_mask": np.array([[False]], dtype=bool),
            "cache_used": False,
            "unresolved_pairs": 0,
            "cache_file": "",
            "build_sec": 0.0,
        }

    active_osrm_base = _normalize_osrm_base_url(get_osrm_base_url())
    osrm_candidates = []
    for base in OSRM_BASE_CANDIDATES:
        normalized = _normalize_osrm_base_url(base)
        if normalized:
            osrm_candidates.append(str(normalized))

    payload = {
        "algoVersion": MATRIX_ALGO_VERSION,
        "cacheSchemaVersion": int(MATRIX_CACHE_SCHEMA_VERSION),
        "targetMonth": str(target_month),
        "osrmActiveBaseUrl": str(active_osrm_base),
        "osrmCandidates": list(osrm_candidates),
        "points": [
            {
                "customerID": str(tech_df.iloc[i].get("customerID", "")),
                "lat": round(float(tech_df.iloc[i]["lat"]), 5),
                "lng": round(float(tech_df.iloc[i]["lng"]), 5),
            }
            for i in range(n)
        ],
    }
    key_raw = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    key_hash = hashlib.sha1(key_raw.encode("utf-8")).hexdigest()[:16]
    cache_dir = MATRIX_CACHE_DIR
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_file = cache_dir / f"{_safe_slug(tech_name)}_{_safe_slug(target_month)}_{key_hash}.json"

    if cache_file.exists():
        try:
            data = json.loads(cache_file.read_text(encoding="utf-8"))
            mat = np.array(data.get("matrix", []), dtype=float)
            fb = np.array(data.get("fallbackMask", []), dtype=bool)
            cache_schema = int(data.get("cacheSchemaVersion", 0) or 0)
            cache_active_base = _normalize_osrm_base_url(str(data.get("osrmActiveBaseUrl", "") or ""))
            cache_unresolved = int(data.get("unresolvedPairs", 0))
            poisoned_all_pairs = (n_pairs > 0) and (cache_unresolved >= n_pairs)
            if (
                mat.shape == (n, n)
                and fb.shape == (n, n)
                and cache_schema >= int(MATRIX_CACHE_SCHEMA_VERSION)
                and (not cache_active_base or cache_active_base == active_osrm_base)
            ):
                if poisoned_all_pairs and _osrm_service_available(force_refresh=True):
                    # OSRM is healthy now, so force a matrix rebuild instead of
                    # reusing an all-fallback cache artifact.
                    pass
                else:
                    return {
                        "matrix": mat,
                        "fallback_mask": fb,
                        "cache_used": True,
                        "unresolved_pairs": int(cache_unresolved),
                        "cache_file": str(cache_file),
                        "build_sec": 0.0,
                    }
        except Exception:
            pass

    started = time.time()
    mat = np.full((n, n), np.nan, dtype=float)
    fb = np.zeros((n, n), dtype=bool)
    block = int(max(8, OSRM_TABLE_BLOCK_SIZE))

    for r0 in range(0, n, block):
        src = list(range(r0, min(n, r0 + block)))
        for c0 in range(0, n, block):
            dst = list(range(c0, min(n, c0 + block)))
            block_minutes = _osrm_table_block_minutes(pts, src, dst)
            if block_minutes is None:
                continue
            for ii, i in enumerate(src):
                row = block_minutes[ii] if ii < len(block_minutes) else []
                for jj, j in enumerate(dst):
                    if jj < len(row):
                        v = float(row[jj])
                        if np.isfinite(v):
                            mat[i, j] = v

    np.fill_diagonal(mat, 0.0)

    unresolved = []
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            if not np.isfinite(mat[i, j]):
                unresolved.append((i, j))
                # Conservative fallback so strict mode is never unrealistically optimistic.
                a = pts[i]
                b = pts[j]
                crow = float(_haversine_miles(float(a[0]), float(a[1]), float(b[0]), float(b[1])))
                base = float(approx_leg_minutes(a[0], a[1], b[0], b[1]))
                z_i = None if "remoteZone" not in tech_df.columns else tech_df.iloc[int(i)].get("remoteZone", None)
                z_j = None if "remoteZone" not in tech_df.columns else tech_df.iloc[int(j)].get("remoteZone", None)
                b_i = None if "remoteBucket" not in tech_df.columns else tech_df.iloc[int(i)].get("remoteBucket", None)
                b_j = None if "remoteBucket" not in tech_df.columns else tech_df.iloc[int(j)].get("remoteBucket", None)
                z_i = None if (pd.isna(z_i) or str(z_i).strip() == "") else str(z_i)
                z_j = None if (pd.isna(z_j) or str(z_j).strip() == "") else str(z_j)
                b_i = None if (pd.isna(b_i) or str(b_i).strip() == "") else str(b_i)
                b_j = None if (pd.isna(b_j) or str(b_j).strip() == "") else str(b_j)
                mult = _fallback_multiplier_for_pair(crow, z_i, z_j, b_i, b_j)
                mat[i, j] = float(base * mult)
                fb[i, j] = True

    final_active_osrm_base = _normalize_osrm_base_url(get_osrm_base_url())
    out_data = {
        "algoVersion": MATRIX_ALGO_VERSION,
        "cacheSchemaVersion": int(MATRIX_CACHE_SCHEMA_VERSION),
        "targetMonth": str(target_month),
        "osrmActiveBaseUrl": str(final_active_osrm_base),
        "osrmCandidates": list(osrm_candidates),
        "matrix": mat.tolist(),
        "fallbackMask": fb.astype(int).tolist(),
        "unresolvedPairs": int(len(unresolved)),
        "nStops": int(n),
        "nPairs": int(n_pairs),
    }
    try:
        tmp = cache_file.with_suffix(cache_file.suffix + ".tmp")
        tmp.write_text(json.dumps(out_data), encoding="utf-8")
        os.replace(tmp, cache_file)
    except Exception:
        pass

    return {
        "matrix": mat,
        "fallback_mask": fb,
        "cache_used": False,
        "unresolved_pairs": int(len(unresolved)),
        "cache_file": str(cache_file),
        "build_sec": float(time.time() - started),
    }


def _global_block_priority(block_key: str) -> int:
    order = {
        "MISSOURI": 0,
        "EAST_OF_BEAVER_LAKE_NORTH": 1,
        "EAST_OF_BEAVER_LAKE_SOUTH": 2,
        "SOUTH_OF_PRAIRIE_GROVE_WEST": 3,
        "SOUTH_OF_PRAIRIE_GROVE_EAST": 4,
        "EAST_OF_PEA_RIDGE": 5,
        "FAR_OUTLIER": 6,
        "LOCAL": 7,
    }
    return int(order.get(str(block_key), 99))


def _two_opt_indices_matrix(order, matrix_minutes: np.ndarray, max_iters: int = 80):
    path = [int(x) for x in order]
    n = len(path)
    if n <= 3:
        return path

    def _edge(a, b):
        return matrix_leg_minutes(matrix_minutes, a, b)

    iters = 0
    improved = True
    while improved and iters < max_iters:
        improved = False
        iters += 1
        for i in range(1, n - 2):
            for j in range(i + 1, n - 1):
                a = path[i - 1]
                b = path[i]
                c = path[j]
                d = path[j + 1]
                cur = _edge(a, b) + _edge(c, d)
                nxt = _edge(a, c) + _edge(b, d)
                if nxt + 1e-6 < cur:
                    path = path[:i] + list(reversed(path[i : j + 1])) + path[j + 1 :]
                    improved = True
                    break
            if improved:
                break
    return path


def _order_block_with_matrix(block_indices, matrix_minutes: np.ndarray, hub_dists: dict):
    block = [int(i) for i in block_indices]
    if len(block) <= 1:
        return block
    if len(block) == 2:
        a, b = block[0], block[1]
        return [a, b] if hub_dists[a] >= hub_dists[b] else [b, a]

    remaining = set(block)
    start = max(block, key=lambda i: (hub_dists[i], -i))
    order = [int(start)]
    remaining.remove(start)
    seed = int(start)

    while remaining:
        cur = int(order[-1])
        cur_h = float(hub_dists[cur])
        best = None
        best_score = None
        for j in sorted(remaining):
            leg = matrix_leg_minutes(matrix_minutes, cur, j)
            if not np.isfinite(leg):
                leg = 1e6
            detour_away = max(0.0, float(hub_dists[j]) - cur_h)
            score = float(leg) + (2.2 * detour_away)
            # no pass-by penalty
            passby = 0.0
            for k in remaining:
                if k == j:
                    continue
                leg_k = matrix_leg_minutes(matrix_minutes, cur, k)
                if leg_k + 1e-6 < leg and float(hub_dists[k]) <= float(hub_dists[j]) + 1e-6:
                    passby += min(8.0, float(leg - leg_k))
            score += passby
            if best_score is None or score < best_score:
                best_score = score
                best = int(j)
        if best is None:
            break
        order.append(best)
        remaining.remove(best)

    if remaining:
        order.extend(sorted(list(remaining)))

    order = _two_opt_indices_matrix(order, matrix_minutes=matrix_minutes, max_iters=60)
    if len(order) >= 2 and float(hub_dists[order[-1]]) > float(hub_dists[order[0]]) + 1e-9:
        order = list(reversed(order))
    if order and order[0] != seed:
        try:
            k = order.index(seed)
            order = order[k:] + order[:k]
        except Exception:
            pass
    return [int(i) for i in order]


def _build_global_chain_zone_blocks(tech_df: pd.DataFrame, matrix_minutes: np.ndarray, hub_lat: float, hub_lng: float):
    idxs = list(tech_df.index.astype(int))
    if len(idxs) <= 1:
        return idxs

    hub_dists = {
        int(i): float(_haversine_miles(float(tech_df.loc[i, "lat"]), float(tech_df.loc[i, "lng"]), float(hub_lat), float(hub_lng)))
        for i in idxs
    }

    block_map = {}
    for i in idxs:
        rb = tech_df.loc[i, "remoteBucket"] if "remoteBucket" in tech_df.columns else None
        key = str(rb) if pd.notna(rb) and str(rb).strip() else "LOCAL"
        block_map.setdefault(key, []).append(int(i))

    ordered_blocks = []
    for bk, bidxs in block_map.items():
        ordered_blocks.append((bk, bidxs))
    ordered_blocks.sort(key=lambda t: (_global_block_priority(t[0]), min(t[1])))

    chain = []
    for bi, (block_key, bidxs) in enumerate(ordered_blocks):
        block_order = _order_block_with_matrix(bidxs, matrix_minutes=matrix_minutes, hub_dists=hub_dists)
        if len(block_order) == 0:
            continue
        if bi == 0 or len(chain) == 0:
            chain.extend(block_order)
            continue
        # choose orientation that minimizes seam cost without interleaving
        prev_end = int(chain[-1])
        forward = block_order
        backward = list(reversed(block_order))
        c_f = matrix_leg_minutes(matrix_minutes, prev_end, int(forward[0]))
        c_b = matrix_leg_minutes(matrix_minutes, prev_end, int(backward[0]))
        # penalize stepping outward from core between blocks
        outward_f = max(0.0, hub_dists[int(forward[0])] - hub_dists[prev_end])
        outward_b = max(0.0, hub_dists[int(backward[0])] - hub_dists[prev_end])
        score_f = float(c_f) + (1.5 * float(outward_f))
        score_b = float(c_b) + (1.5 * float(outward_b))
        chain.extend(forward if score_f <= score_b else backward)

    seen = set()
    dedup = []
    for i in chain:
        if i not in seen:
            dedup.append(int(i))
            seen.add(int(i))
    if len(dedup) != len(idxs):
        for i in idxs:
            if int(i) not in seen:
                dedup.append(int(i))
    return dedup


def _slice_chain_dynamic(
    chain_indices,
    matrix_minutes: np.ndarray,
    fallback_mask: np.ndarray,
    tech_df: pd.DataFrame,
    *,
    target_stops: int,
    min_stops: int,
    max_stops: int,
    max_drive: float,
    hub_lat: float,
    hub_lng: float,
):
    chain = [int(i) for i in chain_indices]
    n = len(chain)
    if n == 0:
        return []

    hub_dist = np.array(
        [
            float(_haversine_miles(float(tech_df.loc[idx, "lat"]), float(tech_df.loc[idx, "lng"]), float(hub_lat), float(hub_lng)))
            for idx in chain
        ],
        dtype=float,
    )
    lat_arr = np.array([float(tech_df.loc[idx, "lat"]) for idx in chain], dtype=float)
    lng_arr = np.array([float(tech_df.loc[idx, "lng"]) for idx in chain], dtype=float)
    is_remote_arr = np.array(
        [bool(tech_df.loc[idx].get("isRemote", False)) for idx in chain],
        dtype=bool,
    )
    edge_mins = np.zeros(max(0, n - 1), dtype=float)
    edge_fb = np.zeros(max(0, n - 1), dtype=int)
    edge_out = np.zeros(max(0, n - 1), dtype=float)
    for i in range(n - 1):
        a = chain[i]
        b = chain[i + 1]
        edge_mins[i] = float(matrix_leg_minutes(matrix_minutes, a, b))
        edge_fb[i] = 1 if bool(fallback_mask[a, b]) else 0
        edge_out[i] = max(0.0, float(hub_dist[i + 1] - hub_dist[i]))

    pref_mins = np.zeros(n, dtype=float)
    pref_fb = np.zeros(n, dtype=int)
    pref_out = np.zeros(n, dtype=float)
    pref_lat = np.zeros(n, dtype=float)
    pref_lng = np.zeros(n, dtype=float)
    pref_lat[0] = lat_arr[0]
    pref_lng[0] = lng_arr[0]
    for i in range(1, n):
        pref_mins[i] = pref_mins[i - 1] + edge_mins[i - 1]
        pref_fb[i] = pref_fb[i - 1] + edge_fb[i - 1]
        pref_out[i] = pref_out[i - 1] + edge_out[i - 1]
        pref_lat[i] = pref_lat[i - 1] + lat_arr[i]
        pref_lng[i] = pref_lng[i - 1] + lng_arr[i]

    def _seg_drive(i, j):
        return float(pref_mins[j] - pref_mins[i])

    def _seg_fb(i, j):
        return int(pref_fb[j] - pref_fb[i])

    def _seg_out(i, j):
        return float(pref_out[j] - pref_out[i])

    def _seg_centroid(i, j):
        cnt = float((j - i + 1))
        lat_sum = float(pref_lat[j] - (pref_lat[i - 1] if i > 0 else 0.0))
        lng_sum = float(pref_lng[j] - (pref_lng[i - 1] if i > 0 else 0.0))
        return (lat_sum / cnt, lng_sum / cnt)

    def _seg_cluster_pen(i, j):
        clat, clng = _seg_centroid(i, j)
        max_r = 0.0
        sum_r = 0.0
        any_remote = bool(np.any(is_remote_arr[i : j + 1]))
        for k in range(i, j + 1):
            r = float(_haversine_miles(float(lat_arr[k]), float(lng_arr[k]), clat, clng))
            sum_r += r
            if r > max_r:
                max_r = r
        avg_r = sum_r / float(max(1, j - i + 1))
        # Penalize stretched segments so outliers are pushed into closer neighboring days.
        radius_cap = 10.5 if any_remote else 5.2
        hard_excess = max(0.0, max_r - radius_cap)
        pen = float((hard_excess * 14.0) + max(0.0, avg_r - (3.2 if any_remote else 1.9)) * 2.0)
        if hard_excess > 2.5:
            pen += 120.0
        return pen

    def _run_dp(allow_under_min: bool):
        best = [None] * (n + 1)
        best[n] = (0, 0.0, 0.0, [])
        for i in range(n - 1, -1, -1):
            best_i = None
            best_key = None
            max_j = min(n - 1, i + max_stops - 1)
            for j in range(i, max_j + 1):
                stops = (j - i + 1)
                if stops < min_stops and not allow_under_min:
                    continue
                d = _seg_drive(i, j)
                if not np.isfinite(d) or d > float(max_drive) + 1e-6:
                    continue
                nxt = best[j + 1]
                if nxt is None:
                    continue

                under_pen = 0.0
                reason = ""
                if stops < min_stops:
                    under_pen = 120.0 * float(min_stops - stops)
                    reason = "HARD_CAP_SPLIT"
                cluster_pen = float(_seg_cluster_pen(i, j))
                key = (
                    int(1 + nxt[0]),
                    float(abs(stops - target_stops) + nxt[1]),
                    float(d + (0.45 * _seg_out(i, j)) + cluster_pen + under_pen + nxt[2]),
                    int(stops),
                )
                seg = {
                    "start": int(i),
                    "end": int(j),
                    "stops": int(stops),
                    "drive": float(d),
                    "clusterPenalty": cluster_pen,
                    "fallbackEdges": int(_seg_fb(i, j)),
                    "capacityReason": reason,
                }
                if best_key is None or key < best_key:
                    best_key = key
                    best_i = (key[0], key[1], key[2], [seg] + list(nxt[3]))
            best[i] = best_i
        return None if best[0] is None else best[0][3]

    out = _run_dp(allow_under_min=False)
    if out is None:
        out = _run_dp(allow_under_min=True)
    return out or []


def _build_dates_for_month(month_start, month_end):
    weekdays = generate_valid_dates(month_start, month_end)
    use_saturday = bool(FORCE_SATURDAY_OVERFLOW or ALLOW_SATURDAY_OVERFLOW)
    saturdays = generate_saturday_dates(month_start, month_end) if use_saturday else []
    if not ALLOW_SUNDAY_OVERFLOW:
        saturdays = [d for d in saturdays if d.weekday() == 5]
    return weekdays, saturdays


def _global_primary_bucket(df_chunk: pd.DataFrame) -> Optional[str]:
    if "remoteBucket" not in df_chunk.columns:
        return None
    z = df_chunk["remoteBucket"].dropna()
    if len(z) == 0:
        return None
    try:
        return str(z.mode().iloc[0])
    except Exception:
        return str(z.iloc[0])


def _global_bucket_compatible(df_a: pd.DataFrame, df_b: pd.DataFrame) -> bool:
    if not REMOTE_STRICT:
        return True
    a_remote = bool(df_a.get("isRemote", pd.Series(dtype=bool)).any())
    b_remote = bool(df_b.get("isRemote", pd.Series(dtype=bool)).any())
    if a_remote != b_remote:
        return False
    if not (a_remote and b_remote):
        return True
    pa = _global_primary_bucket(df_a)
    pb = _global_primary_bucket(df_b)
    if pa is None or pb is None:
        return True
    return str(pa) == str(pb)


def _row_can_join_route(row: pd.Series, df_route: pd.DataFrame) -> bool:
    if not REMOTE_STRICT:
        return True
    row_remote = bool(row.get("isRemote", False))
    row_bucket = row.get("remoteBucket", None)
    row_bucket = None if (pd.isna(row_bucket) or str(row_bucket).strip() == "") else str(row_bucket)

    route_remote = bool(df_route.get("isRemote", pd.Series(dtype=bool)).any())
    if row_remote:
        if not route_remote:
            return False
        route_bucket = _global_primary_bucket(df_route)
        if row_bucket is None or route_bucket is None:
            return True
        return str(route_bucket) == str(row_bucket)

    # Local stops may be used as bridge points when stitching remote-to-core.
    return True


def _route_min_keep_stops(route_plan: dict, df_route: pd.DataFrame) -> int:
    cap_reason = str(route_plan.get("capacity_reason", "") or "")
    if cap_reason == "HARD_CAP_SPLIT":
        return 1
    if len(df_route) < int(MIN_STOPS_PER_DAY):
        return 1
    return int(MIN_STOPS_PER_DAY)


def _chunk_matrix_drive_minutes(df_chunk: pd.DataFrame, matrix_minutes: np.ndarray) -> float:
    if len(df_chunk) <= 1:
        return 0.0
    idxs = df_chunk["__rowIndex"].astype(int).tolist()
    total = 0.0
    for i in range(len(idxs) - 1):
        total += float(matrix_leg_minutes(matrix_minutes, int(idxs[i]), int(idxs[i + 1])))
    return float(total)


def _chunk_fallback_edges(df_chunk: pd.DataFrame, fallback_mask: np.ndarray) -> int:
    if len(df_chunk) <= 1:
        return 0
    idxs = df_chunk["__rowIndex"].astype(int).tolist()
    c = 0
    for i in range(len(idxs) - 1):
        if bool(fallback_mask[int(idxs[i]), int(idxs[i + 1])]):
            c += 1
    return int(c)


def _optimize_chunk_sequence_matrix(df_chunk: pd.DataFrame, matrix_minutes: np.ndarray, hub_lat: float, hub_lng: float) -> pd.DataFrame:
    if len(df_chunk) <= 2:
        return df_chunk.reset_index(drop=True)
    tmp = df_chunk.copy().reset_index(drop=True)
    if "__rowIndex" not in tmp.columns:
        return tmp
    order = tmp["__rowIndex"].astype(int).tolist()
    idx_view = tmp.set_index("__rowIndex", drop=False)

    hub_dists = {
        int(i): float(
            _haversine_miles(
                float(idx_view.loc[int(i), "lat"]),
                float(idx_view.loc[int(i), "lng"]),
                float(hub_lat),
                float(hub_lng),
            )
        )
        for i in order
    }
    seeded = _order_block_with_matrix(order, matrix_minutes=matrix_minutes, hub_dists=hub_dists)
    if len(seeded) != len(order):
        seen = set()
        seeded = [int(i) for i in seeded if int(i) not in seen and not seen.add(int(i))]
        for i in order:
            if int(i) not in seen:
                seeded.append(int(i))
                seen.add(int(i))

    order2 = _two_opt_indices_matrix(seeded, matrix_minutes=matrix_minutes, max_iters=35)
    if len(order2) >= 2 and float(hub_dists[order2[-1]]) > float(hub_dists[order2[0]]) + 1e-6:
        order2 = list(reversed(order2))

    # Guardrail: avoid isolated first hops when reverse orientation is clearly smoother.
    if len(order2) >= 4:
        def _path_legs(path):
            return [float(matrix_leg_minutes(matrix_minutes, int(path[k]), int(path[k + 1]))) for k in range(len(path) - 1)]

        legs_a = _path_legs(order2)
        finite_a = [x for x in legs_a if np.isfinite(x) and x > 0.0]
        if finite_a:
            med_a = float(np.median(np.array(finite_a, dtype=float)))
            first_a = float(legs_a[0]) if legs_a else 0.0
            rev = list(reversed(order2))
            if float(hub_dists[rev[0]]) >= float(hub_dists[rev[-1]]) - 1e-6:
                legs_b = _path_legs(rev)
                first_b = float(legs_b[0]) if legs_b else 0.0
                if np.isfinite(first_a) and np.isfinite(first_b) and first_a > (2.20 * med_a) and first_b + 1e-6 < first_a:
                    order2 = rev

    out = idx_view.loc[order2].reset_index(drop=True)
    if "__rowIndex" not in out.columns:
        out["__rowIndex"] = [int(x) for x in order2]
    return out


def _insert_row_best_position(df_route: pd.DataFrame, row_df: pd.DataFrame, matrix_minutes: np.ndarray) -> pd.DataFrame:
    if len(row_df) == 0:
        return df_route.copy().reset_index(drop=True)
    if len(df_route) == 0:
        return row_df.copy().reset_index(drop=True)

    base = df_route.copy().reset_index(drop=True)
    row = row_df.copy().reset_index(drop=True)
    ridx = int(row["__rowIndex"].iloc[0])
    seq = base["__rowIndex"].astype(int).tolist()

    best_pos = 0
    best_cost = None
    for pos in range(len(seq) + 1):
        cand = seq[:pos] + [ridx] + seq[pos:]
        cost = 0.0
        for i in range(len(cand) - 1):
            cost += float(matrix_leg_minutes(matrix_minutes, int(cand[i]), int(cand[i + 1])))
        if best_cost is None or cost < best_cost:
            best_cost = float(cost)
            best_pos = int(pos)

    return pd.concat([base.iloc[:best_pos], row, base.iloc[best_pos:]], ignore_index=True)


def _outlier_candidate_positions(df_route: pd.DataFrame, max_candidates: int = 4):
    if len(df_route) == 0:
        return []
    c_lat = float(df_route["lat"].astype(float).mean())
    c_lng = float(df_route["lng"].astype(float).mean())
    vals = []
    for i in range(len(df_route)):
        r = df_route.iloc[i]
        d = float(_haversine_miles(float(r["lat"]), float(r["lng"]), c_lat, c_lng))
        vals.append((d, int(i)))
    vals.sort(reverse=True)
    return [int(i) for _, i in vals[: max(1, int(max_candidates))]]


def _route_centroid(df_route: pd.DataFrame):
    if len(df_route) == 0:
        return (0.0, 0.0)
    return (
        float(df_route["lat"].astype(float).mean()),
        float(df_route["lng"].astype(float).mean()),
    )


def _route_max_radius_miles(df_route: pd.DataFrame, c_lat: float, c_lng: float) -> float:
    if len(df_route) == 0:
        return 0.0
    mx = 0.0
    for _, r in df_route.iterrows():
        d = float(_haversine_miles(float(r["lat"]), float(r["lng"]), float(c_lat), float(c_lng)))
        if d > mx:
            mx = d
    return float(mx)


def _route_self_crossings(df_route: pd.DataFrame) -> int:
    if len(df_route) < 4:
        return 0
    pts = list(zip(df_route["lat"].astype(float), df_route["lng"].astype(float)))
    return int(_polyline_self_intersections(pts))


def _pair_cross_route_penalty(df_a: pd.DataFrame, df_b: pd.DataFrame) -> float:
    if len(df_a) == 0 or len(df_b) == 0:
        return 0.0
    a_lat, a_lng = _route_centroid(df_a)
    b_lat, b_lng = _route_centroid(df_b)
    pen = 0.0
    for _, r in df_a.iterrows():
        d_own = float(_haversine_miles(float(r["lat"]), float(r["lng"]), a_lat, a_lng))
        d_other = float(_haversine_miles(float(r["lat"]), float(r["lng"]), b_lat, b_lng))
        pen += max(0.0, d_own - d_other)
    for _, r in df_b.iterrows():
        d_own = float(_haversine_miles(float(r["lat"]), float(r["lng"]), b_lat, b_lng))
        d_other = float(_haversine_miles(float(r["lat"]), float(r["lng"]), a_lat, a_lng))
        pen += max(0.0, d_own - d_other)
    return float(pen)


def _pair_quality_score(df_a: pd.DataFrame, df_b: pd.DataFrame, matrix_minutes: np.ndarray) -> float:
    drive = float(_chunk_matrix_drive_minutes(df_a, matrix_minutes=matrix_minutes)) + float(
        _chunk_matrix_drive_minutes(df_b, matrix_minutes=matrix_minutes)
    )
    cross_pen = float(_pair_cross_route_penalty(df_a, df_b))
    self_cross = float(_route_self_crossings(df_a) + _route_self_crossings(df_b))
    a_lat, a_lng = _route_centroid(df_a)
    b_lat, b_lng = _route_centroid(df_b)
    rad = float(_route_max_radius_miles(df_a, a_lat, a_lng)) + float(_route_max_radius_miles(df_b, b_lat, b_lng))
    # Strongly discourage assignments where stops are spatially closer to the other route.
    return float(drive + (4.2 * cross_pen) + (0.35 * rad) + (30.0 * self_cross))


def _pair_has_boundary_pressure(df_a: pd.DataFrame, df_b: pd.DataFrame, min_gain_miles: float = 2.2, max_checks: int = 6) -> bool:
    if len(df_a) == 0 or len(df_b) == 0:
        return False
    a_lat, a_lng = _route_centroid(df_a)
    b_lat, b_lng = _route_centroid(df_b)

    cand_a = _outlier_candidate_positions(df_a, max_candidates=max_checks)
    cand_b = _outlier_candidate_positions(df_b, max_candidates=max_checks)
    for pos in cand_a:
        r = df_a.iloc[int(pos)]
        d_own = float(_haversine_miles(float(r["lat"]), float(r["lng"]), a_lat, a_lng))
        d_other = float(_haversine_miles(float(r["lat"]), float(r["lng"]), b_lat, b_lng))
        if d_own >= d_other + float(min_gain_miles):
            return True
    for pos in cand_b:
        r = df_b.iloc[int(pos)]
        d_own = float(_haversine_miles(float(r["lat"]), float(r["lng"]), b_lat, b_lng))
        d_other = float(_haversine_miles(float(r["lat"]), float(r["lng"]), a_lat, a_lng))
        if d_own >= d_other + float(min_gain_miles):
            return True
    return False


def _assign_two_seed_partition(df_all: pd.DataFrame, seed_a: int, seed_b: int, n_a: int):
    n = int(len(df_all))
    if n <= 1:
        return None
    if seed_a == seed_b or seed_a < 0 or seed_b < 0 or seed_a >= n or seed_b >= n:
        return None
    n_a = int(n_a)
    n_b = int(n - n_a)
    if n_a <= 0 or n_b <= 0:
        return None

    lat = df_all["lat"].astype(float).to_numpy()
    lng = df_all["lng"].astype(float).to_numpy()
    s_a_lat, s_a_lng = float(lat[int(seed_a)]), float(lng[int(seed_a)])
    s_b_lat, s_b_lng = float(lat[int(seed_b)]), float(lng[int(seed_b)])

    d_a = np.array(
        [float(_haversine_miles(float(lat[i]), float(lng[i]), s_a_lat, s_a_lng)) for i in range(n)],
        dtype=float,
    )
    d_b = np.array(
        [float(_haversine_miles(float(lat[i]), float(lng[i]), s_b_lat, s_b_lng)) for i in range(n)],
        dtype=float,
    )

    g_a = {int(seed_a)}
    g_b = {int(seed_b)}
    order = list(np.argsort(-np.abs(d_a - d_b)))
    for ix in order:
        i = int(ix)
        if i in g_a or i in g_b:
            continue
        prefer_a = bool(d_a[i] <= d_b[i])
        if prefer_a and len(g_a) < n_a:
            g_a.add(i)
        elif (not prefer_a) and len(g_b) < n_b:
            g_b.add(i)
        elif len(g_a) < n_a:
            g_a.add(i)
        else:
            g_b.add(i)

    # Fill any remaining capacity deterministically.
    remaining = [int(i) for i in range(n) if int(i) not in g_a and int(i) not in g_b]
    for i in remaining:
        if len(g_a) < n_a:
            g_a.add(int(i))
        else:
            g_b.add(int(i))

    # Rebalance if one side overflowed from forced assignments.
    if len(g_a) > n_a:
        movable = sorted(list(g_a - {int(seed_a)}), key=lambda i: (float(d_b[i] - d_a[i]), i), reverse=True)
        while len(g_a) > n_a and movable:
            mv = int(movable.pop(0))
            g_a.remove(mv)
            g_b.add(mv)
    if len(g_b) > n_b:
        movable = sorted(list(g_b - {int(seed_b)}), key=lambda i: (float(d_a[i] - d_b[i]), i), reverse=True)
        while len(g_b) > n_b and movable:
            mv = int(movable.pop(0))
            g_b.remove(mv)
            g_a.add(mv)

    if len(g_a) != n_a or len(g_b) != n_b:
        return None

    a_idx = sorted(list(g_a))
    b_idx = sorted(list(g_b))
    return a_idx, b_idx


def _balanced_two_cluster_partition(
    lat: np.ndarray,
    lng: np.ndarray,
    n_a: int,
    c_a: tuple,
    c_b: tuple,
    max_iters: int = 8,
):
    n = int(len(lat))
    n_a = int(n_a)
    if n <= 1 or n_a <= 0 or n_a >= n:
        return None

    ca_lat, ca_lng = float(c_a[0]), float(c_a[1])
    cb_lat, cb_lng = float(c_b[0]), float(c_b[1])
    prev_a = None

    for _ in range(max(1, int(max_iters))):
        d_a = np.array(
            [float(_haversine_miles(float(lat[i]), float(lng[i]), ca_lat, ca_lng)) for i in range(n)],
            dtype=float,
        )
        d_b = np.array(
            [float(_haversine_miles(float(lat[i]), float(lng[i]), cb_lat, cb_lng)) for i in range(n)],
            dtype=float,
        )
        diff = d_a - d_b
        order = np.argsort(diff)
        a_idx = sorted([int(x) for x in order[:n_a]])
        b_idx = sorted([int(x) for x in order[n_a:]])
        a_set = tuple(a_idx)
        if prev_a == a_set:
            return a_idx, b_idx
        prev_a = a_set

        if len(a_idx) == 0 or len(b_idx) == 0:
            return None
        ca_lat = float(np.mean(lat[a_idx]))
        ca_lng = float(np.mean(lng[a_idx]))
        cb_lat = float(np.mean(lat[b_idx]))
        cb_lng = float(np.mean(lng[b_idx]))

    if prev_a is None:
        return None
    a_idx = sorted([int(x) for x in prev_a])
    b_idx = sorted([i for i in range(n) if i not in set(a_idx)])
    return a_idx, b_idx


def _try_pair_repartition(
    df_a: pd.DataFrame,
    df_b: pd.DataFrame,
    *,
    matrix_minutes: np.ndarray,
    hub_lat: float,
    hub_lng: float,
    max_drive: float,
):
    if len(df_a) <= 1 or len(df_b) <= 1:
        return None

    base_a = _optimize_chunk_sequence_matrix(df_a.copy().reset_index(drop=True), matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
    base_b = _optimize_chunk_sequence_matrix(df_b.copy().reset_index(drop=True), matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
    base_da = float(_chunk_matrix_drive_minutes(base_a, matrix_minutes=matrix_minutes))
    base_db = float(_chunk_matrix_drive_minutes(base_b, matrix_minutes=matrix_minutes))
    if base_da > float(max_drive) + 1e-6 or base_db > float(max_drive) + 1e-6:
        return None
    base_total_drive = float(base_da + base_db)
    base_score = float(_pair_quality_score(base_a, base_b, matrix_minutes=matrix_minutes))

    n_a = int(len(base_a))
    n_total = int(len(base_a) + len(base_b))
    all_df = pd.concat([base_a, base_b], ignore_index=True)
    lat = all_df["lat"].astype(float).to_numpy()
    lng = all_df["lng"].astype(float).to_numpy()

    comb_lat = float(np.mean(lat))
    comb_lng = float(np.mean(lng))
    dist_center = np.array(
        [float(_haversine_miles(float(lat[i]), float(lng[i]), comb_lat, comb_lng)) for i in range(n_total)],
        dtype=float,
    )
    seed_far = int(np.argmax(dist_center))
    dist_from_far = np.array(
        [float(_haversine_miles(float(lat[i]), float(lng[i]), float(lat[seed_far]), float(lng[seed_far]))) for i in range(n_total)],
        dtype=float,
    )
    seed_opp = int(np.argmax(dist_from_far))

    a_lat, a_lng = _route_centroid(base_a)
    b_lat, b_lng = _route_centroid(base_b)
    idx_near_a = int(np.argmin([_haversine_miles(float(lat[i]), float(lng[i]), a_lat, a_lng) for i in range(n_total)]))
    idx_near_b = int(np.argmin([_haversine_miles(float(lat[i]), float(lng[i]), b_lat, b_lng) for i in range(n_total)]))
    idx_far_a = int(np.argmax([_haversine_miles(float(lat[i]), float(lng[i]), a_lat, a_lng) for i in range(n_total)]))
    idx_far_b = int(np.argmax([_haversine_miles(float(lat[i]), float(lng[i]), b_lat, b_lng) for i in range(n_total)]))

    seed_pairs = []
    for sa, sb in [
        (idx_near_a, idx_near_b),
        (seed_far, seed_opp),
        (idx_far_a, idx_far_b),
        (idx_near_a, seed_opp),
        (seed_far, idx_near_b),
    ]:
        sa_i, sb_i = int(sa), int(sb)
        if sa_i == sb_i:
            continue
        if (sa_i, sb_i) in seed_pairs or (sb_i, sa_i) in seed_pairs:
            continue
        seed_pairs.append((sa_i, sb_i))
    # Also probe additional far-apart anchors for better boundary re-cuts.
    far_order = [int(x) for x in np.argsort(-dist_center)[: min(5, n_total)]]
    for sf in far_order:
        dist_sf = np.array(
            [float(_haversine_miles(float(lat[i]), float(lng[i]), float(lat[sf]), float(lng[sf]))) for i in range(n_total)],
            dtype=float,
        )
        so = int(np.argmax(dist_sf))
        if sf == so:
            continue
        if (sf, so) in seed_pairs or (so, sf) in seed_pairs:
            continue
        seed_pairs.append((int(sf), int(so)))

    best = None
    best_score = None
    for sa, sb in seed_pairs:
        parts = _assign_two_seed_partition(all_df, seed_a=int(sa), seed_b=int(sb), n_a=n_a)
        if parts is None:
            continue
        a_idx, b_idx = parts
        cand_a = all_df.iloc[a_idx].copy().reset_index(drop=True)
        cand_b = all_df.iloc[b_idx].copy().reset_index(drop=True)

        cand_a = _optimize_chunk_sequence_matrix(cand_a, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
        cand_b = _optimize_chunk_sequence_matrix(cand_b, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

        d_a = float(_chunk_matrix_drive_minutes(cand_a, matrix_minutes=matrix_minutes))
        d_b = float(_chunk_matrix_drive_minutes(cand_b, matrix_minutes=matrix_minutes))
        if d_a > float(max_drive) + 1e-6 or d_b > float(max_drive) + 1e-6:
            continue
        cand_score = float(_pair_quality_score(cand_a, cand_b, matrix_minutes=matrix_minutes))
        if best_score is None or cand_score < best_score:
            best_score = float(cand_score)
            best = {
                "df_a": cand_a,
                "df_b": cand_b,
                "score_delta": float(cand_score - base_score),
            }

    if PAIR_BALANCED_REPARTITION:
        # Also evaluate balanced fixed-capacity two-cluster partitions using
        # current route centroids as starting anchors.
        bal_candidates = [
            _balanced_two_cluster_partition(
                lat,
                lng,
                n_a=n_a,
                c_a=(a_lat, a_lng),
                c_b=(b_lat, b_lng),
                max_iters=8,
            ),
            _balanced_two_cluster_partition(
                lat,
                lng,
                n_a=n_a,
                c_a=(b_lat, b_lng),
                c_b=(a_lat, a_lng),
                max_iters=8,
            ),
        ]
        for parts in bal_candidates:
            if parts is None:
                continue
            a_idx, b_idx = parts
            if len(a_idx) != n_a or len(b_idx) != (n_total - n_a):
                continue
            cand_a = all_df.iloc[a_idx].copy().reset_index(drop=True)
            cand_b = all_df.iloc[b_idx].copy().reset_index(drop=True)
            cand_a = _optimize_chunk_sequence_matrix(cand_a, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
            cand_b = _optimize_chunk_sequence_matrix(cand_b, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
            d_a = float(_chunk_matrix_drive_minutes(cand_a, matrix_minutes=matrix_minutes))
            d_b = float(_chunk_matrix_drive_minutes(cand_b, matrix_minutes=matrix_minutes))
            if d_a > float(max_drive) + 1e-6 or d_b > float(max_drive) + 1e-6:
                continue
            cand_score = float(_pair_quality_score(cand_a, cand_b, matrix_minutes=matrix_minutes))
            if best_score is None or cand_score < best_score:
                best_score = float(cand_score)
                best = {
                    "df_a": cand_a,
                    "df_b": cand_b,
                    "score_delta": float(cand_score - base_score),
                }

    if best is None:
        return None
    if float(best["score_delta"]) >= -0.05:
        return None
    return best


def _slot_reassign_assigned_routes(
    tech_route_plans,
    *,
    matrix_minutes: np.ndarray,
    hub_lat: float,
    hub_lng: float,
    max_drive: float,
):
    assigned_keys = [i for i, p in enumerate(tech_route_plans) if p.get("status") == "ASSIGNED" and len(p.get("chunk_df", [])) > 0]
    if len(assigned_keys) <= 1:
        return False

    route_defs = []
    route_dfs = []
    for k in assigned_keys:
        dfk = tech_route_plans[k]["chunk_df"].copy().reset_index(drop=True)
        route_defs.append(
            {
                "plan_idx": int(k),
                "size": int(len(dfk)),
                "is_remote": bool(dfk.get("isRemote", pd.Series(dtype=bool)).any()),
                "bucket": _global_primary_bucket(dfk),
            }
        )
        route_dfs.append(dfk)

    n_total = int(sum(d["size"] for d in route_defs))
    if n_total <= 1:
        return False

    # Stable stop table for assignment.
    all_rows = []
    for r_idx, dfk in enumerate(route_dfs):
        tmp = dfk.copy().reset_index(drop=True)
        tmp["__routeSlotSource"] = int(r_idx)
        all_rows.append(tmp)
    all_df = pd.concat(all_rows, ignore_index=True).reset_index(drop=True)
    if len(all_df) != n_total:
        return False

    slot_to_route = []
    for r_idx, d in enumerate(route_defs):
        slot_to_route.extend([int(r_idx)] * int(d["size"]))
    if len(slot_to_route) != n_total:
        return False

    def _row_compatible_with_route(row: pd.Series, r_def: dict) -> bool:
        if not REMOTE_STRICT:
            return True
        row_remote = bool(row.get("isRemote", False))
        if not row_remote:
            return True
        if not bool(r_def.get("is_remote", False)):
            return False
        rb = row.get("remoteBucket", None)
        rb = None if (pd.isna(rb) or str(rb).strip() == "") else str(rb)
        pb = r_def.get("bucket", None)
        pb = None if (pb is None or str(pb).strip() == "") else str(pb)
        if rb is None or pb is None:
            return True
        return rb == pb

    improved = False
    prev_assign = np.array([int(x) for x in all_df["__routeSlotSource"].tolist()], dtype=int)

    def _angle_diff_rad(a: float, b: float) -> float:
        d = abs(float(a) - float(b))
        return float(min(d, (2.0 * math.pi) - d))

    for _ in range(max(1, int(SLOT_REASSIGN_ITERS))):
        cents = []
        for dfk in route_dfs:
            c_lat, c_lng = _route_centroid(dfk)
            cents.append((float(c_lat), float(c_lng)))
        route_radius = []
        route_angle = []
        for r_idx, dfk in enumerate(route_dfs):
            c_lat, c_lng = cents[r_idx]
            dvals = np.array(
                [
                    float(_haversine_miles(float(dfk.iloc[m]["lat"]), float(dfk.iloc[m]["lng"]), float(c_lat), float(c_lng)))
                    for m in range(len(dfk))
                ],
                dtype=float,
            )
            if len(dvals) == 0:
                route_radius.append({"p85": 0.0, "p95": 0.0})
            else:
                route_radius.append(
                    {
                        "p85": float(np.percentile(dvals, 85)),
                        "p95": float(np.percentile(dvals, 95)),
                    }
                )

            if len(dfk) <= 1:
                route_angle.append({"mean": 0.0, "p85_deg": 180.0})
            else:
                th = []
                for m in range(len(dfk)):
                    lat_m = float(dfk.iloc[m]["lat"])
                    lng_m = float(dfk.iloc[m]["lng"])
                    t = float(math.atan2(lat_m - float(hub_lat), lng_m - float(hub_lng)))
                    if t < 0.0:
                        t += 2.0 * math.pi
                    th.append(float(t))
                th = np.array(th, dtype=float)
                s = float(np.sin(th).mean())
                c = float(np.cos(th).mean())
                mean_t = float(math.atan2(s, c))
                if mean_t < 0.0:
                    mean_t += 2.0 * math.pi
                diffs = np.array([_angle_diff_rad(float(t), float(mean_t)) for t in th], dtype=float)
                route_angle.append(
                    {
                        "mean": float(mean_t),
                        "p85_deg": float(np.degrees(np.percentile(diffs, 85))) if len(diffs) > 0 else 180.0,
                    }
                )

        route_cost = np.full((n_total, len(route_defs)), float(SLOT_REASSIGN_INFEASIBLE_COST), dtype=float)
        for i in range(n_total):
            row = all_df.iloc[i]
            lat = float(row["lat"])
            lng = float(row["lng"])
            src = int(row["__routeSlotSource"])
            row_remote = bool(row.get("isRemote", False))
            row_theta = float(math.atan2(lat - float(hub_lat), lng - float(hub_lng)))
            if row_theta < 0.0:
                row_theta += 2.0 * math.pi

            base_d = {}
            for r_idx, r_def in enumerate(route_defs):
                if not _row_compatible_with_route(row, r_def):
                    continue
                c_lat, c_lng = cents[r_idx]
                d = float(_haversine_miles(lat, lng, c_lat, c_lng))
                base_d[int(r_idx)] = float(d)

            if not base_d:
                continue
            nearest = float(min(base_d.values()))

            for r_idx, d0 in base_d.items():
                r_def = route_defs[int(r_idx)]
                d = float(d0)
                if (not row_remote) and bool(r_def.get("is_remote", False)):
                    # Prefer keeping local stops out of remote routes unless needed
                    # for strict-capacity feasibility.
                    d += 8.0
                rad = route_radius[r_idx]
                p85 = float(rad.get("p85", 0.0))
                p95 = float(rad.get("p95", 0.0))
                if d > p85 + 1e-6:
                    outlier_w = 1.10 if bool(r_def.get("is_remote", False)) else 1.55
                    d += outlier_w * float(d - p85)
                if d > p95 + 1e-6:
                    tail_w = 0.90 if bool(r_def.get("is_remote", False)) else 1.20
                    d += tail_w * float(d - p95)

                # Strongly prefer assigning each stop to its nearest compatible route territory.
                nearest_gap = float(max(0.0, float(d0 - nearest)))
                d += float(SLOT_REASSIGN_NEAREST_PENALTY) * nearest_gap

                # Keep local routes in tighter angular sectors around the tech core.
                if not row_remote:
                    ra = route_angle[r_idx]
                    mean_t = float(ra.get("mean", 0.0))
                    p85_deg = float(ra.get("p85_deg", 180.0))
                    diff_deg = float(np.degrees(_angle_diff_rad(float(row_theta), float(mean_t))))
                    grace_deg = float(max(float(SLOT_REASSIGN_ANGLE_GRACE_DEG), p85_deg + 6.0))
                    if diff_deg > grace_deg + 1e-9:
                        d += float(SLOT_REASSIGN_ANGLE_PENALTY) * float(diff_deg - grace_deg)

                # Small hysteresis term for stability.
                if int(r_idx) == int(src):
                    d -= 0.03
                route_cost[i, r_idx] = d

        cost = np.full((n_total, n_total), float(SLOT_REASSIGN_INFEASIBLE_COST), dtype=float)
        for s_idx, r_idx in enumerate(slot_to_route):
            cost[:, int(s_idx)] = route_cost[:, int(r_idx)]

        row_ind, col_ind = linear_sum_assignment(cost)
        if len(row_ind) != n_total:
            break
        selected = cost[row_ind, col_ind]
        if np.any(selected >= float(SLOT_REASSIGN_INFEASIBLE_COST) * 0.5):
            break

        new_assign = np.array([int(slot_to_route[int(c)]) for c in col_ind], dtype=int)
        if np.array_equal(new_assign, prev_assign):
            break

        new_route_dfs = []
        valid = True
        for r_idx, r_def in enumerate(route_defs):
            take = [int(i) for i in range(n_total) if int(new_assign[i]) == int(r_idx)]
            if len(take) != int(r_def["size"]):
                valid = False
                break
            cand = all_df.iloc[take].drop(columns=["__routeSlotSource"]).copy().reset_index(drop=True)
            cand = _optimize_chunk_sequence_matrix(cand, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
            d = float(_chunk_matrix_drive_minutes(cand, matrix_minutes=matrix_minutes))
            if d > float(max_drive) + 1e-6:
                valid = False
                break
            new_route_dfs.append(cand)
        if not valid:
            break

        route_dfs = new_route_dfs
        prev_assign = new_assign
        improved = True

    if not improved:
        return False

    for r_idx, r_def in enumerate(route_defs):
        plan_idx = int(r_def["plan_idx"])
        tech_route_plans[plan_idx]["chunk_df"] = route_dfs[r_idx].copy().reset_index(drop=True)
    return True


def _endpoint_cleanup_assigned_routes(
    tech_route_plans,
    *,
    matrix_minutes: np.ndarray,
    hub_lat: float,
    hub_lng: float,
    max_drive: float,
):
    changed = False
    for _ in range(max(1, int(ENDPOINT_CLEANUP_ITERS))):
        route_stats = {}
        assigned_keys = []
        for k, p in enumerate(tech_route_plans):
            if p.get("status") != "ASSIGNED":
                continue
            dpk = p.get("chunk_df")
            if dpk is None or len(dpk) == 0:
                continue
            c_lat, c_lng = _route_centroid(dpk)
            route_stats[int(k)] = {
                "c_lat": float(c_lat),
                "c_lng": float(c_lng),
                "drive": float(_chunk_matrix_drive_minutes(dpk, matrix_minutes=matrix_minutes)),
            }
            assigned_keys.append(int(k))

        if len(assigned_keys) < 2:
            break

        best_action = None
        best_benefit = None

        for i in assigned_keys:
            plan_i = tech_route_plans[i]
            df_i = plan_i["chunk_df"]
            if len(df_i) < 2:
                continue
            min_keep_i = int(_route_min_keep_stops(plan_i, df_i))
            c_i_lat = float(route_stats[i]["c_lat"])
            c_i_lng = float(route_stats[i]["c_lng"])
            d_i = float(route_stats[i]["drive"])

            endpoint_positions = sorted(set([0, int(len(df_i) - 1)]))
            for pos in endpoint_positions:
                row_i = df_i.iloc[[int(pos)]].copy().reset_index(drop=True)
                row_i_s = row_i.iloc[0]
                lat_i = float(row_i_s["lat"])
                lng_i = float(row_i_s["lng"])
                same_d = [
                    float(_haversine_miles(lat_i, lng_i, float(df_i.iloc[k]["lat"]), float(df_i.iloc[k]["lng"])))
                    for k in range(len(df_i))
                    if int(k) != int(pos)
                ]
                nearest_same = float(min(same_d)) if same_d else 0.0
                if nearest_same < float(ENDPOINT_NEAR_SAME_MIN_MI):
                    continue
                own_d = float(_haversine_miles(lat_i, lng_i, c_i_lat, c_i_lng))

                for j in assigned_keys:
                    if j == i:
                        continue
                    plan_j = tech_route_plans[j]
                    df_j = plan_j["chunk_df"]
                    if len(df_j) == 0:
                        continue
                    if not _row_can_join_route(row_i_s, df_j):
                        continue
                    c_j_lat = float(route_stats[j]["c_lat"])
                    c_j_lng = float(route_stats[j]["c_lng"])
                    d_j = float(route_stats[j]["drive"])
                    other_d = float(_haversine_miles(lat_i, lng_i, c_j_lat, c_j_lng))
                    gain = float(own_d - other_d)
                    if gain < float(ENDPOINT_GAIN_MIN_MI) and nearest_same < 4.5:
                        continue

                    # One-way move
                    if len(df_j) < int(MAX_STOPS_PER_DAY) and (len(df_i) - 1) >= min_keep_i:
                        df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                        df_j2 = _insert_row_best_position(df_j, row_i, matrix_minutes=matrix_minutes)
                        df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                        df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                        d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                        d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                        if d_i2 <= float(max_drive) + 1e-6 and d_j2 <= float(max_drive) + 1e-6:
                            drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                            benefit = float(gain + (0.25 * max(0.0, nearest_same - float(ENDPOINT_NEAR_SAME_MIN_MI))) - (0.10 * max(0.0, drive_delta)))
                            if best_benefit is None or benefit > best_benefit:
                                best_benefit = float(benefit)
                                best_action = {"i": int(i), "j": int(j), "df_i2": df_i2, "df_j2": df_j2}

                    # Swap if destination full or swap is better.
                    for pos_j in range(len(df_j)):
                        row_j_df = df_j.iloc[[int(pos_j)]].copy().reset_index(drop=True)
                        row_j_s = row_j_df.iloc[0]
                        if not _row_can_join_route(row_j_s, df_i):
                            continue
                        df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                        df_j2 = df_j.drop(df_j.index[int(pos_j)]).reset_index(drop=True)
                        df_i2 = _insert_row_best_position(df_i2, row_j_df, matrix_minutes=matrix_minutes)
                        df_j2 = _insert_row_best_position(df_j2, row_i, matrix_minutes=matrix_minutes)
                        df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                        df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                        d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                        d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                        if d_i2 > float(max_drive) + 1e-6 or d_j2 > float(max_drive) + 1e-6:
                            continue

                        lat_j = float(row_j_s["lat"])
                        lng_j = float(row_j_s["lng"])
                        j_own = float(_haversine_miles(lat_j, lng_j, c_j_lat, c_j_lng))
                        j_to_i = float(_haversine_miles(lat_j, lng_j, c_i_lat, c_i_lng))
                        gain_j = max(0.0, float(j_own - j_to_i))
                        drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                        benefit = float((gain + gain_j) + (0.20 * max(0.0, nearest_same - float(ENDPOINT_NEAR_SAME_MIN_MI))) - (0.10 * max(0.0, drive_delta)))
                        if best_benefit is None or benefit > best_benefit:
                            best_benefit = float(benefit)
                            best_action = {"i": int(i), "j": int(j), "df_i2": df_i2, "df_j2": df_j2}

        if best_action is None or best_benefit is None or best_benefit < float(ENDPOINT_BENEFIT_MIN):
            break

        tech_route_plans[best_action["i"]]["chunk_df"] = best_action["df_i2"]
        tech_route_plans[best_action["j"]]["chunk_df"] = best_action["df_j2"]
        changed = True

    return changed


def _merge_tiny_assigned_routes(
    tech_route_plans,
    *,
    matrix_minutes: np.ndarray,
    hub_lat: float,
    hub_lng: float,
    max_drive: float,
):
    changed = False
    while True:
        tiny = [
            int(i)
            for i, p in enumerate(tech_route_plans)
            if p.get("status") == "ASSIGNED" and len(p.get("chunk_df", [])) > 0 and len(p.get("chunk_df", [])) < int(MIN_STOPS_PER_DAY)
        ]
        if not tiny:
            break

        tiny = sorted(tiny, key=lambda i: len(tech_route_plans[i].get("chunk_df", [])))
        merged_one = False

        for i in tiny:
            if i >= len(tech_route_plans):
                continue
            plan_i = tech_route_plans[i]
            df_i = plan_i.get("chunk_df")
            if df_i is None or len(df_i) == 0:
                continue
            c_i_lat, c_i_lng = _route_centroid(df_i)

            best = None
            best_score = None
            for j, plan_j in enumerate(tech_route_plans):
                if j == i:
                    continue
                if plan_j.get("status") != "ASSIGNED":
                    continue
                df_j = plan_j.get("chunk_df")
                if df_j is None or len(df_j) == 0:
                    continue
                if len(df_j) + len(df_i) > int(MAX_STOPS_PER_DAY):
                    continue
                if not _global_bucket_compatible(df_i, df_j):
                    continue

                merged = pd.concat([df_j, df_i], ignore_index=True).reset_index(drop=True)
                merged = _optimize_chunk_sequence_matrix(merged, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                d = float(_chunk_matrix_drive_minutes(merged, matrix_minutes=matrix_minutes))
                if d > float(max_drive) + 1e-6:
                    continue

                c_j_lat, c_j_lng = _route_centroid(df_j)
                centroid_gap = float(_haversine_miles(c_i_lat, c_i_lng, c_j_lat, c_j_lng))
                size_pen = float(abs(len(merged) - int(TARGET_STOPS_PER_DAY)))
                score = float(d) + (1.30 * centroid_gap) + (0.70 * size_pen)
                if best_score is None or score < best_score:
                    best_score = float(score)
                    best = {"j": int(j), "merged_df": merged}

            if best is None:
                continue

            j = int(best["j"])
            merged_df = best["merged_df"]
            keep = []
            for k, p in enumerate(tech_route_plans):
                if k == i:
                    continue
                if k == j:
                    p2 = dict(p)
                    p2["chunk_df"] = merged_df.copy().reset_index(drop=True)
                    keep.append(p2)
                else:
                    keep.append(p)
            tech_route_plans[:] = keep
            changed = True
            merged_one = True
            break

        if not merged_one:
            break

    return changed


def _two_opt_improve(latlngs, max_iters: int = 60):
    """2-opt improvement using offline leg minutes. Returns a reordered list of (lat,lng)."""
    pts = _uncross_polyline_2opt(_clean_latlngs(latlngs), max_iters=max(20, int(max_iters)))
    n = len(pts)
    if n <= 3:
        return pts

    def leg(a, b):
        return approx_leg_minutes(a[0], a[1], b[0], b[1])

    def total_cost(path):
        c = 0.0
        for k in range(len(path) - 1):
            c += leg(path[k], path[k + 1])
        return c

    best = pts
    best_cost = total_cost(best)

    iters = 0
    improved = True
    while improved and iters < max_iters:
        improved = False
        iters += 1

        for i in range(1, n - 2):
            for j in range(i + 1, n - 1):
                a, b = best[i - 1], best[i]
                c, d = best[j], best[j + 1]

                cur = leg(a, b) + leg(c, d)
                new = leg(a, c) + leg(b, d)

                if new + 1e-6 < cur:
                    best = best[:i] + list(reversed(best[i : j + 1])) + best[j + 1 :]
                    best_cost = best_cost - cur + new
                    improved = True
                    break
            if improved:
                break

    return _uncross_polyline_2opt(best, max_iters=max(20, int(max_iters)))


def _reorder_df_by_latlng_sequence(df_points: pd.DataFrame, ordered_latlngs):
    """Map an ordered lat/lng sequence back to dataframe rows (stable for duplicates)."""
    base = df_points.copy().reset_index(drop=True)
    if len(base) <= 1:
        return base

    tmp = base.copy()
    tmp["__lat__"] = tmp["lat"].astype(float).round(5)
    tmp["__lng__"] = tmp["lng"].astype(float).round(5)
    used_rows = np.zeros(len(tmp), dtype=bool)
    out_rows = []

    for (lat, lng) in ordered_latlngs:
        latk = round(float(lat), 5)
        lngk = round(float(lng), 5)
        candidates = tmp.index[(~used_rows) & (tmp["__lat__"] == latk) & (tmp["__lng__"] == lngk)].to_numpy()
        if len(candidates) == 0:
            continue
        idx = int(candidates[0])
        used_rows[idx] = True
        out_rows.append(idx)

    leftovers = tmp.index[~used_rows].to_list()
    out_rows.extend(leftovers)
    return base.loc[out_rows].reset_index(drop=True)


def order_points_drive_min(df_points: pd.DataFrame) -> pd.DataFrame:
    """Order stops to reduce drive time: greedy order + small 2-opt refinement."""
    if len(df_points) <= 2:
        return df_points.reset_index(drop=True)

    pts = df_points[["lat", "lng"]].to_numpy(dtype=float)
    n = len(pts)
    used = np.zeros(n, dtype=bool)
    order = []
    current = int(np.argmin(pts[:, 1]))  # western-most

    for _ in range(n):
        used[current] = True
        order.append(current)
        remaining = np.where(~used)[0]
        if len(remaining) == 0:
            break
        cur = pts[current]
        diffs = pts[remaining] - cur
        d2 = (diffs[:, 0] ** 2) + (diffs[:, 1] ** 2)
        current = int(remaining[int(np.argmin(d2))])

    ordered = df_points.iloc[order].reset_index(drop=True)

    latlngs = list(zip(ordered["lat"].astype(float), ordered["lng"].astype(float)))
    improved = _two_opt_improve(latlngs, max_iters=50)
    improved = _uncross_polyline_2opt(improved, max_iters=80)
    ordered2 = _reorder_df_by_latlng_sequence(ordered, improved)

    # Preserve the optimized edge set; only choose direction.
    try:
        c_lat = float(ordered2["lat"].astype(float).mean())
        c_lng = float(ordered2["lng"].astype(float).mean())
        pts2 = ordered2[["lat", "lng"]].astype(float).to_numpy()
        if len(pts2) > 1:
            d2_first = (pts2[0, 0] - c_lat) ** 2 + (pts2[0, 1] - c_lng) ** 2
            d2_last = (pts2[-1, 0] - c_lat) ** 2 + (pts2[-1, 1] - c_lng) ** 2
            if d2_last > d2_first + 1e-12:
                ordered2 = ordered2.iloc[::-1].reset_index(drop=True)
    except Exception:
        pass

    return ordered2


def order_points_remote_to_core(df_points: pd.DataFrame, hub_lat: float, hub_lng: float) -> pd.DataFrame:
    """Order remote-heavy routes from far-out starts back toward a hub.

    Score each candidate with:
    - leg travel minutes from current stop
    - detour penalty for moving away from hub
    - pass-by penalty for skipping an obvious forward-nearby candidate
    """
    if len(df_points) <= 2:
        return df_points.reset_index(drop=True)

    df = df_points.copy().reset_index(drop=True)
    pts = df[["lat", "lng"]].to_numpy(dtype=float)
    n = len(df)

    d_hub = np.array(
        [_haversine_miles(float(lat), float(lng), float(hub_lat), float(hub_lng)) for lat, lng in pts],
        dtype=float,
    )

    current = int(np.argmax(d_hub))  # farthest from hub starts the route
    seed_idx = int(current)
    seed_lat, seed_lng = float(pts[seed_idx][0]), float(pts[seed_idx][1])
    remaining = set(range(n))
    order = [current]
    remaining.remove(current)

    while remaining:
        cur_lat, cur_lng = pts[current]
        cur_hub = float(d_hub[current])
        best_j = None
        best_score = None

        for j in remaining:
            lat_j, lng_j = pts[j]
            leg_mins = float(approx_leg_minutes(cur_lat, cur_lng, lat_j, lng_j))
            hub_j = float(d_hub[j])

            detour_away = max(0.0, hub_j - cur_hub)
            score = leg_mins + (2.2 * detour_away)

            # Prevent loop-backs near the starting area once we've moved inward.
            if len(order) >= 3:
                dist_seed_j = float(_haversine_miles(seed_lat, seed_lng, lat_j, lng_j))
                dist_seed_cur = float(_haversine_miles(seed_lat, seed_lng, cur_lat, cur_lng))
                if dist_seed_j + 1e-6 < (0.65 * dist_seed_cur):
                    score += 40.0

            # Pass-by penalty: if there is another remaining candidate that's
            # both closer by leg and more in the "toward hub" direction, penalize j.
            passby = 0.0
            for k in remaining:
                if k == j:
                    continue
                lat_k, lng_k = pts[k]
                leg_k = float(approx_leg_minutes(cur_lat, cur_lng, lat_k, lng_k))
                hub_k = float(d_hub[k])
                if leg_k + 1e-6 < leg_mins and hub_k <= hub_j + 1e-6:
                    passby += min(6.0, (leg_mins - leg_k))
            score += passby

            if best_score is None or score < best_score:
                best_score = score
                best_j = int(j)

        if best_j is None:
            break
        current = best_j
        order.append(current)
        remaining.remove(current)

    leftovers = [i for i in range(n) if i not in set(order)]
    order.extend(leftovers)
    ordered = df.iloc[order].reset_index(drop=True)

    # If route closes back near the start, enforce open progression along seed->hub axis.
    try:
        if len(ordered) >= 5:
            p0 = ordered.iloc[0]
            pN = ordered.iloc[-1]
            start_end = float(_haversine_miles(float(p0["lat"]), float(p0["lng"]), float(pN["lat"]), float(pN["lng"])))
            all_pts = ordered[["lat", "lng"]].astype(float).to_numpy()
            max_pair = 0.0
            for i in range(len(all_pts)):
                for j in range(i + 1, len(all_pts)):
                    d = float(_haversine_miles(all_pts[i, 0], all_pts[i, 1], all_pts[j, 0], all_pts[j, 1]))
                    if d > max_pair:
                        max_pair = d
            if max_pair > 0 and start_end < 0.25 * max_pair:
                sx, sy = float(seed_lat), float(seed_lng)
                vx = float(hub_lat) - sx
                vy = float(hub_lng) - sy
                denom = (vx * vx + vy * vy) or 1.0
                tmp = ordered.copy()
                tmp["__proj"] = tmp.apply(
                    lambda r: (((float(r["lat"]) - sx) * vx) + ((float(r["lng"]) - sy) * vy)) / denom,
                    axis=1,
                )
                ordered = tmp.sort_values("__proj", ascending=True).drop(columns=["__proj"]).reset_index(drop=True)
    except Exception:
        pass

    # Remove any remaining geometric crossing without changing membership.
    try:
        latlngs = list(zip(ordered["lat"].astype(float), ordered["lng"].astype(float)))
        uncrossed = _uncross_polyline_2opt(latlngs, max_iters=80)
        ordered = _reorder_df_by_latlng_sequence(ordered, uncrossed)
    except Exception:
        pass

    return ordered


def osrm_route(latlngs):
    """
    latlngs: list of (lat,lng)
    Returns:
      road_line: list of (lat,lng) following roads (fallback to straight)
      miles: float | None
      minutes: float | None
    """
    latlngs = _clean_latlngs(latlngs)
    try:
        if not latlngs or len(latlngs) < 2:
            return latlngs, None, None

        coords = [f"{lng},{lat}" for (lat, lng) in latlngs]
        key = ";".join(coords)
        data = _osrm_route_multi_cached(key)
        road_line, miles, minutes = _parse_osrm_route(data)
        if road_line and len(road_line) >= 2:
            return road_line, miles, minutes

        raise RuntimeError("OSRM multi-waypoint returned no route")

    except Exception:
        try:
            stitched = []
            total_miles = 0.0
            total_minutes = 0.0
            have_any = False

            for i in range(len(latlngs) - 1):
                (lat1, lon1) = latlngs[i]
                (lat2, lon2) = latlngs[i + 1]

                data = _osrm_route_leg_cached(lon1, lat1, lon2, lat2)
                road_line, miles, minutes = _parse_osrm_route(data)

                if road_line and len(road_line) >= 2:
                    have_any = True
                    if stitched and stitched[-1] == road_line[0]:
                        stitched.extend(road_line[1:])
                    else:
                        stitched.extend(road_line)

                if miles is not None:
                    total_miles += float(miles)
                if minutes is not None:
                    total_minutes += float(minutes)

            if have_any and len(stitched) >= 2:
                return stitched, (total_miles if total_miles > 0 else None), (total_minutes if total_minutes > 0 else None)
        except Exception:
            pass

        return latlngs, None, None


from pathlib import Path
from typing import Optional
import time
import traceback
import pandas as pd


def _pick_scheduling_request_column(df: pd.DataFrame) -> Optional[str]:
    alias_lookup = {str(a).strip().lower() for a in SCHEDULING_REQUEST_COLUMN_ALIASES}
    for col in df.columns:
        if str(col).strip().lower() in alias_lookup:
            return str(col)
    return None


def _find_column_by_alias(df: pd.DataFrame, aliases: list) -> Optional[str]:
    alias_lookup = {str(a).strip().lower() for a in aliases}
    for col in df.columns:
        if str(col).strip().lower() in alias_lookup:
            return str(col)
    return None


def _normalize_input_columns(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    for target_col, aliases in INPUT_COLUMN_ALIASES.items():
        if target_col in out.columns:
            continue
        found_col = _find_column_by_alias(out, aliases)
        if found_col and found_col != target_col:
            out = out.rename(columns={found_col: target_col})
    return out


def _load_coordinate_cache(cache_dir: Path) -> Dict[str, tuple]:
    out: Dict[str, tuple] = {}
    for filename in COORDINATE_CACHE_CANDIDATE_FILES:
        cache_path = (cache_dir / filename).resolve()
        if not cache_path.exists():
            continue
        try:
            hist = pd.read_csv(str(cache_path), dtype=str, encoding="utf-8-sig", low_memory=False)
        except Exception:
            continue

        hist = _normalize_input_columns(hist)
        if not {"customerID", "lat", "lng"}.issubset(set(hist.columns)):
            continue

        ids = hist["customerID"].astype(str).str.strip()
        lats = pd.to_numeric(hist["lat"], errors="coerce")
        lngs = pd.to_numeric(hist["lng"], errors="coerce")
        good_mask = ids.ne("") & lats.notna() & lngs.notna()
        if not bool(good_mask.any()):
            continue

        for cid, lat, lng in zip(ids[good_mask], lats[good_mask], lngs[good_mask]):
            out[str(cid)] = (float(lat), float(lng))
    return out


def _enforce_scheduling_weekday_constraints(df_out: pd.DataFrame) -> Dict[str, Any]:
    """Move hard weekday-constrained stops onto valid weekdays when feasible.

    Policy:
    - Strict weekday match when possible.
    - Capacity override allowed up to MAX_STOPS_PER_ROUTE + 6.
    - Preserve hard drive cap (MAX_ROUTE_DRIVE_MIN).
    """
    summary = {
        "checked": 0,
        "moved": 0,
        "overriddenCap": 0,
        "unresolved": 0,
        "touchedRoutes": [],
    }
    if len(df_out) == 0:
        return summary

    required_cols = {
        "preferredTech",
        "routeName",
        "routeDate",
        "routeIndex",
        "sequence",
        "lat",
        "lng",
        "assignmentReason",
        "schedulingAllowedWeekdays",
        "schedulingBlockedWeekdays",
        "schedulingConstraintStatus",
        "schedulingConstraintNote",
    }
    if not required_cols.issubset(set(df_out.columns)):
        return summary

    hard_mask = (
        df_out["schedulingAllowedWeekdays"].astype(str).str.strip().ne("")
        | df_out["schedulingBlockedWeekdays"].astype(str).str.strip().ne("")
    )
    candidate_idxs = df_out.index[hard_mask].to_list()
    if not candidate_idxs:
        return summary

    touched_routes = set()
    base_cap = int(MAX_STOPS_PER_ROUTE)
    override_cap = int(MAX_STOPS_PER_ROUTE) + 6

    for idx in candidate_idxs:
        if idx not in df_out.index:
            continue

        row = df_out.loc[idx]
        allowed = _deserialize_weekdays(row.get("schedulingAllowedWeekdays", ""))
        blocked = _deserialize_weekdays(row.get("schedulingBlockedWeekdays", ""))
        if not allowed and not blocked:
            continue

        summary["checked"] += 1
        current_date = row.get("routeDate")
        if _weekday_ok_for_date(current_date, allowed, blocked):
            if _normalize_sched_text(row.get("schedulingConstraintStatus", "")) in {"", "PENDING"}:
                df_out.at[idx, "schedulingConstraintStatus"] = "OK"
            continue

        tech = str(row.get("preferredTech", ""))
        src_route_name = str(row.get("routeName", ""))
        src_lat = float(row.get("lat", 0.0))
        src_lng = float(row.get("lng", 0.0))

        # Build candidate destination routes for this tech with allowed weekday.
        best = None
        for route_name, g in df_out.groupby("routeName", sort=False):
            route_name_str = str(route_name)
            if route_name_str == src_route_name:
                continue
            if len(g) == 0:
                continue
            if str(g["preferredTech"].iloc[0]) != tech:
                continue
            route_date = g["routeDate"].iloc[0]
            if not _weekday_ok_for_date(route_date, allowed, blocked):
                continue
            if ("UNASSIGNED" in route_name_str.upper()) or pd.isna(pd.to_datetime(route_date, errors="coerce")):
                continue

            route_idxs = g.sort_values("sequence").index.to_list()
            route_size = len(route_idxs)
            if route_size >= override_cap:
                continue

            route_pts = list(zip(df_out.loc[route_idxs, "lat"].astype(float), df_out.loc[route_idxs, "lng"].astype(float)))
            insert_idx = _best_insert_index_by_distance(route_pts, src_lat, src_lng)
            new_pts = route_pts.copy()
            new_pts.insert(insert_idx, (src_lat, src_lng))

            old_drive = float(route_drive_minutes_from_points_fast(route_pts)) if len(route_pts) >= 2 else 0.0
            new_drive = float(route_drive_minutes_from_points_fast(new_pts)) if len(new_pts) >= 2 else 0.0
            if new_drive > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                continue

            # Geo cohesion tie-breaker: distance to destination centroid.
            c_lat = float(df_out.loc[route_idxs, "lat"].astype(float).mean())
            c_lng = float(df_out.loc[route_idxs, "lng"].astype(float).mean())
            geo_mi = float(_haversine_miles(src_lat, src_lng, c_lat, c_lng))

            status = "OVERRIDDEN_CAP" if route_size >= base_cap else "OK"
            score = float((new_drive - old_drive) + (0.05 * geo_mi) + (2.0 if status == "OVERRIDDEN_CAP" else 0.0))
            candidate = {
                "routeName": route_name_str,
                "routeDate": g["routeDate"].iloc[0],
                "routeIndex": g["routeIndex"].iloc[0] if "routeIndex" in g.columns else None,
                "dayType": g["dayType"].iloc[0] if "dayType" in g.columns else "WEEKDAY",
                "status": status,
                "score": score,
                "insertIndex": int(insert_idx),
            }
            if best is None or float(candidate["score"]) < float(best["score"]):
                best = candidate

        if best is None:
            df_out.at[idx, "schedulingConstraintStatus"] = "UNRESOLVED"
            prev_note = _normalize_sched_text(df_out.at[idx, "schedulingConstraintNote"])
            note = "No feasible same-tech route/date satisfied weekday rule within drive cap."
            df_out.at[idx, "schedulingConstraintNote"] = f"{prev_note}; {note}" if prev_note else note
            df_out.at[idx, "assignmentReason"] = _append_sched_reason(df_out.at[idx, "assignmentReason"], "SCHED_REQUEST_UNRESOLVED")
            summary["unresolved"] += 1
            continue

        # Move stop by rewriting assignment fields and resequencing source+destination routes.
        dst_route_name = str(best["routeName"])
        dst_idxs = _route_sequence_indices(df_out, dst_route_name)
        insert_at = int(best["insertIndex"])
        insert_at = max(0, min(insert_at, len(dst_idxs)))

        df_out.at[idx, "routeName"] = dst_route_name
        df_out.at[idx, "routeDate"] = best["routeDate"]
        df_out.at[idx, "routeIndex"] = best["routeIndex"]
        df_out.at[idx, "dayType"] = best["dayType"]
        df_out.at[idx, "schedulingConstraintStatus"] = str(best["status"])
        df_out.at[idx, "assignmentReason"] = _append_sched_reason(
            df_out.at[idx, "assignmentReason"],
            ("SCHED_REQUEST_CAP_OVERRIDE" if best["status"] == "OVERRIDDEN_CAP" else "SCHED_REQUEST_ENFORCED"),
        )
        prev_note = _normalize_sched_text(df_out.at[idx, "schedulingConstraintNote"])
        move_note = f"Moved to {best['routeDate']} on {dst_route_name}."
        df_out.at[idx, "schedulingConstraintNote"] = f"{prev_note}; {move_note}" if prev_note else move_note

        # Resequence destination in exact insertion order.
        dst_idxs_after = _route_sequence_indices(df_out, dst_route_name)
        if idx in dst_idxs_after:
            dst_idxs_after.remove(idx)
        dst_idxs_after.insert(insert_at, idx)
        df_out.loc[dst_idxs_after, "sequence"] = np.arange(1, len(dst_idxs_after) + 1)
        _resequence_route(df_out, src_route_name)
        _recompute_route_drive_minutes(df_out, src_route_name)
        _recompute_route_drive_minutes(df_out, dst_route_name)

        touched_routes.add(src_route_name)
        touched_routes.add(dst_route_name)
        summary["moved"] += 1
        if best["status"] == "OVERRIDDEN_CAP":
            summary["overriddenCap"] += 1

    # Ensure all hard-request rows have explicit final status.
    hard_idxs = df_out.index[
        df_out["schedulingAllowedWeekdays"].astype(str).str.strip().ne("")
        | df_out["schedulingBlockedWeekdays"].astype(str).str.strip().ne("")
    ].to_list()
    for idx in hard_idxs:
        cur = _normalize_sched_text(df_out.at[idx, "schedulingConstraintStatus"])
        if cur in {"", "PENDING"}:
            route_date_val = df_out.at[idx, "routeDate"]
            allowed = _deserialize_weekdays(df_out.at[idx, "schedulingAllowedWeekdays"])
            blocked = _deserialize_weekdays(df_out.at[idx, "schedulingBlockedWeekdays"])
            if _weekday_ok_for_date(route_date_val, allowed, blocked):
                df_out.at[idx, "schedulingConstraintStatus"] = "OK"
            else:
                df_out.at[idx, "schedulingConstraintStatus"] = "UNRESOLVED"
                df_out.at[idx, "assignmentReason"] = _append_sched_reason(df_out.at[idx, "assignmentReason"], "SCHED_REQUEST_UNRESOLVED")
                summary["unresolved"] += 1

    summary["touchedRoutes"] = sorted([str(x) for x in touched_routes if str(x).strip()])
    return summary


def run_routing(
    input_csv,
    progress_path: Optional[str] = "routing_progress.json",
    run_settings: Optional[dict] = None,
    run_id: Optional[str] = None,
):
    """Run routing and write outputs to the same folder as the input CSV.

    progress_path can be None (disables progress), an absolute path, or a relative filename.
    If relative, it will be placed in the input CSV's directory.
    """
    input_path = Path(str(input_csv)).expanduser().resolve()
    output_dir = input_path.parent

    def _resolve_out_path(p: Optional[str]) -> Optional[str]:
        if not p:
            return None
        pp = Path(str(p)).expanduser()
        if pp.is_absolute():
            return str(pp)
        return str((output_dir / pp).resolve())

    progress_path = _resolve_out_path(progress_path)

    out_csv_path = (output_dir / "routing_plan.csv").resolve()
    out_html_path = (output_dir / "route_preview.html").resolve()
    out_scaffold_path = (output_dir / "route_scaffolds.json").resolve()

    # --- ETA estimation helpers ---
    started_at = time.time()
    total_techs_for_eta: Optional[int] = None
    strict_osrm_for_run = bool(STRICT_OSRM_FOR_OPTIMIZATION)
    run_osrm_route_validation = bool(STRICT_OSRM_FOR_OPTIMIZATION)
    settings_bundle = _coerce_run_settings_bundle(run_settings)
    effective_run_settings = dict(settings_bundle.get("effective", {}))
    run_settings_meta = {
        "unknownKeys": list(settings_bundle.get("unknownKeys", [])),
        "corrections": list(settings_bundle.get("corrections", [])),
    }
    run_settings_summary = summarize_run_settings(effective_run_settings)
    restore_run_settings = _apply_run_settings_overrides(effective_run_settings)

    def _with_eta(payload: dict, processed_techs: Optional[int] = None, total_techs: Optional[int] = None) -> dict:
        """Augment progress payload with elapsed + percent + ETA when possible."""
        try:
            now = time.time()
            out = dict(payload)
            out.setdefault("startedAt", int(started_at))
            out["elapsedSec"] = int(now - started_at)

            t_total = total_techs if total_techs is not None else total_techs_for_eta
            if t_total is not None:
                out["totalTechs"] = int(t_total)

            if processed_techs is not None and t_total is not None:
                done = max(0, int(processed_techs))
                t_total = int(t_total)
                out["processedTechs"] = done
                frac = float(done / max(1, t_total))
                out["progress"] = frac
                out["percent"] = int(round(frac * 100))

                if done > 0:
                    avg_per_tech = (now - started_at) / float(done)
                    remaining = max(0, t_total - done)
                    eta_sec = int(avg_per_tech * remaining)
                    out["etaSec"] = eta_sec
                    out["etaAt"] = int(now + eta_sec)

            out.setdefault("runSettings", dict(effective_run_settings))
            out.setdefault("runSettingsMeta", dict(run_settings_meta))
            out.setdefault("runSettingsSummary", str(run_settings_summary))
            return out
        except Exception:
            return payload

    try:
        # Initial progress
        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "read_csv",
                "message": f"Loading CSV: {input_path.name}",
                "inputCsv": str(input_path),
            }, processed_techs=0))

        df = pd.read_csv(str(input_path))

        # Estimate total techs early (for ETA) if possible
        if "Preferred Tech" in df.columns:
            total_techs_for_eta = int(df["Preferred Tech"].nunique())
        elif "preferredTech" in df.columns:
            total_techs_for_eta = int(df["preferredTech"].nunique())

        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "loaded_csv",
                "message": "Loaded CSV",
                "rows": int(len(df)),
                "outputCsv": str(out_csv_path),
                "outputHtml": str(out_html_path),
            }, processed_techs=0, total_techs=total_techs_for_eta))

        staffing_warnings = []
        matrix_quality_rows = []

        if PRODUCTION_HANDS_OFF_MODE and FAIL_FAST_IF_OSRM_UNAVAILABLE:
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "osrm_preflight",
                    "message": "Running OSRM preflight check",
                }, processed_techs=0, total_techs=total_techs_for_eta))
            if not _osrm_service_available(force_refresh=True):
                raise RuntimeError(
                    "OSRM_UNAVAILABLE: strict mode requires a reachable OSRM backend. "
                    "Set OSRM_BASE_URL and/or OSRM_FALLBACK_BASE_URLS to healthy endpoints and rerun."
                )

        df = _normalize_input_columns(df)

        missing_required = [c for c in ["customerID", "preferredTech"] if c not in df.columns]
        if missing_required:
            raise RuntimeError(
                "INPUT_SCHEMA_INVALID: missing required column(s): "
                + ", ".join(missing_required)
                + ". Required aliases include Customer ID and Preferred Tech."
            )

        if "lat" not in df.columns:
            df["lat"] = np.nan
        if "lng" not in df.columns:
            df["lng"] = np.nan

        df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
        df["lng"] = pd.to_numeric(df["lng"], errors="coerce")
        coord_missing_mask = df["lat"].isna() | df["lng"].isna()
        coords_backfilled = 0
        if bool(coord_missing_mask.any()):
            coord_cache = _load_coordinate_cache(input_path.parent)
            if coord_cache:
                customer_ids = df["customerID"].astype(str).str.strip()
                for idx in df.index[coord_missing_mask]:
                    cid = str(customer_ids.at[idx])
                    hit = coord_cache.get(cid)
                    if hit is None:
                        continue
                    df.at[idx, "lat"] = float(hit[0])
                    df.at[idx, "lng"] = float(hit[1])
                    coords_backfilled += 1
                coord_missing_mask = df["lat"].isna() | df["lng"].isna()

        if bool(coord_missing_mask.any()):
            missing_ids = (
                df.loc[coord_missing_mask, "customerID"]
                .astype(str)
                .str.strip()
                .replace("", np.nan)
                .dropna()
                .unique()
                .tolist()
            )
            sample_ids = ", ".join([str(x) for x in missing_ids[:12]]) if missing_ids else "n/a"
            raise RuntimeError(
                f"INPUT_COORDINATES_MISSING: {int(coord_missing_mask.sum())} row(s) are missing Latitude/Longitude "
                f"after local cache backfill. Provide Latitude/Longitude in the upload or enrich these customerIDs first. "
                f"Sample customerIDs: {sample_ids}"
            )

        sched_col = _pick_scheduling_request_column(df)
        if sched_col:
            df["schedulingRequestRaw"] = df[sched_col]
        elif "schedulingRequestRaw" not in df.columns:
            df["schedulingRequestRaw"] = ""

        parsed_sched = df["schedulingRequestRaw"].apply(parse_scheduling_request).apply(pd.Series)
        for col in parsed_sched.columns:
            df[col] = parsed_sched[col]

        if "subscriptionID" not in df.columns:
            df["subscriptionID"] = ""
        else:
            df["subscriptionID"] = df["subscriptionID"].fillna("").astype(str).str.strip()

        if "planStopId" in df.columns:
            df["planStopId"] = df["planStopId"].astype(str).str.strip()
            missing_mask = df["planStopId"].eq("") | df["planStopId"].isna()
            if bool(missing_mask.any()):
                base_ids = [f"plan-{i + 1:07d}" for i in range(len(df))]
                df.loc[missing_mask, "planStopId"] = np.array(base_ids, dtype=object)[missing_mask.to_numpy()]
        else:
            df["planStopId"] = [f"plan-{i + 1:07d}" for i in range(len(df))]

        if "serviceDue" not in df.columns:
            df["serviceDue"] = pd.NaT
        df["serviceDue"] = pd.to_datetime(df["serviceDue"], errors="coerce")
        if bool(df["serviceDue"].notna().any()):
            due_fallback = pd.to_datetime(df["serviceDue"].dropna().median())
        else:
            due_fallback = pd.Timestamp.today().normalize()
        df["serviceDue"] = df["serviceDue"].fillna(due_fallback)

        planning_start, planning_end = _planning_horizon_bounds(
            int(PLANNING_HORIZON_MONTHS),
            service_due_series=df["serviceDue"],
        )
        planning_mask = (df["serviceDue"] >= planning_start) & (df["serviceDue"] <= planning_end)
        dropped_outside_horizon = int((~planning_mask).sum())
        df = df.loc[planning_mask].copy().reset_index(drop=True)
        if len(df) == 0:
            raise RuntimeError(
                f"NO_STOPS_IN_DATE_RANGE: No stops with serviceDue between "
                f"{planning_start.date()} and {planning_end.date()}."
            )

        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "normalized_columns",
                "message": "Normalized columns",
                "rows": int(len(df)),
                "coordsBackfilled": int(coords_backfilled),
                "planningStart": str(planning_start.date()),
                "planningEnd": str(planning_end.date()),
                "planningHorizonMonths": int(PLANNING_HORIZON_MONTHS),
                "droppedOutsideDateRange": int(dropped_outside_horizon),
            }, processed_techs=0, total_techs=total_techs_for_eta))

        staffing_warnings.append(
            {
                "warning": "SATURDAY_OVERFLOW_FORCED",
                "forced": bool(FORCE_SATURDAY_OVERFLOW),
                "requestedAllowSaturdayOverflow": bool(ALLOW_SATURDAY_OVERFLOW),
            }
        )

        df["duration"] = DEFAULT_DURATION

        df["windowStart"] = df["serviceDue"] - pd.Timedelta(days=10)
        df["windowEnd"] = df["serviceDue"] + pd.Timedelta(days=10)
        df["remoteZone"] = df.apply(lambda r: classify_remote_zone(r["lat"], r["lng"]), axis=1)
        df["isRemote"] = df["remoteZone"].notna()
        df["remoteBucket"] = df.apply(lambda r: remote_bucket(r["remoteZone"], r["lat"], r["lng"]), axis=1)
        df["assignmentReason"] = np.where(df["isRemote"], "REMOTE_HARD", "LOCAL_BALANCE")
        df["sequenceStrategy"] = np.where(df["isRemote"], "REMOTE_TO_CORE", "FARTHEST_TO_CORE")

        route_rows = []

        def _chunk_subset(
            subset_df: pd.DataFrame,
            *,
            route_number_start: int,
            stop_cap: int,
            hub_lat: float,
            hub_lng: float,
            assignment_reason: str,
            sequence_strategy: str,
        ):
            """Create ordered chunks for one subset (remote or local)."""
            if len(subset_df) == 0:
                return [], route_number_start

            local = subset_df.copy().reset_index(drop=True)
            local["__zonePriority"] = local["remoteBucket"].map(remote_zone_priority).astype(int)
            chunks_out = []
            rn = int(route_number_start)

            def _build_routes_farthest_seed(df_in: pd.DataFrame):
                """Build route groups by angular sweep sectors toward centroid.

                This strongly reduces cross-route intersections compared with free-form
                nearest-neighbor assignment.
                """
                if len(df_in) == 0:
                    return []

                work = df_in.copy().reset_index(drop=True)
                n = len(work)
                rcount = int(max(1, np.ceil(n / max(1, stop_cap))))

                dists = np.array(
                    [
                        _haversine_miles(float(work.iloc[i]["lat"]), float(work.iloc[i]["lng"]), float(hub_lat), float(hub_lng))
                        for i in range(n)
                    ],
                    dtype=float,
                )
                angs = np.array(
                    [
                        math.atan2(float(work.iloc[i]["lat"]) - float(hub_lat), float(work.iloc[i]["lng"]) - float(hub_lng))
                        for i in range(n)
                    ],
                    dtype=float,
                )
                angs = np.where(angs < 0.0, angs + (2.0 * math.pi), angs)

                # Rotate at the largest angular gap to avoid wrap-around splitting.
                order_ang = np.argsort(angs)
                ordered_angles = angs[order_ang]
                if len(ordered_angles) > 1:
                    gaps = np.diff(np.concatenate([ordered_angles, [ordered_angles[0] + (2.0 * math.pi)]]))
                    cut_at = int(np.argmax(gaps))
                    rot_base = float(ordered_angles[(cut_at + 1) % len(ordered_angles)])
                else:
                    rot_base = 0.0

                def _build_variant(variant: int):
                    rot = (float(rot_base) + ((2.0 * math.pi) * float(variant) / float(max(1, rcount * 5)))) % (2.0 * math.pi)
                    shifted = (angs - rot) % (2.0 * math.pi)

                    if variant % 2 == 0:
                        idx_sorted = sorted(range(n), key=lambda i: (shifted[i], -dists[i]))
                    else:
                        idx_sorted = sorted(range(n), key=lambda i: (shifted[i], dists[i]))

                    routes_idx = []
                    base = n // rcount
                    rem = n % rcount
                    pos = 0
                    for r in range(rcount):
                        take = base + (1 if r < rem else 0)
                        if take <= 0:
                            continue
                        block = idx_sorted[pos : pos + take]
                        pos += take
                        block = sorted(block, key=lambda i: dists[i], reverse=True)
                        routes_idx.append(block)

                    routes = []
                    for block in routes_idx:
                        if not block:
                            continue
                        routes.append(work.iloc[block].copy().reset_index(drop=True))
                    return routes

                def _angle_span_rad(df_pts: pd.DataFrame) -> float:
                    if len(df_pts) <= 2:
                        return 0.0
                    a = np.array(
                        [
                            math.atan2(float(r["lat"]) - float(hub_lat), float(r["lng"]) - float(hub_lng))
                            for _, r in df_pts.iterrows()
                        ],
                        dtype=float,
                    )
                    a = np.where(a < 0.0, a + (2.0 * math.pi), a)
                    aa = np.sort(a)
                    gaps = np.diff(np.concatenate([aa, [aa[0] + (2.0 * math.pi)]]))
                    return float((2.0 * math.pi) - float(np.max(gaps)))

                def _loop_ratio(df_pts: pd.DataFrame) -> float:
                    if len(df_pts) <= 2:
                        return 1.0
                    tmp = order_points_remote_to_core(df_pts, hub_lat=hub_lat, hub_lng=hub_lng)
                    pts = tmp[["lat", "lng"]].astype(float).to_numpy()
                    start_end = float(_haversine_miles(pts[0, 0], pts[0, 1], pts[-1, 0], pts[-1, 1]))
                    max_pair = 0.0
                    for i in range(len(pts)):
                        for j in range(i + 1, len(pts)):
                            d = float(_haversine_miles(pts[i, 0], pts[i, 1], pts[j, 0], pts[j, 1]))
                            if d > max_pair:
                                max_pair = d
                    if max_pair <= 1e-9:
                        return 1.0
                    return float(start_end / max_pair)

                def _variant_score(routes):
                    if not routes:
                        return 1e18
                    score = 0.0
                    for ch in routes:
                        if sequence_strategy in ("REMOTE_TO_CORE", "FARTHEST_TO_CORE"):
                            ord_ch = order_points_remote_to_core(ch, hub_lat=hub_lat, hub_lng=hub_lng)
                        else:
                            ord_ch = order_points_drive_min(ch)
                        pts = list(zip(ord_ch["lat"].astype(float), ord_ch["lng"].astype(float)))
                        # Variant scoring is exploratory; keep this fast and defer
                        # strict OSRM checks to acceptance/quality gates.
                        drive_fast = float(route_drive_minutes_from_points_fast(pts))
                        score += drive_fast

                        pref_drive = float(PREFERRED_ROUTE_DRIVE_MIN_REMOTE if bool(ord_ch.get("isRemote", pd.Series(dtype=bool)).any()) else PREFERRED_ROUTE_DRIVE_MIN_LOCAL)
                        if drive_fast > pref_drive:
                            score += 20.0 * float(drive_fast - pref_drive)

                        loop_r = _loop_ratio(ord_ch)
                        if loop_r < float(MIN_LOOP_OPEN_RATIO):
                            score += 200.0 * float(MIN_LOOP_OPEN_RATIO - loop_r)

                        span = _angle_span_rad(ord_ch)
                        max_span = math.radians(float(MAX_ROUTE_ANGLE_SPAN_DEG))
                        if span > max_span:
                            score += 80.0 * float(span - max_span)

                        if len(pts) >= 2:
                            diam = 0.0
                            for i in range(len(pts)):
                                for j in range(i + 1, len(pts)):
                                    d = float(_haversine_miles(pts[i][0], pts[i][1], pts[j][0], pts[j][1]))
                                    if d > diam:
                                        diam = d
                            diam_cap = float(MAX_ROUTE_DIAMETER_MI_REMOTE if bool(ord_ch.get("isRemote", pd.Series(dtype=bool)).any()) else MAX_ROUTE_DIAMETER_MI_LOCAL)
                            if diam > diam_cap:
                                score += 60.0 * float(diam - diam_cap)

                        if "remoteBucket" in ord_ch.columns:
                            b = {str(x) for x in ord_ch["remoteBucket"].dropna().tolist()}
                            if "EAST_OF_BEAVER_LAKE_NORTH" in b and "EAST_OF_BEAVER_LAKE_SOUTH" in b:
                                score += 1000.0
                            if "SOUTH_OF_PRAIRIE_GROVE_EAST" in b and "SOUTH_OF_PRAIRIE_GROVE_WEST" in b:
                                score += 700.0
                    return float(score)

                best_routes = None
                best_score = None
                for variant in range(max(1, int(ROUTE_BUILD_VARIANTS))):
                    cand = _build_variant(variant)
                    sc = _variant_score(cand)
                    if best_score is None or sc < best_score:
                        best_score = sc
                        best_routes = cand

                return best_routes if best_routes is not None else _build_variant(0)

            if assignment_reason == "REMOTE_HARD":
                zone_groups = []
                for z in sorted(local["remoteBucket"].dropna().unique(), key=remote_zone_priority):
                    zone_groups.append(local[local["remoteBucket"] == z].copy().reset_index(drop=True))
            else:
                zone_groups = [local]

            for bucket_df in zone_groups:
                bucket_df = bucket_df.copy().reset_index(drop=True)
                bucket_df = bucket_df.sort_values(["__zonePriority", "serviceDue"]).reset_index(drop=True)
                chunks = _build_routes_farthest_seed(bucket_df)

                for chunk in chunks:
                    if sequence_strategy in ("REMOTE_TO_CORE", "FARTHEST_TO_CORE"):
                        chunk = order_points_remote_to_core(chunk, hub_lat=hub_lat, hub_lng=hub_lng)
                    else:
                        # Local routes still use drive-min optimization, but route membership
                        # now comes from farthest-seed inward building to reduce crossing.
                        chunk = order_points_drive_min(chunk)

                    chunk["assignmentReason"] = assignment_reason
                    chunk["sequenceStrategy"] = sequence_strategy
                    chunk["isRemote"] = chunk["remoteZone"].notna()
                    median_due = pd.to_datetime(chunk["serviceDue"].median()).date()
                    chunks_out.append((median_due, rn, chunk))
                    rn += 1

            return chunks_out, rn

        tech_groups = list(df.groupby("preferredTech"))
        total_techs = int(len(tech_groups))
        total_techs_for_eta = total_techs

        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "grouping_by_tech",
                "message": "Grouped stops by preferred tech",
                "totalTechs": total_techs,
                "processedTechs": 0,
            }, processed_techs=0, total_techs=total_techs))

        for tech_i, (tech, tech_df) in enumerate(tech_groups, start=1):
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "processing_tech",
                    "message": f"Processing tech {tech} ({tech_i}/{total_techs})",
                    "tech": str(tech),
                    "techIndex": int(tech_i),
                    "totalTechs": total_techs,
                    "processedTechs": int(tech_i - 1),
                    "techStops": int(len(tech_df)),
                }, processed_techs=int(tech_i - 1), total_techs=total_techs))

            tech_df = tech_df.copy().reset_index(drop=True)

            if ROUTING_MODE == "GLOBAL_CHAIN_ZONE_BLOCKS":
                global_tech_started = time.time()

                def _global_time_exceeded() -> bool:
                    return (time.time() - float(global_tech_started)) > float(MAX_OPT_SECONDS_PER_TECH)

                tech_df = tech_df.sort_values(["serviceDue", "customerID", "lat", "lng"]).reset_index(drop=True)
                tech_df["serviceMonth"] = tech_df["serviceDue"].dt.to_period("M").astype(str)
                month_tokens = sorted({str(x) for x in tech_df["serviceMonth"].dropna().tolist() if str(x).strip()})
                target_month = month_tokens[0] if month_tokens else pd.Timestamp.today().strftime("%Y-%m")
                month_start = pd.Timestamp(f"{target_month}-01").date()
                month_end = (
                    pd.Timestamp(month_start)
                    + pd.offsets.MonthEnd(max(1, int(PLANNING_HORIZON_MONTHS)))
                ).date()

                weekdays, saturdays = _build_dates_for_month(month_start, month_end)
                day_dates = list(weekdays) + list(saturdays)
                if len(day_dates) == 0:
                    day_dates = [month_start]

                hub_lat = float(tech_df["lat"].astype(float).mean())
                hub_lng = float(tech_df["lng"].astype(float).mean())

                tech_df["hubMiles"] = tech_df.apply(
                    lambda r: _haversine_miles(float(r["lat"]), float(r["lng"]), hub_lat, hub_lng),
                    axis=1,
                )
                q_far = float(tech_df["hubMiles"].quantile(REMOTE_OUTLIER_QUANTILE)) if len(tech_df) else 0.0
                far_cut = max(float(REMOTE_OUTLIER_MIN_MILES), q_far)
                dynamic_remote = tech_df["hubMiles"].astype(float) >= far_cut
                tech_df.loc[dynamic_remote & tech_df["remoteZone"].isna(), "remoteZone"] = "FAR_OUTLIER"
                tech_df.loc[dynamic_remote & tech_df["remoteBucket"].isna(), "remoteBucket"] = "FAR_OUTLIER"
                tech_df["isRemote"] = tech_df["remoteZone"].notna()

                matrix_started = time.time()
                matrix_info = build_or_load_tech_matrix(tech_df, target_month=str(target_month), tech_name=str(tech))
                matrix_build_sec = float(time.time() - matrix_started)
                matrix_minutes = matrix_info["matrix"]
                fallback_mask = matrix_info["fallback_mask"]
                unresolved_pairs = int(matrix_info.get("unresolved_pairs", 0))
                n_stops_matrix = int(len(tech_df))
                n_pairs_matrix = int(max(0, n_stops_matrix * (n_stops_matrix - 1)))
                matrix_cov = 1.0 if n_pairs_matrix <= 0 else max(0.0, 1.0 - (float(unresolved_pairs) / float(n_pairs_matrix)))
                matrix_quality_rows.append(
                    {
                        "tech": str(tech),
                        "month": str(target_month),
                        "stops": int(n_stops_matrix),
                        "pairs": int(n_pairs_matrix),
                        "unresolvedPairs": int(unresolved_pairs),
                        "coverage": float(matrix_cov),
                        "cacheUsed": bool(matrix_info.get("cache_used", False)),
                    }
                )
                if int(matrix_info.get("unresolved_pairs", 0)) > 0:
                    staffing_warnings.append(
                        {
                            "tech": str(tech),
                            "month": str(target_month),
                            "warning": "OSRM_MATRIX_FALLBACK",
                            "unresolved_pairs": int(unresolved_pairs),
                            "matrix_coverage": float(matrix_cov),
                            "drive_model": "FALLBACK_APPROX",
                        }
                    )
                if float(matrix_cov) < float(MIN_OSRM_MATRIX_COVERAGE):
                    if PRODUCTION_HANDS_OFF_MODE and QUALITY_GATES_HARD_FAIL and strict_osrm_for_run:
                        raise RuntimeError(
                            "OSRM_MATRIX_COVERAGE_TOO_LOW "
                            f"for {tech} ({matrix_cov:.3f} < {MIN_OSRM_MATRIX_COVERAGE:.3f}). "
                            "Hands-off mode refuses fallback-heavy optimization."
                        )
                    staffing_warnings.append(
                        {
                            "tech": str(tech),
                            "month": str(target_month),
                            "warning": "OSRM_MATRIX_COVERAGE_LOW_USING_APPROX",
                            "matrix_coverage": float(matrix_cov),
                            "threshold": float(MIN_OSRM_MATRIX_COVERAGE),
                        }
                    )

                chain_started = time.time()
                tech_df = tech_df.copy()
                tech_df["__rowIndex"] = np.arange(len(tech_df), dtype=int)
                tech_df_idx = tech_df.set_index("__rowIndex", drop=False)
                chain_indices = _build_global_chain_zone_blocks(tech_df_idx, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                chain_build_sec = float(time.time() - chain_started)

                slice_started = time.time()
                slices = _slice_chain_dynamic(
                    chain_indices,
                    matrix_minutes=matrix_minutes,
                    fallback_mask=fallback_mask,
                    tech_df=tech_df_idx,
                    target_stops=int(TARGET_STOPS_PER_DAY),
                    min_stops=int(MIN_STOPS_PER_DAY),
                    max_stops=int(MAX_STOPS_PER_DAY),
                    # Keep initial slicing less brittle; final hard caps still enforced
                    # by quality gates + OSRM route validation later in the pipeline.
                    max_drive=float(MAX_ROUTE_DRIVE_MIN) + float(SLICE_DRIVE_BUFFER_MIN),
                    hub_lat=hub_lat,
                    hub_lng=hub_lng,
                )
                slice_sec = float(time.time() - slice_started)

                required_routes = int(len(slices))
                if required_routes > len(day_dates):
                    overflow_routes = int(required_routes - len(day_dates))
                    staffing_warnings.append(
                        {
                            "tech": str(tech),
                            "month": str(target_month),
                            "stops": int(len(tech_df)),
                            "weekday_days": int(len(weekdays)),
                            "saturday_days": int(len(saturdays)),
                            "available_days": int(len(day_dates)),
                            "routes_needed": int(required_routes),
                            "overflow_routes": int(overflow_routes),
                            "capacity_reason": "MONTH_CAPACITY_EXHAUSTED",
                        }
                    )

                tech_route_plans = []
                for route_num, seg in enumerate(slices, start=1):
                    start_i = int(seg["start"])
                    end_i = int(seg["end"])
                    seg_indices = [int(x) for x in chain_indices[start_i : end_i + 1]]
                    if len(seg_indices) == 0:
                        continue
                    chunk_df = tech_df_idx.loc[seg_indices].copy().reset_index(drop=True)
                    route_drive_matrix = float(seg.get("drive", 0.0))
                    violates_drive_cap = route_drive_matrix > float(MAX_ROUTE_DRIVE_MIN) + 1e-6
                    seg_capacity_reason = str(seg.get("capacityReason", "") or "")

                    if route_num <= len(day_dates):
                        day_date = day_dates[route_num - 1]
                        day_idx = int(route_num)
                        day_type = "SATURDAY_OVERFLOW" if day_date.weekday() == 5 else "WEEKDAY"
                        status = "ASSIGNED"
                        if violates_drive_cap:
                            cap_reason = "DRIVE_PREF_EXCEEDED_MATRIX"
                        else:
                            cap_reason = seg_capacity_reason
                    else:
                        day_date = None
                        day_idx = None
                        day_type = "UNASSIGNED"
                        status = "OVERFLOW_CAPACITY"
                        cap_reason = "MONTH_CAPACITY_EXHAUSTED"

                    tech_route_plans.append(
                        {
                            "route_num": int(route_num),
                            "day_idx": day_idx,
                            "day_date": day_date,
                            "day_type": day_type,
                            "status": status,
                            "capacity_reason": cap_reason,
                            "chunk_df": chunk_df,
                        }
                    )

                # Inter-route reassignment polish:
                # move obvious outlier stops to a better neighboring route when it
                # improves fit and preserves hard drive/size constraints.
                polish_iters = 0
                while polish_iters < 160:
                    polish_iters += 1
                    if _global_time_exceeded():
                        break
                    best_move = None
                    best_score = None
                    best_spatial_move = None
                    best_spatial_gain = None
                    route_stats = {}
                    for k, pk in enumerate(tech_route_plans):
                        if pk["status"] != "ASSIGNED":
                            continue
                        dpk = pk["chunk_df"]
                        route_stats[k] = {
                            "drive": float(_chunk_matrix_drive_minutes(dpk, matrix_minutes=matrix_minutes)),
                            "c_lat": float(dpk["lat"].astype(float).mean()),
                            "c_lng": float(dpk["lng"].astype(float).mean()),
                        }

                    for i, pi in enumerate(tech_route_plans):
                        if _global_time_exceeded():
                            break
                        if pi["status"] != "ASSIGNED":
                            continue
                        df_i = pi["chunk_df"]
                        min_keep_i = int(_route_min_keep_stops(pi, df_i))
                        if len(df_i) <= min_keep_i:
                            continue
                        st_i = route_stats.get(i)
                        if st_i is None:
                            continue
                        d_i = float(st_i["drive"])
                        c_i_lat = float(st_i["c_lat"])
                        c_i_lng = float(st_i["c_lng"])

                        for pos in _outlier_candidate_positions(df_i, max_candidates=4):
                            row_i = df_i.iloc[[int(pos)]].copy().reset_index(drop=True)
                            row_i_lat = float(row_i["lat"].iloc[0])
                            row_i_lng = float(row_i["lng"].iloc[0])
                            d_i_own = float(_haversine_miles(row_i_lat, row_i_lng, c_i_lat, c_i_lng))

                            for j, pj in enumerate(tech_route_plans):
                                if _global_time_exceeded():
                                    break
                                if j == i:
                                    continue
                                if pj["status"] != "ASSIGNED":
                                    continue
                                df_j = pj["chunk_df"]
                                if not _global_bucket_compatible(df_i, df_j):
                                    continue
                                st_j = route_stats.get(j)
                                if st_j is None:
                                    continue
                                d_j = float(st_j["drive"])
                                c_j_lat = float(st_j["c_lat"])
                                c_j_lng = float(st_j["c_lng"])
                                d_i_to_j = float(_haversine_miles(row_i_lat, row_i_lng, c_j_lat, c_j_lng))

                                # One-way move
                                if len(df_j) < int(MAX_STOPS_PER_DAY) and (len(df_i) - 1) >= min_keep_i:
                                    size_pressure = (len(df_i) > int(TARGET_STOPS_PER_DAY)) and (len(df_j) < int(TARGET_STOPS_PER_DAY))
                                    spatial_ok = (d_i_own > d_i_to_j + 1.0) or (size_pressure and d_i_to_j <= d_i_own + 1.5)
                                    if spatial_ok:
                                        df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                        df_j2 = _insert_row_best_position(df_j, row_i, matrix_minutes=matrix_minutes)
                                        df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                        df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

                                        d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                                        d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                                        if d_i2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6 and d_j2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                            before_size = abs(len(df_i) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j) - int(TARGET_STOPS_PER_DAY))
                                            after_size = abs(len(df_i2) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j2) - int(TARGET_STOPS_PER_DAY))
                                            size_delta = float(after_size - before_size)
                                            drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                                            spatial_gain = float(d_i_own - d_i_to_j)
                                            score = float(drive_delta) + (0.35 * size_delta) - (0.95 * spatial_gain) - (1.50 if size_pressure else 0.0)
                                            if best_score is None or score < best_score:
                                                best_score = float(score)
                                                best_move = {
                                                    "i": int(i),
                                                    "j": int(j),
                                                    "df_i2": df_i2,
                                                    "df_j2": df_j2,
                                                }
                                            if drive_delta <= 8.0:
                                                if best_spatial_gain is None or float(spatial_gain) > best_spatial_gain:
                                                    best_spatial_gain = float(spatial_gain)
                                                    best_spatial_move = {
                                                        "i": int(i),
                                                        "j": int(j),
                                                        "df_i2": df_i2,
                                                        "df_j2": df_j2,
                                                    }

                                # 1-for-1 swap
                                    for pos_j in range(len(df_j)):
                                        if _global_time_exceeded():
                                            break
                                        row_j = df_j.iloc[[int(pos_j)]].copy().reset_index(drop=True)
                                    row_j_lat = float(row_j["lat"].iloc[0])
                                    row_j_lng = float(row_j["lng"].iloc[0])

                                    d_j_own = float(_haversine_miles(row_j_lat, row_j_lng, c_j_lat, c_j_lng))
                                    d_j_to_i = float(_haversine_miles(row_j_lat, row_j_lng, c_i_lat, c_i_lng))
                                    combined_gain = float((d_i_own - d_i_to_j) + (d_j_own - d_j_to_i))
                                    if combined_gain <= 0.6:
                                        continue

                                    df_i_swap = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                    df_j_swap = df_j.drop(df_j.index[int(pos_j)]).reset_index(drop=True)
                                    df_i_swap = _insert_row_best_position(df_i_swap, row_j, matrix_minutes=matrix_minutes)
                                    df_j_swap = _insert_row_best_position(df_j_swap, row_i, matrix_minutes=matrix_minutes)
                                    df_i_swap = _optimize_chunk_sequence_matrix(df_i_swap, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                    df_j_swap = _optimize_chunk_sequence_matrix(df_j_swap, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

                                    d_i2 = float(_chunk_matrix_drive_minutes(df_i_swap, matrix_minutes=matrix_minutes))
                                    d_j2 = float(_chunk_matrix_drive_minutes(df_j_swap, matrix_minutes=matrix_minutes))
                                    if d_i2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6 or d_j2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                        continue

                                    before_size = abs(len(df_i) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j) - int(TARGET_STOPS_PER_DAY))
                                    after_size = abs(len(df_i_swap) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j_swap) - int(TARGET_STOPS_PER_DAY))
                                    size_delta = float(after_size - before_size)
                                    drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                                    score = float(drive_delta) + (0.20 * size_delta) - (1.15 * combined_gain)

                                    if best_score is None or score < best_score:
                                        best_score = float(score)
                                        best_move = {
                                            "i": int(i),
                                            "j": int(j),
                                            "df_i2": df_i_swap,
                                            "df_j2": df_j_swap,
                                        }
                                    if drive_delta <= 8.0:
                                        if best_spatial_gain is None or float(combined_gain) > best_spatial_gain:
                                            best_spatial_gain = float(combined_gain)
                                            best_spatial_move = {
                                                "i": int(i),
                                                "j": int(j),
                                                "df_i2": df_i_swap,
                                                "df_j2": df_j_swap,
                                            }

                    chosen = None
                    if best_move is not None and best_score is not None and best_score < -0.20:
                        chosen = best_move
                    elif best_spatial_move is not None and best_spatial_gain is not None and best_spatial_gain >= 3.0:
                        chosen = best_spatial_move
                    if chosen is None:
                        break

                    tech_route_plans[chosen["i"]]["chunk_df"] = chosen["df_i2"]
                    tech_route_plans[chosen["j"]]["chunk_df"] = chosen["df_j2"]

                # Pairwise repartition polish:
                # re-cut nearby route pairs together (same tech and same remote/local
                # compatibility) to eliminate "obvious closer to another route" stops.
                pair_iters = 0
                while pair_iters < 96:
                    pair_iters += 1
                    if _global_time_exceeded():
                        break
                    best_pair = None
                    best_delta = None

                    route_stats = {}
                    for k, pk in enumerate(tech_route_plans):
                        if pk["status"] != "ASSIGNED":
                            continue
                        dpk = pk["chunk_df"]
                        if len(dpk) == 0:
                            continue
                        c_lat = float(dpk["lat"].astype(float).mean())
                        c_lng = float(dpk["lng"].astype(float).mean())
                        route_stats[k] = {
                            "c_lat": c_lat,
                            "c_lng": c_lng,
                            "is_remote": bool(dpk.get("isRemote", pd.Series(dtype=bool)).any()),
                        }

                    keys = sorted(route_stats.keys())
                    for ai in range(len(keys)):
                        if _global_time_exceeded():
                            break
                        i = int(keys[ai])
                        for bj in range(ai + 1, len(keys)):
                            if _global_time_exceeded():
                                break
                            j = int(keys[bj])
                            df_i = tech_route_plans[i]["chunk_df"]
                            df_j = tech_route_plans[j]["chunk_df"]
                            if len(df_i) <= 1 or len(df_j) <= 1:
                                continue
                            if not _global_bucket_compatible(df_i, df_j):
                                continue

                            st_i = route_stats[i]
                            st_j = route_stats[j]
                            cdist = float(
                                _haversine_miles(
                                    float(st_i["c_lat"]),
                                    float(st_i["c_lng"]),
                                    float(st_j["c_lat"]),
                                    float(st_j["c_lng"]),
                                )
                            )
                            is_remote_pair = bool(st_i["is_remote"] or st_j["is_remote"])
                            near_limit = 24.0 if is_remote_pair else 16.0
                            max_consider = 36.0 if is_remote_pair else 28.0
                            if cdist > max_consider:
                                continue
                            if cdist > near_limit and not _pair_has_boundary_pressure(df_i, df_j, min_gain_miles=1.6, max_checks=8):
                                continue

                            rep = _try_pair_repartition(
                                df_i,
                                df_j,
                                matrix_minutes=matrix_minutes,
                                hub_lat=hub_lat,
                                hub_lng=hub_lng,
                                max_drive=float(MAX_ROUTE_DRIVE_MIN),
                            )
                            if rep is None:
                                continue
                            delta = float(rep["score_delta"])
                            if best_delta is None or delta < best_delta:
                                best_delta = float(delta)
                                best_pair = {
                                    "i": int(i),
                                    "j": int(j),
                                    "df_i2": rep["df_a"],
                                    "df_j2": rep["df_b"],
                                }

                    if best_pair is None or best_delta is None or best_delta >= -0.05:
                        break

                    tech_route_plans[best_pair["i"]]["chunk_df"] = best_pair["df_i2"]
                    tech_route_plans[best_pair["j"]]["chunk_df"] = best_pair["df_j2"]

                # Misfit-driven cleanup:
                # directly fix stops that are clearly closer to another compatible route.
                if MISFIT_PASS_ENABLED:
                    misfit_iters = 0
                    while misfit_iters < int(MISFIT_MAX_ITERS_PER_TECH):
                        misfit_iters += 1
                        if _global_time_exceeded():
                            break

                        route_stats = {}
                        assigned_keys = []
                        for k, pk in enumerate(tech_route_plans):
                            if pk["status"] != "ASSIGNED":
                                continue
                            dpk = pk["chunk_df"]
                            if len(dpk) == 0:
                                continue
                            c_lat, c_lng = _route_centroid(dpk)
                            route_stats[k] = {
                                "c_lat": float(c_lat),
                                "c_lng": float(c_lng),
                                "drive": float(_chunk_matrix_drive_minutes(dpk, matrix_minutes=matrix_minutes)),
                            }
                            assigned_keys.append(int(k))

                        if len(assigned_keys) < 2:
                            break

                        misfit_candidates = []
                        for i in assigned_keys:
                            if _global_time_exceeded():
                                break
                            df_i = tech_route_plans[i]["chunk_df"]
                            st_i = route_stats[i]
                            c_i_lat = float(st_i["c_lat"])
                            c_i_lng = float(st_i["c_lng"])

                            for pos in range(len(df_i)):
                                if _global_time_exceeded():
                                    break
                                row = df_i.iloc[int(pos)]
                                lat = float(row["lat"])
                                lng = float(row["lng"])
                                own_d = float(_haversine_miles(lat, lng, c_i_lat, c_i_lng))

                                best_j = None
                                best_d = None
                                best_open_j = None
                                best_open_d = None
                                for j in assigned_keys:
                                    if j == i:
                                        continue
                                    df_j = tech_route_plans[j]["chunk_df"]
                                    if not _row_can_join_route(row, df_j):
                                        continue
                                    st_j = route_stats[j]
                                    d_other = float(_haversine_miles(lat, lng, float(st_j["c_lat"]), float(st_j["c_lng"])))
                                    if len(df_j) < int(MAX_STOPS_PER_DAY):
                                        if best_open_d is None or d_other < best_open_d:
                                            best_open_d = float(d_other)
                                            best_open_j = int(j)
                                    if best_d is None or d_other < best_d:
                                        best_d = float(d_other)
                                        best_j = int(j)
                                if best_open_j is not None and best_open_d is not None:
                                    best_j = int(best_open_j)
                                    best_d = float(best_open_d)

                                if best_j is None or best_d is None:
                                    continue
                                gain = float(own_d - best_d)
                                if gain >= float(MISFIT_GAIN_THRESHOLD_MI):
                                    misfit_candidates.append(
                                        {
                                            "gain": gain,
                                            "i": int(i),
                                            "j": int(best_j),
                                            "pos": int(pos),
                                            "own_d": own_d,
                                            "other_d": float(best_d),
                                        }
                                    )

                        if not misfit_candidates:
                            break

                        misfit_candidates.sort(key=lambda x: (float(x["gain"]), -int(x["i"])), reverse=True)
                        misfit_candidates = misfit_candidates[: int(MISFIT_MAX_CANDIDATES_PER_ITER)]

                        best_action = None
                        best_score = None

                        for cand in misfit_candidates:
                            i = int(cand["i"])
                            j = int(cand["j"])
                            pos = int(cand["pos"])
                            gain = float(cand["gain"])

                            df_i = tech_route_plans[i]["chunk_df"]
                            df_j = tech_route_plans[j]["chunk_df"]
                            if len(df_i) == 0 or len(df_j) == 0:
                                continue

                            st_i = route_stats[i]
                            st_j = route_stats[j]
                            d_i = float(st_i["drive"])
                            d_j = float(st_j["drive"])
                            min_keep_i = int(_route_min_keep_stops(tech_route_plans[i], df_i))
                            row_i = df_i.iloc[[int(pos)]].copy().reset_index(drop=True)
                            row_i_s = row_i.iloc[0]

                            # One-way move.
                            if len(df_j) < int(MAX_STOPS_PER_DAY) and (len(df_i) - 1) >= min_keep_i:
                                if not _row_can_join_route(row_i_s, df_j):
                                    pass
                                else:
                                    df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                    df_j2 = _insert_row_best_position(df_j, row_i, matrix_minutes=matrix_minutes)
                                    df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                    df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

                                    d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                                    d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                                    if d_i2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6 and d_j2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                        before_size = abs(len(df_i) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j) - int(TARGET_STOPS_PER_DAY))
                                        after_size = abs(len(df_i2) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j2) - int(TARGET_STOPS_PER_DAY))
                                        size_delta = float(after_size - before_size)
                                        drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                                        score = float(drive_delta) + (0.12 * size_delta) - (3.00 * gain)
                                        if best_score is None or score < best_score:
                                            best_score = float(score)
                                            best_action = {
                                                "kind": "move",
                                                "i": int(i),
                                                "j": int(j),
                                                "df_i2": df_i2,
                                                "df_j2": df_j2,
                                                "gain_value": float(gain),
                                            }

                            # 1-for-1 swap with best candidate stops from destination.
                            c_i_lat = float(st_i["c_lat"])
                            c_i_lng = float(st_i["c_lng"])
                            c_j_lat = float(st_j["c_lat"])
                            c_j_lng = float(st_j["c_lng"])
                            swap_rank = []
                            for pos_j in range(len(df_j)):
                                row_j = df_j.iloc[int(pos_j)]
                                lat_j = float(row_j["lat"])
                                lng_j = float(row_j["lng"])
                                d_j_own = float(_haversine_miles(lat_j, lng_j, c_j_lat, c_j_lng))
                                d_j_to_i = float(_haversine_miles(lat_j, lng_j, c_i_lat, c_i_lng))
                                gain_j = float(d_j_own - d_j_to_i)
                                swap_rank.append((gain_j, int(pos_j)))
                            swap_rank.sort(reverse=True)

                            for gain_j, pos_j in swap_rank[: int(MISFIT_MAX_SWAP_CANDIDATES)]:
                                combined_gain = float(gain + max(0.0, float(gain_j)))
                                if combined_gain < (0.75 * float(MISFIT_GAIN_THRESHOLD_MI)):
                                    continue
                                row_j_df = df_j.iloc[[int(pos_j)]].copy().reset_index(drop=True)
                                row_j_s = row_j_df.iloc[0]
                                if (not _row_can_join_route(row_i_s, df_j)) or (not _row_can_join_route(row_j_s, df_i)):
                                    continue

                                df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                df_j2 = df_j.drop(df_j.index[int(pos_j)]).reset_index(drop=True)
                                df_i2 = _insert_row_best_position(df_i2, row_j_df, matrix_minutes=matrix_minutes)
                                df_j2 = _insert_row_best_position(df_j2, row_i, matrix_minutes=matrix_minutes)
                                df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

                                d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                                d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                                if d_i2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6 or d_j2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                    continue

                                before_size = abs(len(df_i) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j) - int(TARGET_STOPS_PER_DAY))
                                after_size = abs(len(df_i2) - int(TARGET_STOPS_PER_DAY)) + abs(len(df_j2) - int(TARGET_STOPS_PER_DAY))
                                size_delta = float(after_size - before_size)
                                drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                                score = float(drive_delta) + (0.06 * size_delta) - (2.50 * combined_gain)

                                if best_score is None or score < best_score:
                                    best_score = float(score)
                                    best_action = {
                                        "kind": "swap",
                                        "i": int(i),
                                        "j": int(j),
                                        "df_i2": df_i2,
                                        "df_j2": df_j2,
                                        "gain_value": float(combined_gain),
                                    }

                        if best_action is None:
                            break
                        if best_score is None:
                            break
                        best_gain = float(best_action.get("gain_value", 0.0))
                        if best_score >= -0.02 and not (best_gain >= 2.0 and best_score <= 5.0):
                            break

                        tech_route_plans[best_action["i"]]["chunk_df"] = best_action["df_i2"]
                        tech_route_plans[best_action["j"]]["chunk_df"] = best_action["df_j2"]

                # Last-mile severe-misfit cleanup:
                # aggressively fix only the largest cross-route misplacements.
                severe_iters = 0
                while severe_iters < int(SEVERE_MISFIT_MAX_ITERS):
                    severe_iters += 1
                    if _global_time_exceeded():
                        break

                    route_stats = {}
                    assigned_keys = []
                    for k, pk in enumerate(tech_route_plans):
                        if pk["status"] != "ASSIGNED":
                            continue
                        dpk = pk["chunk_df"]
                        if len(dpk) == 0:
                            continue
                        c_lat, c_lng = _route_centroid(dpk)
                        route_stats[k] = {
                            "c_lat": float(c_lat),
                            "c_lng": float(c_lng),
                            "drive": float(_chunk_matrix_drive_minutes(dpk, matrix_minutes=matrix_minutes)),
                        }
                        assigned_keys.append(int(k))

                    if len(assigned_keys) < 2:
                        break

                    severe_candidates = []
                    for i in assigned_keys:
                        if _global_time_exceeded():
                            break
                        df_i = tech_route_plans[i]["chunk_df"]
                        c_i_lat = float(route_stats[i]["c_lat"])
                        c_i_lng = float(route_stats[i]["c_lng"])
                        for pos in range(len(df_i)):
                            if _global_time_exceeded():
                                break
                            row = df_i.iloc[int(pos)]
                            lat = float(row["lat"])
                            lng = float(row["lng"])
                            own_d = float(_haversine_miles(lat, lng, c_i_lat, c_i_lng))
                            dest_rank = []
                            for j in assigned_keys:
                                if j == i:
                                    continue
                                df_j = tech_route_plans[j]["chunk_df"]
                                if not _row_can_join_route(row, df_j):
                                    continue
                                d_other = float(
                                    _haversine_miles(lat, lng, float(route_stats[j]["c_lat"]), float(route_stats[j]["c_lng"]))
                                )
                                prefer = 0 if len(df_j) < int(MAX_STOPS_PER_DAY) else 1
                                dest_rank.append((int(prefer), float(d_other), int(j)))

                            if not dest_rank:
                                continue
                            dest_rank.sort(key=lambda x: (int(x[0]), float(x[1]), int(x[2])))
                            for _, d_other, best_j in dest_rank[: int(SEVERE_MISFIT_MAX_DEST_CANDIDATES)]:
                                gain = float(own_d - float(d_other))
                                if gain < float(SEVERE_MISFIT_GAIN_MI):
                                    continue
                                severe_candidates.append(
                                    {
                                        "gain": float(gain),
                                        "i": int(i),
                                        "j": int(best_j),
                                        "pos": int(pos),
                                    }
                                )

                    if not severe_candidates:
                        break

                    severe_candidates.sort(
                        key=lambda x: (float(x.get("gain", 0.0)), -int(x.get("i", 0)), -int(x.get("pos", 0))),
                        reverse=True,
                    )

                    applied_action = None
                    for severe in severe_candidates:
                        if _global_time_exceeded():
                            break
                        i = int(severe["i"])
                        j = int(severe["j"])
                        pos = int(severe["pos"])
                        gain = float(severe["gain"])

                        if i not in route_stats or j not in route_stats:
                            continue
                        df_i = tech_route_plans[i]["chunk_df"]
                        df_j = tech_route_plans[j]["chunk_df"]
                        if pos >= len(df_i):
                            continue

                        d_i = float(route_stats[i]["drive"])
                        d_j = float(route_stats[j]["drive"])
                        min_keep_i = int(_route_min_keep_stops(tech_route_plans[i], df_i))
                        row_i = df_i.iloc[[int(pos)]].copy().reset_index(drop=True)
                        row_i_s = row_i.iloc[0]

                        best_action = None
                        best_gain_score = None

                        # Move if destination has space.
                        if len(df_j) < int(MAX_STOPS_PER_DAY) and (len(df_i) - 1) >= min_keep_i:
                            if _row_can_join_route(row_i_s, df_j):
                                df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                df_j2 = _insert_row_best_position(df_j, row_i, matrix_minutes=matrix_minutes)
                                df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                                d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                                if d_i2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6 and d_j2 <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                    drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                                    if drive_delta <= float(SEVERE_MISFIT_MAX_DRIVE_DELTA):
                                        gain_score = float(gain - (0.12 * drive_delta))
                                        best_gain_score = float(gain_score)
                                        best_action = {"i": int(i), "j": int(j), "df_i2": df_i2, "df_j2": df_j2}

                        # Try swaps even when destination is full.
                        c_i_lat = float(route_stats[i]["c_lat"])
                        c_i_lng = float(route_stats[i]["c_lng"])
                        c_j_lat = float(route_stats[j]["c_lat"])
                        c_j_lng = float(route_stats[j]["c_lng"])
                        swap_rank = []
                        for pos_j in range(len(df_j)):
                            if _global_time_exceeded():
                                break
                            row_j = df_j.iloc[int(pos_j)]
                            lat_j = float(row_j["lat"])
                            lng_j = float(row_j["lng"])
                            d_j_own = float(_haversine_miles(lat_j, lng_j, c_j_lat, c_j_lng))
                            d_j_to_i = float(_haversine_miles(lat_j, lng_j, c_i_lat, c_i_lng))
                            swap_rank.append((float(d_j_own - d_j_to_i), int(pos_j)))
                        swap_rank.sort(reverse=True)
                        for _, pos_j in swap_rank:
                            row_j_df = df_j.iloc[[int(pos_j)]].copy().reset_index(drop=True)
                            row_j_s = row_j_df.iloc[0]
                            if (not _row_can_join_route(row_i_s, df_j)) or (not _row_can_join_route(row_j_s, df_i)):
                                continue
                            df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                            df_j2 = df_j.drop(df_j.index[int(pos_j)]).reset_index(drop=True)
                            df_i2 = _insert_row_best_position(df_i2, row_j_df, matrix_minutes=matrix_minutes)
                            df_j2 = _insert_row_best_position(df_j2, row_i, matrix_minutes=matrix_minutes)
                            df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                            df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                            d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                            d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                            if d_i2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6 or d_j2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                continue
                            drive_delta = float((d_i2 + d_j2) - (d_i + d_j))
                            if drive_delta > float(SEVERE_MISFIT_MAX_DRIVE_DELTA):
                                continue
                            gain_score = float(gain - (0.10 * drive_delta))
                            if best_gain_score is None or gain_score > best_gain_score:
                                best_gain_score = float(gain_score)
                                best_action = {"i": int(i), "j": int(j), "df_i2": df_i2, "df_j2": df_j2}

                        # 3-route relocation: free one slot in destination route and place
                        # the displaced stop into a nearby compatible route with capacity.
                        if (
                            best_action is None
                            and len(df_j) >= int(MAX_STOPS_PER_DAY)
                            and (len(df_i) - 1) >= min_keep_i
                            and _row_can_join_route(row_i_s, df_j)
                        ):
                            d_i_base = float(d_i)
                            d_j_base = float(d_j)
                            for _, pos_j in swap_rank[: int(SEVERE_CHAIN_MAX_SWAP_CANDIDATES)]:
                                row_j_df = df_j.iloc[[int(pos_j)]].copy().reset_index(drop=True)
                                row_j_s = row_j_df.iloc[0]
                                lat_j = float(row_j_s["lat"])
                                lng_j = float(row_j_s["lng"])

                                k_rank = []
                                for k in assigned_keys:
                                    if k == i or k == j:
                                        continue
                                    df_k = tech_route_plans[k]["chunk_df"]
                                    if len(df_k) >= int(MAX_STOPS_PER_DAY):
                                        continue
                                    if not _row_can_join_route(row_j_s, df_k):
                                        continue
                                    d_to_k = float(
                                        _haversine_miles(
                                            lat_j,
                                            lng_j,
                                            float(route_stats[k]["c_lat"]),
                                            float(route_stats[k]["c_lng"]),
                                        )
                                    )
                                    k_rank.append((float(d_to_k), int(k)))

                                if not k_rank:
                                    continue
                                k_rank.sort(key=lambda x: (float(x[0]), int(x[1])))

                                for _, k in k_rank[: int(SEVERE_CHAIN_MAX_RECEIVER_CANDIDATES)]:
                                    if _global_time_exceeded():
                                        break
                                    df_k = tech_route_plans[k]["chunk_df"]
                                    d_k_base = float(route_stats[k]["drive"])

                                    df_i2 = df_i.drop(df_i.index[int(pos)]).reset_index(drop=True)
                                    df_j2 = df_j.drop(df_j.index[int(pos_j)]).reset_index(drop=True)
                                    df_k2 = df_k.copy().reset_index(drop=True)

                                    df_j2 = _insert_row_best_position(df_j2, row_i, matrix_minutes=matrix_minutes)
                                    df_k2 = _insert_row_best_position(df_k2, row_j_df, matrix_minutes=matrix_minutes)

                                    df_i2 = _optimize_chunk_sequence_matrix(df_i2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                    df_j2 = _optimize_chunk_sequence_matrix(df_j2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)
                                    df_k2 = _optimize_chunk_sequence_matrix(df_k2, matrix_minutes=matrix_minutes, hub_lat=hub_lat, hub_lng=hub_lng)

                                    d_i2 = float(_chunk_matrix_drive_minutes(df_i2, matrix_minutes=matrix_minutes))
                                    d_j2 = float(_chunk_matrix_drive_minutes(df_j2, matrix_minutes=matrix_minutes))
                                    d_k2 = float(_chunk_matrix_drive_minutes(df_k2, matrix_minutes=matrix_minutes))
                                    if (
                                        d_i2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6
                                        or d_j2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6
                                        or d_k2 > float(MAX_ROUTE_DRIVE_MIN) + 1e-6
                                    ):
                                        continue

                                    drive_delta = float((d_i2 + d_j2 + d_k2) - (d_i_base + d_j_base + d_k_base))
                                    if drive_delta > float(SEVERE_MISFIT_MAX_DRIVE_DELTA) * 1.15:
                                        continue

                                    gain_score = float(gain - (0.08 * drive_delta))
                                    if best_gain_score is None or gain_score > best_gain_score:
                                        best_gain_score = float(gain_score)
                                        best_action = {
                                            "i": int(i),
                                            "j": int(j),
                                            "k": int(k),
                                            "df_i2": df_i2,
                                            "df_j2": df_j2,
                                            "df_k2": df_k2,
                                        }

                        if best_action is not None:
                            applied_action = dict(best_action)
                            break

                    if applied_action is None:
                        break
                    tech_route_plans[applied_action["i"]]["chunk_df"] = applied_action["df_i2"]
                    tech_route_plans[applied_action["j"]]["chunk_df"] = applied_action["df_j2"]
                    if "k" in applied_action:
                        tech_route_plans[int(applied_action["k"])]["chunk_df"] = applied_action["df_k2"]

                if SLOT_REASSIGN_ENABLED:
                    _slot_reassign_assigned_routes(
                        tech_route_plans,
                        matrix_minutes=matrix_minutes,
                        hub_lat=hub_lat,
                        hub_lng=hub_lng,
                        max_drive=float(MAX_ROUTE_DRIVE_MIN),
                    )
                if ENDPOINT_CLEANUP_ENABLED:
                    _endpoint_cleanup_assigned_routes(
                        tech_route_plans,
                        matrix_minutes=matrix_minutes,
                        hub_lat=hub_lat,
                        hub_lng=hub_lng,
                        max_drive=float(MAX_ROUTE_DRIVE_MIN),
                    )
                _merge_tiny_assigned_routes(
                    tech_route_plans,
                    matrix_minutes=matrix_minutes,
                    hub_lat=hub_lat,
                    hub_lng=hub_lng,
                    max_drive=float(MAX_ROUTE_DRIVE_MIN),
                )

                for plan in tech_route_plans:
                    chunk_df = plan["chunk_df"].copy().reset_index(drop=True)
                    if len(chunk_df) == 0:
                        continue
                    route_num = int(plan["route_num"])
                    day_idx = plan["day_idx"]
                    day_date = plan["day_date"]
                    day_type = str(plan["day_type"])
                    status = str(plan["status"])

                    route_drive_matrix = float(_chunk_matrix_drive_minutes(chunk_df, matrix_minutes=matrix_minutes))
                    fallback_edges = int(_chunk_fallback_edges(chunk_df, fallback_mask=fallback_mask))
                    route_remote = bool(chunk_df.get("isRemote", pd.Series(dtype=bool)).any())

                    cap_reason = str(plan.get("capacity_reason", "") or "")
                    if status == "ASSIGNED":
                        if route_drive_matrix > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                            cap_reason = "DRIVE_PREF_EXCEEDED_MATRIX"
                        elif len(chunk_df) < int(MIN_STOPS_PER_DAY):
                            cap_reason = "HARD_CAP_SPLIT"
                        else:
                            cap_reason = cap_reason if cap_reason == "HARD_CAP_SPLIT" else ""

                    if status == "ASSIGNED":
                        route_name = _format_assigned_route_name(str(tech), day_date, day_idx, route_num)
                        assignment_reason = "HARD_CAP_SPLIT" if cap_reason == "HARD_CAP_SPLIT" else ("REMOTE_HARD" if route_remote else "LOCAL_BALANCE")
                        drive_model = "FALLBACK_APPROX" if fallback_edges > 0 else "OSRM_MATRIX_STRICT"
                    elif status == "QUALITY_OVERFLOW":
                        route_name = f"{tech} — UNASSIGNED (quality overflow) — Route {route_num}"
                        assignment_reason = "QUALITY_OVERFLOW"
                        drive_model = "FALLBACK_APPROX" if fallback_edges > 0 else "OSRM_MATRIX_STRICT"
                    else:
                        route_name = f"{tech} — UNASSIGNED (need more capacity) — Route {route_num}"
                        assignment_reason = "OVERFLOW_UNASSIGNED"
                        drive_model = "OVERFLOW_CAPACITY"
                        cap_reason = "MONTH_CAPACITY_EXHAUSTED"

                    chunk_df["routeIndex"] = day_idx
                    chunk_df["routeDate"] = day_date
                    chunk_df["routeName"] = route_name
                    chunk_df["dayType"] = day_type
                    chunk_df["capacityReason"] = cap_reason
                    chunk_df["driveModel"] = drive_model
                    chunk_df["assignmentReason"] = assignment_reason
                    chunk_df["sequenceStrategy"] = "GLOBAL_CHAIN_ZONE_BLOCKS"
                    chunk_df["routeDriveMinutesMatrix"] = route_drive_matrix
                    chunk_df["sequence"] = np.arange(1, len(chunk_df) + 1)

                    route_rows.append(chunk_df)

                if progress_path:
                    _progress_update(progress_path, _with_eta({
                        "status": "running",
                        "stage": "tech_routes_built",
                        "message": f"Built {len(slices)} route(s) for tech {tech}",
                        "tech": str(tech),
                        "techRoutes": int(len(slices)),
                        "weekdayDays": int(len(weekdays)),
                        "saturdayOverflowDays": int(len(saturdays)),
                        "matrixBuildSec": round(float(matrix_build_sec), 2),
                        "chainBuildSec": round(float(chain_build_sec), 2),
                        "sliceSec": round(float(slice_sec), 2),
                        "matrixCacheUsed": bool(matrix_info.get("cache_used", False)),
                        "matrixUnresolvedPairs": int(unresolved_pairs),
                        "matrixCoverage": round(float(matrix_cov), 4),
                    }, processed_techs=int(tech_i), total_techs=total_techs))
                continue

            tech_df["serviceMonth"] = tech_df["serviceDue"].dt.to_period("M").astype(str)
            month_tokens = sorted({str(x) for x in tech_df["serviceMonth"].dropna().tolist() if str(x).strip()})
            target_month = month_tokens[0] if month_tokens else pd.Timestamp.today().strftime("%Y-%m")

            month_start = pd.Timestamp(f"{target_month}-01").date()
            month_end = (
                pd.Timestamp(month_start)
                + pd.offsets.MonthEnd(max(1, int(PLANNING_HORIZON_MONTHS)))
            ).date()

            weekdays, saturdays = _build_dates_for_month(month_start, month_end)
            month_days = list(weekdays) + list(saturdays)
            if len(month_days) == 0:
                fallback_weekdays, fallback_saturdays = _build_dates_for_month(month_start, month_start + timedelta(days=40))
                month_days = list(fallback_weekdays) + list(fallback_saturdays)

            max_working_days = int(
                max(
                    1,
                    (int(MAX_WORKING_DAYS) * max(1, int(PLANNING_HORIZON_MONTHS))) + int(len(saturdays)),
                )
            )
            day_dates = month_days[:max_working_days]
            if len(day_dates) == 0:
                day_dates = [month_start]

            total_stops = int(len(tech_df))
            cap_needed = int(np.ceil(total_stops / max(1, len(day_dates))))
            stop_cap = int(min(MAX_STOPS_PER_ROUTE, max(STOPS_PER_ROUTE, cap_needed)))
            target_total_routes = int(np.ceil(total_stops / max(1, STOPS_PER_ROUTE)))
            route_count = int(np.ceil(total_stops / stop_cap))

            if route_count > len(day_dates):
                required_techs_for_this = int(np.ceil(total_stops / (len(day_dates) * MAX_STOPS_PER_ROUTE)))
                extra = max(0, required_techs_for_this - 1)
                staffing_warnings.append(
                    {
                        "tech": str(tech),
                        "month": str(target_month),
                        "stops": total_stops,
                        "working_days": int(len(day_dates)),
                        "max_stops_per_day": int(MAX_STOPS_PER_ROUTE),
                        "routes_needed_at_max": int(np.ceil(total_stops / MAX_STOPS_PER_ROUTE)),
                        "extra_techs_needed": int(extra),
                    }
                )

            tech_chunks = []
            route_number = 1
            tech_started_at = time.time()
            hub_lat = float(tech_df["lat"].astype(float).mean())
            hub_lng = float(tech_df["lng"].astype(float).mean())

            tech_df["hubMiles"] = tech_df.apply(
                lambda r: _haversine_miles(float(r["lat"]), float(r["lng"]), hub_lat, hub_lng),
                axis=1,
            )
            q_far = float(tech_df["hubMiles"].quantile(REMOTE_OUTLIER_QUANTILE)) if len(tech_df) else 0.0
            far_cut = max(float(REMOTE_OUTLIER_MIN_MILES), q_far)
            dynamic_remote = tech_df["hubMiles"].astype(float) >= far_cut
            tech_df.loc[dynamic_remote & tech_df["remoteZone"].isna(), "remoteZone"] = "FAR_OUTLIER"
            tech_df.loc[dynamic_remote & tech_df["remoteBucket"].isna(), "remoteBucket"] = "FAR_OUTLIER"
            tech_df["isRemote"] = tech_df["remoteZone"].notna()
            tech_df["assignmentReason"] = np.where(tech_df["isRemote"], "REMOTE_HARD", "LOCAL_BALANCE")
            tech_df["sequenceStrategy"] = np.where(tech_df["isRemote"], "REMOTE_TO_CORE", "FARTHEST_TO_CORE")

            tech_remote = tech_df[tech_df["isRemote"]].copy().reset_index(drop=True)
            tech_local = tech_df[~tech_df["isRemote"]].copy().reset_index(drop=True)
            remote_stop_cap = int(min(MAX_STOPS_PER_ROUTE, max(STOPS_PER_ROUTE, REMOTE_STOP_CAP)))

            remote_chunks, route_number = _chunk_subset(
                tech_remote,
                route_number_start=route_number,
                stop_cap=remote_stop_cap,
                hub_lat=hub_lat,
                hub_lng=hub_lng,
                assignment_reason="REMOTE_HARD",
                sequence_strategy="REMOTE_TO_CORE",
            )
            tech_chunks.extend(remote_chunks)

            local_stop_cap = int(stop_cap)
            if len(tech_local) > 0:
                desired_local_routes = max(1, int(target_total_routes - len(remote_chunks)))
                local_cap_needed = int(np.ceil(len(tech_local) / max(1, desired_local_routes)))
                local_stop_cap = int(min(MAX_STOPS_PER_ROUTE, max(STOPS_PER_ROUTE, local_cap_needed)))

            local_chunks, route_number = _chunk_subset(
                tech_local,
                route_number_start=route_number,
                stop_cap=local_stop_cap,
                hub_lat=hub_lat,
                hub_lng=hub_lng,
                assignment_reason="LOCAL_BALANCE",
                sequence_strategy="FARTHEST_TO_CORE",
            )
            tech_chunks.extend(local_chunks)

            if len(tech_chunks) > len(day_dates):

                def _try_merge_chunks(chunks_tuples):
                    changed = True
                    while changed and len(chunks_tuples) > len(day_dates):
                        changed = False
                        chunks_tuples = sorted(chunks_tuples, key=lambda t: len(t[2]))

                        for i, (a_small, rn_small, df_small) in enumerate(chunks_tuples):
                            small_n = len(df_small)
                            best_j = None
                            best_diff = None
                            for j, (a_big, rn_big, df_big) in enumerate(chunks_tuples):
                                if j == i:
                                    continue
                                if REMOTE_STRICT:
                                    small_remote = bool(df_small.get("isRemote", pd.Series(dtype=bool)).any())
                                    big_remote = bool(df_big.get("isRemote", pd.Series(dtype=bool)).any())
                                    if small_remote != big_remote:
                                        continue
                                    if small_remote and big_remote:
                                        z_small = df_small["remoteBucket"].dropna()
                                        z_big = df_big["remoteBucket"].dropna()
                                        p_small = str(z_small.mode().iloc[0]) if len(z_small) else None
                                        p_big = str(z_big.mode().iloc[0]) if len(z_big) else None
                                        if p_small is not None and p_big is not None and p_small != p_big:
                                            continue
                                if len(df_big) + small_n <= MAX_STOPS_PER_ROUTE:
                                    diff = abs((a_big - a_small).days)
                                    if best_diff is None or diff < best_diff:
                                        best_diff = diff
                                        best_j = j

                            if best_j is not None:
                                a_big, rn_big, df_big = chunks_tuples[best_j]
                                merged = pd.concat([df_big, df_small], ignore_index=True).reset_index(drop=True)
                                if bool(merged["isRemote"].any()):
                                    merged = order_points_remote_to_core(merged, hub_lat=hub_lat, hub_lng=hub_lng)
                                else:
                                    merged = order_points_drive_min(merged)
                                new_anchor = a_big if a_big <= a_small else a_small

                                keep = []
                                for k, t in enumerate(chunks_tuples):
                                    if k not in (i, best_j):
                                        keep.append(t)
                                keep.append((new_anchor, rn_big, merged))
                                chunks_tuples = keep
                                changed = True
                                break

                    return chunks_tuples

                tech_chunks = _try_merge_chunks(tech_chunks)

                if len(tech_chunks) > len(day_dates):
                    staffing_warnings.append(
                        {
                            "tech": str(tech),
                            "month": str(target_month),
                            "stops": int(total_stops),
                            "working_days": int(len(day_dates)),
                            "max_stops_per_day": int(MAX_STOPS_PER_ROUTE),
                            "routes_needed_at_max": int(len(tech_chunks)),
                            "extra_techs_needed": int(
                                max(0, int(np.ceil(total_stops / (len(day_dates) * MAX_STOPS_PER_ROUTE))) - 1)
                            ),
                        }
                    )

            if len(tech_chunks) == 0:
                continue

            tech_chunks = sorted(tech_chunks, key=lambda t: t[0])

            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "tech_routes_built",
                    "message": f"Built {len(tech_chunks)} route(s) for tech {tech}",
                    "tech": str(tech),
                    "techRoutes": int(len(tech_chunks)),
                    "workingDays": int(len(day_dates)),
                }, processed_techs=int(tech_i), total_techs=total_techs))

            def _chunk_drive_minutes(df_pts: pd.DataFrame, *, fast: bool = False) -> float:
                pts = list(zip(df_pts["lat"].astype(float), df_pts["lng"].astype(float)))
                if strict_osrm_for_run:
                    if fast:
                        return float(route_drive_minutes_from_points_fast(pts))
                    mins = route_drive_minutes_from_points_osrm_only(pts)
                    if mins is None:
                        return float(OSRM_UNAVAILABLE_PENALTY_MIN)
                    return float(mins)
                if fast:
                    return float(route_drive_minutes_from_points_fast(pts))
                return float(route_drive_minutes_from_points(pts))

            def _chunk_centroid(df_pts: pd.DataFrame):
                return (float(df_pts["lat"].mean()), float(df_pts["lng"].mean()))

            tech_center = (float(tech_df["lat"].mean()), float(tech_df["lng"].mean()))

            def _route_remoteness_miles(df_pts: pd.DataFrame) -> float:
                """Distance of a route centroid from the tech's monthly working core."""
                c_lat, c_lng = _chunk_centroid(df_pts)
                return float(_haversine_miles(tech_center[0], tech_center[1], c_lat, c_lng))

            def _point_attach_minutes(row_df: pd.DataFrame, df_pts: pd.DataFrame) -> float:
                """Approx minutes from moved stop to destination route centroid."""
                if len(df_pts) == 0:
                    return 0.0
                c_lat, c_lng = _chunk_centroid(df_pts)
                r_lat = float(row_df["lat"].iloc[0])
                r_lng = float(row_df["lng"].iloc[0])
                return float(approx_leg_minutes(r_lat, r_lng, c_lat, c_lng))

            def _worst_outlier_index(df_pts: pd.DataFrame):
                """Pick the stop whose removal most reduces route drive time (approx)."""
                if len(df_pts) <= 2:
                    return 0

                pts = list(zip(df_pts["lat"].astype(float), df_pts["lng"].astype(float)))

                def leg(a, b):
                    return float(approx_leg_minutes(a[0], a[1], b[0], b[1]))

                best_i = 0
                best_delta = -1.0

                for i in range(len(pts)):
                    if i == 0:
                        # removing first removes leg (0->1)
                        delta = leg(pts[0], pts[1])
                    elif i == len(pts) - 1:
                        # removing last removes leg (n-2->n-1)
                        delta = leg(pts[-2], pts[-1])
                    else:
                        prevp = pts[i - 1]
                        curp = pts[i]
                        nextp = pts[i + 1]
                        # removal replaces prev->cur + cur->next with prev->next
                        delta = (leg(prevp, curp) + leg(curp, nextp)) - leg(prevp, nextp)

                    if delta > best_delta:
                        best_delta = float(delta)
                        best_i = int(i)

                return int(best_i)

            def _is_chunk_remote(df_pts: pd.DataFrame) -> bool:
                return bool(df_pts.get("isRemote", pd.Series(dtype=bool)).any())

            def _chunk_primary_zone(df_pts: pd.DataFrame) -> Optional[str]:
                zone_col = "remoteBucket" if "remoteBucket" in df_pts.columns else "remoteZone"
                if zone_col not in df_pts.columns:
                    return None
                z = df_pts[zone_col].dropna()
                if len(z) == 0:
                    return None
                return str(z.mode().iloc[0])

            def _chunk_bucket_set(df_pts: pd.DataFrame):
                if "remoteBucket" not in df_pts.columns:
                    return set()
                return {str(x) for x in df_pts["remoteBucket"].dropna().tolist()}

            def _beaver_mix_violation(df_pts: pd.DataFrame) -> bool:
                b = _chunk_bucket_set(df_pts)
                return ("EAST_OF_BEAVER_LAKE_NORTH" in b) and ("EAST_OF_BEAVER_LAKE_SOUTH" in b)

            def _south_prairie_mix_violation(df_pts: pd.DataFrame) -> bool:
                b = _chunk_bucket_set(df_pts)
                return ("SOUTH_OF_PRAIRIE_GROVE_EAST" in b) and ("SOUTH_OF_PRAIRIE_GROVE_WEST" in b)

            def _bucket_compatible(df_a: pd.DataFrame, df_b: pd.DataFrame) -> bool:
                if not REMOTE_STRICT:
                    return True
                if not (_is_chunk_remote(df_a) and _is_chunk_remote(df_b)):
                    return True
                return _chunk_primary_zone(df_a) == _chunk_primary_zone(df_b)

            def _chunk_mean_angle(df_pts: pd.DataFrame) -> float:
                if len(df_pts) == 0:
                    return 0.0
                lats = df_pts["lat"].astype(float).to_numpy()
                lngs = df_pts["lng"].astype(float).to_numpy()
                angs = np.array([math.atan2(lat - hub_lat, lng - hub_lng) for lat, lng in zip(lats, lngs)], dtype=float)
                s = float(np.sin(angs).mean())
                c = float(np.cos(angs).mean())
                return float(math.atan2(s, c))

            def _angle_diff(a: float, b: float) -> float:
                d = abs(a - b)
                return float(min(d, (2.0 * math.pi) - d))

            def _chunk_angle_span_rad(df_pts: pd.DataFrame) -> float:
                if len(df_pts) <= 2:
                    return 0.0
                lats = df_pts["lat"].astype(float).to_numpy()
                lngs = df_pts["lng"].astype(float).to_numpy()
                angs = np.array([math.atan2(lat - hub_lat, lng - hub_lng) for lat, lng in zip(lats, lngs)], dtype=float)
                angs = np.where(angs < 0.0, angs + (2.0 * math.pi), angs)
                aa = np.sort(angs)
                gaps = np.diff(np.concatenate([aa, [aa[0] + (2.0 * math.pi)]]))
                return float((2.0 * math.pi) - float(np.max(gaps)))

            def _chunk_loop_ratio(df_pts: pd.DataFrame) -> float:
                if len(df_pts) <= 2:
                    return 1.0
                tmp = _reorder_chunk(df_pts)
                pts = tmp[["lat", "lng"]].astype(float).to_numpy()
                start_end = float(_haversine_miles(pts[0, 0], pts[0, 1], pts[-1, 0], pts[-1, 1]))
                max_pair = 0.0
                for i in range(len(pts)):
                    for j in range(i + 1, len(pts)):
                        d = float(_haversine_miles(pts[i, 0], pts[i, 1], pts[j, 0], pts[j, 1]))
                        if d > max_pair:
                            max_pair = d
                if max_pair <= 1e-9:
                    return 1.0
                return float(start_end / max_pair)

            def _chunk_diameter_miles(df_pts: pd.DataFrame) -> float:
                if len(df_pts) <= 1:
                    return 0.0
                pts = df_pts[["lat", "lng"]].astype(float).to_numpy()
                diam = 0.0
                for i in range(len(pts)):
                    for j in range(i + 1, len(pts)):
                        d = float(_haversine_miles(pts[i, 0], pts[i, 1], pts[j, 0], pts[j, 1]))
                        if d > diam:
                            diam = d
                return float(diam)

            def _preferred_drive_target(df_pts: pd.DataFrame) -> float:
                return float(PREFERRED_ROUTE_DRIVE_MIN_REMOTE if _is_chunk_remote(df_pts) else PREFERRED_ROUTE_DRIVE_MIN_LOCAL)

            def _diameter_cap(df_pts: pd.DataFrame) -> float:
                return float(MAX_ROUTE_DIAMETER_MI_REMOTE if _is_chunk_remote(df_pts) else MAX_ROUTE_DIAMETER_MI_LOCAL)

            def _chunk_quality_violations(df_pts: pd.DataFrame):
                out = []
                # Keep iterative quality passes fast; strict OSRM validation is
                # enforced in the final pre-export fail-fast gate.
                drive = float(_chunk_drive_minutes(df_pts, fast=True))
                if drive > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                    out.append("DRIVE_CAP")
                self_cross_limit = int(max(MAX_ROUTE_SELF_INTERSECTIONS, SOFT_GEOMETRY_SELF_CROSS_TOLERANCE))
                if _polyline_self_intersections(list(zip(df_pts["lat"].astype(float), df_pts["lng"].astype(float)))) > self_cross_limit:
                    out.append("SELF_CROSS")
                # Soft quality rules only trigger if route is clearly pathological.
                if _chunk_loop_ratio(df_pts) < float(MIN_LOOP_OPEN_RATIO) * 0.75:
                    out.append("LOOP")
                if _chunk_angle_span_rad(df_pts) > math.radians(float(MAX_ROUTE_ANGLE_SPAN_DEG) + 20.0) + 1e-9:
                    out.append("ANGLE_SPAN")
                if _chunk_diameter_miles(df_pts) > float(_diameter_cap(df_pts)) * 1.6 + 1e-6:
                    out.append("DIAMETER")
                if _beaver_mix_violation(df_pts):
                    out.append("LAKE_MIX")
                if _south_prairie_mix_violation(df_pts):
                    out.append("SOUTH_MIX")
                return out

            def _split_chunk_by_angle(df_pts: pd.DataFrame):
                if len(df_pts) <= 3:
                    return None
                tmp = df_pts.copy().reset_index(drop=True)
                lats = tmp["lat"].astype(float).to_numpy()
                lngs = tmp["lng"].astype(float).to_numpy()
                angs = np.array([math.atan2(lat - hub_lat, lng - hub_lng) for lat, lng in zip(lats, lngs)], dtype=float)
                angs = np.where(angs < 0.0, angs + (2.0 * math.pi), angs)
                ord_idx = np.argsort(angs)
                ord_ang = angs[ord_idx]
                if len(ord_ang) > 1:
                    gaps = np.diff(np.concatenate([ord_ang, [ord_ang[0] + (2.0 * math.pi)]]))
                    cut = int(np.argmax(gaps))
                    chain = list(ord_idx[cut + 1 :]) + list(ord_idx[: cut + 1])
                else:
                    chain = list(ord_idx)

                k = len(chain) // 2
                if k <= 0 or k >= len(chain):
                    return None
                a_idx = chain[:k]
                b_idx = chain[k:]
                a = tmp.iloc[a_idx].copy().reset_index(drop=True)
                b = tmp.iloc[b_idx].copy().reset_index(drop=True)
                if len(a) == 0 or len(b) == 0:
                    return None
                return a, b

            def _reorder_chunk(df_pts: pd.DataFrame) -> pd.DataFrame:
                if len(df_pts) <= 1:
                    return df_pts.reset_index(drop=True)
                strat = str(df_pts["sequenceStrategy"].mode().iloc[0]) if "sequenceStrategy" in df_pts.columns else "LOCAL_OPT"
                if strat in ("REMOTE_TO_CORE", "FARTHEST_TO_CORE") or _is_chunk_remote(df_pts):
                    return order_points_remote_to_core(df_pts, hub_lat=hub_lat, hub_lng=hub_lng)
                return order_points_drive_min(df_pts)

            def _try_swap_between_routes(df_a: pd.DataFrame, df_b: pd.DataFrame):
                """Try a 1-for-1 swap that reduces max route drive and preserves remote strictness."""
                if len(df_a) <= 1 or len(df_b) <= 1:
                    return None

                a_remote = _is_chunk_remote(df_a)
                b_remote = _is_chunk_remote(df_b)
                if REMOTE_STRICT and a_remote != b_remote:
                    return None
                if not _bucket_compatible(df_a, df_b):
                    return None

                best = None
                for ia in range(len(df_a)):
                    row_a = df_a.iloc[[ia]].copy().reset_index(drop=True)
                    base_a = df_a.drop(df_a.index[ia]).reset_index(drop=True)
                    for ib in range(len(df_b)):
                        row_b = df_b.iloc[[ib]].copy().reset_index(drop=True)
                        base_b = df_b.drop(df_b.index[ib]).reset_index(drop=True)

                        cand_a = _reorder_chunk(pd.concat([base_a, row_b], ignore_index=True).reset_index(drop=True))
                        cand_b = _reorder_chunk(pd.concat([base_b, row_a], ignore_index=True).reset_index(drop=True))

                        d_a = float(_chunk_drive_minutes(cand_a, fast=True))
                        d_b = float(_chunk_drive_minutes(cand_b, fast=True))
                        max_d = max(d_a, d_b)

                        if max_d > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                            continue

                        score = max_d
                        if best is None or score < best[0]:
                            best = (score, cand_a, cand_b)
                return best

            # --- Drive time enforcement (<= 60 min total per route if possible) ---
            drive_changed = True
            drive_safety = 0
            while drive_changed and drive_safety < MAX_DRIVE_ITERS:
                drive_safety += 1
                drive_changed = False
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break

                # Use fast estimator to find the likely worst route cheaply.
                drives_fast = [(_chunk_drive_minutes(t[2], fast=True)) for t in tech_chunks]
                if not drives_fast:
                    break

                worst_i = int(np.argmax(drives_fast))

                # Confirm worst route with OSRM (single-call per route) so we don't optimize based on a bad estimate.
                worst_drive = float(_chunk_drive_minutes(tech_chunks[worst_i][2], fast=False))
                if worst_drive <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                    break

                a_from, rn_from, df_from = tech_chunks[worst_i]
                if len(df_from) <= MIN_STOPS_PER_ROUTE:
                    break

                move_idx = _worst_outlier_index(df_from)
                row_to_move = df_from.iloc[[move_idx]].copy().reset_index(drop=True)

                best_j = None
                best_new_max = None

                for j, (a_to, rn_to, df_to) in enumerate(tech_chunks):
                    if j == worst_i:
                        continue
                    if len(df_to) >= MAX_STOPS_PER_ROUTE:
                        continue
                    if REMOTE_STRICT and (_is_chunk_remote(df_from) != _is_chunk_remote(df_to)):
                        continue
                    if not _bucket_compatible(df_from, df_to):
                        continue
                    if _angle_diff(_chunk_mean_angle(df_from), _chunk_mean_angle(df_to)) > 1.10 and not _is_chunk_remote(df_from):
                        continue

                    # Pre-score the destination route before adding the outlier
                    d_to_before_fast = _chunk_drive_minutes(df_to, fast=True)
                    dest_remoteness = _route_remoteness_miles(df_to)
                    attach_minutes = _point_attach_minutes(row_to_move, df_to)
                    zone_from = _chunk_primary_zone(df_from)
                    zone_to = _chunk_primary_zone(df_to)

                    df_from2 = df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                    df_to2 = pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)

                    df_from2 = _reorder_chunk(df_from2)
                    df_to2 = _reorder_chunk(df_to2)

                    # Fast score for candidate moves
                    d_from_fast = _chunk_drive_minutes(df_from2, fast=True)
                    d_to_fast = _chunk_drive_minutes(df_to2, fast=True)
                    new_max = max(d_from_fast, d_to_fast)
                    zone_penalty = 0.0
                    if zone_from is not None and zone_to is not None and zone_from != zone_to:
                        zone_penalty = 8.0
                    score = float(new_max) + (0.20 * float(attach_minutes)) - (1.50 * float(dest_remoteness)) + zone_penalty

                    # Prefer concentrating outliers into a few routes:
                    # If the destination route was "good" (well under the limit), heavily penalize making it worse.
                    good_cutoff = float(MAX_ROUTE_DRIVE_MIN) * 0.80
                    if d_to_before_fast <= good_cutoff and d_to_fast > d_to_before_fast + 2.0:
                        score = float(score) + 999.0

                    if best_new_max is None or score < best_new_max:
                        best_new_max = score
                        best_j = j

                if best_j is not None and best_new_max is not None and best_new_max + 1e-6 < worst_drive:
                    a_to, rn_to, df_to = tech_chunks[best_j]

                    df_from2 = df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                    df_to2 = pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)

                    # Prefer a swap over a one-way move when available.
                    swap = _try_swap_between_routes(df_from, df_to)
                    if swap is not None:
                        _, df_from2_swap, df_to2_swap = swap
                        df_from2 = df_from2_swap
                        df_to2 = df_to2_swap
                    else:
                        df_from2 = _reorder_chunk(df_from2)
                        df_to2 = _reorder_chunk(df_to2)

                    # OSRM confirm the candidate move (single-call per route) before committing.
                    d_from_osrm = float(_chunk_drive_minutes(df_from2, fast=False))
                    d_to_osrm = float(_chunk_drive_minutes(df_to2, fast=False))
                    new_max_osrm = max(d_from_osrm, d_to_osrm)

                    if new_max_osrm + 1e-6 < worst_drive:
                        tech_chunks[worst_i] = (a_from, rn_from, df_from2)
                        tech_chunks[best_j] = (a_to, rn_to, df_to2)
                        drive_changed = True
                        continue

                # last resort: split the outlier into its own route (may increase day count)
                df_from2 = df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                df_new = row_to_move.copy().reset_index(drop=True)

                df_from2 = _reorder_chunk(df_from2)
                df_new = _reorder_chunk(df_new)
                df_new["assignmentReason"] = "HARD_CAP_SPLIT"

                new_rn = max([int(t[1]) for t in tech_chunks] + [int(rn_from)]) + 1
                tech_chunks[worst_i] = (a_from, rn_from, df_from2)
                tech_chunks.append((a_from, new_rn, df_new))
                drive_changed = True

            # Optional: quick OSRM verification pass (bounded) for routes still over the limit.
            # This keeps OSRM calls small while still honoring the 60-minute target when possible.
            verify_iters = 0
            while verify_iters < MAX_VERIFY_ITERS:
                verify_iters += 1
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break
                drives_fast = [(_chunk_drive_minutes(t[2], fast=True)) for t in tech_chunks]
                if not drives_fast:
                    break
                worst_i = int(np.argmax(drives_fast))
                worst_drive = float(_chunk_drive_minutes(tech_chunks[worst_i][2], fast=False))
                if worst_drive <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                    break
                if worst_drive >= float(OSRM_UNAVAILABLE_PENALTY_MIN):
                    break

                a_from, rn_from, df_from = tech_chunks[worst_i]
                if len(df_from) <= MIN_STOPS_PER_ROUTE:
                    break

                move_idx = _worst_outlier_index(df_from)
                row_to_move = df_from.iloc[[move_idx]].copy().reset_index(drop=True)

                best_j = None
                best_new_max = None

                for j, (a_to, rn_to, df_to) in enumerate(tech_chunks):
                    if j == worst_i:
                        continue
                    if len(df_to) >= MAX_STOPS_PER_ROUTE:
                        continue
                    if REMOTE_STRICT and (_is_chunk_remote(df_from) != _is_chunk_remote(df_to)):
                        continue
                    if not _bucket_compatible(df_from, df_to):
                        continue
                    if _angle_diff(_chunk_mean_angle(df_from), _chunk_mean_angle(df_to)) > 1.10 and not _is_chunk_remote(df_from):
                        continue

                    dest_remoteness = _route_remoteness_miles(df_to)
                    attach_minutes = _point_attach_minutes(row_to_move, df_to)
                    zone_from = _chunk_primary_zone(df_from)
                    zone_to = _chunk_primary_zone(df_to)

                    df_from2 = df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                    df_to2 = pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)

                    df_from2 = _reorder_chunk(df_from2)
                    df_to2 = _reorder_chunk(df_to2)

                    d_from = _chunk_drive_minutes(df_from2, fast=True)
                    d_to = _chunk_drive_minutes(df_to2, fast=True)
                    new_max = float(max(d_from, d_to))
                    zone_penalty = 0.0
                    if zone_from is not None and zone_to is not None and zone_from != zone_to:
                        zone_penalty = 8.0
                    score = float(new_max) + (0.20 * float(attach_minutes)) - (1.50 * float(dest_remoteness)) + zone_penalty

                    if best_new_max is None or score < best_new_max:
                        best_new_max = score
                        best_j = j

                if best_j is None or best_new_max is None or best_new_max + 1e-6 >= worst_drive:
                    break

                a_to, rn_to, df_to = tech_chunks[best_j]

                df_from2 = df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                df_to2 = pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)

                df_from2 = _reorder_chunk(df_from2)
                df_to2 = _reorder_chunk(df_to2)

                d_from_osrm = float(_chunk_drive_minutes(df_from2, fast=False))
                d_to_osrm = float(_chunk_drive_minutes(df_to2, fast=False))
                new_max_osrm = max(d_from_osrm, d_to_osrm)

                if (
                    d_from_osrm < float(OSRM_UNAVAILABLE_PENALTY_MIN)
                    and d_to_osrm < float(OSRM_UNAVAILABLE_PENALTY_MIN)
                    and new_max_osrm + 1e-6 < worst_drive
                ):
                    tech_chunks[worst_i] = (a_from, rn_from, df_from2)
                    tech_chunks[best_j] = (a_to, rn_to, df_to2)
                else:
                    break

            # Hard enforcement: no route may exceed MAX_ROUTE_DRIVE_MIN.
            # If needed, keep carving out outliers into new routes until every
            # route is <= 60 minutes (stop-to-stop). This intentionally ignores
            # min/max stop-count preferences for this pass.
            hard_iters = 0
            while hard_iters < MAX_HARD_ITERS:
                hard_iters += 1
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break
                if not tech_chunks:
                    break

                drives = [float(_chunk_drive_minutes(t[2], fast=True)) for t in tech_chunks]
                worst_i = int(np.argmax(drives))
                worst_drive = float(_chunk_drive_minutes(tech_chunks[worst_i][2], fast=False))
                if worst_drive <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                    break
                if worst_drive >= float(OSRM_UNAVAILABLE_PENALTY_MIN):
                    break

                a_from, rn_from, df_from = tech_chunks[worst_i]
                if len(df_from) <= 1:
                    # A single-stop route should have 0 stop-to-stop drive.
                    # If this still exceeds the cap, we cannot improve further.
                    break

                move_idx = _worst_outlier_index(df_from)
                row_to_move = df_from.iloc[[move_idx]].copy().reset_index(drop=True)
                df_from2 = _reorder_chunk(
                    df_from.drop(df_from.index[move_idx]).reset_index(drop=True)
                )

                # Try moving this stop to another route if that helps and keeps cap.
                best_j = None
                best_score = None

                for j, (a_to, rn_to, df_to) in enumerate(tech_chunks):
                    if j == worst_i:
                        continue
                    if REMOTE_STRICT and (_is_chunk_remote(df_from) != _is_chunk_remote(df_to)):
                        continue
                    if not _bucket_compatible(df_from, df_to):
                        continue
                    if _angle_diff(_chunk_mean_angle(df_from), _chunk_mean_angle(df_to)) > 1.10 and not _is_chunk_remote(df_from):
                        continue

                    dest_remoteness = _route_remoteness_miles(df_to)
                    attach_minutes = _point_attach_minutes(row_to_move, df_to)
                    zone_from = _chunk_primary_zone(df_from)
                    zone_to = _chunk_primary_zone(df_to)

                    df_to2 = _reorder_chunk(
                        pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)
                    )
                    d_from = float(_chunk_drive_minutes(df_from2, fast=True))
                    d_to = float(_chunk_drive_minutes(df_to2, fast=True))
                    score = float(max(d_from, d_to))

                    if score > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                        continue

                    zone_penalty = 0.0
                    if zone_from is not None and zone_to is not None and zone_from != zone_to:
                        zone_penalty = 8.0
                    score_adj = float(score) + (0.20 * float(attach_minutes)) - (1.50 * float(dest_remoteness)) + zone_penalty
                    if best_score is None or score_adj < best_score:
                        best_score = score_adj
                        best_j = j

                if best_j is not None:
                    a_to, rn_to, df_to = tech_chunks[best_j]
                    df_to2 = _reorder_chunk(
                        pd.concat([df_to, row_to_move], ignore_index=True).reset_index(drop=True)
                    )
                    d_from_osrm = float(_chunk_drive_minutes(df_from2, fast=False))
                    d_to_osrm = float(_chunk_drive_minutes(df_to2, fast=False))
                    new_max_osrm = max(d_from_osrm, d_to_osrm)
                    if (
                        d_from_osrm < float(OSRM_UNAVAILABLE_PENALTY_MIN)
                        and d_to_osrm < float(OSRM_UNAVAILABLE_PENALTY_MIN)
                        and new_max_osrm <= float(MAX_ROUTE_DRIVE_MIN) + 1e-6
                        and new_max_osrm + 1e-6 < worst_drive
                    ):
                        tech_chunks[worst_i] = (a_from, rn_from, df_from2)
                        tech_chunks[best_j] = (a_to, rn_to, df_to2)
                        continue

                # Otherwise isolate the outlier into its own route (always <= cap
                # because one stop has zero stop-to-stop drive).
                df_new = _reorder_chunk(row_to_move.copy().reset_index(drop=True))
                df_new["assignmentReason"] = "HARD_CAP_SPLIT"
                new_rn = max([int(t[1]) for t in tech_chunks] + [int(rn_from)]) + 1
                tech_chunks[worst_i] = (a_from, rn_from, df_from2)
                tech_chunks.append((a_from, new_rn, df_new))

            # Final quality repair gate (before day assignment / export):
            # enforce anti-loop, angle span, and no north+south lake mix on one route.
            quality_iters = 0
            while quality_iters < MAX_QUALITY_ITERS:
                quality_iters += 1
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break
                changed = False
                new_chunks = []
                next_rn = max([int(t[1]) for t in tech_chunks] + [0]) + 1

                for (anchor, rn, chunk_df) in tech_chunks:
                    chunk_df = _reorder_chunk(chunk_df.copy().reset_index(drop=True))
                    viol = _chunk_quality_violations(chunk_df)

                    if not viol:
                        new_chunks.append((anchor, rn, chunk_df))
                        continue

                    # Hard split lake north/south mixes.
                    if "LAKE_MIX" in viol and "remoteBucket" in chunk_df.columns:
                        nb = chunk_df[chunk_df["remoteBucket"] == "EAST_OF_BEAVER_LAKE_NORTH"].copy().reset_index(drop=True)
                        sb = chunk_df[chunk_df["remoteBucket"] == "EAST_OF_BEAVER_LAKE_SOUTH"].copy().reset_index(drop=True)
                        if len(nb) > 0 and len(sb) > 0:
                            nb = _reorder_chunk(nb)
                            sb = _reorder_chunk(sb)
                            nb["assignmentReason"] = "QUALITY_SPLIT"
                            sb["assignmentReason"] = "QUALITY_SPLIT"
                            new_chunks.append((anchor, rn, nb))
                            new_chunks.append((anchor, next_rn, sb))
                            next_rn += 1
                            changed = True
                            continue

                    # Hard split south-prairie east/west mixes.
                    if "SOUTH_MIX" in viol and "remoteBucket" in chunk_df.columns:
                        wb = chunk_df[chunk_df["remoteBucket"] == "SOUTH_OF_PRAIRIE_GROVE_WEST"].copy().reset_index(drop=True)
                        eb = chunk_df[chunk_df["remoteBucket"] == "SOUTH_OF_PRAIRIE_GROVE_EAST"].copy().reset_index(drop=True)
                        if len(wb) > 0 and len(eb) > 0:
                            wb = _reorder_chunk(wb)
                            eb = _reorder_chunk(eb)
                            wb["assignmentReason"] = "QUALITY_SPLIT"
                            eb["assignmentReason"] = "QUALITY_SPLIT"
                            new_chunks.append((anchor, rn, wb))
                            new_chunks.append((anchor, next_rn, eb))
                            next_rn += 1
                            changed = True
                            continue

                    # Split wide-span/loop/self-cross routes by angle to avoid circles/backtracking.
                    if ("ANGLE_SPAN" in viol or "LOOP" in viol or "DIAMETER" in viol or "SELF_CROSS" in viol) and len(chunk_df) >= 4:
                        parts = _split_chunk_by_angle(chunk_df)
                        if parts is not None:
                            a, b = parts
                            a = _reorder_chunk(a)
                            b = _reorder_chunk(b)
                            a["assignmentReason"] = "QUALITY_SPLIT"
                            b["assignmentReason"] = "QUALITY_SPLIT"
                            new_chunks.append((anchor, rn, a))
                            new_chunks.append((anchor, next_rn, b))
                            next_rn += 1
                            changed = True
                            continue

                    # If route still self-crosses, isolate the worst outlier and continue.
                    if "SELF_CROSS" in viol and len(chunk_df) >= 3:
                        oi = _worst_outlier_index(chunk_df)
                        keep = chunk_df.drop(chunk_df.index[oi]).reset_index(drop=True)
                        out = chunk_df.iloc[[oi]].copy().reset_index(drop=True)
                        keep = _reorder_chunk(keep)
                        out = _reorder_chunk(out)
                        keep["assignmentReason"] = "QUALITY_SPLIT"
                        out["assignmentReason"] = "QUALITY_SPLIT"
                        new_chunks.append((anchor, rn, keep))
                        new_chunks.append((anchor, next_rn, out))
                        next_rn += 1
                        changed = True
                        continue

                    # If still over drive cap here, isolate worst outlier.
                    if "DRIVE_CAP" in viol and len(chunk_df) >= 2:
                        oi = _worst_outlier_index(chunk_df)
                        keep = chunk_df.drop(chunk_df.index[oi]).reset_index(drop=True)
                        out = chunk_df.iloc[[oi]].copy().reset_index(drop=True)
                        keep = _reorder_chunk(keep)
                        out = _reorder_chunk(out)
                        keep["assignmentReason"] = "QUALITY_SPLIT"
                        out["assignmentReason"] = "QUALITY_OVERFLOW"
                        new_chunks.append((anchor, rn, keep))
                        new_chunks.append((anchor, next_rn, out))
                        next_rn += 1
                        changed = True
                        continue

                    soft_only_viol = set(viol).issubset({"SELF_CROSS", "LOOP", "ANGLE_SPAN", "DIAMETER"})
                    if soft_only_viol:
                        if "capacityReason" not in chunk_df.columns:
                            chunk_df["capacityReason"] = ""
                        cap_series = chunk_df["capacityReason"].fillna("").astype(str).str.strip()
                        chunk_df.loc[cap_series.eq("") | cap_series.eq("nan"), "capacityReason"] = "QUALITY_WARN_SOFT_GEOMETRY"
                        new_chunks.append((anchor, rn, chunk_df))
                        continue

                    # Cannot auto-repair: force overflow marker (fail-fast rule).
                    chunk_df["assignmentReason"] = "QUALITY_OVERFLOW"
                    new_chunks.append((anchor, rn, chunk_df))

                tech_chunks = new_chunks
                if not changed:
                    break

            tech_chunks = sorted(tech_chunks, key=lambda t: t[0])
            # Keep route numbers unique and stable after quality repairs/splits.
            tech_chunks = [(a, i + 1, d.copy().reset_index(drop=True)) for i, (a, _, d) in enumerate(tech_chunks)]

            # Stop-count rebalance pass:
            # move single stops from 13/14-stop routes into 10/11-stop routes.
            rebalance_iters = 0
            while rebalance_iters < MAX_SIZE_REBALANCE_ITERS:
                rebalance_iters += 1
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break

                receivers = [i for i, (_, _, d) in enumerate(tech_chunks) if len(d) < STOPS_PER_ROUTE]
                donors = [i for i, (_, _, d) in enumerate(tech_chunks) if len(d) > STOPS_PER_ROUTE]
                if not receivers or not donors:
                    break

                best_move = None

                for i in receivers:
                    a_recv, rn_recv, df_recv = tech_chunks[i]
                    if len(df_recv) >= MAX_STOPS_PER_ROUTE:
                        continue
                    recv_lat, recv_lng = _chunk_centroid(df_recv)
                    recv_drive_before = float(_chunk_drive_minutes(df_recv, fast=True))

                    for j in donors:
                        if j == i:
                            continue
                        a_don, rn_don, df_don = tech_chunks[j]
                        if len(df_don) <= STOPS_PER_ROUTE:
                            continue
                        if not _bucket_compatible(df_recv, df_don):
                            continue
                        if REMOTE_STRICT and (_is_chunk_remote(df_recv) != _is_chunk_remote(df_don)):
                            continue
                        if _angle_diff(_chunk_mean_angle(df_recv), _chunk_mean_angle(df_don)) > 1.15 and not _is_chunk_remote(df_recv):
                            continue

                        don_lat, don_lng = _chunk_centroid(df_don)
                        donor_drive_before = float(_chunk_drive_minutes(df_don, fast=True))

                        candidates = []
                        for idx in range(len(df_don)):
                            r = df_don.iloc[idx]
                            lat = float(r["lat"])
                            lng = float(r["lng"])
                            attach = float(approx_leg_minutes(lat, lng, recv_lat, recv_lng))
                            donor_outlier = float(_haversine_miles(lat, lng, don_lat, don_lng))
                            # Favor stops that naturally fit receiver and are outliers in donor.
                            rank = attach - (0.70 * donor_outlier)
                            candidates.append((rank, idx))
                        candidates.sort(key=lambda t: t[0])

                        for _, move_idx in candidates[:4]:
                            row = df_don.iloc[[move_idx]].copy().reset_index(drop=True)
                            df_don2 = _reorder_chunk(df_don.drop(df_don.index[move_idx]).reset_index(drop=True))
                            df_recv2 = _reorder_chunk(pd.concat([df_recv, row], ignore_index=True).reset_index(drop=True))

                            if len(df_recv2) > MAX_STOPS_PER_ROUTE or len(df_don2) < 1:
                                continue

                            d_don_fast = float(_chunk_drive_minutes(df_don2, fast=True))
                            d_recv_fast = float(_chunk_drive_minutes(df_recv2, fast=True))
                            if d_don_fast > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                continue
                            if d_recv_fast > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                                continue

                            before = abs(len(df_recv) - STOPS_PER_ROUTE) + abs(len(df_don) - STOPS_PER_ROUTE)
                            after = abs(len(df_recv2) - STOPS_PER_ROUTE) + abs(len(df_don2) - STOPS_PER_ROUTE)
                            gain = float(before - after)
                            if gain <= 0.0:
                                continue

                            drive_delta = (d_recv_fast - recv_drive_before) + (d_don_fast - donor_drive_before)
                            score = (-40.0 * gain) + (0.35 * drive_delta) + (0.10 * max(d_recv_fast, d_don_fast))

                            if best_move is None or score < best_move["score"]:
                                best_move = {
                                    "score": float(score),
                                    "recv_i": int(i),
                                    "don_i": int(j),
                                    "a_recv": a_recv,
                                    "rn_recv": rn_recv,
                                    "a_don": a_don,
                                    "rn_don": rn_don,
                                    "df_recv2": df_recv2,
                                    "df_don2": df_don2,
                                }

                if best_move is None:
                    break

                i = int(best_move["recv_i"])
                j = int(best_move["don_i"])
                tech_chunks[i] = (best_move["a_recv"], best_move["rn_recv"], best_move["df_recv2"])
                tech_chunks[j] = (best_move["a_don"], best_move["rn_don"], best_move["df_don2"])

            # Route compaction pass: merge undersized routes when compatible.
            compact_changed = True
            compact_iters = 0
            while compact_changed and compact_iters < MAX_COMPACT_ITERS:
                compact_iters += 1
                compact_changed = False
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break
                idx_order = sorted(range(len(tech_chunks)), key=lambda i: len(tech_chunks[i][2]))
                for i in idx_order:
                    if i >= len(tech_chunks):
                        continue
                    a_small, rn_small, df_small = tech_chunks[i]
                    if len(df_small) >= STOPS_PER_ROUTE:
                        continue

                    best_j = None
                    best_score = None
                    best_merged = None

                    for j, (a_big, rn_big, df_big) in enumerate(tech_chunks):
                        if j == i:
                            continue
                        if not _bucket_compatible(df_small, df_big):
                            continue
                        if REMOTE_STRICT and (_is_chunk_remote(df_small) != _is_chunk_remote(df_big)):
                            continue
                        if len(df_big) + len(df_small) > MAX_STOPS_PER_ROUTE:
                            continue

                        merged = _reorder_chunk(pd.concat([df_big, df_small], ignore_index=True).reset_index(drop=True))
                        d_fast = float(_chunk_drive_minutes(merged, fast=True))
                        if d_fast > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                            continue

                        day_gap = abs((a_big - a_small).days)
                        size_penalty = abs(len(merged) - STOPS_PER_ROUTE)
                        score = (2.0 * size_penalty) + (0.15 * d_fast) + (0.02 * day_gap)
                        if best_score is None or score < best_score:
                            best_score = score
                            best_j = j
                            best_merged = merged

                    if best_j is None or best_merged is None:
                        continue

                    a_big, rn_big, _ = tech_chunks[best_j]
                    new_anchor = a_big if a_big <= a_small else a_small

                    keep = []
                    for k, item in enumerate(tech_chunks):
                        if k not in (i, best_j):
                            keep.append(item)
                    best_merged["assignmentReason"] = "COMPACT_MERGE"
                    keep.append((new_anchor, rn_big, best_merged))
                    tech_chunks = keep
                    compact_changed = True
                    break

            # Final capacity merge pass after all quality repairs:
            # if routes exceed available working days, keep merging compatible pairs.
            day_merge_iters = 0
            while len(tech_chunks) > len(day_dates) and day_merge_iters < MAX_COMPACT_ITERS:
                day_merge_iters += 1
                if (time.time() - tech_started_at) > float(MAX_OPT_SECONDS_PER_TECH):
                    break

                best_pair = None
                best_score = None
                for i in range(len(tech_chunks)):
                    a_i, rn_i, df_i = tech_chunks[i]
                    for j in range(i + 1, len(tech_chunks)):
                        a_j, rn_j, df_j = tech_chunks[j]
                        if not _bucket_compatible(df_i, df_j):
                            continue
                        if REMOTE_STRICT and (_is_chunk_remote(df_i) != _is_chunk_remote(df_j)):
                            continue
                        if len(df_i) + len(df_j) > MAX_STOPS_PER_ROUTE:
                            continue

                        merged = _reorder_chunk(pd.concat([df_i, df_j], ignore_index=True).reset_index(drop=True))
                        d_fast = float(_chunk_drive_minutes(merged, fast=True))
                        if d_fast > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                            continue

                        size_penalty = abs(len(merged) - STOPS_PER_ROUTE)
                        day_gap = abs((a_i - a_j).days)
                        score = (1.8 * size_penalty) + (0.15 * d_fast) + (0.02 * day_gap)
                        if best_score is None or score < best_score:
                            best_score = float(score)
                            best_pair = (i, j, min(a_i, a_j), rn_i, merged)

                if best_pair is None:
                    break

                i, j, new_anchor, rn_i, merged = best_pair
                merged["assignmentReason"] = "CAPACITY_MERGE"
                keep = []
                for k, item in enumerate(tech_chunks):
                    if k not in (i, j):
                        keep.append(item)
                keep.append((new_anchor, rn_i, merged))
                tech_chunks = keep

            tech_chunks = sorted(tech_chunks, key=lambda t: t[0])
            tech_chunks = [(a, i + 1, d.copy().reset_index(drop=True)) for i, (a, _, d) in enumerate(tech_chunks)]

            available = list(enumerate(day_dates, start=1))  # [(day_idx, date), ...]

            for (anchor, rn, chunk_df) in tech_chunks:
                if not available:
                    day_idx, day_date = None, None
                else:
                    best_pos = 0
                    best_diff = None
                    for pos, (didx, d) in enumerate(available):
                        diff = abs((d - anchor).days)
                        if best_diff is None or diff < best_diff:
                            best_diff = diff
                            best_pos = pos
                    day_idx, day_date = available.pop(best_pos)

                chunk_df["routeIndex"] = day_idx
                chunk_df["routeDate"] = day_date
                if day_idx is None or day_date is None:
                    chunk_df["routeName"] = f"{tech} — UNASSIGNED (need more capacity) — Route {int(rn)}"
                    chunk_df["assignmentReason"] = "OVERFLOW_UNASSIGNED"
                else:
                    chunk_df["routeName"] = _format_assigned_route_name(str(tech), day_date, day_idx, int(rn))
                chunk_df["sequence"] = np.arange(1, len(chunk_df) + 1)

                route_rows.append(chunk_df)

        df_out = pd.concat(route_rows, ignore_index=True)

        # Final quality gate before export: auto-overflow any remaining assigned
        # route that still violates hard quality constraints.
        try:
            tech_hubs = (
                df_out.groupby("preferredTech")[["lat", "lng"]]
                .mean()
                .rename(columns={"lat": "hubLat", "lng": "hubLng"})
            )
            route_index_rows = []
            soft_geometry_warn_routes = 0
            for rname, g in df_out.groupby("routeName", sort=False):
                route_index_rows.append((str(rname), g.index.to_list()))

            for route_name, idxs in route_index_rows:
                if not idxs:
                    continue
                g = df_out.loc[idxs].copy().sort_values("sequence")

                # already overflow/unassigned
                is_unassigned = bool(g["routeDate"].isna().all()) or ("UNASSIGNED" in str(route_name))
                if is_unassigned:
                    continue

                pts = list(zip(g["lat"].astype(float), g["lng"].astype(float)))
                drive_osrm = route_drive_minutes_from_points_osrm_only(pts)
                drive_eval = float(route_drive_minutes_from_points_fast(pts))
                drive_source_gate = "FAST_APPROX"
                if drive_osrm is not None and np.isfinite(float(drive_osrm)):
                    drive_eval = float(drive_osrm)
                    drive_source_gate = "OSRM_ROUTE"
                elif strict_osrm_for_run:
                    drive_eval = float(OSRM_UNAVAILABLE_PENALTY_MIN)
                    drive_source_gate = "OSRM_UNAVAILABLE"

                is_remote_route = bool(g.get("isRemote", pd.Series(dtype=bool)).any())
                preferred_drive = float(PREFERRED_ROUTE_DRIVE_MIN_REMOTE if is_remote_route else PREFERRED_ROUTE_DRIVE_MIN_LOCAL)

                loop_ratio = 1.0
                diam = 0.0
                if len(pts) >= 3:
                    start_end = float(_haversine_miles(pts[0][0], pts[0][1], pts[-1][0], pts[-1][1]))
                    max_pair = 0.0
                    for i in range(len(pts)):
                        for j in range(i + 1, len(pts)):
                            d = float(_haversine_miles(pts[i][0], pts[i][1], pts[j][0], pts[j][1]))
                            if d > max_pair:
                                max_pair = d
                            if d > diam:
                                diam = d
                    if max_pair > 1e-9:
                        loop_ratio = float(start_end / max_pair)
                elif len(pts) == 2:
                    diam = float(_haversine_miles(pts[0][0], pts[0][1], pts[1][0], pts[1][1]))
                diam_cap = float(MAX_ROUTE_DIAMETER_MI_REMOTE if is_remote_route else MAX_ROUTE_DIAMETER_MI_LOCAL)

                tech_name = str(g["preferredTech"].iloc[0])
                hub_lat = float(tech_hubs.loc[tech_name, "hubLat"]) if tech_name in tech_hubs.index else float(g["lat"].mean())
                hub_lng = float(tech_hubs.loc[tech_name, "hubLng"]) if tech_name in tech_hubs.index else float(g["lng"].mean())
                angs = np.array(
                    [math.atan2(float(lat) - hub_lat, float(lng) - hub_lng) for (lat, lng) in pts],
                    dtype=float,
                )
                angs = np.where(angs < 0.0, angs + (2.0 * math.pi), angs)
                ang_span = 0.0
                if len(angs) > 2:
                    aa = np.sort(angs)
                    gaps = np.diff(np.concatenate([aa, [aa[0] + (2.0 * math.pi)]]))
                    ang_span = float((2.0 * math.pi) - float(np.max(gaps)))
                self_cross = int(_polyline_self_intersections(pts))

                buckets = {str(x) for x in g.get("remoteBucket", pd.Series(dtype=str)).dropna().tolist()}
                lake_mix = ("EAST_OF_BEAVER_LAKE_NORTH" in buckets) and ("EAST_OF_BEAVER_LAKE_SOUTH" in buckets)
                south_mix = ("SOUTH_OF_PRAIRIE_GROVE_EAST" in buckets) and ("SOUTH_OF_PRAIRIE_GROVE_WEST" in buckets)
                self_cross_limit = int(max(MAX_ROUTE_SELF_INTERSECTIONS, SOFT_GEOMETRY_SELF_CROSS_TOLERANCE))
                soft_geometry_violates = (
                    (loop_ratio < float(MIN_LOOP_OPEN_RATIO) * 0.70)
                    or (ang_span > math.radians(float(MAX_ROUTE_ANGLE_SPAN_DEG) + 20.0) + 1e-9)
                    or (diam > (diam_cap * 1.8) + 1e-6)
                    or (self_cross > self_cross_limit)
                )
                hard_drive_over_cap = bool(
                    drive_eval > float(MAX_ROUTE_DRIVE_MIN) + float(OSRM_DRIVE_CAP_TOLERANCE_MIN) + 1e-6
                )
                hard_violates = (
                    ((drive_source_gate == "OSRM_UNAVAILABLE") and strict_osrm_for_run)
                    or lake_mix
                    or south_mix
                )
                if hard_violates:
                    df_out.loc[idxs, "routeDate"] = pd.NaT
                    df_out.loc[idxs, "routeIndex"] = np.nan
                    df_out.loc[idxs, "routeName"] = f"{tech_name} — UNASSIGNED (quality overflow) — Route {route_name.split('Route ')[-1]}"
                    if drive_source_gate == "OSRM_UNAVAILABLE":
                        df_out.loc[idxs, "assignmentReason"] = "QUALITY_OVERFLOW_OSRM"
                    else:
                        df_out.loc[idxs, "assignmentReason"] = "QUALITY_OVERFLOW"
                elif hard_drive_over_cap:
                    if "capacityReason" not in df_out.columns:
                        df_out["capacityReason"] = ""
                    cap_vals = df_out.loc[idxs, "capacityReason"].fillna("").astype(str).str.strip()
                    empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                    if bool(empty_cap.any()):
                        fill_idx = cap_vals.index[empty_cap.to_numpy()]
                        df_out.loc[fill_idx, "capacityReason"] = "DRIVE_PREF_EXCEEDED_MATRIX"
                elif soft_geometry_violates:
                    soft_geometry_warn_routes += 1
                    if "capacityReason" not in df_out.columns:
                        df_out["capacityReason"] = ""
                    cap_vals = df_out.loc[idxs, "capacityReason"].fillna("").astype(str).str.strip()
                    empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                    if bool(empty_cap.any()):
                        fill_idx = cap_vals.index[empty_cap.to_numpy()]
                        df_out.loc[fill_idx, "capacityReason"] = "QUALITY_WARN_SOFT_GEOMETRY"
                elif drive_eval > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                    if "capacityReason" not in df_out.columns:
                        df_out["capacityReason"] = ""
                    cap_vals = df_out.loc[idxs, "capacityReason"].fillna("").astype(str).str.strip()
                    empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                    if bool(empty_cap.any()):
                        fill_idx = cap_vals.index[empty_cap.to_numpy()]
                        df_out.loc[fill_idx, "capacityReason"] = "DRIVE_CAP_TOLERATED_NEAR_LIMIT"
            if soft_geometry_warn_routes > 0:
                staffing_warnings.append(
                    {
                        "warning": "SOFT_GEOMETRY_WARNINGS",
                        "routes": int(soft_geometry_warn_routes),
                    }
                )
        except Exception:
            pass

        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "compiled_output",
                "message": "Compiled routing output",
                "outputRows": int(len(df_out)),
            }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

        if "driveModel" not in df_out.columns:
            df_out["driveModel"] = "LEGACY_MODEL"
        if "dayType" not in df_out.columns:
            df_out["dayType"] = np.where(df_out["routeDate"].isna(), "UNASSIGNED", "WEEKDAY")
        if "capacityReason" not in df_out.columns:
            df_out["capacityReason"] = ""
        if "routeDriveMinutesMatrix" not in df_out.columns:
            df_out["routeDriveMinutesMatrix"] = np.nan
        if "routeDriveMinutesOSRM" not in df_out.columns:
            df_out["routeDriveMinutesOSRM"] = np.nan
        if "planStopId" not in df_out.columns:
            df_out["planStopId"] = [f"plan-{i + 1:07d}" for i in range(len(df_out))]
        else:
            df_out["planStopId"] = df_out["planStopId"].astype(str).str.strip()
            missing_mask = df_out["planStopId"].eq("") | df_out["planStopId"].isna()
            if bool(missing_mask.any()):
                fallback_ids = [f"plan-{i + 1:07d}" for i in range(len(df_out))]
                df_out.loc[missing_mask, "planStopId"] = np.array(fallback_ids, dtype=object)[missing_mask.to_numpy()]

        # Scheduling-request metadata defaults (backward compatibility for older inputs).
        if "schedulingRequestRaw" not in df_out.columns:
            df_out["schedulingRequestRaw"] = ""
        if "schedulingRequestClass" not in df_out.columns:
            df_out["schedulingRequestClass"] = ""
        if "schedulingAllowedWeekdays" not in df_out.columns:
            df_out["schedulingAllowedWeekdays"] = ""
        if "schedulingBlockedWeekdays" not in df_out.columns:
            df_out["schedulingBlockedWeekdays"] = ""
        if "schedulingRequiresPhoneConfirm" not in df_out.columns:
            df_out["schedulingRequiresPhoneConfirm"] = False
        if "schedulingCritical" not in df_out.columns:
            df_out["schedulingCritical"] = False
        if "schedulingConstraintStatus" not in df_out.columns:
            df_out["schedulingConstraintStatus"] = ""
        if "schedulingConstraintNote" not in df_out.columns:
            df_out["schedulingConstraintNote"] = ""
        if "subscriptionID" not in df_out.columns:
            df_out["subscriptionID"] = ""
        else:
            df_out["subscriptionID"] = df_out["subscriptionID"].fillna("").astype(str).str.strip()

        # Apply hard weekday scheduling constraints (strict + capacity override).
        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "scheduling_constraints",
                "message": "Applying scheduling-request weekday constraints",
            }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))
        sched_summary = _enforce_scheduling_weekday_constraints(df_out)
        if sched_summary.get("checked", 0) > 0:
            staffing_warnings.append(
                {
                    "warning": "SCHEDULING_CONSTRAINT_PASS",
                    "checked": int(sched_summary.get("checked", 0)),
                    "moved": int(sched_summary.get("moved", 0)),
                    "overriddenCap": int(sched_summary.get("overriddenCap", 0)),
                    "unresolved": int(sched_summary.get("unresolved", 0)),
                }
            )

        # Route-level OSRM validation for drive-time preference signaling.
        if run_osrm_route_validation:
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "osrm_route_validation",
                    "message": "Validating assigned routes with OSRM route durations",
                }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

            osrm_missing_assigned = 0
            osrm_over_cap_assigned = 0
            osrm_split_saved_assigned = 0
            for route_name, g in df_out.groupby("routeName"):
                idxs = g.index
                route_date_val = g["routeDate"].iloc[0] if "routeDate" in g.columns else None
                is_assigned = not (route_date_val is None or pd.isna(route_date_val) or ("UNASSIGNED" in str(route_name)))
                pts_df = g.sort_values("sequence")
                pts = list(zip(pts_df["lat"].astype(float), pts_df["lng"].astype(float)))
                osrm_route_min = route_drive_minutes_from_points_osrm_only(pts)

                if osrm_route_min is not None and np.isfinite(float(osrm_route_min)):
                    osrm_route_min = float(osrm_route_min)
                    df_out.loc[idxs, "routeDriveMinutesOSRM"] = osrm_route_min
                    if is_assigned and osrm_route_min > float(MAX_ROUTE_DRIVE_MIN) + float(OSRM_DRIVE_CAP_TOLERANCE_MIN) + 1e-6:
                        split_ok = _attempt_split_assigned_route_into_unused_days(
                            df_out,
                            route_name=str(route_name),
                            idxs=list(idxs),
                            max_drive_min=float(MAX_ROUTE_DRIVE_MIN),
                            tolerance_min=float(OSRM_DRIVE_CAP_TOLERANCE_MIN),
                            require_osrm=bool(strict_osrm_for_run),
                        )
                        if split_ok:
                            osrm_split_saved_assigned += 1
                            continue
                        osrm_over_cap_assigned += 1
                        if "capacityReason" not in df_out.columns:
                            df_out["capacityReason"] = ""
                        cap_vals = df_out.loc[idxs, "capacityReason"].fillna("").astype(str).str.strip()
                        empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                        if bool(empty_cap.any()):
                            fill_idx = cap_vals.index[empty_cap.to_numpy()]
                            df_out.loc[fill_idx, "capacityReason"] = "DRIVE_PREF_EXCEEDED_OSRM"
                    elif is_assigned and osrm_route_min > float(MAX_ROUTE_DRIVE_MIN) + 1e-6:
                        if "capacityReason" not in df_out.columns:
                            df_out["capacityReason"] = ""
                        cap_vals = df_out.loc[idxs, "capacityReason"].fillna("").astype(str).str.strip()
                        empty_cap = cap_vals.eq("") | cap_vals.eq("nan")
                        if bool(empty_cap.any()):
                            fill_idx = cap_vals.index[empty_cap.to_numpy()]
                            df_out.loc[fill_idx, "capacityReason"] = "DRIVE_CAP_TOLERATED_NEAR_LIMIT"
                elif is_assigned:
                    osrm_missing_assigned += 1
                    tech_name = str(g["preferredTech"].iloc[0])
                    suffix = str(route_name).split("Route ")[-1] if "Route " in str(route_name) else str(route_name)
                    df_out.loc[idxs, "routeDate"] = pd.NaT
                    df_out.loc[idxs, "routeIndex"] = np.nan
                    df_out.loc[idxs, "routeName"] = f"{tech_name} — UNASSIGNED (quality overflow) — Route {suffix}"
                    df_out.loc[idxs, "assignmentReason"] = "QUALITY_OVERFLOW_OSRM_UNAVAILABLE"
                    df_out.loc[idxs, "capacityReason"] = "QUALITY_OVERFLOW_OSRM_UNAVAILABLE"

            if osrm_missing_assigned > 0 or osrm_over_cap_assigned > 0 or osrm_split_saved_assigned > 0:
                staffing_warnings.append(
                    {
                        "warning": "OSRM_ROUTE_VALIDATION_ISSUES",
                        "missing_assigned": int(osrm_missing_assigned),
                        "over_cap_assigned": int(osrm_over_cap_assigned),
                        "split_saved_assigned": int(osrm_split_saved_assigned),
                    }
                )

        if PRODUCTION_GATES_ENABLED:
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "quality_gates",
                    "message": "Running production quality gates",
                }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

            gate_errors = []

            if ROUTING_MODE == "GLOBAL_CHAIN_ZONE_BLOCKS" and strict_osrm_for_run:
                low_cov = [r for r in matrix_quality_rows if float(r.get("coverage", 0.0)) < float(MIN_OSRM_MATRIX_COVERAGE)]
                if low_cov:
                    worst = sorted(low_cov, key=lambda x: float(x.get("coverage", 0.0)))[0]
                    gate_errors.append(
                        "OSRM_MATRIX_COVERAGE_TOO_LOW "
                        f"(threshold={MIN_OSRM_MATRIX_COVERAGE:.2f}, "
                        f"techs_below={len(low_cov)}, "
                        f"worst={worst.get('tech')}:{float(worst.get('coverage', 0.0)):.3f})"
                    )

            route_sizes = df_out.groupby("routeName").size()
            route_date = df_out.groupby("routeName")["routeDate"].first()
            route_reason = df_out.groupby("routeName")["assignmentReason"].agg(
                lambda s: "|".join(sorted({str(x) for x in s if str(x).strip() and str(x) != "nan"}))
            )
            route_model = df_out.groupby("routeName")["driveModel"].agg(
                lambda s: str(s.mode().iloc[0]) if len(s.dropna()) > 0 else "LEGACY_MODEL"
            )
            route_osrm = df_out.groupby("routeName")["routeDriveMinutesOSRM"].first()
            assigned_mask = route_date.notna() & (~route_date.index.to_series().str.contains("UNASSIGNED", na=False))
            under_min_mask = assigned_mask & (route_sizes < int(MIN_STOPS_PER_DAY))
            single_mask = assigned_mask & (route_sizes <= 1)
            non_hard_under = under_min_mask & (~route_reason.reindex(route_sizes.index).fillna("").str.contains("HARD_CAP_SPLIT", na=False))
            non_hard_single = single_mask & (~route_reason.reindex(route_sizes.index).fillna("").str.contains("HARD_CAP_SPLIT", na=False))
            fallback_assigned_mask = assigned_mask & (route_model.reindex(route_sizes.index).fillna("LEGACY_MODEL") != "OSRM_MATRIX_STRICT")
            missing_osrm_assigned_mask = assigned_mask & (route_osrm.reindex(route_sizes.index).isna())

            under_min_count = int(under_min_mask.sum())
            single_count = int(single_mask.sum())
            non_hard_count = int(non_hard_under.sum())
            non_hard_single_count = int(non_hard_single.sum())
            fallback_assigned_count = int(fallback_assigned_mask.sum())
            missing_osrm_assigned_count = int(missing_osrm_assigned_mask.sum())
            size_gate_warnings = []

            if (under_min_count > int(MAX_ASSIGNED_UNDER_MIN_ROUTES)) and (non_hard_count > int(MAX_ASSIGNED_UNDER_MIN_NON_HARD_SPLIT)):
                size_gate_warnings.append(
                    "TOO_MANY_UNDER_MIN_ASSIGNED_ROUTES "
                    f"(count={under_min_count}, non_hard={non_hard_count}, max={MAX_ASSIGNED_UNDER_MIN_ROUTES})"
                )
            if (single_count > int(MAX_ASSIGNED_SINGLE_STOP_ROUTES)) and (non_hard_single_count > 0):
                size_gate_warnings.append(
                    "TOO_MANY_SINGLE_STOP_ASSIGNED_ROUTES "
                    f"(count={single_count}, non_hard={non_hard_single_count}, max={MAX_ASSIGNED_SINGLE_STOP_ROUTES})"
                )
            if non_hard_count > int(MAX_ASSIGNED_UNDER_MIN_NON_HARD_SPLIT):
                size_gate_warnings.append(
                    "UNDER_MIN_ASSIGNED_WITHOUT_HARD_CAP_SPLIT "
                    f"(count={non_hard_count}, max={MAX_ASSIGNED_UNDER_MIN_NON_HARD_SPLIT})"
                )
            if strict_osrm_for_run:
                if fallback_assigned_count > int(MAX_ASSIGNED_FALLBACK_ROUTES):
                    gate_errors.append(
                        "ASSIGNED_FALLBACK_ROUTES_PRESENT "
                        f"(count={fallback_assigned_count}, max={MAX_ASSIGNED_FALLBACK_ROUTES})"
                    )
                if missing_osrm_assigned_count > int(MAX_ASSIGNED_MISSING_OSRM_ROUTE_METRICS):
                    gate_errors.append(
                        "ASSIGNED_ROUTES_MISSING_OSRM_METRICS "
                        f"(count={missing_osrm_assigned_count}, max={MAX_ASSIGNED_MISSING_OSRM_ROUTE_METRICS})"
                    )

            if size_gate_warnings:
                staffing_warnings.append(
                    {
                        "warning": "QUALITY_GATE_SIZE_WARNINGS",
                        "details": list(size_gate_warnings),
                    }
                )
                if progress_path:
                    _progress_update(progress_path, _with_eta({
                        "status": "running",
                        "stage": "quality_gates_warning",
                        "message": "QUALITY_GATE_SIZE_WARNINGS: " + " | ".join(size_gate_warnings),
                        "gateWarnings": list(size_gate_warnings),
                    }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

            if gate_errors:
                gate_msg = "QUALITY_GATE_FAILED: " + " | ".join(gate_errors)
                staffing_warnings.append(
                    {
                        "warning": "QUALITY_GATE_FAILED",
                        "mode": ("HARD_FAIL" if QUALITY_GATES_HARD_FAIL else "WARN_ONLY"),
                        "details": list(gate_errors),
                    }
                )
                if progress_path:
                    _progress_update(progress_path, _with_eta({
                        "status": ("error" if QUALITY_GATES_HARD_FAIL else "running"),
                        "stage": "quality_gates_warning",
                        "message": gate_msg,
                        "gateWarnings": list(gate_errors),
                    }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))
                if QUALITY_GATES_HARD_FAIL:
                    raise RuntimeError(gate_msg)

        # Recovery pass: if unassigned share is still high, auto-assign nearest stops
        # into existing/new same-tech routes to reduce manual cleanup.
        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "recovery_assignment",
                "message": "Recovering high unassigned fraction where possible",
            }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))
        recovery_summary = _recover_high_unassigned_fraction(df_out)
        if bool(recovery_summary.get("triggered", False)):
            staffing_warnings.append(
                {
                    "warning": "UNASSIGNED_RECOVERY_PASS",
                    "before": int(recovery_summary.get("before", 0)),
                    "moved": int(recovery_summary.get("moved", 0)),
                    "remaining": int(recovery_summary.get("remaining", 0)),
                    "techsTouched": int(recovery_summary.get("techsTouched", 0)),
                }
            )

        # Normalize assigned route naming to date-first format after all moves/validations.
        _refresh_assigned_route_names(df_out)
        fieldroutes_template_summary = _apply_fieldroutes_template_ids(df_out)

        for col in ROUTING_PLAN_EXPORT_COLUMNS:
            if col not in df_out.columns:
                df_out[col] = ""
        df_out[ROUTING_PLAN_EXPORT_COLUMNS].to_csv(str(out_csv_path), index=False)

        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "running",
                "stage": "wrote_csv",
                "message": "Wrote routing_plan.csv",
                "file": str(out_csv_path),
                "fieldRoutesTemplateSummary": fieldroutes_template_summary,
            }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

        scaffold_warning = None
        scaffold_payload = _build_route_scaffold_payload(
            df_out,
            planning_start=planning_start,
            planning_end=planning_end,
            run_id=run_id,
        )
        try:
            with open(out_scaffold_path, "w", encoding="utf-8") as f:
                json.dump(scaffold_payload, f, indent=2)
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "wrote_scaffolds",
                    "message": "Wrote route_scaffolds.json",
                    "file": str(out_scaffold_path),
                    "routeScaffolds": int(scaffold_payload.get("routeCount", 0)),
                }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))
        except Exception as scaffold_exc:
            scaffold_warning = f"ROUTE_SCAFFOLD_WRITE_WARNING: {type(scaffold_exc).__name__}: {scaffold_exc}"
            staffing_warnings.append(
                {
                    "warning": "ROUTE_SCAFFOLD_WRITE_WARNING",
                    "details": str(scaffold_warning),
                }
            )
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "scaffold_write_warning",
                    "message": str(scaffold_warning),
                }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

        routes = []
        PALETTE = [
            "#2563eb",
            "#16a34a",
            "#f97316",
            "#a855f7",
            "#ef4444",
            "#06b6d4",
            "#84cc16",
            "#f43f5e",
            "#0ea5e9",
            "#64748b",
        ]

        def _color_for_name(name: str) -> str:
            h = 0
            for ch in name:
                h = (h * 31 + ord(ch)) & 0xFFFFFFFF
            return PALETTE[h % len(PALETTE)]

        for route_name, g in df_out.groupby("routeName"):
            route_name = str(route_name)
            tech = str(g["preferredTech"].iloc[0])
            date_val = g["routeDate"].iloc[0] if "routeDate" in g.columns else None
            date = "UNASSIGNED" if (date_val is None or pd.isna(date_val)) else str(date_val)

            g = g.sort_values("sequence")
            zones = sorted({str(z) for z in g["remoteZone"].dropna().tolist() if str(z).strip()})
            reasons = sorted({str(z) for z in g["assignmentReason"].dropna().tolist() if str(z).strip()})
            cap_reasons = sorted({str(z) for z in g.get("capacityReason", pd.Series(dtype=str)).dropna().tolist() if str(z).strip()})
            seq_strategy = str(g["sequenceStrategy"].mode().iloc[0]) if "sequenceStrategy" in g.columns else "LOCAL_OPT"
            day_type = (
                str(g["dayType"].mode().iloc[0])
                if ("dayType" in g.columns and len(g["dayType"].dropna()) > 0)
                else ("UNASSIGNED" if ("UNASSIGNED" in route_name or date == "UNASSIGNED") else "WEEKDAY")
            )
            drive_model = (
                str(g["driveModel"].mode().iloc[0])
                if ("driveModel" in g.columns and len(g["driveModel"].dropna()) > 0)
                else "LEGACY_MODEL"
            )
            matrix_minutes = (
                None
                if ("routeDriveMinutesMatrix" not in g.columns or g["routeDriveMinutesMatrix"].dropna().empty)
                else float(g["routeDriveMinutesMatrix"].dropna().iloc[0])
            )
            osrm_minutes = (
                None
                if ("routeDriveMinutesOSRM" not in g.columns or g["routeDriveMinutesOSRM"].dropna().empty)
                else float(g["routeDriveMinutesOSRM"].dropna().iloc[0])
            )

            stops = []
            latlngs = []
            for _, r in g.iterrows():
                lat = float(r["lat"])
                lng = float(r["lng"])
                latlngs.append((lat, lng))
                stops.append(
                    {
                        "planStopId": str(r.get("planStopId", "")),
                        "seq": int(r["sequence"]),
                        "lat": lat,
                        "lng": lng,
                        "customerID": str(r["customerID"]),
                        "subscriptionID": ("" if pd.isna(r.get("subscriptionID", "")) else str(r.get("subscriptionID", ""))),
                        "duration": int(r.get("duration", DEFAULT_DURATION)),
                        "isRemote": bool(r.get("isRemote", False)),
                        "remoteZone": ("" if pd.isna(r.get("remoteZone", "")) else str(r.get("remoteZone", ""))),
                        "assignmentReason": ("" if pd.isna(r.get("assignmentReason", "")) else str(r.get("assignmentReason", ""))),
                        "sequenceStrategy": ("" if pd.isna(r.get("sequenceStrategy", "")) else str(r.get("sequenceStrategy", ""))),
                        "driveModel": ("" if pd.isna(r.get("driveModel", "")) else str(r.get("driveModel", ""))),
                        "dayType": ("" if pd.isna(r.get("dayType", "")) else str(r.get("dayType", ""))),
                        "fieldRoutesTemplateID": (
                            ""
                            if pd.isna(r.get("fieldRoutesTemplateID", ""))
                            else str(r.get("fieldRoutesTemplateID", ""))
                        ),
                        "fieldRoutesTemplateSource": (
                            ""
                            if pd.isna(r.get("fieldRoutesTemplateSource", ""))
                            else str(r.get("fieldRoutesTemplateSource", ""))
                        ),
                        "capacityReason": ("" if pd.isna(r.get("capacityReason", "")) else str(r.get("capacityReason", ""))),
                        "schedulingRequestRaw": ("" if pd.isna(r.get("schedulingRequestRaw", "")) else str(r.get("schedulingRequestRaw", ""))),
                        "schedulingRequestClass": ("" if pd.isna(r.get("schedulingRequestClass", "")) else str(r.get("schedulingRequestClass", ""))),
                        "schedulingAllowedWeekdays": ("" if pd.isna(r.get("schedulingAllowedWeekdays", "")) else str(r.get("schedulingAllowedWeekdays", ""))),
                        "schedulingBlockedWeekdays": ("" if pd.isna(r.get("schedulingBlockedWeekdays", "")) else str(r.get("schedulingBlockedWeekdays", ""))),
                        "schedulingRequiresPhoneConfirm": bool(r.get("schedulingRequiresPhoneConfirm", False)),
                        "schedulingCritical": bool(r.get("schedulingCritical", False)),
                        "schedulingConstraintStatus": ("" if pd.isna(r.get("schedulingConstraintStatus", "")) else str(r.get("schedulingConstraintStatus", ""))),
                        "schedulingConstraintNote": ("" if pd.isna(r.get("schedulingConstraintNote", "")) else str(r.get("schedulingConstraintNote", ""))),
                    }
                )

            # Keep display miles/minutes from a consistent source.
            road_line, miles, minutes, minutes_source = route_drive_metrics_for_display(latlngs)
            road_key = ";".join([f"{lng},{lat}" for (lat, lng) in latlngs])
            display_minutes = minutes
            display_source = str(minutes_source)
            if (
                (display_minutes is None or not np.isfinite(float(display_minutes)))
                and matrix_minutes is not None
                and np.isfinite(float(matrix_minutes))
            ):
                # Default popup drive minutes to the same matrix-backed value used for routing.
                display_minutes = float(matrix_minutes)
                display_source = "matrix"

            routes.append(
                {
                    "routeName": route_name,
                    "routeIndex": (
                        None
                        if ("routeIndex" not in g.columns or pd.isna(g["routeIndex"].iloc[0]))
                        else int(g["routeIndex"].iloc[0])
                    ),
                    "tech": str(tech),
                    "date": str(date),
                    "color": _color_for_name(route_name),
                    "isRemoteRoute": bool(g["isRemote"].any()) if "isRemote" in g.columns else False,
                    "remoteZones": zones,
                    "assignmentReasons": reasons,
                    "capacityReasons": cap_reasons,
                    "dayType": day_type,
                    "fieldRoutesTemplateID": (
                        ""
                        if ("fieldRoutesTemplateID" not in g.columns or pd.isna(g["fieldRoutesTemplateID"].iloc[0]))
                        else str(g["fieldRoutesTemplateID"].iloc[0])
                    ),
                    "fieldRoutesTemplateSource": (
                        ""
                        if ("fieldRoutesTemplateSource" not in g.columns or pd.isna(g["fieldRoutesTemplateSource"].iloc[0]))
                        else str(g["fieldRoutesTemplateSource"].iloc[0])
                    ),
                    "driveModel": drive_model,
                    "routeDriveMinutesMatrix": matrix_minutes,
                    "routeDriveMinutesOSRM": osrm_minutes,
                    "sequenceStrategy": seq_strategy,
                    "stops": stops,
                    "roadKey": road_key,
                    "roadLine": [[float(a), float(b)] for (a, b) in road_line],
                    "miles": None if miles is None else float(miles),
                    "minutes": None if display_minutes is None else float(display_minutes),
                    "minutesSource": str(display_source),
                }
            )

        existing_route_names = {str(r.get("routeName", "")).strip() for r in routes if str(r.get("routeName", "")).strip()}
        for scaffold in list(scaffold_payload.get("routes", [])):
            if not isinstance(scaffold, dict):
                continue
            route_name = str(scaffold.get("routeName", "")).strip()
            tech_name = str(scaffold.get("tech", "")).strip()
            date_text = str(scaffold.get("date", "")).strip()
            if not route_name or not tech_name or not date_text:
                continue
            if route_name in existing_route_names:
                continue

            route_index_raw = scaffold.get("routeIndex", None)
            try:
                route_index = int(float(route_index_raw)) if route_index_raw is not None else None
            except Exception:
                route_index = None

            routes.append(
                {
                    "routeName": route_name,
                    "routeIndex": route_index,
                    "tech": tech_name,
                    "date": date_text,
                    "color": _color_for_name(route_name),
                    "isRemoteRoute": False,
                    "remoteZones": [],
                    "assignmentReasons": [],
                    "capacityReasons": [],
                    "dayType": str(scaffold.get("dayType", "WEEKDAY") or "WEEKDAY"),
                    "fieldRoutesTemplateID": str(scaffold.get("fieldRoutesTemplateID", "") or ""),
                    "fieldRoutesTemplateSource": str(scaffold.get("fieldRoutesTemplateSource", "scaffold") or "scaffold"),
                    "driveModel": str(scaffold.get("driveModel", "SCAFFOLD_EMPTY_ROUTE") or "SCAFFOLD_EMPTY_ROUTE"),
                    "routeDriveMinutesMatrix": None,
                    "routeDriveMinutesOSRM": None,
                    "sequenceStrategy": str(scaffold.get("sequenceStrategy", "SCAFFOLD_EMPTY_ROUTE") or "SCAFFOLD_EMPTY_ROUTE"),
                    "stops": [],
                    "roadKey": "",
                    "roadLine": [],
                    "miles": None,
                    "minutes": None,
                    "minutesSource": "scaffold",
                    "isScaffoldRoute": True,
                }
            )
            existing_route_names.add(route_name)

        center_lat = float(df_out["lat"].mean())
        center_lng = float(df_out["lng"].mean())

        map_warning = None
        html_output_path = str(out_html_path)
        try:
            html = render_route_preview_html(
                routes,
                center_lat=center_lat,
                center_lng=center_lng,
                manual_draft_edited=False,
                run_id=run_id,
            )
            with open(out_html_path, "w", encoding="utf-8") as f:
                f.write(html)
        except Exception as map_exc:
            html_output_path = None
            map_warning = (
                f"MAP_RENDER_WARNING: {type(map_exc).__name__}: {map_exc}. "
                "CSV output is complete. Use POST /rebuild-map to regenerate route_preview.html."
            )
            staffing_warnings.append(
                {
                    "warning": "MAP_RENDER_WARNING",
                    "details": str(map_warning),
                }
            )
            if progress_path:
                _progress_update(progress_path, _with_eta({
                    "status": "running",
                    "stage": "map_render_warning",
                    "message": str(map_warning),
                    "files": [str(out_csv_path)],
                    "staffingWarnings": int(len(staffing_warnings)),
                }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

        warning_parts = [x for x in [map_warning, scaffold_warning] if str(x or "").strip()]
        combined_warning = " | ".join(warning_parts) if warning_parts else None
        done_message = "Routing complete." if combined_warning is None else "Routing complete with warning."
        done_stage = "done" if combined_warning is None else "done_with_warning"
        done_files = [str(out_csv_path)]
        if map_warning is None:
            done_files.append(str(out_html_path))
        if out_scaffold_path.exists():
            done_files.append(str(out_scaffold_path))
        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "done",
                "stage": done_stage,
                "message": done_message,
                "warning": combined_warning,
                "files": done_files,
                "staffingWarnings": int(len(staffing_warnings)),
            }, processed_techs=total_techs_for_eta or 0, total_techs=total_techs_for_eta))

        return {
            "csv": str(out_csv_path),
            "html": html_output_path,
            "scaffold": (str(out_scaffold_path) if out_scaffold_path.exists() else None),
            "warning": combined_warning,
        }

    except Exception as e:
        if progress_path:
            _progress_update(progress_path, _with_eta({
                "status": "error",
                "stage": "error",
                "message": f"Routing failed: {type(e).__name__}: {e}",
                "traceback": traceback.format_exc(),
                "updatedAt": int(time.time()),
            }))
        raise
    finally:
        try:
            restore_run_settings()
        except Exception:
            pass
