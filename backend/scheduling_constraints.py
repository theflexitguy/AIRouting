"""
Scheduling Constraints Parser
=============================
Extracted from routing_engine.py — parses free-text scheduling requests
from FieldRoutes into structured constraint classifications.

Usage:
    from scheduling_constraints import parse_scheduling_request
    result = parse_scheduling_request("Fridays only, call before coming")
    # result["schedulingRequestClass"] == "HARD_WEEKDAY_ONLY"
    # result["schedulingAllowedWeekdays"] == "FRI"
    # result["schedulingRequiresPhoneConfirm"] == True
"""

from __future__ import annotations

import re
from typing import Any


_WEEKDAY_LABELS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]

_WEEKDAY_INDEX_BY_TOKEN = {
    "mon": 0, "monday": 0, "mondays": 0,
    "tue": 1, "tues": 1, "tuesday": 1, "tuesdays": 1,
    "wed": 2, "weds": 2, "wednesday": 2, "wednesdays": 2,
    "thu": 3, "thur": 3, "thurs": 3, "thursday": 3, "thursdays": 3,
    "fri": 4, "friday": 4, "fridays": 4,
    "sat": 5, "saturday": 5, "saturdays": 5,
    "sun": 6, "sunday": 6, "sundays": 6,
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

# Classes that should exclude a job from routing
CRITICAL_CLASSES = frozenset({
    "DO_NOT_SCHEDULE",
    "PAYMENT_OR_ACCOUNT_HOLD",
    "MOVE_OR_ADDRESS_HOLD",
})


def _normalize_sched_text(value: Any) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if not text or text.lower() in {"nan", "none", "null"}:
        return ""
    return text


def _extract_weekday_indices(text: str) -> set[int]:
    out: set[int] = set()
    for token in re.findall(r"\b[a-z]{3,10}\b", str(text or "").lower()):
        idx = _WEEKDAY_INDEX_BY_TOKEN.get(token)
        if idx is not None:
            out.add(idx)
    return out


def _serialize_weekdays(values: set[int]) -> str:
    ordered = [v for v in sorted(values) if 0 <= v <= 6]
    return ",".join([_WEEKDAY_LABELS[v] for v in ordered])


def parse_scheduling_request(value: Any) -> dict[str, Any]:
    """Parse a free-text scheduling request into structured constraints."""
    raw = _normalize_sched_text(value)
    result: dict[str, Any] = {
        "schedulingRequestRaw": raw,
        "schedulingRequestClass": "",
        "schedulingAllowedWeekdays": "",
        "schedulingBlockedWeekdays": "",
        "schedulingRequiresPhoneConfirm": False,
        "schedulingCritical": False,
        "schedulingConstraintNote": "",
    }
    if not raw:
        return result

    txt = str(raw)
    lowered = txt.lower()
    all_weekdays = _extract_weekday_indices(lowered)
    blocked: set[int] = set()
    allowed: set[int] = set()

    for m in _BLOCKED_WEEKDAY_PATTERN.finditer(lowered):
        blocked |= _extract_weekday_indices(m.group(2))
    if _ONLY_WEEKDAY_PATTERN.search(lowered) and all_weekdays:
        allowed |= set(all_weekdays)
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
        note_parts.append("critical hold")

    result["schedulingRequestClass"] = class_name
    result["schedulingAllowedWeekdays"] = _serialize_weekdays(allowed)
    result["schedulingBlockedWeekdays"] = _serialize_weekdays(blocked)
    result["schedulingRequiresPhoneConfirm"] = requires_phone
    result["schedulingCritical"] = critical
    result["schedulingConstraintNote"] = "; ".join(note_parts)
    return result
