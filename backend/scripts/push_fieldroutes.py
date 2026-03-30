#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import os
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

from fieldroutes_client import FieldRoutesApiError, FieldRoutesClient, FieldRoutesConfig
from fieldroutes_mapping import (
    APPOINTMENT_ID_FIELD_CANDIDATES,
    ASSIGNED_TECH_FIELD_CANDIDATES,
    ROUTE_ID_FIELD_CANDIDATES,
    PlanRow,
    build_appointment_indexes,
    build_employee_lookup,
    extract_appointment_date,
    extract_appointment_id,
    extract_customer_id,
    extract_subscription_id,
    extract_records,
    extract_route_id,
    extract_sequence,
    first_present,
    load_plan_rows_for_date,
    normalize_date,
    normalize_name,
)


DEFAULT_PILOT_DATE = "2026-04-01"
DEFAULT_REPORT_NAME = "fieldroutes_push_report.json"
DEFAULT_EXCEPTIONS_NAME = "fieldroutes_push_exceptions.csv"
DEFAULT_REQUEST_LOG_NAME = "fieldroutes_request_log.ndjson"
DEFAULT_CREATE_MISSING_APPOINTMENTS = True
DEFAULT_SERVICE_TYPE_ID = 2

ROUTE_TEMPLATE_FIELD_CANDIDATES = [
    "fieldRoutesTemplateID",
    "fieldroutesTemplateID",
    "fieldroutesTemplateId",
    "routeTemplateID",
    "routeTemplateId",
    "templateID",
    "templateId",
]


def _bool_env(name: str, default: bool = False) -> bool:
    raw = str(os.environ.get(name, "1" if default else "0") or "").strip().lower()
    return raw not in {"0", "false", "no", "off", ""}


def _iso_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Push one-day routing assignments into FieldRoutes with skip+report safety defaults."
    )
    parser.add_argument("--csv", help="Path to routing plan CSV (base or edited).")
    parser.add_argument("--run-id", help="Run ID under FR_DATA_ROOT/runs/<runId>.")
    parser.add_argument("--edited", action="store_true", help="Use run-scoped edited CSV when --run-id is provided.")
    parser.add_argument("--date", required=True, help="Route date scope in YYYY-MM-DD format.")
    parser.add_argument(
        "--preferred-tech",
        help="Optional preferredTech scope. Uses normalized exact full-name match against CSV preferredTech.",
    )
    parser.add_argument("--dry-run", action="store_true", help="Plan-only mode (default if --apply is omitted).")
    parser.add_argument("--apply", action="store_true", help="Execute route/appointment writes.")
    parser.add_argument("--sync-duration", action="store_true", help="Also write duration to appointment/update.")
    return parser.parse_args()


def _validate_date(date_text: str) -> str:
    normalized = normalize_date(date_text)
    try:
        datetime.strptime(normalized, "%Y-%m-%d")
    except Exception as e:
        raise ValueError(f"Invalid --date '{date_text}'. Expected YYYY-MM-DD.") from e
    return normalized


def _candidate_data_roots() -> List[Path]:
    base_dir = Path(__file__).resolve().parents[1]
    env_root = str(os.environ.get("FR_DATA_ROOT", "")).strip()
    candidates = []
    if env_root:
        candidates.append(Path(env_root).expanduser())
    candidates.extend([Path("/data"), base_dir / "data"])
    unique: List[Path] = []
    seen = set()
    for p in candidates:
        key = str(p)
        if key in seen:
            continue
        seen.add(key)
        unique.append(p.resolve())
    return unique


def _resolve_run_dir(run_id: str) -> Path:
    for root in _candidate_data_roots():
        candidate = (root / "runs" / run_id).resolve()
        if candidate.exists():
            return candidate
    root = _candidate_data_roots()[0]
    return (root / "runs" / run_id).resolve()


def _resolve_input_and_output(args: argparse.Namespace) -> Tuple[Path, Optional[str], Path]:
    if not args.csv and not args.run_id:
        raise ValueError("Provide either --csv or --run-id.")

    run_id = str(args.run_id).strip() if args.run_id else None
    csv_path: Optional[Path] = None
    output_dir: Optional[Path] = None

    if run_id:
        run_dir = _resolve_run_dir(run_id)
        if args.csv:
            csv_path = Path(args.csv).expanduser().resolve()
        else:
            csv_name = "routing_plan.edited.csv" if bool(args.edited) else "routing_plan.csv"
            csv_path = (run_dir / csv_name).resolve()
        output_dir = run_dir
    else:
        csv_path = Path(args.csv).expanduser().resolve()
        output_dir = csv_path.parent

    if not csv_path.exists():
        raise FileNotFoundError(f"CSV file not found: {csv_path}")
    assert output_dir is not None
    output_dir.mkdir(parents=True, exist_ok=True)
    return csv_path, run_id, output_dir


def _route_record_matches(rec: Dict[str, Any], tech_id: str, date: str) -> bool:
    rec_date = normalize_date(first_present(rec, ["date", "routeDate", "serviceDate"]))
    rec_tech = str(first_present(rec, ASSIGNED_TECH_FIELD_CANDIDATES) or "").strip()
    if not rec_date:
        return False
    if rec_date != date:
        return False
    if rec_tech and rec_tech != str(tech_id):
        return False
    return True


def _date_variants(date_text: str) -> List[str]:
    normalized = normalize_date(date_text)
    variants: List[str] = []

    def _add(value: str) -> None:
        value_s = str(value or "").strip()
        if not value_s:
            return
        if value_s not in variants:
            variants.append(value_s)

    _add(normalized)
    try:
        dt = datetime.strptime(normalized, "%Y-%m-%d")
        _add(dt.strftime("%m/%d/%Y"))
        _add(f"{dt.month}/{dt.day}/{dt.year}")
        _add(dt.strftime("%Y%m%d"))
    except Exception:
        pass
    return variants


def _extract_route_id_from_payload(payload: Any, tech_id: str, date: str) -> str:
    records = extract_records(payload, ("routes", "results", "items", "data"))
    for rec in records:
        route_id = extract_route_id(rec)
        if route_id and _route_record_matches(rec, tech_id, date):
            return route_id

    if isinstance(payload, dict):
        direct = first_present(payload, ROUTE_ID_FIELD_CANDIDATES)
        if direct:
            return str(direct).strip()
        nested = payload.get("data")
        if isinstance(nested, dict):
            direct_nested = first_present(nested, ROUTE_ID_FIELD_CANDIDATES)
            if direct_nested:
                return str(direct_nested).strip()
    return ""


def _extract_rows_for_appointment_get(payload: Any) -> List[Dict[str, Any]]:
    rows = extract_records(payload, ("appointments", "results", "items", "data"))
    if rows:
        return rows
    if isinstance(payload, dict):
        appt_id = first_present(payload, APPOINTMENT_ID_FIELD_CANDIDATES)
        if appt_id:
            return [payload]
    return []


def _extract_appointment_id_from_payload(payload: Any) -> str:
    for rec in _extract_rows_for_appointment_get(payload):
        appointment_id = extract_appointment_id(rec)
        if appointment_id:
            return appointment_id
    if isinstance(payload, dict):
        direct = first_present(payload, APPOINTMENT_ID_FIELD_CANDIDATES)
        if direct:
            return str(direct).strip()
        nested = payload.get("data")
        if isinstance(nested, dict):
            nested_direct = first_present(nested, APPOINTMENT_ID_FIELD_CANDIDATES)
            if nested_direct:
                return str(nested_direct).strip()
    return ""


def _fetch_appointments_for_date(client: FieldRoutesClient, date: str) -> List[Dict[str, Any]]:
    combined: Dict[str, Dict[str, Any]] = {}
    max_pages = 40

    def _scan_pages(status_value: Optional[int], query_date: str) -> None:
        for page in range(1, max_pages + 1):
            payload = client.appointment_search(
                date_start=query_date,
                date_end=query_date,
                status=status_value,
                include_data=1,
                page=page,
            )
            rows = extract_records(payload, ("appointments", "results", "items", "data"))
            if not rows and page == 1 and isinstance(payload, dict):
                appt_id = first_present(payload, APPOINTMENT_ID_FIELD_CANDIDATES)
                if appt_id:
                    rows = [payload]

            new_count = 0
            for rec in rows:
                appt_id = extract_appointment_id(rec)
                if not appt_id:
                    continue
                if appt_id not in combined:
                    new_count += 1
                combined[appt_id] = rec

            if not rows:
                break
            if page > 1 and new_count == 0:
                break

            total_pages = first_present(payload if isinstance(payload, dict) else {}, ["totalPages", "pages", "lastPage"])
            if total_pages not in (None, ""):
                try:
                    if page >= int(float(str(total_pages))):
                        break
                except Exception:
                    pass

            # If API is not paginated, page 2 usually repeats or empties.
            if page >= 2 and new_count == 0:
                break

    # Try multiple date encodings because some FieldRoutes environments
    # require DayID-style formats instead of ISO date strings.
    for query_date in _date_variants(date):
        _scan_pages(0, query_date)
        try:
            _scan_pages(None, query_date)
        except Exception:
            # Some deployments require explicit status; keep prior results.
            pass

    records = list(combined.values())
    if not records:
        return records

    # If search returns records without date or match keys, hydrate with appointment/get.
    needs_hydrate = False
    for rec in records:
        has_date = bool(extract_appointment_date(rec))
        has_key = bool(extract_subscription_id(rec) or extract_customer_id(rec))
        if not has_date or not has_key:
            needs_hydrate = True
            break

    if not needs_hydrate:
        return records

    hydrated: Dict[str, Dict[str, Any]] = {}
    ids = [extract_appointment_id(rec) for rec in records if extract_appointment_id(rec)]
    chunk_size = 500
    for i in range(0, len(ids), chunk_size):
        batch_ids = ids[i : i + chunk_size]
        if not batch_ids:
            continue
        payload = client.appointment_get(appointment_ids=batch_ids, include_data=1)
        for rec in _extract_rows_for_appointment_get(payload):
            appt_id = extract_appointment_id(rec)
            if appt_id:
                hydrated[appt_id] = rec

    if hydrated:
        merged = dict(combined)
        merged.update(hydrated)
        return list(merged.values())
    return records


def _exception_row(base: Dict[str, Any], reason: str, details: str = "") -> Dict[str, Any]:
    out = dict(base)
    out["reason"] = reason
    out["details"] = details
    return out


def _row_base_fields(row: PlanRow) -> Dict[str, Any]:
    return {
        "rowNumber": row.row_number,
        "planStopId": row.plan_stop_id,
        "customerID": row.customer_id,
        "subscriptionID": row.subscription_id,
        "preferredTech": row.preferred_tech,
        "routeDate": row.route_date,
        "routeName": row.route_name,
        "sequence": row.sequence,
    }


def _parse_int(value: Any) -> Optional[int]:
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        return int(float(raw))
    except Exception:
        return None


def _is_tuesday(date_text: str) -> bool:
    try:
        dt = datetime.strptime(normalize_date(date_text), "%Y-%m-%d")
        return dt.weekday() == 1
    except Exception:
        return False


def _resolve_route_template_for_group(
    *,
    route_date: str,
    group_rows: List[PlanRow],
    template_id_specialty: Optional[int],
    template_id_regular: Optional[int],
    template_id_lawn: Optional[int],
    template_id_tuesday: Optional[int],
    template_id_default: Optional[int],
) -> Tuple[Optional[int], str]:
    if _is_tuesday(route_date) and template_id_tuesday is not None:
        return int(template_id_tuesday), "tuesday_override"

    explicit_values: List[int] = []
    for row in group_rows:
        for key in ROUTE_TEMPLATE_FIELD_CANDIDATES:
            parsed = _parse_int(row.raw.get(key))
            if parsed is None:
                continue
            explicit_values.append(parsed)
            break
    if explicit_values:
        top = Counter(explicit_values).most_common(1)[0][0]
        return int(top), "csv_explicit"

    score = {"specialty": 0, "regular": 0, "lawn": 0}
    for row in group_rows:
        blob = " ".join(
            [
                str(row.route_name or ""),
                str(row.raw.get("dayType") or ""),
                str(row.raw.get("assignmentReason") or ""),
                str(row.raw.get("capacityReason") or ""),
                str(row.raw.get("schedulingRequestClass") or ""),
                str(row.raw.get("serviceType") or ""),
                str(row.raw.get("type") or ""),
            ]
        ).lower()
        if "specialty" in blob or "speciality" in blob:
            score["specialty"] += 1
        if "regular" in blob:
            score["regular"] += 1
        if "lawn" in blob:
            score["lawn"] += 1

    ranked = sorted(score.items(), key=lambda item: item[1], reverse=True)
    if ranked and ranked[0][1] > 0:
        winner = ranked[0][0]
        if winner == "specialty" and template_id_specialty is not None:
            return int(template_id_specialty), "specialty_match"
        if winner == "regular" and template_id_regular is not None:
            return int(template_id_regular), "regular_match"
        if winner == "lawn" and template_id_lawn is not None:
            return int(template_id_lawn), "lawn_match"

    if template_id_default is not None:
        return int(template_id_default), "default"
    return None, "none"


def _resolve_service_type_for_row(row: PlanRow, default_service_type: Optional[int]) -> Optional[int]:
    for key in ("type", "serviceID", "serviceId", "serviceType", "service_type"):
        value = _parse_int(row.raw.get(key))
        if value is not None:
            return value
    return default_service_type


def _extract_service_type_from_record(rec: Dict[str, Any]) -> Optional[int]:
    return _parse_int(first_present(rec, ["type", "serviceID", "serviceId", "serviceType", "service_type"]))


def _write_json(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def _write_exceptions_csv(path: Path, rows: Iterable[Dict[str, Any]]) -> None:
    rows_list = list(rows)
    if not rows_list:
        headers = [
            "rowNumber",
            "planStopId",
            "customerID",
            "subscriptionID",
            "preferredTech",
            "routeDate",
            "routeName",
            "sequence",
            "reason",
            "details",
            "appointmentID",
            "matchKey",
        ]
        with path.open("w", encoding="utf-8", newline="") as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
        return

    headers: List[str] = []
    seen = set()
    for row in rows_list:
        for key in row.keys():
            if key in seen:
                continue
            seen.add(key)
            headers.append(key)

    with path.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=headers, extrasaction="ignore")
        writer.writeheader()
        for row in rows_list:
            writer.writerow(row)


def _write_request_log(path: Path, events: Iterable[Dict[str, Any]]) -> None:
    with path.open("w", encoding="utf-8") as f:
        for event in events:
            f.write(json.dumps(event, ensure_ascii=False) + "\n")


def main() -> int:
    args = _parse_args()

    if args.apply and args.dry_run:
        raise SystemExit("Choose either --dry-run or --apply, not both.")
    apply_mode = bool(args.apply)
    dry_run = not apply_mode
    if args.dry_run:
        dry_run = True
        apply_mode = False

    pilot_date = _validate_date(args.date or DEFAULT_PILOT_DATE)
    csv_path, run_id, output_dir = _resolve_input_and_output(args)
    preferred_tech_scope_raw = str(args.preferred_tech or "").strip()
    preferred_tech_scope_norm = normalize_name(preferred_tech_scope_raw)

    report_path = output_dir / DEFAULT_REPORT_NAME
    exceptions_path = output_dir / DEFAULT_EXCEPTIONS_NAME
    request_log_path = output_dir / DEFAULT_REQUEST_LOG_NAME

    rows, parse_skips = load_plan_rows_for_date(csv_path, pilot_date)
    if preferred_tech_scope_norm:
        rows = [row for row in rows if normalize_name(row.preferred_tech) == preferred_tech_scope_norm]
    request_events: List[Dict[str, Any]] = []
    exceptions: List[Dict[str, Any]] = []
    outcomes: List[Dict[str, Any]] = []

    for skip in parse_skips:
        exceptions.append(_exception_row(skip, reason=skip.get("reason", "INVALID_ROW"), details=skip.get("details", "")))

    if not rows:
        payload = {
            "ok": True,
            "mode": "dry-run" if dry_run else "apply",
            "runId": run_id,
            "date": pilot_date,
            "preferredTech": (preferred_tech_scope_raw or None),
            "inputCsv": str(csv_path),
            "startedAt": _iso_now(),
            "finishedAt": _iso_now(),
            "summary": {
                "totalScopedRows": 0,
                "updated": 0,
                "unchanged": 0,
                "skipped": len(exceptions),
                "failed_api": 0,
            },
            "outcomes": outcomes,
            "exceptions": exceptions,
        }
        _write_json(report_path, payload)
        _write_exceptions_csv(exceptions_path, exceptions)
        _write_request_log(request_log_path, request_events)
        print(f"No eligible rows for date {pilot_date}. Report: {report_path}")
        return 0

    config = FieldRoutesConfig.from_env()
    bypass_locked = _bool_env("FIELDROUTES_BYPASS_LOCKED_ROUTE", False)
    bypass_schedule_perm = _bool_env("FIELDROUTES_BYPASS_SCHEDULE_PERMISSION", False)
    create_missing_appointments = _bool_env(
        "FIELDROUTES_CREATE_MISSING_APPOINTMENTS",
        DEFAULT_CREATE_MISSING_APPOINTMENTS,
    )
    default_service_type = _parse_int(os.environ.get("FIELDROUTES_DEFAULT_SERVICE_ID", ""))
    if default_service_type is None:
        default_service_type = DEFAULT_SERVICE_TYPE_ID
    template_id_specialty = _parse_int(os.environ.get("FIELDROUTES_ROUTE_TEMPLATE_ID_SPECIALTY", "35"))
    template_id_regular = _parse_int(os.environ.get("FIELDROUTES_ROUTE_TEMPLATE_ID_REGULAR", "34"))
    template_id_lawn = _parse_int(os.environ.get("FIELDROUTES_ROUTE_TEMPLATE_ID_LAWN", "38"))
    template_id_tuesday = _parse_int(os.environ.get("FIELDROUTES_ROUTE_TEMPLATE_ID_TUESDAY", "26"))
    template_id_default = _parse_int(
        os.environ.get(
            "FIELDROUTES_ROUTE_TEMPLATE_ID_DEFAULT",
            str(template_id_regular if template_id_regular is not None else ""),
        )
    )
    client = FieldRoutesClient(config, log_sink=request_events.append)

    started_at = _iso_now()
    summary = {
        "totalScopedRows": len(rows),
        "updated": 0,
        "unchanged": 0,
        "would_update": 0,
        "skipped_missing_tech": 0,
        "skipped_ambiguous_tech": 0,
        "skipped_missing_appointment": 0,
        "skipped_ambiguous_appointment": 0,
        "skipped_route_unavailable": 0,
        "failed_api": 0,
        "route_creates_planned": 0,
        "route_creates_applied": 0,
        "route_creates_failed": 0,
        "route_creates_with_template": 0,
        "route_creates_without_template": 0,
        "created_appointments_planned": 0,
        "created_appointments_applied": 0,
        "created_appointments_failed": 0,
        "skipped_missing_service_type": 0,
        "appointments_fetched": 0,
        "appointments_with_date": 0,
        "appointments_with_match_key": 0,
        "default_service_type_inferred": None,
    }

    try:
        client.preflight_auth()
    except Exception as e:
        raise RuntimeError(f"FieldRoutes auth preflight failed: {e}") from e

    employee_payload = client.employee_search(includeData=1, active=1)
    employee_records = extract_records(employee_payload, ("employees", "results", "items", "data"))
    tech_lookup, tech_ambiguous = build_employee_lookup(employee_records)

    # Resolve tech IDs and keep only rows that pass tech matching.
    eligible_rows: List[Tuple[PlanRow, str]] = []
    route_rows_by_key: Dict[Tuple[str, str], List[PlanRow]] = {}
    for row in rows:
        row_base = _row_base_fields(row)
        tech_key = normalize_name(row.preferred_tech)
        if not tech_key:
            summary["skipped_missing_tech"] += 1
            exceptions.append(_exception_row(row_base, "MISSING_TECH", "preferredTech is empty."))
            continue
        if tech_key in tech_ambiguous:
            summary["skipped_ambiguous_tech"] += 1
            details = f"Ambiguous tech name '{row.preferred_tech}' matched employee IDs: {tech_ambiguous.get(tech_key)}"
            exceptions.append(_exception_row(row_base, "AMBIGUOUS_TECH", details))
            continue
        tech_id = tech_lookup.get(tech_key)
        if not tech_id:
            summary["skipped_missing_tech"] += 1
            exceptions.append(_exception_row(row_base, "TECH_NOT_FOUND", f"No active employee match for '{row.preferred_tech}'"))
            continue
        eligible_rows.append((row, tech_id))
        route_rows_by_key.setdefault((tech_id, row.route_date), []).append(row)

    # Resolve or create routes once per (tech,date).
    route_resolution: Dict[Tuple[str, str], Dict[str, Any]] = {}
    grouped_route_keys = sorted(route_rows_by_key.keys())
    for tech_id, route_date in grouped_route_keys:
        key = (tech_id, route_date)
        group_rows = route_rows_by_key.get(key, [])
        template_id, template_source = _resolve_route_template_for_group(
            route_date=route_date,
            group_rows=group_rows,
            template_id_specialty=template_id_specialty,
            template_id_regular=template_id_regular,
            template_id_lawn=template_id_lawn,
            template_id_tuesday=template_id_tuesday,
            template_id_default=template_id_default,
        )
        route_resolution[key] = {
            "techId": tech_id,
            "routeDate": route_date,
            "dateInputUsed": "",
            "routeId": "",
            "templateId": template_id,
            "templateSource": template_source,
            "status": "unknown",
            "message": "",
        }
        try:
            existing_route_id = ""
            existing_route_date_input = ""
            for query_date in _date_variants(route_date):
                search_payload = client.route_search(assigned_tech=tech_id, date=query_date, include_data=1)
                existing_route_id = _extract_route_id_from_payload(search_payload, tech_id, route_date)
                if existing_route_id:
                    existing_route_date_input = query_date
                    break
            if existing_route_id:
                route_resolution[key]["routeId"] = existing_route_id
                route_resolution[key]["dateInputUsed"] = existing_route_date_input or route_date
                route_resolution[key]["status"] = "existing"
                continue

            if dry_run:
                summary["route_creates_planned"] += 1
                route_resolution[key]["status"] = "planned_create"
                route_resolution[key]["dateInputUsed"] = _date_variants(route_date)[0] if _date_variants(route_date) else route_date
                route_resolution[key]["message"] = (
                    f"Dry-run: route/create not called. templateID={template_id} source={template_source}"
                )
                continue

            created_route_id = ""
            used_create_date = ""
            create_errors: List[str] = []
            for query_date in _date_variants(route_date):
                try:
                    create_payload = client.route_create(
                        assigned_tech=tech_id,
                        date=query_date,
                        template_id=template_id,
                        auto_create_group=1,
                    )
                    created_route_id = _extract_route_id_from_payload(create_payload, tech_id, route_date)
                    if created_route_id:
                        used_create_date = query_date
                        break
                except Exception as e:
                    create_errors.append(f"{query_date}: {e}")
                    continue
            if not created_route_id:
                summary["route_creates_failed"] += 1
                route_resolution[key]["status"] = "create_failed"
                route_resolution[key]["message"] = (
                    "; ".join(create_errors) if create_errors else "route/create returned no routeID."
                )
                continue
            summary["route_creates_applied"] += 1
            if template_id is None:
                summary["route_creates_without_template"] += 1
            else:
                summary["route_creates_with_template"] += 1
            route_resolution[key]["routeId"] = created_route_id
            route_resolution[key]["dateInputUsed"] = used_create_date or route_date
            route_resolution[key]["status"] = "created"
        except Exception as e:
            summary["route_creates_failed"] += 1
            route_resolution[key]["status"] = "create_failed"
            route_resolution[key]["message"] = str(e)

    appointment_records = _fetch_appointments_for_date(client, pilot_date)
    if default_service_type is None:
        inferred_counts: Dict[int, int] = {}
        for rec in appointment_records:
            service_type_value = _extract_service_type_from_record(rec)
            if service_type_value is None:
                continue
            inferred_counts[service_type_value] = inferred_counts.get(service_type_value, 0) + 1
        if inferred_counts:
            default_service_type = sorted(inferred_counts.items(), key=lambda item: (-item[1], item[0]))[0][0]
            summary["default_service_type_inferred"] = default_service_type
    summary["appointments_fetched"] = len(appointment_records)
    summary["appointments_with_date"] = sum(1 for rec in appointment_records if extract_appointment_date(rec))
    summary["appointments_with_match_key"] = sum(
        1 for rec in appointment_records if (extract_subscription_id(rec) or extract_customer_id(rec))
    )
    by_subscription, by_customer, _ = build_appointment_indexes(appointment_records, fallback_date=pilot_date)

    # Prevent conflicting writes to the same appointment in one run.
    claimed_targets: Dict[str, Dict[str, Any]] = {}

    for row, tech_id in eligible_rows:
        row_base = _row_base_fields(row)
        route_key = (tech_id, row.route_date)
        route_info = route_resolution.get(route_key, {})
        target_route_id = str(route_info.get("routeId", "")).strip()
        duration_to_write = row.duration if bool(args.sync_duration) else None

        if not target_route_id and route_info.get("status") == "create_failed":
            summary["skipped_route_unavailable"] += 1
            exceptions.append(
                _exception_row(
                    row_base,
                    "ROUTE_UNAVAILABLE",
                    f"Route unavailable for tech/date {route_key}: {route_info.get('message', '')}",
                )
            )
            continue

        match_key = ""
        candidates: List[Dict[str, Any]] = []
        if row.subscription_id:
            match_key = "subscriptionID"
            candidates = by_subscription.get((row.subscription_id, row.route_date), [])
            if len(candidates) > 1:
                summary["skipped_ambiguous_appointment"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "AMBIGUOUS_APPOINTMENT",
                        f"subscriptionID/date matched {len(candidates)} appointments.",
                    )
                )
                continue

        if not candidates:
            match_key = "customerID"
            candidates = by_customer.get((row.customer_id, row.route_date), [])

        if len(candidates) == 0:
            if not create_missing_appointments:
                summary["skipped_missing_appointment"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "MISSING_APPOINTMENT",
                        "No appointment matched by subscriptionID/date or customerID/date.",
                    )
                )
                continue

            service_type = _resolve_service_type_for_row(row, default_service_type)
            if service_type is None:
                summary["skipped_missing_service_type"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "MISSING_SERVICE_TYPE",
                        "No service type available for appointment/create. Set FIELDROUTES_DEFAULT_SERVICE_ID or include serviceID/type column.",
                    )
                )
                continue

            if not target_route_id and dry_run:
                summary["created_appointments_planned"] += 1
                outcomes.append(
                    {
                        **row_base,
                        "appointmentID": "",
                        "matchKey": "appointment/create",
                        "assignedTechID": tech_id,
                        "targetRouteID": target_route_id,
                        "currentRouteID": "",
                        "currentAssignedTechID": "",
                        "currentSequence": None,
                        "action": "would_create_appointment_after_route_create",
                        "plannedServiceType": service_type,
                    }
                )
                continue

            if dry_run:
                summary["created_appointments_planned"] += 1
                outcomes.append(
                    {
                        **row_base,
                        "appointmentID": "",
                        "matchKey": "appointment/create",
                        "assignedTechID": tech_id,
                        "targetRouteID": target_route_id,
                        "currentRouteID": "",
                        "currentAssignedTechID": "",
                        "currentSequence": None,
                        "action": "would_create_appointment",
                        "plannedServiceType": service_type,
                    }
                )
                continue

            if not target_route_id:
                summary["skipped_route_unavailable"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "ROUTE_UNAVAILABLE",
                        "No routeID available for appointment/create in apply mode.",
                    )
                )
                continue

            try:
                create_params: Dict[str, Any] = {}
                if bypass_locked:
                    create_params["bypassLockedRoute"] = 1
                if bypass_schedule_perm:
                    create_params["bypassSchedulePermission"] = 1
                create_payload = client.appointment_create(
                    customer_id=row.customer_id,
                    service_type=service_type,
                    route_id=target_route_id,
                    assigned_tech=tech_id,
                    subscription_id=(row.subscription_id or None),
                    sequence=row.sequence,
                    duration=duration_to_write,
                    **create_params,
                )
                appointment_id = _extract_appointment_id_from_payload(create_payload)
                if not appointment_id:
                    summary["created_appointments_failed"] += 1
                    summary["failed_api"] += 1
                    exceptions.append(
                        _exception_row(
                            row_base,
                            "FAILED_API",
                            "appointment/create returned no appointmentID.",
                        )
                    )
                    continue

                summary["created_appointments_applied"] += 1
                summary["updated"] += 1
                outcomes.append(
                    {
                        **row_base,
                        "appointmentID": appointment_id,
                        "matchKey": "appointment/create",
                        "assignedTechID": tech_id,
                        "targetRouteID": target_route_id,
                        "currentRouteID": "",
                        "currentAssignedTechID": "",
                        "currentSequence": None,
                        "action": "created_appointment",
                        "plannedServiceType": service_type,
                    }
                )
                continue
            except FieldRoutesApiError as e:
                summary["created_appointments_failed"] += 1
                summary["failed_api"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "FAILED_API",
                        f"appointment/create failed: {e}",
                    )
                )
                outcomes.append({**row_base, "action": "failed_api", "error": str(e), "matchKey": "appointment/create"})
                continue

        if len(candidates) > 1:
            summary["skipped_ambiguous_appointment"] += 1
            exceptions.append(
                _exception_row(
                    row_base,
                    "AMBIGUOUS_APPOINTMENT",
                    f"{match_key}/date matched {len(candidates)} appointments.",
                )
            )
            continue

        appointment = candidates[0]
        appointment_id = extract_appointment_id(appointment)
        if not appointment_id:
            summary["skipped_missing_appointment"] += 1
            exceptions.append(_exception_row(row_base, "MISSING_APPOINTMENT_ID", "Matched record has no appointmentID."))
            continue

        if appointment_id in claimed_targets:
            prior = claimed_targets[appointment_id]
            same_target = (
                str(prior.get("targetRouteId", "")) == str(target_route_id)
                and int(prior.get("sequence", -1)) == int(row.sequence)
                and str(prior.get("assignedTech", "")) == str(tech_id)
            )
            if not same_target:
                summary["skipped_ambiguous_appointment"] += 1
                exceptions.append(
                    _exception_row(
                        row_base,
                        "DUPLICATE_APPOINTMENT_TARGET",
                        f"appointmentID {appointment_id} already mapped by row {prior.get('rowNumber')}.",
                    )
                )
                continue
        else:
            claimed_targets[appointment_id] = {
                "rowNumber": row.row_number,
                "targetRouteId": target_route_id,
                "assignedTech": tech_id,
                "sequence": row.sequence,
            }

        current_route_id = str(first_present(appointment, ROUTE_ID_FIELD_CANDIDATES) or "").strip()
        current_tech = str(first_present(appointment, ASSIGNED_TECH_FIELD_CANDIDATES) or "").strip()
        current_sequence = extract_sequence(appointment)

        if target_route_id:
            unchanged = (
                current_route_id == target_route_id
                and current_tech == str(tech_id)
                and current_sequence == int(row.sequence)
            )
        else:
            unchanged = False

        action = "unchanged" if unchanged else ("would_update" if dry_run else "updated")
        if not target_route_id and dry_run:
            action = "would_update_after_route_create"

        outcome = {
            **row_base,
            "appointmentID": appointment_id,
            "matchKey": match_key,
            "assignedTechID": tech_id,
            "targetRouteID": target_route_id,
            "currentRouteID": current_route_id,
            "currentAssignedTechID": current_tech,
            "currentSequence": current_sequence,
            "action": action,
            "schedulingRequestClass": row.raw.get("schedulingRequestClass", ""),
            "schedulingCritical": row.raw.get("schedulingCritical", ""),
            "schedulingRequiresPhoneConfirm": row.raw.get("schedulingRequiresPhoneConfirm", ""),
            "schedulingConstraintStatus": row.raw.get("schedulingConstraintStatus", ""),
        }

        if unchanged:
            summary["unchanged"] += 1
            outcomes.append(outcome)
            continue

        if dry_run:
            summary["would_update"] += 1
            outcomes.append(outcome)
            continue

        if not target_route_id:
            summary["skipped_route_unavailable"] += 1
            exceptions.append(
                _exception_row(
                    {**row_base, "appointmentID": appointment_id, "matchKey": match_key},
                    "ROUTE_UNAVAILABLE",
                    "No routeID available for apply mode.",
                )
            )
            continue

        try:
            client.appointment_update(
                appointment_id=appointment_id,
                route_id=target_route_id,
                assigned_tech=tech_id,
                sequence=row.sequence,
                duration=duration_to_write,
                bypass_locked_route=bypass_locked,
                bypass_schedule_permission=bypass_schedule_perm,
            )
            summary["updated"] += 1
            outcomes.append(outcome)
        except FieldRoutesApiError as e:
            summary["failed_api"] += 1
            failure = _exception_row(
                {
                    **row_base,
                    "appointmentID": appointment_id,
                    "matchKey": match_key,
                },
                "FAILED_API",
                str(e),
            )
            exceptions.append(failure)
            outcomes.append({**outcome, "action": "failed_api", "error": str(e)})

    finished_at = _iso_now()
    report_payload = {
        "ok": summary["failed_api"] == 0,
        "mode": "apply" if apply_mode else "dry-run",
        "runId": run_id,
        "date": pilot_date,
        "preferredTech": (preferred_tech_scope_raw or None),
        "inputCsv": str(csv_path),
        "outputs": {
            "report": str(report_path),
            "exceptionsCsv": str(exceptions_path),
            "requestLogNdjson": str(request_log_path),
        },
        "startedAt": started_at,
        "finishedAt": finished_at,
        "summary": summary,
        "routeResolution": [
            {
                "techId": tech_id,
                "routeDate": route_date,
                "dateInputUsed": details.get("dateInputUsed", ""),
                "routeId": details.get("routeId", ""),
                "templateId": details.get("templateId"),
                "templateSource": details.get("templateSource", ""),
                "status": details.get("status", ""),
                "message": details.get("message", ""),
            }
            for (tech_id, route_date), details in sorted(route_resolution.items(), key=lambda x: (x[0][1], x[0][0]))
        ],
        "outcomes": outcomes,
        "exceptions": exceptions,
        "settings": {
            "syncDuration": bool(args.sync_duration),
            "bypassLockedRoute": bool(bypass_locked),
            "bypassSchedulePermission": bool(bypass_schedule_perm),
            "createMissingAppointments": bool(create_missing_appointments),
            "defaultServiceTypeConfigured": default_service_type is not None,
            "defaultServiceTypeValue": default_service_type,
            "routeTemplateIdSpecialty": template_id_specialty,
            "routeTemplateIdRegular": template_id_regular,
            "routeTemplateIdLawn": template_id_lawn,
            "routeTemplateIdTuesday": template_id_tuesday,
            "routeTemplateIdDefault": template_id_default,
            "preferredTechFilter": (preferred_tech_scope_raw or None),
        },
    }

    _write_json(report_path, report_payload)
    _write_exceptions_csv(exceptions_path, exceptions)
    _write_request_log(request_log_path, request_events)

    print(f"Mode: {'apply' if apply_mode else 'dry-run'}")
    print(f"Date: {pilot_date}")
    if preferred_tech_scope_raw:
        print(f"PreferredTech scope: {preferred_tech_scope_raw}")
    print(f"Input CSV: {csv_path}")
    print(f"Report: {report_path}")
    print(f"Exceptions: {exceptions_path}")
    print(f"Request log: {request_log_path}")
    print("Summary:")
    for key in sorted(summary.keys()):
        print(f"  {key}: {summary[key]}")

    return 1 if summary["failed_api"] > 0 else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SystemExit:
        raise
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        raise SystemExit(2)
