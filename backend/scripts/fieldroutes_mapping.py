from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple


REQUIRED_PLAN_COLUMNS = [
    "customerID",
    "preferredTech",
    "routeDate",
    "sequence",
    "routeName",
]

SKIP_UNASSIGNED_TOKEN = "UNASSIGNED"

SUBSCRIPTION_FIELD_CANDIDATES = [
    "subscriptionID",
    "subscriptionId",
    "subscription_id",
    "subscription",
    "subscriptionIDFk",
]

CUSTOMER_FIELD_CANDIDATES = [
    "customerID",
    "customerId",
    "customer_id",
    "customer",
    "accountID",
    "accountId",
]

APPOINTMENT_ID_FIELD_CANDIDATES = [
    "appointmentID",
    "appointmentId",
    "appointment_id",
    "id",
]

ROUTE_ID_FIELD_CANDIDATES = [
    "routeID",
    "routeId",
    "route_id",
]

ASSIGNED_TECH_FIELD_CANDIDATES = [
    "assignedTech",
    "assignedTechID",
    "assignedTechId",
]

SEQUENCE_FIELD_CANDIDATES = [
    "sequence",
    "sortOrder",
    "order",
]

APPOINTMENT_DATE_FIELD_CANDIDATES = [
    "date",
    "dateStart",
    "serviceDate",
    "scheduledDate",
    "appointmentDate",
]

EMPLOYEE_ID_FIELD_CANDIDATES = [
    "employeeID",
    "employeeId",
    "id",
]

EMPLOYEE_NAME_FIELD_CANDIDATES = [
    ("fname", "lname"),
    ("firstName", "lastName"),
    ("first_name", "last_name"),
]


@dataclass
class PlanRow:
    row_number: int
    raw: Dict[str, str]
    plan_stop_id: str
    customer_id: str
    subscription_id: str
    preferred_tech: str
    route_date: str
    route_name: str
    sequence: int
    duration: Optional[int]


def _clean(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def normalize_name(value: str) -> str:
    txt = "".join(ch.lower() if ch.isalnum() else " " for ch in _clean(value))
    return " ".join(txt.split())


def normalize_date(value: Any) -> str:
    raw = _clean(value)
    if not raw:
        return ""
    if len(raw) >= 10 and raw[4] == "-" and raw[7] == "-":
        return raw[:10]
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%Y/%m/%d", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
        except Exception:
            continue
    try:
        # Keep this as a last fallback for ISO-ish values.
        return datetime.fromisoformat(raw.replace("Z", "+00:00")).strftime("%Y-%m-%d")
    except Exception:
        return raw[:10] if len(raw) >= 10 else raw


def first_present(record: Dict[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in record and record.get(key) not in (None, ""):
            return record.get(key)
    return None


def deep_find_first_key(payload: Any, keys: Sequence[str]) -> Any:
    if isinstance(payload, dict):
        for key in keys:
            if key in payload and payload.get(key) not in (None, ""):
                return payload.get(key)
        for value in payload.values():
            hit = deep_find_first_key(value, keys)
            if hit not in (None, ""):
                return hit
    if isinstance(payload, list):
        for item in payload:
            hit = deep_find_first_key(item, keys)
            if hit not in (None, ""):
                return hit
    return None


def extract_records(payload: Any, preferred_keys: Sequence[str] = ()) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if not isinstance(payload, dict):
        return []

    for key in preferred_keys:
        value = payload.get(key)
        if isinstance(value, list):
            return [x for x in value if isinstance(x, dict)]
        if isinstance(value, dict):
            nested = extract_records(value, ())
            if nested:
                return nested

    data = payload.get("data")
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    if isinstance(data, dict):
        for key in ("items", "rows", "results", "employees", "routes", "appointments"):
            value = data.get(key)
            if isinstance(value, list):
                return [x for x in value if isinstance(x, dict)]

    for value in payload.values():
        if isinstance(value, list) and value and isinstance(value[0], dict):
            return [x for x in value if isinstance(x, dict)]

    return []


def load_plan_rows_for_date(csv_path: Path, pilot_date: str) -> Tuple[List[PlanRow], List[Dict[str, str]]]:
    if not csv_path.exists():
        raise FileNotFoundError(f"CSV not found: {csv_path}")

    with csv_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        cols = list(reader.fieldnames or [])
        missing = [c for c in REQUIRED_PLAN_COLUMNS if c not in cols]
        if missing:
            raise ValueError(f"CSV missing required column(s): {', '.join(missing)}")

        rows: List[PlanRow] = []
        skipped: List[Dict[str, str]] = []

        for row_number, raw in enumerate(reader, start=2):
            route_date = normalize_date(raw.get("routeDate"))
            route_name = _clean(raw.get("routeName"))
            if not route_date or route_date != pilot_date:
                continue
            if SKIP_UNASSIGNED_TOKEN in route_name.upper():
                continue

            seq_txt = _clean(raw.get("sequence"))
            try:
                sequence = int(float(seq_txt))
            except Exception:
                skipped.append(
                    {
                        "rowNumber": str(row_number),
                        "planStopId": _clean(raw.get("planStopId")),
                        "reason": "INVALID_SEQUENCE",
                        "details": f"sequence='{seq_txt}'",
                    }
                )
                continue

            duration = None
            dur_raw = _clean(raw.get("duration"))
            if dur_raw:
                try:
                    duration = int(float(dur_raw))
                except Exception:
                    duration = None

            rows.append(
                PlanRow(
                    row_number=row_number,
                    raw={str(k): _clean(v) for k, v in raw.items()},
                    plan_stop_id=_clean(raw.get("planStopId")),
                    customer_id=_clean(raw.get("customerID")),
                    subscription_id=_clean(raw.get("subscriptionID")),
                    preferred_tech=_clean(raw.get("preferredTech")),
                    route_date=route_date,
                    route_name=route_name,
                    sequence=sequence,
                    duration=duration,
                )
            )

    return rows, skipped


def build_employee_lookup(employee_records: Iterable[Dict[str, Any]]) -> Tuple[Dict[str, str], Dict[str, List[str]]]:
    resolved: Dict[str, str] = {}
    ambiguous: Dict[str, List[str]] = {}

    for rec in employee_records:
        employee_id = _clean(first_present(rec, EMPLOYEE_ID_FIELD_CANDIDATES))
        if not employee_id:
            continue

        full_name = ""
        for first_key, last_key in EMPLOYEE_NAME_FIELD_CANDIDATES:
            first = _clean(rec.get(first_key))
            last = _clean(rec.get(last_key))
            if first or last:
                full_name = f"{first} {last}".strip()
                break
        if not full_name:
            full_name = _clean(first_present(rec, ["name", "fullName"]))
        if not full_name:
            continue

        key = normalize_name(full_name)
        if not key:
            continue
        if key in resolved and resolved[key] != employee_id:
            ambiguous.setdefault(key, sorted({resolved[key]}))
            if employee_id not in ambiguous[key]:
                ambiguous[key].append(employee_id)
            continue
        resolved[key] = employee_id

    for key in list(ambiguous.keys()):
        if key in resolved:
            del resolved[key]
        ambiguous[key] = sorted(set(ambiguous[key]))
    return resolved, ambiguous


def extract_appointment_id(rec: Dict[str, Any]) -> str:
    return _clean(first_present(rec, APPOINTMENT_ID_FIELD_CANDIDATES))


def extract_route_id(rec: Dict[str, Any]) -> str:
    return _clean(first_present(rec, ROUTE_ID_FIELD_CANDIDATES))


def extract_assigned_tech_id(rec: Dict[str, Any]) -> str:
    return _clean(first_present(rec, ASSIGNED_TECH_FIELD_CANDIDATES))


def extract_sequence(rec: Dict[str, Any]) -> Optional[int]:
    value = first_present(rec, SEQUENCE_FIELD_CANDIDATES)
    if value in (None, ""):
        return None
    try:
        return int(float(str(value)))
    except Exception:
        return None


def extract_customer_id(rec: Dict[str, Any]) -> str:
    value = first_present(rec, CUSTOMER_FIELD_CANDIDATES)
    if isinstance(value, (dict, list, tuple, set)):
        value = None
    if value in (None, ""):
        value = deep_find_first_key(rec, CUSTOMER_FIELD_CANDIDATES)
    if isinstance(value, dict):
        nested = first_present(value, ["customerID", "customerId", "customer_id", "accountID", "accountId", "id"])
        if nested in (None, ""):
            nested = deep_find_first_key(value, ["customerID", "customerId", "customer_id", "accountID", "accountId", "id"])
        value = nested
    if isinstance(value, (list, tuple, set)):
        value = None
    return _clean(value)


def extract_subscription_id(rec: Dict[str, Any]) -> str:
    value = first_present(rec, SUBSCRIPTION_FIELD_CANDIDATES)
    if isinstance(value, (dict, list, tuple, set)):
        value = None
    if value in (None, ""):
        value = deep_find_first_key(rec, SUBSCRIPTION_FIELD_CANDIDATES)
    if isinstance(value, dict):
        nested = first_present(value, ["subscriptionID", "subscriptionId", "subscription_id", "subscriptionIDFk", "id"])
        if nested in (None, ""):
            nested = deep_find_first_key(
                value,
                ["subscriptionID", "subscriptionId", "subscription_id", "subscriptionIDFk", "id"],
            )
        value = nested
    if isinstance(value, (list, tuple, set)):
        value = None
    return _clean(value)


def extract_appointment_date(rec: Dict[str, Any]) -> str:
    value = first_present(rec, APPOINTMENT_DATE_FIELD_CANDIDATES)
    if value in (None, ""):
        value = deep_find_first_key(rec, APPOINTMENT_DATE_FIELD_CANDIDATES)
    return normalize_date(value)


def build_appointment_indexes(
    appointment_records: Iterable[Dict[str, Any]],
    *,
    fallback_date: str = "",
) -> Tuple[Dict[Tuple[str, str], List[Dict[str, Any]]], Dict[Tuple[str, str], List[Dict[str, Any]]], Dict[str, Dict[str, Any]]]:
    by_subscription: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    by_customer: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
    by_id: Dict[str, Dict[str, Any]] = {}

    fallback_date_norm = normalize_date(fallback_date)

    for rec in appointment_records:
        appointment_id = extract_appointment_id(rec)
        if not appointment_id:
            continue
        by_id[appointment_id] = rec

        date_key = extract_appointment_date(rec)
        if not date_key:
            date_key = fallback_date_norm
        if not date_key:
            continue

        subscription_id = extract_subscription_id(rec)
        if subscription_id:
            by_subscription.setdefault((subscription_id, date_key), []).append(rec)

        customer_id = extract_customer_id(rec)
        if customer_id:
            by_customer.setdefault((customer_id, date_key), []).append(rec)

    return by_subscription, by_customer, by_id
