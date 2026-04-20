from __future__ import annotations

from fastapi import FastAPI, UploadFile, File, Form, Request, Query
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse, PlainTextResponse
from fastapi.templating import Jinja2Templates
from fastapi.middleware.cors import CORSMiddleware
from typing import Optional, Dict, Any, Tuple, List
from dataclasses import dataclass

import base64
import csv
import hashlib
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import uuid
import sys
from pathlib import Path
from datetime import datetime, timedelta

from routing_engine import (
    ROUTING_PLAN_EXPORT_COLUMNS,
    get_non_exposed_run_settings_notes,
    get_run_settings_defaults,
    get_run_settings_limits,
    get_run_settings_ui_hints,
    normalize_run_settings,
    render_route_preview_html,
    run_routing,
    summarize_run_settings,
    _osrm_service_available,
    OSRM_BASE_URL,
    OSRM_BASE_CANDIDATES,
    get_osrm_base_url,
    STRICT_OSRM_FOR_OPTIMIZATION,
    FAIL_FAST_IF_OSRM_UNAVAILABLE,
)


app = FastAPI()

# --- RouteIQ bridge endpoints ---
from routeiq_router import router as routeiq_router  # noqa: E402
app.include_router(routeiq_router)

# --- AI Learning endpoints ---
from ai_learning import router as ai_learning_router  # noqa: E402
app.include_router(ai_learning_router)

# --- Logging ---
LOG_LEVEL = str(os.environ.get("FR_LOG_LEVEL", "INFO")).upper()
logging.basicConfig(level=getattr(logging, LOG_LEVEL, logging.INFO), format="%(message)s")
LOGGER = logging.getLogger("flex-routing")


def _utc() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _log_event(event: str, **fields) -> None:
    payload = {"ts": _utc(), "event": event}
    payload.update(fields)
    try:
        LOGGER.info(json.dumps(payload, default=str))
    except Exception:
        LOGGER.info(f"{event} {fields}")


# --- Paths and storage ---
BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))


_LOCAL_ENV_DEFAULT_KEYS = {
    "FR_AUTH_ENABLED",
    "FR_SHARED_USERNAME",
    "FR_SHARED_PASSWORD",
    "FR_LOG_LEVEL",
    "FR_ALLOWED_ORIGINS",
}


def _load_env_defaults_from_file(path: Path) -> None:
    if not path.exists():
        return
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception:
        return

    # Match shell sourcing behavior: the last assignment in the file wins.
    parsed_defaults = {}
    for line in raw.splitlines():
        txt = str(line).strip()
        if not txt or txt.startswith("#"):
            continue
        if txt.startswith("export "):
            txt = txt[7:].strip()
        if "=" not in txt:
            continue
        key, value = txt.split("=", 1)
        key = str(key).strip()
        if not (key in _LOCAL_ENV_DEFAULT_KEYS or key.startswith("FIELDROUTES_")):
            continue
        if not key or key in os.environ:
            continue
        val = str(value).strip()
        if len(val) >= 2 and ((val[0] == val[-1] == '"') or (val[0] == val[-1] == "'")):
            val = val[1:-1]
        parsed_defaults[key] = val

    for key, val in parsed_defaults.items():
        if key in os.environ:
            continue
        os.environ[key] = val


# Local uvicorn runs do not read .env by default; hydrate auth/FieldRoutes vars only.
_load_env_defaults_from_file(BASE_DIR / ".env")


def _resolve_data_root() -> Path:
    configured = str(os.environ.get("FR_DATA_ROOT", "") or "").strip()
    if not configured:
        configured = str(BASE_DIR / "data")
    candidate = Path(configured).expanduser().resolve()
    try:
        candidate.mkdir(parents=True, exist_ok=True)
        return candidate
    except Exception as e:
        fallback = (BASE_DIR / "data").resolve()
        fallback.mkdir(parents=True, exist_ok=True)
        _log_event("data_root_fallback", configured=str(candidate), fallback=str(fallback), error=str(e))
        return fallback


DATA_ROOT = _resolve_data_root()
RUNS_DIR = (DATA_ROOT / "runs").resolve()
RUN_REGISTRY_FILE = (DATA_ROOT / "run_registry.json").resolve()

# Legacy fallback files for backward compatibility.
LEGACY_UPLOAD_FILE = BASE_DIR / "uploaded.csv"
LEGACY_OUTPUT_CSV = BASE_DIR / "routing_plan.csv"
LEGACY_OUTPUT_MAP = BASE_DIR / "route_preview.html"
LEGACY_EDITED_OUTPUT_CSV = BASE_DIR / "routing_plan.edited.csv"
LEGACY_EDITED_OUTPUT_MAP = BASE_DIR / "route_preview.edited.html"
LEGACY_EDIT_AUDIT_FILE = BASE_DIR / "route_edits.audit.json"
LEGACY_PROGRESS_FILE = BASE_DIR / "routing_progress.json"
ROUTE_PREVIEW_TEMPLATE_FILE = (TEMPLATES_DIR / "route_preview.template.html").resolve()
ROUTE_PREVIEW_FALLBACK_FILE = (BASE_DIR / "route_preview.html").resolve()

AUTO_START_ON_BOOT = os.environ.get("AUTO_START_ON_BOOT", "0").strip().lower() not in {"0", "false", "no", "off"}


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "1" if default else "0")
    return str(raw).strip().lower() not in {"0", "false", "no", "off", ""}


def _parse_allowed_origins() -> list:
    raw = str(os.environ.get("FR_ALLOWED_ORIGINS", "") or "")
    out = []
    for part in raw.split(","):
        item = part.strip()
        if item:
            out.append(item)
    return out


# Same-origin by default; RouteIQ adds Vercel origins via FR_ALLOWED_ORIGINS env var.
_ROUTEIQ_EXTRA_ORIGINS = [
    o.strip()
    for o in str(os.environ.get("ROUTEIQ_ALLOWED_ORIGINS", "") or "").split(",")
    if o.strip()
]
_ALLOWED_ORIGINS = _parse_allowed_origins() + _ROUTEIQ_EXTRA_ORIGINS
app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Auth middleware (shared team password) ---
FR_AUTH_ENABLED = _bool_env("FR_AUTH_ENABLED", True)
FR_SHARED_USERNAME = str(os.environ.get("FR_SHARED_USERNAME", "team"))
FR_SHARED_PASSWORD = str(os.environ.get("FR_SHARED_PASSWORD", ""))
FIELDROUTES_ADMIN_PASSWORD = str(os.environ.get("FIELDROUTES_ADMIN_PASSWORD", "") or "").strip()
_PUBLIC_PATHS = {"/healthz", "/readyz"}


@app.middleware("http")
async def _basic_auth_guard(request: Request, call_next):
    path = str(request.url.path or "")
    if path in _PUBLIC_PATHS:
        return await call_next(request)
    if not FR_AUTH_ENABLED:
        return await call_next(request)

    auth = str(request.headers.get("authorization", "") or "")
    ok = False
    if auth.lower().startswith("basic "):
        token = auth.split(" ", 1)[1].strip()
        try:
            decoded = base64.b64decode(token).decode("utf-8", errors="ignore")
            username, password = decoded.split(":", 1)
            ok = secrets.compare_digest(str(username), FR_SHARED_USERNAME) and secrets.compare_digest(str(password), FR_SHARED_PASSWORD)
        except Exception:
            ok = False

    if ok:
        return await call_next(request)

    _log_event("auth_failure", path=path, client=str(getattr(request.client, "host", "")))
    headers = {"WWW-Authenticate": "Basic realm=flex-routing"}
    api_prefixes = (
        "/upload",
        "/generate",
        "/run-existing",
        "/progress",
        "/download-",
        "/plan-editor",
        "/runs",
        "/rebuild-map",
        "/osrm-preflight",
        "/run-settings",
        "/fieldroutes",
        "/reset",
    )
    wants_json = path.startswith(api_prefixes) or ("application/json" in str(request.headers.get("accept", "")).lower())
    if wants_json:
        return JSONResponse({"error": "UNAUTHORIZED", "message": "Authentication required."}, status_code=401, headers=headers)
    return PlainTextResponse("Unauthorized", status_code=401, headers=headers)


# --- Run paths ---
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9._-]{4,80}$")


@dataclass(frozen=True)
class RunPaths:
    run_id: str
    run_dir: Path
    upload_file: Path
    output_csv: Path
    output_map: Path
    edited_output_csv: Path
    edited_output_map: Path
    edit_audit_file: Path
    route_scaffolds_file: Path
    progress_file: Path


def _sanitize_run_id(raw: str) -> str:
    rid = str(raw or "").strip()
    if not _RUN_ID_RE.match(rid):
        raise ValueError("Invalid runId format.")
    return rid


def _new_run_id() -> str:
    return datetime.utcnow().strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]


def _run_paths(run_id: str) -> RunPaths:
    rid = _sanitize_run_id(run_id)
    run_dir = (RUNS_DIR / rid).resolve()
    return RunPaths(
        run_id=rid,
        run_dir=run_dir,
        upload_file=run_dir / "uploaded.csv",
        output_csv=run_dir / "routing_plan.csv",
        output_map=run_dir / "route_preview.html",
        edited_output_csv=run_dir / "routing_plan.edited.csv",
        edited_output_map=run_dir / "route_preview.edited.html",
        edit_audit_file=run_dir / "route_edits.audit.json",
        route_scaffolds_file=run_dir / "route_scaffolds.json",
        progress_file=run_dir / "routing_progress.json",
    )


def _ensure_run_dir(paths: RunPaths) -> None:
    paths.run_dir.mkdir(parents=True, exist_ok=True)


def _active_route_preview_source_path() -> Optional[Path]:
    for candidate in (ROUTE_PREVIEW_TEMPLATE_FILE, ROUTE_PREVIEW_FALLBACK_FILE):
        try:
            if candidate.exists() and candidate.is_file():
                return candidate
        except Exception:
            continue
    return None


def _file_mtime_epoch(path: Optional[Path]) -> float:
    if not path:
        return 0.0
    try:
        return float(path.stat().st_mtime)
    except Exception:
        return 0.0


def _map_html_stale(path: Path) -> bool:
    source = _active_route_preview_source_path()
    if source is None:
        return False
    source_mtime = _file_mtime_epoch(source)
    map_mtime = _file_mtime_epoch(path)
    if source_mtime <= 0:
        return False
    if map_mtime <= 0:
        return True
    return map_mtime < (source_mtime - 1e-6)


# --- Job / registry state ---
JOB_STATE = {
    "status": "idle",  # idle | running | done | error
    "startedAt": None,
    "finishedAt": None,
    "error": None,
    "runId": None,
    "runSettings": None,
    "runSettingsMeta": None,
    "runSettingsSummary": None,
}

JOB_LOCK = threading.Lock()
REGISTRY_LOCK = threading.Lock()
JOB_THREAD = {"thread": None}

FIELDROUTES_REPORT_FILE = "fieldroutes_push_report.json"
FIELDROUTES_EXCEPTIONS_FILE = "fieldroutes_push_exceptions.csv"
FIELDROUTES_REQUEST_LOG_FILE = "fieldroutes_request_log.ndjson"
FIELDROUTES_HISTORY_FILE = "fieldroutes_push_history.json"
FIELDROUTES_REQUIRED_UPLOAD_COLUMNS = ["customerID", "preferredTech", "routeDate", "sequence", "routeName"]

FIELDROUTES_PUSH_STATE = {
    "status": "idle",  # idle | running | done | error
    "runId": None,
    "date": None,
    "preferredTech": None,
    "mode": None,  # dry-run | apply
    "useEdited": True,
    "syncDuration": False,
    "startedAt": None,
    "finishedAt": None,
    "exitCode": None,
    "error": None,
    "stdout": "",
    "stderr": "",
    "command": [],
    "artifacts": None,
}
FIELDROUTES_PUSH_LOCK = threading.Lock()
FIELDROUTES_PUSH_THREAD = {"thread": None}


def _is_job_running() -> bool:
    t = JOB_THREAD.get("thread")
    return bool(t and getattr(t, "is_alive", lambda: False)())


def _parse_utc(ts: str) -> Optional[datetime]:
    try:
        if ts.endswith("Z"):
            ts = ts[:-1]
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def _compute_timing_fields(payload: dict) -> dict:
    started_at = payload.get("startedAt") or payload.get("job", {}).get("startedAt")
    percent = payload.get("percent")
    status = payload.get("status")

    if not started_at:
        return payload

    started_dt = None
    if isinstance(started_at, (int, float)):
        try:
            started_dt = datetime.utcfromtimestamp(float(started_at))
        except Exception:
            started_dt = None
    else:
        txt = str(started_at)
        if txt.isdigit():
            try:
                started_dt = datetime.utcfromtimestamp(float(txt))
            except Exception:
                started_dt = None
        else:
            started_dt = _parse_utc(txt)
    if not started_dt:
        return payload

    elapsed = max(0, int((datetime.utcnow() - started_dt).total_seconds()))
    payload.setdefault("elapsedSeconds", elapsed)

    try:
        p = float(percent) if percent is not None else None
    except Exception:
        p = None

    if status == "running" and p is not None and 0 < p < 100:
        payload.setdefault("etaSeconds", int(elapsed * (100.0 - p) / p))
    else:
        payload.setdefault("etaSeconds", None)

    return payload


def _atomic_write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


def _safe_write_progress(paths: RunPaths, payload: dict) -> None:
    try:
        out = dict(payload)
        out.setdefault("runId", paths.run_id)
        out.setdefault("updatedAt", _utc())
        _atomic_write_json(paths.progress_file, out)
    except Exception:
        pass


def _sha256_file(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    h = hashlib.sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _file_meta(path: Path) -> dict:
    if not path.exists():
        return {"exists": False, "path": str(path)}
    st = path.stat()
    return {
        "exists": True,
        "path": str(path),
        "size": int(st.st_size),
        "updatedAtEpoch": int(st.st_mtime),
        "sha256": _sha256_file(path),
    }


def _default_progress_payload(run_id: Optional[str], paths: Optional[RunPaths]) -> dict:
    status = JOB_STATE.get("status", "idle") if (JOB_STATE.get("runId") == run_id) else "idle"
    percent = 0
    if status == "running":
        percent = 1
    elif status in ("done", "error"):
        percent = 100

    return {
        "status": status,
        "stage": status,
        "percent": percent,
        "message": "No progress file yet.",
        "runId": run_id,
        "resolvedRunId": run_id,
        "job": JOB_STATE,
        "runSettings": JOB_STATE.get("runSettings") if JOB_STATE.get("runId") == run_id else None,
        "runSettingsMeta": JOB_STATE.get("runSettingsMeta") if JOB_STATE.get("runId") == run_id else None,
        "runSettingsSummary": JOB_STATE.get("runSettingsSummary") if JOB_STATE.get("runId") == run_id else None,
        "outputs": {
            "csv": (paths.output_csv.name if (paths and paths.output_csv.exists()) else None),
            "map": (paths.output_map.name if (paths and paths.output_map.exists()) else None),
        },
        "updatedAt": _utc(),
        "elapsedSeconds": None,
        "etaSeconds": None,
    }


def _registry_empty() -> dict:
    return {"runs": []}


def _load_registry() -> dict:
    if not RUN_REGISTRY_FILE.exists():
        return _registry_empty()
    try:
        data = json.loads(RUN_REGISTRY_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _registry_empty()
        runs = data.get("runs", [])
        if not isinstance(runs, list):
            runs = []
        out = {"runs": runs}
        return out
    except Exception:
        return _registry_empty()


def _save_registry(data: dict) -> None:
    RUN_REGISTRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_json(RUN_REGISTRY_FILE, data)


def _registry_sort_key(item: dict) -> str:
    return str(item.get("updatedAt") or item.get("createdAt") or "")


def _touch_run_registry(
    run_id: str,
    *,
    status: Optional[str] = None,
    message: Optional[str] = None,
    error: Optional[str] = None,
    owner_label: Optional[str] = None,
    run_settings_summary: Optional[str] = None,
) -> None:
    paths = _run_paths(run_id)
    now = _utc()
    with REGISTRY_LOCK:
        reg = _load_registry()
        runs = reg.get("runs", [])
        target = None
        for item in runs:
            if str(item.get("runId")) == run_id:
                target = item
                break
        if target is None:
            target = {"runId": run_id, "createdAt": now}
            runs.append(target)

        target["updatedAt"] = now
        if status is not None:
            target["status"] = str(status)
        if message is not None:
            target["message"] = str(message)
        if error is not None:
            target["error"] = str(error)
        if owner_label is not None:
            target["ownerLabel"] = str(owner_label)
        if run_settings_summary is not None:
            target["runSettingsSummary"] = str(run_settings_summary)

        target["files"] = {
            "upload": _file_meta(paths.upload_file),
            "csv": _file_meta(paths.output_csv),
            "map": _file_meta(paths.output_map),
            "editedCsv": _file_meta(paths.edited_output_csv),
            "editedMap": _file_meta(paths.edited_output_map),
            "audit": _file_meta(paths.edit_audit_file),
            "scaffolds": _file_meta(paths.route_scaffolds_file),
            "progress": _file_meta(paths.progress_file),
        }

        reg["runs"] = sorted(runs, key=_registry_sort_key, reverse=True)
        _save_registry(reg)


def _list_runs(limit: int = 30) -> list:
    reg = _load_registry()
    runs = sorted(reg.get("runs", []), key=_registry_sort_key, reverse=True)
    out = []
    for item in runs[: max(1, int(limit))]:
        run_id = str(item.get("runId", "")).strip()
        if not run_id:
            continue
        out.append(item)
    return out


def _latest_run_id(prefer_uploaded: bool = False) -> Optional[str]:
    runs = _list_runs(limit=500)
    for item in runs:
        run_id = str(item.get("runId", "")).strip()
        if not run_id:
            continue
        paths = _run_paths(run_id)
        if prefer_uploaded and not paths.upload_file.exists():
            continue
        return run_id

    if RUNS_DIR.exists():
        candidates = sorted([p for p in RUNS_DIR.iterdir() if p.is_dir()], key=lambda p: p.stat().st_mtime, reverse=True)
        for p in candidates:
            rid = p.name
            if _RUN_ID_RE.match(rid):
                rp = _run_paths(rid)
                if prefer_uploaded and not rp.upload_file.exists():
                    continue
                return rid
    return None


def _resolve_run(run_id: Optional[str], *, prefer_uploaded: bool = False) -> Tuple[Optional[str], Optional[RunPaths]]:
    rid = None
    if run_id is not None and str(run_id).strip():
        rid = _sanitize_run_id(str(run_id))
    else:
        active = str(JOB_STATE.get("runId") or "").strip()
        if active and _is_job_running():
            rid = active
        else:
            rid = _latest_run_id(prefer_uploaded=prefer_uploaded)

    if not rid:
        return None, None
    return rid, _run_paths(rid)


def _is_fieldroutes_push_running() -> bool:
    t = FIELDROUTES_PUSH_THREAD.get("thread")
    return bool(t and getattr(t, "is_alive", lambda: False)())


def _fieldroutes_credentials_status() -> dict:
    required = ["FIELDROUTES_BASE_URL", "FIELDROUTES_AUTH_KEY", "FIELDROUTES_AUTH_TOKEN"]
    missing = [k for k in required if not str(os.environ.get(k, "")).strip()]
    return {
        "configured": len(missing) == 0,
        "missing": missing,
        "baseUrl": str(os.environ.get("FIELDROUTES_BASE_URL", "")).strip(),
    }


def _fieldroutes_admin_required() -> bool:
    return bool(FIELDROUTES_ADMIN_PASSWORD)


def _fieldroutes_admin_auth_error(request: Request) -> Optional[JSONResponse]:
    if not _fieldroutes_admin_required():
        return None
    provided = str(request.headers.get("x-fieldroutes-admin-password", "") or "").strip()
    if not provided:
        return JSONResponse(
            {
                "error": "FIELDROUTES_ADMIN_PASSWORD_REQUIRED",
                "message": "FieldRoutes admin password is required.",
                "adminRequired": True,
            },
            status_code=401,
        )
    if not secrets.compare_digest(provided, FIELDROUTES_ADMIN_PASSWORD):
        return JSONResponse(
            {
                "error": "FIELDROUTES_ADMIN_PASSWORD_INVALID",
                "message": "FieldRoutes admin password is invalid.",
                "adminRequired": True,
            },
            status_code=401,
        )
    return None


def _fieldroutes_artifact_paths(paths: RunPaths) -> dict:
    return {
        "report": paths.run_dir / FIELDROUTES_REPORT_FILE,
        "exceptions": paths.run_dir / FIELDROUTES_EXCEPTIONS_FILE,
        "requestLog": paths.run_dir / FIELDROUTES_REQUEST_LOG_FILE,
    }


def _fieldroutes_history_path(paths: RunPaths) -> Path:
    return paths.run_dir / FIELDROUTES_HISTORY_FILE


def _read_json_dict(path: Path) -> Optional[dict]:
    if not path.exists():
        return None
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if isinstance(parsed, dict):
        return parsed
    return None


def _normalize_person_name(value: Optional[str]) -> str:
    raw = str(value or "")
    cooked = "".join(ch.lower() if ch.isalnum() else " " for ch in raw)
    return " ".join(cooked.split())


def _load_fieldroutes_history_entries(paths: RunPaths) -> list:
    history_path = _fieldroutes_history_path(paths)
    parsed = _read_json_dict(history_path)
    if not parsed:
        return []
    entries = parsed.get("entries", [])
    if not isinstance(entries, list):
        return []
    out = []
    for entry in entries:
        if isinstance(entry, dict):
            out.append(entry)
    return out


def _append_fieldroutes_history_entry(paths: RunPaths, entry: dict) -> None:
    history_path = _fieldroutes_history_path(paths)
    existing = _load_fieldroutes_history_entries(paths)
    payload = {"entries": existing + [dict(entry)]}
    _atomic_write_json(history_path, payload)


def _latest_fieldroutes_report_summary(paths: RunPaths) -> Optional[dict]:
    report_path = _fieldroutes_artifact_paths(paths)["report"]
    parsed = _read_json_dict(report_path)
    if not parsed:
        return None
    summary = parsed.get("summary")
    if not isinstance(summary, dict):
        summary = {}
    return {
        "ok": bool(parsed.get("ok")),
        "mode": str(parsed.get("mode") or ""),
        "date": str(parsed.get("date") or ""),
        "preferredTech": (str(parsed.get("preferredTech") or "").strip() or None),
        "summary": summary,
        "finishedAt": str(parsed.get("finishedAt") or ""),
    }


def _tail_text(value: str, max_chars: int = 12000) -> str:
    txt = str(value or "")
    if len(txt) <= max_chars:
        return txt
    return txt[-max_chars:]


def _fieldroutes_state_payload() -> dict:
    with FIELDROUTES_PUSH_LOCK:
        out = dict(FIELDROUTES_PUSH_STATE)

    run_id = str(out.get("runId") or "").strip()
    artifacts_meta = None
    latest_report_summary = None
    if run_id:
        try:
            rp = _run_paths(run_id)
            art = _fieldroutes_artifact_paths(rp)
            artifacts_meta = {
                "report": _file_meta(art["report"]),
                "exceptions": _file_meta(art["exceptions"]),
                "requestLog": _file_meta(art["requestLog"]),
                "downloadReportUrl": f"/download-fieldroutes-report?runId={run_id}",
                "downloadExceptionsUrl": f"/download-fieldroutes-exceptions?runId={run_id}",
                "downloadRequestLogUrl": f"/download-fieldroutes-request-log?runId={run_id}",
            }
            latest_report_summary = _latest_fieldroutes_report_summary(rp)
        except Exception:
            artifacts_meta = None
            latest_report_summary = None

    out["artifacts"] = artifacts_meta
    out["credentials"] = _fieldroutes_credentials_status()
    out["adminRequired"] = _fieldroutes_admin_required()
    out["latestReportSummary"] = latest_report_summary
    return out


def _run_fieldroutes_push_thread(
    *,
    run_id: str,
    date_value: str,
    preferred_tech: Optional[str],
    mode: str,
    use_edited: bool,
    sync_duration: bool,
) -> None:
    rp = _run_paths(run_id)
    script_path = (BASE_DIR / "scripts" / "push_fieldroutes.py").resolve()

    cmd: List[str] = [
        str(sys.executable),
        str(script_path),
        "--run-id",
        str(run_id),
        "--date",
        str(date_value),
    ]
    preferred_tech_s = str(preferred_tech or "").strip()
    if preferred_tech_s:
        cmd.extend(["--preferred-tech", preferred_tech_s])
    if use_edited:
        cmd.append("--edited")
    if mode == "apply":
        cmd.append("--apply")
    else:
        cmd.append("--dry-run")
    if sync_duration:
        cmd.append("--sync-duration")

    with FIELDROUTES_PUSH_LOCK:
        FIELDROUTES_PUSH_STATE["status"] = "running"
        FIELDROUTES_PUSH_STATE["runId"] = run_id
        FIELDROUTES_PUSH_STATE["date"] = date_value
        FIELDROUTES_PUSH_STATE["preferredTech"] = preferred_tech_s or None
        FIELDROUTES_PUSH_STATE["mode"] = mode
        FIELDROUTES_PUSH_STATE["useEdited"] = bool(use_edited)
        FIELDROUTES_PUSH_STATE["syncDuration"] = bool(sync_duration)
        FIELDROUTES_PUSH_STATE["startedAt"] = _utc()
        FIELDROUTES_PUSH_STATE["finishedAt"] = None
        FIELDROUTES_PUSH_STATE["exitCode"] = None
        FIELDROUTES_PUSH_STATE["error"] = None
        FIELDROUTES_PUSH_STATE["stdout"] = ""
        FIELDROUTES_PUSH_STATE["stderr"] = ""
        FIELDROUTES_PUSH_STATE["command"] = list(cmd)

    _log_event(
        "fieldroutes_push_started",
        runId=run_id,
        date=date_value,
        preferredTech=(preferred_tech_s or None),
        mode=mode,
        edited=bool(use_edited),
    )

    env = dict(os.environ)
    env["PYTHONUNBUFFERED"] = "1"
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            env=env,
            capture_output=True,
            text=True,
        )
        stdout_txt = _tail_text(proc.stdout or "")
        stderr_txt = _tail_text(proc.stderr or "")

        with FIELDROUTES_PUSH_LOCK:
            FIELDROUTES_PUSH_STATE["exitCode"] = int(proc.returncode)
            FIELDROUTES_PUSH_STATE["stdout"] = stdout_txt
            FIELDROUTES_PUSH_STATE["stderr"] = stderr_txt
            FIELDROUTES_PUSH_STATE["finishedAt"] = _utc()
            if int(proc.returncode) == 0:
                FIELDROUTES_PUSH_STATE["status"] = "done"
                FIELDROUTES_PUSH_STATE["error"] = None
            else:
                FIELDROUTES_PUSH_STATE["status"] = "error"
                FIELDROUTES_PUSH_STATE["error"] = stderr_txt or stdout_txt or f"Push failed with exit {proc.returncode}"

        if int(proc.returncode) == 0:
            _touch_run_registry(run_id, message=f"FieldRoutes {mode} finished for {date_value}.")
            if mode == "apply":
                report_summary = _latest_fieldroutes_report_summary(rp) or {}
                art = _fieldroutes_artifact_paths(rp)
                history_entry = {
                    "runId": run_id,
                    "date": date_value,
                    "preferredTech": (preferred_tech_s or None),
                    "appliedAt": _utc(),
                    "summary": report_summary.get("summary", {}),
                    "reportMeta": {
                        "ok": report_summary.get("ok"),
                        "mode": report_summary.get("mode"),
                        "finishedAt": report_summary.get("finishedAt"),
                    },
                    "artifacts": {
                        "report": _file_meta(art["report"]),
                        "exceptions": _file_meta(art["exceptions"]),
                        "requestLog": _file_meta(art["requestLog"]),
                    },
                }
                try:
                    _append_fieldroutes_history_entry(rp, history_entry)
                except Exception:
                    pass
            _log_event(
                "fieldroutes_push_finished",
                runId=run_id,
                date=date_value,
                preferredTech=(preferred_tech_s or None),
                mode=mode,
                exitCode=int(proc.returncode),
            )
        else:
            _log_event(
                "fieldroutes_push_failed",
                runId=run_id,
                date=date_value,
                preferredTech=(preferred_tech_s or None),
                mode=mode,
                exitCode=int(proc.returncode),
                error=(stderr_txt or stdout_txt or None),
            )
    except Exception as e:
        with FIELDROUTES_PUSH_LOCK:
            FIELDROUTES_PUSH_STATE["status"] = "error"
            FIELDROUTES_PUSH_STATE["finishedAt"] = _utc()
            FIELDROUTES_PUSH_STATE["exitCode"] = -1
            FIELDROUTES_PUSH_STATE["error"] = str(e)
            FIELDROUTES_PUSH_STATE["stderr"] = _tail_text(str(e))
        _log_event(
            "fieldroutes_push_failed",
            runId=run_id,
            date=date_value,
            preferredTech=(preferred_tech_s or None),
            mode=mode,
            error=str(e),
        )


def _conflict_response() -> JSONResponse:
    active = str(JOB_STATE.get("runId") or "")
    return JSONResponse(
        {
            "error": "RUN_IN_PROGRESS",
            "message": (
                f"Run '{active}' is in progress. Try again after completion."
                if active
                else "Another run is currently in progress. Try again after completion."
            ),
            "activeRunId": active or None,
            "status": "running",
        },
        status_code=409,
    )


# --- Run settings parsing ---
def _parse_run_settings_json(raw_settings: Optional[str]) -> dict:
    if raw_settings is None or str(raw_settings).strip() == "":
        return normalize_run_settings({})
    try:
        decoded = json.loads(str(raw_settings))
    except Exception as e:
        raise ValueError(f"Invalid settings JSON: {e}") from e
    return normalize_run_settings(decoded)


def _coerce_editor_bool(v) -> bool:
    if isinstance(v, bool):
        return bool(v)
    if isinstance(v, (int, float)):
        return bool(int(v))
    if isinstance(v, str):
        return v.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _normalize_editor_rows(raw_rows) -> dict:
    if not isinstance(raw_rows, list) or len(raw_rows) == 0:
        raise ValueError("rows must be a non-empty array.")

    required_keys = ["planStopId", "customerID", "preferredTech", "routeDate", "routeName", "sequence"]
    normalized = []
    seen = set()

    for idx, row in enumerate(raw_rows):
        if not isinstance(row, dict):
            raise ValueError(f"rows[{idx}] must be an object.")
        out = {}
        for col in ROUTING_PLAN_EXPORT_COLUMNS:
            out[col] = row.get(col, "")

        for key in required_keys:
            if str(out.get(key, "")).strip() == "":
                raise ValueError(f"rows[{idx}] missing required field '{key}'.")

        plan_id = str(out["planStopId"]).strip()
        if plan_id in seen:
            raise ValueError(f"Duplicate planStopId detected: {plan_id}")
        seen.add(plan_id)
        out["planStopId"] = plan_id

        out["customerID"] = str(out["customerID"]).strip()
        out["subscriptionID"] = str(out.get("subscriptionID", "")).strip()
        out["preferredTech"] = str(out["preferredTech"]).strip()
        out["routeDate"] = str(out["routeDate"]).strip()
        out["routeName"] = str(out["routeName"]).strip()

        try:
            out["sequence"] = int(float(out["sequence"]))
        except Exception as e:
            raise ValueError(f"rows[{idx}] invalid sequence.") from e
        if out["sequence"] <= 0:
            raise ValueError(f"rows[{idx}] sequence must be > 0.")

        route_index_raw = str(out.get("routeIndex", "")).strip()
        if route_index_raw == "":
            out["routeIndex"] = ""
        else:
            try:
                out["routeIndex"] = int(float(route_index_raw))
            except Exception:
                out["routeIndex"] = route_index_raw

        try:
            out["duration"] = int(float(out.get("duration", 25)))
        except Exception:
            out["duration"] = 25
        if out["duration"] <= 0:
            out["duration"] = 25

        out["isRemote"] = _coerce_editor_bool(out.get("isRemote"))
        out["schedulingRequiresPhoneConfirm"] = _coerce_editor_bool(out.get("schedulingRequiresPhoneConfirm"))
        out["schedulingCritical"] = _coerce_editor_bool(out.get("schedulingCritical"))

        for fld in ("lat", "lng", "routeDriveMinutesMatrix", "routeDriveMinutesOSRM"):
            raw = out.get(fld, "")
            if raw == "" or raw is None:
                out[fld] = ""
                continue
            try:
                out[fld] = float(raw)
            except Exception:
                if fld in ("lat", "lng"):
                    raise ValueError(f"rows[{idx}] invalid {fld}.")
                out[fld] = ""

        for fld in (
            "remoteZone",
            "assignmentReason",
            "sequenceStrategy",
            "driveModel",
            "dayType",
            "fieldRoutesTemplateSource",
            "capacityReason",
            "schedulingRequestRaw",
            "schedulingRequestClass",
            "schedulingAllowedWeekdays",
            "schedulingBlockedWeekdays",
            "schedulingConstraintStatus",
            "schedulingConstraintNote",
        ):
            out[fld] = str(out.get(fld, "")).strip()

        template_raw = str(out.get("fieldRoutesTemplateID", "")).strip()
        if template_raw == "":
            out["fieldRoutesTemplateID"] = ""
        else:
            try:
                out["fieldRoutesTemplateID"] = int(float(template_raw))
            except Exception:
                out["fieldRoutesTemplateID"] = template_raw

        normalized.append(out)

    groups = {}
    for row in normalized:
        key = (row["routeName"], row["preferredTech"], row["routeDate"])
        groups.setdefault(key, []).append(row)
    for _, grp in groups.items():
        grp.sort(key=lambda r: int(r["sequence"]))
        for i, row in enumerate(grp, start=1):
            row["sequence"] = i

    return {"rows": normalized}


def _load_plan_rows(path: Path) -> dict:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        out = {}
        for row in reader:
            key = str(row.get("planStopId", "")).strip()
            if key:
                out[key] = row
        return out


def _load_plan_rows_list(path: Path) -> list:
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


_ASSIGNED_ROUTE_NUMBER_RE = re.compile(r"Route\s+(\d+)\s*$", flags=re.IGNORECASE)
_WORKING_DAY_RE = re.compile(r"Working Day\s+(\d+)", flags=re.IGNORECASE)
_ISO_DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")
_ROUTE_COLOR_PALETTE = [
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


def _route_color_for_name(name: str) -> str:
    h = 0
    for ch in str(name or ""):
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return _ROUTE_COLOR_PALETTE[h % len(_ROUTE_COLOR_PALETTE)]


def _extract_route_number_from_name(route_name: str, fallback: int = 1) -> int:
    m = _ASSIGNED_ROUTE_NUMBER_RE.search(str(route_name or ""))
    if m:
        try:
            return int(m.group(1))
        except Exception:
            pass
    return max(1, int(fallback))


def _extract_route_index_from_name(route_name: str) -> Optional[int]:
    m = _WORKING_DAY_RE.search(str(route_name or ""))
    if not m:
        return None
    try:
        out = int(m.group(1))
        return out if out > 0 else None
    except Exception:
        return None


def _coerce_iso_date(value: Any) -> str:
    txt = str(value or "").strip()
    if not txt:
        return ""
    if txt.upper() == "UNASSIGNED":
        return ""
    try:
        ts = datetime.fromisoformat(txt.replace("Z", ""))
        return ts.date().isoformat()
    except Exception:
        pass
    m = _ISO_DATE_RE.search(txt)
    if not m:
        return ""
    try:
        return datetime.fromisoformat(m.group(1)).date().isoformat()
    except Exception:
        return ""


def _format_assigned_route_name_local(tech: str, route_date: str, route_index: Any, route_num: int) -> str:
    idx = 1
    try:
        idx = max(1, int(float(route_index)))
    except Exception:
        idx = 1
    date_txt = _coerce_iso_date(route_date) or "UNASSIGNED"
    return f"{str(tech)} — {date_txt} (Working Day {idx}) — Route {int(max(1, int(route_num)))}"


def _is_unassigned_route(route_name: Any, route_date: Any) -> bool:
    route_name_s = str(route_name or "").strip().upper()
    route_date_s = str(route_date or "").strip().upper()
    return ("UNASSIGNED" in route_name_s) or (route_date_s == "") or (route_date_s == "UNASSIGNED")


def _normalize_scaffold_routes(raw_routes: Any) -> List[Dict[str, Any]]:
    if not isinstance(raw_routes, list):
        return []

    dedup: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for item in raw_routes:
        if not isinstance(item, dict):
            continue

        route_name = str(item.get("routeName", "")).strip()
        tech = str(item.get("tech", "")).strip()
        route_date = _coerce_iso_date(item.get("date", ""))

        if not route_date:
            route_date = _coerce_iso_date(route_name)
        if not tech:
            route_name_tokens = [x.strip() for x in str(route_name).split("—")]
            if route_name_tokens:
                tech = str(route_name_tokens[0]).strip()

        route_index_raw = item.get("routeIndex", "")
        route_index = ""
        try:
            if str(route_index_raw).strip() != "":
                route_index = int(float(route_index_raw))
        except Exception:
            route_index = ""
        if route_index == "":
            inferred_idx = _extract_route_index_from_name(route_name)
            if inferred_idx is not None:
                route_index = int(inferred_idx)

        if route_index == "":
            try:
                route_index = int(float(item.get("routeIndex", 1)))
            except Exception:
                route_index = 1

        if not route_name and tech and route_date:
            route_num = _extract_route_number_from_name(str(item.get("routeName", "")), fallback=1)
            route_name = _format_assigned_route_name_local(tech, route_date, route_index, route_num)

        if not route_name or not tech or not route_date:
            continue
        if _is_unassigned_route(route_name, route_date):
            continue

        day_type = str(item.get("dayType", "")).strip()
        if not day_type:
            try:
                wd = datetime.fromisoformat(route_date).weekday()
                day_type = "SATURDAY_OVERFLOW" if wd == 5 else "WEEKDAY"
            except Exception:
                day_type = "WEEKDAY"

        normalized = {
            "routeName": str(route_name),
            "routeIndex": route_index,
            "tech": str(tech),
            "date": str(route_date),
            "dayType": str(day_type),
            "sequenceStrategy": str(item.get("sequenceStrategy", "") or "SCAFFOLD_EMPTY_ROUTE"),
            "driveModel": str(item.get("driveModel", "") or "SCAFFOLD_EMPTY_ROUTE"),
            "fieldRoutesTemplateID": str(item.get("fieldRoutesTemplateID", "") or ""),
            "fieldRoutesTemplateSource": str(item.get("fieldRoutesTemplateSource", "") or "scaffold"),
            "isScaffoldRoute": True,
        }
        dedup[(normalized["tech"], normalized["date"], normalized["routeName"])] = normalized

    return list(dedup.values())


def _extract_scaffold_routes_from_routes_payload(routes_raw: Any) -> List[Dict[str, Any]]:
    if not isinstance(routes_raw, list):
        return []
    raw_scaffolds = []
    for route in routes_raw:
        if not isinstance(route, dict):
            continue
        route_name = str(route.get("routeName", "")).strip()
        route_date = _coerce_iso_date(route.get("date", ""))
        stops = route.get("stops", [])
        if not isinstance(stops, list):
            stops = []
        if _is_unassigned_route(route_name, route_date):
            continue
        if len(stops) > 0:
            continue
        raw_scaffolds.append(
            {
                "routeName": route_name,
                "routeIndex": route.get("routeIndex", ""),
                "tech": str(route.get("tech", "")).strip(),
                "date": route_date,
                "dayType": str(route.get("dayType", "")).strip(),
                "sequenceStrategy": str(route.get("sequenceStrategy", "")).strip(),
                "driveModel": str(route.get("driveModel", "")).strip(),
                "fieldRoutesTemplateID": str(route.get("fieldRoutesTemplateID", "")).strip(),
                "fieldRoutesTemplateSource": str(route.get("fieldRoutesTemplateSource", "")).strip(),
                "isScaffoldRoute": True,
            }
        )
    return _normalize_scaffold_routes(raw_scaffolds)


def _read_route_scaffold_payload(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, list):
        return {"routes": raw}
    return {}


def _load_scaffold_routes(paths: RunPaths) -> List[Dict[str, Any]]:
    payload = _read_route_scaffold_payload(paths.route_scaffolds_file)
    return _normalize_scaffold_routes(payload.get("routes", []))


def _write_scaffold_routes(
    paths: RunPaths,
    routes: List[Dict[str, Any]],
    *,
    source: str,
    planning_start: Optional[str] = None,
    planning_end: Optional[str] = None,
) -> None:
    payload: Dict[str, Any] = {
        "runId": str(paths.run_id),
        "generatedAt": _utc(),
        "source": str(source),
        "routeCount": int(len(routes)),
        "routes": list(routes),
    }
    if planning_start:
        payload["planningStart"] = str(planning_start)
    if planning_end:
        payload["planningEnd"] = str(planning_end)
    _atomic_write_json(paths.route_scaffolds_file, payload)


def _infer_scaffold_routes_from_rows(rows: list) -> List[Dict[str, Any]]:
    if not isinstance(rows, list) or len(rows) == 0:
        return []

    by_tech: Dict[str, Dict[str, Any]] = {}
    for row in rows:
        tech = str(row.get("preferredTech", "")).strip()
        route_name = str(row.get("routeName", "")).strip()
        route_date = _coerce_iso_date(row.get("routeDate", ""))
        if not tech:
            continue
        state = by_tech.setdefault(
            tech,
            {
                "assignedDates": set(),
                "usedNames": set(),
                "usedNums": set(),
            },
        )
        if route_name:
            state["usedNames"].add(route_name)
            state["usedNums"].add(_extract_route_number_from_name(route_name, fallback=1))
        if route_date and not _is_unassigned_route(route_name, route_date):
            state["assignedDates"].add(route_date)

    out = []
    for tech, state in by_tech.items():
        assigned_dates = sorted({str(d) for d in state["assignedDates"] if str(d).strip()})
        if not assigned_dates:
            continue
        try:
            start = datetime.fromisoformat(assigned_dates[0]).date()
            end = datetime.fromisoformat(assigned_dates[-1]).date()
        except Exception:
            continue

        day_dates = []
        cur = start
        while cur <= end:
            if cur.weekday() <= 5:  # Monday-Saturday
                day_dates.append(cur)
            cur += timedelta(days=1)

        next_num = (max(state["usedNums"]) + 1) if state["usedNums"] else 1
        used_names = set(state["usedNames"])
        assigned_date_set = {datetime.fromisoformat(d).date() for d in assigned_dates}

        for day_idx, day_date in enumerate(day_dates, start=1):
            if day_date in assigned_date_set:
                continue
            route_num = int(next_num)
            route_name = _format_assigned_route_name_local(tech, day_date.isoformat(), day_idx, route_num)
            while route_name in used_names:
                route_num += 1
                route_name = _format_assigned_route_name_local(tech, day_date.isoformat(), day_idx, route_num)
            next_num = int(route_num + 1)
            used_names.add(route_name)
            out.append(
                {
                    "routeName": route_name,
                    "routeIndex": int(day_idx),
                    "tech": str(tech),
                    "date": day_date.isoformat(),
                    "dayType": ("SATURDAY_OVERFLOW" if day_date.weekday() == 5 else "WEEKDAY"),
                    "sequenceStrategy": "SCAFFOLD_EMPTY_ROUTE",
                    "driveModel": "SCAFFOLD_EMPTY_ROUTE",
                    "fieldRoutesTemplateID": "",
                    "fieldRoutesTemplateSource": "inferred",
                    "isScaffoldRoute": True,
                }
            )

    return _normalize_scaffold_routes(out)


def _resolve_scaffold_routes(paths: RunPaths, rows: list, provided_routes: Any = None) -> List[Dict[str, Any]]:
    if provided_routes is not None:
        return _normalize_scaffold_routes(provided_routes)
    from_file = _load_scaffold_routes(paths)
    if from_file:
        return from_file
    return _infer_scaffold_routes_from_rows(rows)


def _merge_scaffold_routes_into_payload(routes_raw: Any, scaffold_routes: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    out = []
    existing_names = set()
    for route in (routes_raw if isinstance(routes_raw, list) else []):
        if not isinstance(route, dict):
            continue
        out.append(route)
        rname = str(route.get("routeName", "")).strip()
        if rname:
            existing_names.add(rname)

    for scaffold in scaffold_routes:
        if not isinstance(scaffold, dict):
            continue
        route_name = str(scaffold.get("routeName", "")).strip()
        if not route_name or route_name in existing_names:
            continue
        out.append(
            {
                "routeName": route_name,
                "routeIndex": scaffold.get("routeIndex", ""),
                "tech": str(scaffold.get("tech", "")).strip(),
                "date": str(scaffold.get("date", "")).strip(),
                "color": _route_color_for_name(route_name),
                "isRemoteRoute": False,
                "remoteZones": [],
                "assignmentReasons": [],
                "capacityReasons": [],
                "dayType": str(scaffold.get("dayType", "WEEKDAY")).strip() or "WEEKDAY",
                "fieldRoutesTemplateID": str(scaffold.get("fieldRoutesTemplateID", "")).strip(),
                "fieldRoutesTemplateSource": str(scaffold.get("fieldRoutesTemplateSource", "scaffold")).strip() or "scaffold",
                "driveModel": str(scaffold.get("driveModel", "SCAFFOLD_EMPTY_ROUTE")).strip() or "SCAFFOLD_EMPTY_ROUTE",
                "routeDriveMinutesMatrix": "",
                "routeDriveMinutesOSRM": "",
                "sequenceStrategy": str(scaffold.get("sequenceStrategy", "SCAFFOLD_EMPTY_ROUTE")).strip() or "SCAFFOLD_EMPTY_ROUTE",
                "stops": [],
                "roadKey": "",
                "roadLine": [],
                "miles": None,
                "minutes": None,
                "minutesSource": "scaffold",
                "isScaffoldRoute": True,
            }
        )
        existing_names.add(route_name)
    return out


def _validate_fieldroutes_upload_csv(path: Path) -> dict:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        columns = [str(col).strip() for col in list(reader.fieldnames or []) if str(col).strip()]
        if not columns:
            raise ValueError("CSV appears empty or missing a header row.")
        missing = [col for col in FIELDROUTES_REQUIRED_UPLOAD_COLUMNS if col not in columns]
        if missing:
            raise ValueError(f"CSV missing required column(s): {', '.join(missing)}")

        row_count = 0
        for _ in reader:
            row_count += 1

    if row_count <= 0:
        raise ValueError("CSV has no data rows.")

    return {"columns": columns, "rowCount": row_count}


def _build_routes_from_rows(
    rows: list,
    *,
    manual_draft_edited: bool = True,
    scaffold_routes: Optional[List[Dict[str, Any]]] = None,
) -> list:
    groups = {}
    for row in rows:
        key = str(row.get("routeName", "")).strip()
        groups.setdefault(key, []).append(row)

    def _num_or_blank(value):
        raw = str(value).strip()
        if raw == "":
            return ""
        try:
            return float(raw)
        except Exception:
            return ""

    routes = []
    for route_name, grp in groups.items():
        grp = sorted(grp, key=lambda r: int(r.get("sequence", 0)))
        head = grp[0]
        stops = []
        for row in grp:
            stops.append(
                {
                    "planStopId": str(row.get("planStopId", "")).strip(),
                    "seq": int(row.get("sequence", 0)),
                    "lat": float(row.get("lat", 0.0) or 0.0),
                    "lng": float(row.get("lng", 0.0) or 0.0),
                    "customerID": str(row.get("customerID", "")).strip(),
                    "subscriptionID": str(row.get("subscriptionID", "")).strip(),
                    "duration": int(row.get("duration", 25) or 25),
                    "isRemote": _coerce_editor_bool(row.get("isRemote")),
                    "remoteZone": str(row.get("remoteZone", "")).strip(),
                    "assignmentReason": str(row.get("assignmentReason", "")).strip(),
                    "sequenceStrategy": str(row.get("sequenceStrategy", "")).strip(),
                    "driveModel": str(row.get("driveModel", "")).strip(),
                    "dayType": str(row.get("dayType", "")).strip(),
                    "fieldRoutesTemplateID": str(row.get("fieldRoutesTemplateID", "")).strip(),
                    "fieldRoutesTemplateSource": str(row.get("fieldRoutesTemplateSource", "")).strip(),
                    "capacityReason": str(row.get("capacityReason", "")).strip(),
                    "schedulingRequestRaw": str(row.get("schedulingRequestRaw", "")).strip(),
                    "schedulingRequestClass": str(row.get("schedulingRequestClass", "")).strip(),
                    "schedulingAllowedWeekdays": str(row.get("schedulingAllowedWeekdays", "")).strip(),
                    "schedulingBlockedWeekdays": str(row.get("schedulingBlockedWeekdays", "")).strip(),
                    "schedulingRequiresPhoneConfirm": _coerce_editor_bool(row.get("schedulingRequiresPhoneConfirm")),
                    "schedulingCritical": _coerce_editor_bool(row.get("schedulingCritical")),
                    "schedulingConstraintStatus": str(row.get("schedulingConstraintStatus", "")).strip(),
                    "schedulingConstraintNote": str(row.get("schedulingConstraintNote", "")).strip(),
                    "manualDraftEdited": bool(manual_draft_edited),
                }
            )
        road_line = [[float(s["lat"]), float(s["lng"])] for s in stops]
        routes.append(
            {
                "routeName": str(route_name),
                "routeIndex": head.get("routeIndex", ""),
                "tech": str(head.get("preferredTech", "")).strip(),
                "date": str(head.get("routeDate", "")).strip(),
                "color": _route_color_for_name(str(route_name)),
                "isRemoteRoute": any(bool(s.get("isRemote")) for s in stops),
                "remoteZones": sorted({str(s.get("remoteZone", "")).strip() for s in stops if str(s.get("remoteZone", "")).strip()}),
                "assignmentReasons": sorted({str(s.get("assignmentReason", "")).strip() for s in stops if str(s.get("assignmentReason", "")).strip()}),
                "capacityReasons": sorted({str(s.get("capacityReason", "")).strip() for s in stops if str(s.get("capacityReason", "")).strip()}),
                "dayType": str(head.get("dayType", "")).strip(),
                "fieldRoutesTemplateID": str(head.get("fieldRoutesTemplateID", "")).strip(),
                "fieldRoutesTemplateSource": str(head.get("fieldRoutesTemplateSource", "")).strip(),
                "driveModel": str(head.get("driveModel", "")).strip(),
                "routeDriveMinutesMatrix": _num_or_blank(head.get("routeDriveMinutesMatrix", "")),
                "routeDriveMinutesOSRM": _num_or_blank(head.get("routeDriveMinutesOSRM", "")),
                "sequenceStrategy": str(head.get("sequenceStrategy", "")).strip(),
                "stops": stops,
                "roadKey": ";".join([f"{s['lng']},{s['lat']}" for s in stops]),
                "roadLine": road_line,
                "miles": None,
                "minutes": None,
                "minutesSource": ("manual-draft" if bool(manual_draft_edited) else "matrix"),
                "manualDraftEdited": bool(manual_draft_edited),
            }
        )
    return _merge_scaffold_routes_into_payload(routes, _normalize_scaffold_routes(scaffold_routes))


def _rebuild_base_map_from_csv(paths: RunPaths) -> dict:
    rows = _load_plan_rows_list(paths.output_csv)
    if not rows:
        raise FileNotFoundError("routing_plan.csv is missing or empty.")

    scaffold_routes = _resolve_scaffold_routes(paths, rows)
    routes = _build_routes_from_rows(rows, manual_draft_edited=False, scaffold_routes=scaffold_routes)

    lats = []
    lngs = []
    for row in rows:
        try:
            lats.append(float(row.get("lat", "") or 0.0))
            lngs.append(float(row.get("lng", "") or 0.0))
        except Exception:
            continue
    center_lat = float(sum(lats) / len(lats)) if len(lats) > 0 else 36.332
    center_lng = float(sum(lngs) / len(lngs)) if len(lngs) > 0 else -94.118

    rebuilt_html = render_route_preview_html(
        routes,
        center_lat=center_lat,
        center_lng=center_lng,
        manual_draft_edited=False,
        run_id=paths.run_id,
    )
    paths.output_map.write_text(rebuilt_html, encoding="utf-8")
    return {
        "ok": True,
        "rebuilt": True,
        "runId": paths.run_id,
        "csvPath": str(paths.output_csv),
        "mapPath": str(paths.output_map),
        "downloadMapUrl": f"/download-map?runId={paths.run_id}",
        "openMapUrl": f"/open-map?runId={paths.run_id}",
    }


def _rebuild_edited_map_from_csv(paths: RunPaths) -> dict:
    rows = _load_plan_rows_list(paths.edited_output_csv)
    if not rows:
        raise FileNotFoundError("routing_plan.edited.csv is missing or empty.")

    scaffold_routes = _resolve_scaffold_routes(paths, rows)
    routes = _build_routes_from_rows(rows, manual_draft_edited=True, scaffold_routes=scaffold_routes)

    lats = []
    lngs = []
    for row in rows:
        try:
            lats.append(float(row.get("lat", "") or 0.0))
            lngs.append(float(row.get("lng", "") or 0.0))
        except Exception:
            continue
    center_lat = float(sum(lats) / len(lats)) if len(lats) > 0 else 36.332
    center_lng = float(sum(lngs) / len(lngs)) if len(lngs) > 0 else -94.118

    rebuilt_html = render_route_preview_html(
        routes,
        center_lat=center_lat,
        center_lng=center_lng,
        manual_draft_edited=True,
        run_id=paths.run_id,
    )
    paths.edited_output_map.write_text(rebuilt_html, encoding="utf-8")
    return {
        "ok": True,
        "rebuilt": True,
        "runId": paths.run_id,
        "csvPath": str(paths.edited_output_csv),
        "mapPath": str(paths.edited_output_map),
        "downloadEditedMapUrl": f"/download-edited-map?runId={paths.run_id}",
        "openEditedMapUrl": f"/open-edited-map?runId={paths.run_id}",
    }


def _run_settings_bundle(run_settings: Optional[dict]) -> dict:
    settings_bundle = normalize_run_settings({})
    if isinstance(run_settings, dict) and isinstance(run_settings.get("effective"), dict):
        settings_bundle = normalize_run_settings(run_settings.get("effective", {}))

    unknown_keys = list(settings_bundle.get("unknownKeys", []))
    corrections = list(settings_bundle.get("corrections", []))
    if isinstance(run_settings, dict):
        if isinstance(run_settings.get("unknownKeys"), list):
            unknown_keys = sorted(set(unknown_keys + [str(x) for x in run_settings.get("unknownKeys", [])]))
        if isinstance(run_settings.get("corrections"), list):
            corrections = list(dict.fromkeys(corrections + [str(x) for x in run_settings.get("corrections", [])]))

    settings_bundle["unknownKeys"] = list(unknown_keys)
    settings_bundle["corrections"] = list(corrections)
    return settings_bundle


def _run_state_payload(effective_settings: dict, settings_meta: dict, settings_summary: Optional[str]) -> dict:
    return {
        "runSettings": effective_settings,
        "runSettingsMeta": settings_meta,
        "runSettingsSummary": settings_summary,
    }


def _run_thread(paths: RunPaths, run_settings: Optional[dict] = None) -> None:
    settings_bundle = _run_settings_bundle(run_settings)
    effective_settings = dict(settings_bundle.get("effective", {}))
    settings_meta = {
        "unknownKeys": list(settings_bundle.get("unknownKeys", [])),
        "corrections": list(settings_bundle.get("corrections", [])),
    }
    settings_summary = summarize_run_settings(effective_settings) if effective_settings else None

    with JOB_LOCK:
        JOB_STATE["status"] = "running"
        JOB_STATE["startedAt"] = _utc()
        JOB_STATE["finishedAt"] = None
        JOB_STATE["error"] = None
        JOB_STATE["runId"] = paths.run_id
        JOB_STATE["runSettings"] = effective_settings
        JOB_STATE["runSettingsMeta"] = settings_meta
        JOB_STATE["runSettingsSummary"] = settings_summary

    _touch_run_registry(
        paths.run_id,
        status="running",
        message="Routing started.",
        run_settings_summary=settings_summary,
    )
    _log_event("run_started", runId=paths.run_id)

    _safe_write_progress(
        paths,
        {
            "status": "running",
            "stage": "starting",
            "percent": 0,
            "message": "Starting routing…",
            "startedAt": JOB_STATE["startedAt"],
            "runId": paths.run_id,
            **_run_state_payload(effective_settings, settings_meta, settings_summary),
        },
    )

    try:
        routing_result = run_routing(
            str(paths.upload_file),
            progress_path=str(paths.progress_file),
            run_settings=settings_bundle,
            run_id=paths.run_id,
        )
        map_exists = bool(paths.output_map.exists())
        csv_exists = bool(paths.output_csv.exists())
        warning_text = ""
        if isinstance(routing_result, dict) and str(routing_result.get("warning", "")).strip():
            warning_text = str(routing_result.get("warning", "")).strip()
        if (not map_exists) and csv_exists and not warning_text:
            warning_text = "Map output is missing. Use Rebuild Map to regenerate route_preview.html."

        done_message = "Routing complete." if not warning_text else "Routing complete with warning."
        done_stage = "complete" if not warning_text else "complete_with_warning"

        with JOB_LOCK:
            JOB_STATE["status"] = "done"
            JOB_STATE["finishedAt"] = _utc()

        _touch_run_registry(
            paths.run_id,
            status="done",
            message=done_message,
            run_settings_summary=settings_summary,
        )
        _log_event("run_finished", runId=paths.run_id, warning=warning_text or None)

        _safe_write_progress(
            paths,
            {
                "status": "done",
                "stage": done_stage,
                "percent": 100,
                "message": done_message,
                "warning": warning_text or None,
                "runId": paths.run_id,
                "startedAt": JOB_STATE["startedAt"],
                "finishedAt": JOB_STATE["finishedAt"],
                **_run_state_payload(effective_settings, settings_meta, settings_summary),
                "outputs": {
                    "csv": paths.output_csv.name if paths.output_csv.exists() else None,
                    "map": paths.output_map.name if paths.output_map.exists() else None,
                },
            },
        )

    except Exception as e:
        with JOB_LOCK:
            JOB_STATE["status"] = "error"
            JOB_STATE["finishedAt"] = _utc()
            JOB_STATE["error"] = str(e)

        _touch_run_registry(
            paths.run_id,
            status="error",
            message="Routing failed.",
            error=str(e),
            run_settings_summary=settings_summary,
        )
        _log_event("run_failed", runId=paths.run_id, error=str(e))

        _safe_write_progress(
            paths,
            {
                "status": "error",
                "stage": "error",
                "percent": 100,
                "message": "Routing failed.",
                "error": str(e),
                "runId": paths.run_id,
                "startedAt": JOB_STATE.get("startedAt"),
                "finishedAt": JOB_STATE.get("finishedAt"),
                **_run_state_payload(effective_settings, settings_meta, settings_summary),
                "outputs": {
                    "csv": paths.output_csv.name if paths.output_csv.exists() else None,
                    "map": paths.output_map.name if paths.output_map.exists() else None,
                },
            },
        )


def _start_job(paths: RunPaths, run_settings: Optional[dict]) -> None:
    settings_bundle = _run_settings_bundle(run_settings)
    effective_settings = dict(settings_bundle.get("effective", {}))
    settings_meta = {
        "unknownKeys": list(settings_bundle.get("unknownKeys", [])),
        "corrections": list(settings_bundle.get("corrections", [])),
    }
    settings_summary = summarize_run_settings(effective_settings) if effective_settings else None

    with JOB_LOCK:
        JOB_STATE["status"] = "idle"
        JOB_STATE["startedAt"] = None
        JOB_STATE["finishedAt"] = None
        JOB_STATE["error"] = None
        JOB_STATE["runId"] = paths.run_id
        JOB_STATE["runSettings"] = effective_settings
        JOB_STATE["runSettingsMeta"] = settings_meta
        JOB_STATE["runSettingsSummary"] = settings_summary

    _touch_run_registry(
        paths.run_id,
        status="idle",
        message="File uploaded. Starting…",
        run_settings_summary=settings_summary,
    )

    _safe_write_progress(
        paths,
        {
            "status": "idle",
            "stage": "ready",
            "percent": 0,
            "message": "File uploaded. Starting…",
            "runId": paths.run_id,
            **_run_state_payload(effective_settings, settings_meta, settings_summary),
        },
    )

    t = threading.Thread(target=_run_thread, args=(paths, settings_bundle), daemon=True)
    JOB_THREAD["thread"] = t
    t.start()


def _can_auto_start(paths: RunPaths) -> bool:
    if not paths.upload_file.exists():
        return False
    if _is_job_running():
        return False
    if not paths.output_csv.exists() and not paths.output_map.exists():
        return True
    try:
        upload_mtime = paths.upload_file.stat().st_mtime
        output_mtime = max(
            paths.output_csv.stat().st_mtime if paths.output_csv.exists() else 0,
            paths.output_map.stat().st_mtime if paths.output_map.exists() else 0,
        )
        return upload_mtime > output_mtime
    except Exception:
        return True


def _verify_data_root_writable() -> bool:
    try:
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        probe = DATA_ROOT / ".write_probe"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink(missing_ok=True)
        return True
    except Exception:
        return False


@app.on_event("startup")
def _startup():
    ok = _verify_data_root_writable()
    _log_event("startup", dataRoot=str(DATA_ROOT), writable=bool(ok), authEnabled=bool(FR_AUTH_ENABLED))

    if FR_AUTH_ENABLED and not FR_SHARED_PASSWORD:
        _log_event("auth_warning", message="FR_SHARED_PASSWORD is empty while FR_AUTH_ENABLED=1")

    if not AUTO_START_ON_BOOT:
        return

    rid = _latest_run_id(prefer_uploaded=True)
    if not rid:
        return
    paths = _run_paths(rid)
    if _can_auto_start(paths):
        _start_job(paths, normalize_run_settings({}))


@app.get("/healthz")
def healthz():
    return {"ok": True, "time": _utc()}


@app.get("/readyz")
def readyz():
    writable = _verify_data_root_writable()
    osrm_ok = bool(_osrm_service_available(force_refresh=True))
    payload = {
        "ok": bool(writable and osrm_ok),
        "dataRoot": str(DATA_ROOT),
        "writable": bool(writable),
        "osrmReachable": bool(osrm_ok),
        "osrmBaseUrl": str(get_osrm_base_url()),
        "time": _utc(),
    }
    if payload["ok"]:
        return JSONResponse(payload)
    return JSONResponse(payload, status_code=503)


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if JOB_STATE.get("status") == "running" and not _is_job_running():
        with JOB_LOCK:
            JOB_STATE["status"] = "idle"
            JOB_STATE["error"] = None
            JOB_STATE["startedAt"] = None
            JOB_STATE["finishedAt"] = None
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/runs")
def runs(limit: int = Query(default=30, ge=1, le=200)):
    out = _list_runs(limit=limit)
    active_run_id = str(JOB_STATE.get("runId") or "") if _is_job_running() else None
    return {
        "runs": out,
        "activeRunId": active_run_id,
        "count": len(out),
        "dataRoot": str(DATA_ROOT),
    }


@app.get("/fieldroutes/pilot/config")
def fieldroutes_pilot_config():
    creds = _fieldroutes_credentials_status()
    state = _fieldroutes_state_payload()
    return JSONResponse(
        {
            "ok": bool(creds.get("configured")),
            "credentials": creds,
            "running": bool(_is_fieldroutes_push_running()),
            "adminRequired": bool(state.get("adminRequired")),
            "state": state,
        }
    )


@app.get("/fieldroutes/pilot/status")
def fieldroutes_pilot_status():
    return JSONResponse(_fieldroutes_state_payload())


@app.get("/fieldroutes/pilot/history")
def fieldroutes_pilot_history(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId, prefer_uploaded=True)
    if not resolved_run_id or not paths:
        return JSONResponse({"error": "RUN_NOT_FOUND", "message": "No run found for FieldRoutes history."}, status_code=404)

    entries = _load_fieldroutes_history_entries(paths)
    entries_sorted = sorted(entries, key=lambda item: str(item.get("appliedAt") or ""), reverse=True)
    by_scope = {}
    for entry in entries_sorted:
        date_s = str(entry.get("date") or "").strip()
        if not date_s:
            continue
        pref_s = str(entry.get("preferredTech") or "").strip()
        scope_key = f"{date_s}|{_normalize_person_name(pref_s) or 'ALL'}"
        by_scope[scope_key] = entry

    return JSONResponse(
        {
            "runId": resolved_run_id,
            "history": entries_sorted,
            "byScope": by_scope,
            "count": len(entries_sorted),
        }
    )


@app.post("/fieldroutes/pilot/upload-edited")
async def fieldroutes_pilot_upload_edited(
    request: Request,
    file: UploadFile = File(...),
    runId: Optional[str] = Form(default=None),
):
    auth_error = _fieldroutes_admin_auth_error(request)
    if auth_error is not None:
        return auth_error

    if _is_fieldroutes_push_running():
        return JSONResponse(
            {
                "error": "FIELDROUTES_PUSH_IN_PROGRESS",
                "message": "A FieldRoutes push is already running.",
            },
            status_code=409,
        )

    run_id_raw = str(runId or "").strip()
    try:
        run_id = _sanitize_run_id(run_id_raw) if run_id_raw else _new_run_id()
    except Exception:
        return JSONResponse({"error": "INVALID_RUN_ID", "message": "runId format is invalid."}, status_code=422)

    paths = _run_paths(run_id)
    _ensure_run_dir(paths)
    temp_path = paths.run_dir / f".upload-edited-{uuid.uuid4().hex}.csv"
    filename = str(file.filename or "").strip() or "uploaded.edited.csv"

    try:
        with temp_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        if int(temp_path.stat().st_size) <= 0:
            return JSONResponse({"error": "EMPTY_UPLOAD", "message": "Uploaded CSV file is empty."}, status_code=422)

        try:
            parsed = _validate_fieldroutes_upload_csv(temp_path)
        except Exception as e:
            return JSONResponse(
                {
                    "error": "INVALID_CSV",
                    "message": str(e),
                    "requiredColumns": list(FIELDROUTES_REQUIRED_UPLOAD_COLUMNS),
                },
                status_code=422,
            )

        os.replace(temp_path, paths.edited_output_csv)
        # Keep uploaded.csv present for new runs, but do not overwrite existing source uploads.
        if not paths.upload_file.exists():
            shutil.copy2(paths.edited_output_csv, paths.upload_file)

        for stale in (paths.edited_output_map, paths.edit_audit_file):
            try:
                if stale.exists():
                    stale.unlink()
            except Exception:
                pass

        _touch_run_registry(run_id, status="done", message="Edited CSV uploaded for FieldRoutes push.")
        _log_event(
            "fieldroutes_edited_csv_uploaded",
            runId=run_id,
            filename=filename,
            bytes=int(paths.edited_output_csv.stat().st_size) if paths.edited_output_csv.exists() else None,
            rowCount=int(parsed.get("rowCount") or 0),
        )
        return JSONResponse(
            {
                "ok": True,
                "runId": run_id,
                "resolvedRunId": run_id,
                "message": "Edited CSV uploaded. Ready for FieldRoutes push.",
                "fileName": filename,
                "rowCount": int(parsed.get("rowCount") or 0),
                "columns": parsed.get("columns") or [],
                "editedCsvPath": str(paths.edited_output_csv),
                "downloadEditedCsvUrl": f"/download-edited-csv?runId={run_id}",
                "state": _fieldroutes_state_payload(),
            }
        )
    except Exception as e:
        _log_event(
            "fieldroutes_edited_csv_upload_failed",
            runId=run_id,
            filename=filename,
            runDir=str(paths.run_dir),
            dataRoot=str(DATA_ROOT),
            error=str(e),
        )
        return JSONResponse(
            {
                "error": "UPLOAD_FAILED",
                "message": f"Upload failed: {e}",
                "runId": run_id,
                "dataRoot": str(DATA_ROOT),
            },
            status_code=500,
        )
    finally:
        try:
            if temp_path.exists():
                temp_path.unlink()
        except Exception:
            pass


@app.post("/fieldroutes/pilot/start")
async def fieldroutes_pilot_start(request: Request):
    auth_error = _fieldroutes_admin_auth_error(request)
    if auth_error is not None:
        return auth_error

    try:
        payload = await request.json()
    except Exception:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    if _is_job_running():
        return JSONResponse(
            {
                "error": "ROUTING_RUN_IN_PROGRESS",
                "message": "Routing is currently running. Wait for it to finish before pushing to FieldRoutes.",
                "activeRunId": JOB_STATE.get("runId"),
            },
            status_code=409,
        )
    if _is_fieldroutes_push_running():
        return JSONResponse(
            {
                "error": "FIELDROUTES_PUSH_IN_PROGRESS",
                "message": "A FieldRoutes push is already running.",
                "state": _fieldroutes_state_payload(),
            },
            status_code=409,
        )

    run_id_raw = payload.get("runId")
    use_edited = bool(payload.get("useEdited", True))
    sync_duration = bool(payload.get("syncDuration", False))
    mode = str(payload.get("mode", "dry-run")).strip().lower()
    preferred_tech = str(payload.get("preferredTech") or "").strip()
    if preferred_tech.upper() == "__ALL__":
        preferred_tech = ""
    if mode not in {"dry-run", "apply"}:
        return JSONResponse({"error": "INVALID_MODE", "message": "mode must be 'dry-run' or 'apply'."}, status_code=422)

    date_raw = str(payload.get("date", "")).strip()
    try:
        date_value = datetime.strptime(date_raw, "%Y-%m-%d").strftime("%Y-%m-%d")
    except Exception:
        return JSONResponse({"error": "INVALID_DATE", "message": "date must be YYYY-MM-DD."}, status_code=422)

    resolved_run_id, paths = _resolve_run(run_id_raw, prefer_uploaded=True)
    if not resolved_run_id or not paths:
        return JSONResponse({"error": "RUN_NOT_FOUND", "message": "No run found for FieldRoutes push."}, status_code=404)

    csv_path = paths.edited_output_csv if use_edited else paths.output_csv
    if not csv_path.exists():
        return JSONResponse(
            {
                "error": "CSV_NOT_FOUND",
                "message": f"CSV not found for runId={resolved_run_id}: {csv_path.name}",
                "hint": ("Save draft first to create edited CSV." if use_edited else "Generate routing output first."),
            },
            status_code=404,
        )

    creds = _fieldroutes_credentials_status()
    if not creds.get("configured"):
        return JSONResponse(
            {
                "error": "FIELDROUTES_CREDENTIALS_MISSING",
                "message": "FieldRoutes credentials are not configured on the server.",
                "credentials": creds,
            },
            status_code=422,
        )

    t = threading.Thread(
        target=_run_fieldroutes_push_thread,
        kwargs={
            "run_id": resolved_run_id,
            "date_value": date_value,
            "preferred_tech": (preferred_tech or None),
            "mode": mode,
            "use_edited": bool(use_edited),
            "sync_duration": bool(sync_duration),
        },
        daemon=True,
    )
    FIELDROUTES_PUSH_THREAD["thread"] = t
    t.start()

    return JSONResponse(
        {
            "ok": True,
            "message": "FieldRoutes push started.",
            "state": _fieldroutes_state_payload(),
        },
        status_code=202,
    )


@app.get("/osrm-preflight")
def osrm_preflight():
    ok = bool(_osrm_service_available(force_refresh=True))
    active = str(get_osrm_base_url())
    if not ok:
        _log_event("osrm_preflight_failed", activeBaseUrl=active)
    return JSONResponse(
        {
            "ok": ok,
            "osrmBaseUrl": active,
            "osrmConfiguredBaseUrl": str(OSRM_BASE_URL),
            "osrmCandidates": [str(x) for x in list(OSRM_BASE_CANDIDATES)],
            "strictOsrmMode": bool(STRICT_OSRM_FOR_OPTIMIZATION),
            "failFastIfUnavailable": bool(FAIL_FAST_IF_OSRM_UNAVAILABLE),
            "message": (
                "OSRM reachable."
                if ok
                else "OSRM unreachable. Strict mode blocks route generation until OSRM is healthy."
            ),
        }
    )


@app.get("/run-settings")
def run_settings():
    defaults = get_run_settings_defaults()
    limits = get_run_settings_limits()
    ui_hints = get_run_settings_ui_hints()
    notes = get_non_exposed_run_settings_notes()
    return JSONResponse(
        {
            "defaults": defaults,
            "limits": limits,
            "uiHints": ui_hints,
            "nonExposedNotes": notes,
            "active": {
                "runId": JOB_STATE.get("runId"),
                "runSettings": JOB_STATE.get("runSettings"),
                "runSettingsMeta": JOB_STATE.get("runSettingsMeta"),
                "runSettingsSummary": JOB_STATE.get("runSettingsSummary"),
            },
        }
    )


@app.get("/plan-editor/status")
def plan_editor_status(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)

    if not resolved_run_id or not paths:
        # Legacy fallback for pre-run-id files.
        return JSONResponse(
            {
                "resolvedRunId": None,
                "base": {"csv": _file_meta(LEGACY_OUTPUT_CSV), "map": _file_meta(LEGACY_OUTPUT_MAP)},
                "edited": {
                    "csv": _file_meta(LEGACY_EDITED_OUTPUT_CSV),
                    "map": _file_meta(LEGACY_EDITED_OUTPUT_MAP),
                    "audit": _file_meta(LEGACY_EDIT_AUDIT_FILE),
                },
                "hasEditedDraft": bool(LEGACY_EDITED_OUTPUT_CSV.exists() and LEGACY_EDITED_OUTPUT_MAP.exists()),
            }
        )

    return JSONResponse(
        {
            "resolvedRunId": resolved_run_id,
            "base": {
                "csv": _file_meta(paths.output_csv),
                "map": _file_meta(paths.output_map),
            },
            "edited": {
                "csv": _file_meta(paths.edited_output_csv),
                "map": _file_meta(paths.edited_output_map),
                "audit": _file_meta(paths.edit_audit_file),
            },
            "hasEditedDraft": bool(paths.edited_output_csv.exists() and paths.edited_output_map.exists()),
        }
    )


@app.post("/rebuild-map")
def rebuild_map(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)
    if not resolved_run_id or not paths:
        if LEGACY_OUTPUT_CSV.exists():
            rows = _load_plan_rows_list(LEGACY_OUTPUT_CSV)
            if not rows:
                return JSONResponse({"error": "CSV_NOT_READY", "message": "routing_plan.csv missing or empty."}, status_code=404)
            legacy_scaffolds = _infer_scaffold_routes_from_rows(rows)
            routes = _build_routes_from_rows(rows, manual_draft_edited=False, scaffold_routes=legacy_scaffolds)
            center_lat = float(sum(float(r.get("lat", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
            center_lng = float(sum(float(r.get("lng", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
            legacy_html = render_route_preview_html(routes, center_lat=center_lat, center_lng=center_lng, manual_draft_edited=False)
            LEGACY_OUTPUT_MAP.write_text(legacy_html, encoding="utf-8")
            return JSONResponse(
                {
                    "ok": True,
                    "rebuilt": True,
                    "runId": None,
                    "csvPath": str(LEGACY_OUTPUT_CSV),
                    "mapPath": str(LEGACY_OUTPUT_MAP),
                    "downloadMapUrl": "/download-map",
                    "openMapUrl": "/open-map",
                }
            )
        return JSONResponse({"error": "CSV_NOT_READY", "message": "No run found and legacy CSV not found."}, status_code=404)

    if not paths.output_csv.exists():
        return JSONResponse(
            {"error": "CSV_NOT_READY", "message": f"routing_plan.csv not found for runId={resolved_run_id}."},
            status_code=404,
        )

    try:
        payload = _rebuild_base_map_from_csv(paths)
        if JOB_STATE.get("runId") == resolved_run_id:
            with JOB_LOCK:
                if JOB_STATE.get("status") == "error":
                    JOB_STATE["status"] = "done"
                JOB_STATE["error"] = None
                if not JOB_STATE.get("finishedAt"):
                    JOB_STATE["finishedAt"] = _utc()

        _touch_run_registry(resolved_run_id, status="done", message="Rebuilt route map from existing routing_plan.csv.")
        _safe_write_progress(
            paths,
            {
                "status": "done",
                "stage": "map_rebuilt",
                "percent": 100,
                "message": "Rebuilt route map from existing routing_plan.csv.",
                "runId": resolved_run_id,
                "startedAt": JOB_STATE.get("startedAt") if JOB_STATE.get("runId") == resolved_run_id else None,
                "finishedAt": JOB_STATE.get("finishedAt") if JOB_STATE.get("runId") == resolved_run_id else _utc(),
                "runSettings": JOB_STATE.get("runSettings") if JOB_STATE.get("runId") == resolved_run_id else None,
                "runSettingsMeta": JOB_STATE.get("runSettingsMeta") if JOB_STATE.get("runId") == resolved_run_id else None,
                "runSettingsSummary": JOB_STATE.get("runSettingsSummary") if JOB_STATE.get("runId") == resolved_run_id else None,
                "outputs": {
                    "csv": paths.output_csv.name if paths.output_csv.exists() else None,
                    "map": paths.output_map.name if paths.output_map.exists() else None,
                },
            },
        )
        return JSONResponse(payload)
    except Exception as e:
        return JSONResponse({"error": "MAP_REBUILD_FAILED", "message": str(e)}, status_code=500)


@app.post("/plan-editor/save")
async def plan_editor_save(request: Request, runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)
    if not resolved_run_id or not paths:
        return JSONResponse({"error": "RUN_NOT_FOUND", "message": "No run found. Generate routes first."}, status_code=404)

    try:
        payload = await request.json()
    except Exception as e:
        return JSONResponse({"error": "INVALID_JSON", "message": str(e)}, status_code=422)

    rows_raw = payload.get("rows", None) if isinstance(payload, dict) else None
    routes_raw = payload.get("routes", None) if isinstance(payload, dict) else None
    scaffold_routes_raw = payload.get("scaffoldRoutes", None) if isinstance(payload, dict) else None

    try:
        normalized = _normalize_editor_rows(rows_raw)
    except Exception as e:
        return JSONResponse({"error": "INVALID_EDITOR_ROWS", "message": str(e)}, status_code=422)

    rows = list(normalized["rows"])
    rows.sort(key=lambda r: (str(r.get("preferredTech", "")), str(r.get("routeDate", "")), str(r.get("routeName", "")), int(r.get("sequence", 0))))

    base_rows = _load_plan_rows(paths.output_csv)
    changed_entries = []
    for row in rows:
        pid = str(row.get("planStopId", "")).strip()
        prev = base_rows.get(pid)
        if prev is None:
            changed_entries.append(
                {
                    "planStopId": pid,
                    "changeType": "new",
                    "after": {
                        "preferredTech": row.get("preferredTech", ""),
                        "routeDate": row.get("routeDate", ""),
                        "routeName": row.get("routeName", ""),
                        "sequence": row.get("sequence", 0),
                    },
                }
            )
            continue
        before = {
            "preferredTech": str(prev.get("preferredTech", "")),
            "routeDate": str(prev.get("routeDate", "")),
            "routeName": str(prev.get("routeName", "")),
            "sequence": int(float(prev.get("sequence", 0))) if str(prev.get("sequence", "")).strip() != "" else 0,
        }
        after = {
            "preferredTech": str(row.get("preferredTech", "")),
            "routeDate": str(row.get("routeDate", "")),
            "routeName": str(row.get("routeName", "")),
            "sequence": int(row.get("sequence", 0)),
        }
        if before != after:
            changed_entries.append({"planStopId": pid, "changeType": "updated", "before": before, "after": after})

    routes_touched = sorted({str(e.get("after", {}).get("routeName", "")) for e in changed_entries if str(e.get("after", {}).get("routeName", "")).strip()})
    dates_touched = sorted({str(e.get("after", {}).get("routeDate", "")) for e in changed_entries if str(e.get("after", {}).get("routeDate", "")).strip()})

    with paths.edited_output_csv.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=ROUTING_PLAN_EXPORT_COLUMNS)
        writer.writeheader()
        for row in rows:
            out = dict(row)
            out["isRemote"] = "True" if bool(out.get("isRemote")) else "False"
            writer.writerow(out)

    scaffold_source = "editor_inferred"
    if scaffold_routes_raw is not None:
        scaffold_routes = _normalize_scaffold_routes(scaffold_routes_raw)
        scaffold_source = "editor_scaffold_routes"
    else:
        extracted_scaffolds = _extract_scaffold_routes_from_routes_payload(routes_raw)
        if extracted_scaffolds:
            scaffold_routes = extracted_scaffolds
            scaffold_source = "editor_routes_payload"
        else:
            scaffold_routes = _resolve_scaffold_routes(paths, rows)
            scaffold_source = "existing_or_inferred"

    existing_scaffold_payload = _read_route_scaffold_payload(paths.route_scaffolds_file)
    planning_start = str(existing_scaffold_payload.get("planningStart", "")).strip() or None
    planning_end = str(existing_scaffold_payload.get("planningEnd", "")).strip() or None
    if not planning_start or not planning_end:
        assigned_dates: List[str] = []
        for row in rows:
            route_date = _coerce_iso_date(row.get("routeDate", ""))
            route_name = str(row.get("routeName", "")).strip()
            if not route_date or _is_unassigned_route(route_name, route_date):
                continue
            assigned_dates.append(route_date)
        if assigned_dates:
            assigned_dates = sorted(set(assigned_dates))
            planning_start = planning_start or assigned_dates[0]
            planning_end = planning_end or assigned_dates[-1]

    _write_scaffold_routes(
        paths,
        scaffold_routes,
        source=scaffold_source,
        planning_start=planning_start,
        planning_end=planning_end,
    )

    if isinstance(routes_raw, list) and len(routes_raw) > 0:
        routes_for_html = _merge_scaffold_routes_into_payload(routes_raw, scaffold_routes)
    else:
        routes_for_html = _build_routes_from_rows(rows, scaffold_routes=scaffold_routes)

    lats = [float(r["lat"]) for r in rows if isinstance(r.get("lat"), (int, float))]
    lngs = [float(r["lng"]) for r in rows if isinstance(r.get("lng"), (int, float))]
    center_lat = float(sum(lats) / len(lats)) if len(lats) > 0 else 36.332
    center_lng = float(sum(lngs) / len(lngs)) if len(lngs) > 0 else -94.118

    edited_html = render_route_preview_html(
        routes_for_html,
        center_lat=center_lat,
        center_lng=center_lng,
        manual_draft_edited=True,
        run_id=resolved_run_id,
    )
    paths.edited_output_map.write_text(edited_html, encoding="utf-8")

    audit_payload = {
        "savedAt": _utc(),
        "runId": resolved_run_id,
        "inputRows": int(len(rows)),
        "changedRows": int(len(changed_entries)),
        "routesTouched": routes_touched,
        "datesTouched": dates_touched,
        "changes": changed_entries,
    }
    paths.edit_audit_file.write_text(json.dumps(audit_payload, indent=2), encoding="utf-8")

    _touch_run_registry(resolved_run_id, status=(JOB_STATE.get("status") if JOB_STATE.get("runId") == resolved_run_id else "done"), message="Draft saved.")
    _log_event("editor_saved", runId=resolved_run_id, changedRows=int(len(changed_entries)))

    return JSONResponse(
        {
            "ok": True,
            "runId": resolved_run_id,
            "changedRows": int(len(changed_entries)),
            "routesTouched": routes_touched,
            "datesTouched": dates_touched,
            "warnings": [
                "Route drive metrics in manual draft are marked stale until re-optimized.",
            ],
            "editedCsvPath": str(paths.edited_output_csv),
            "editedMapPath": str(paths.edited_output_map),
            "auditPath": str(paths.edit_audit_file),
            "downloadEditedCsvUrl": f"/download-edited-csv?runId={resolved_run_id}",
            "downloadEditedMapUrl": f"/download-edited-map?runId={resolved_run_id}",
            "scaffoldRoutesSaved": int(len(scaffold_routes)),
            "scaffoldPath": str(paths.route_scaffolds_file),
        }
    )


async def _start_job_from_upload(
    file: UploadFile,
    *,
    force: bool = False,
    run_settings: Optional[dict] = None,
    owner_label: Optional[str] = None,
):
    if _is_job_running():
        return _conflict_response()

    run_id = _new_run_id()
    paths = _run_paths(run_id)
    _ensure_run_dir(paths)

    with paths.upload_file.open("wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    _touch_run_registry(run_id, status="idle", message="Upload received.", owner_label=owner_label)
    _log_event("run_created", runId=run_id, ownerLabel=(owner_label or None))
    _start_job(paths, run_settings)

    return {
        "ok": True,
        "runId": run_id,
        "resolvedRunId": run_id,
        "message": "Routing started.",
        "status": "running",
        "progressUrl": f"/progress?runId={run_id}",
        "uploadUrl": "/upload",
        "generateUrl": "/generate",
        "downloadCsvUrl": f"/download-csv?runId={run_id}",
        "downloadMapUrl": f"/download-map?runId={run_id}",
        "openMapUrl": f"/open-map?runId={run_id}",
    }


@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
    settings: Optional[str] = Form(None),
    force: bool = False,
    ownerLabel: Optional[str] = Form(None),
):
    try:
        normalized = _parse_run_settings_json(settings)
    except Exception as e:
        return JSONResponse({"error": "INVALID_RUN_SETTINGS", "message": str(e)}, status_code=422)
    return await _start_job_from_upload(file=file, force=force, run_settings=normalized, owner_label=ownerLabel)


@app.post("/generate")
async def generate(
    file: UploadFile = File(...),
    settings: Optional[str] = Form(None),
    force: bool = False,
    ownerLabel: Optional[str] = Form(None),
):
    return await upload(file=file, settings=settings, force=force, ownerLabel=ownerLabel)


@app.post("/run-existing")
def run_existing(
    force: bool = False,
    settings: Optional[str] = Form(None),
    runId: Optional[str] = Query(default=None),
):
    if _is_job_running():
        return _conflict_response()

    resolved_run_id, paths = _resolve_run(runId, prefer_uploaded=True)
    if not resolved_run_id or not paths or not paths.upload_file.exists():
        if LEGACY_UPLOAD_FILE.exists():
            # Backward-compatible behavior.
            legacy_run_id = _new_run_id()
            legacy_paths = _run_paths(legacy_run_id)
            _ensure_run_dir(legacy_paths)
            shutil.copy2(LEGACY_UPLOAD_FILE, legacy_paths.upload_file)
            resolved_run_id = legacy_run_id
            paths = legacy_paths
        else:
            return JSONResponse(
                {
                    "error": "uploaded.csv not found.",
                    "hint": "Upload once or provide runId that has an uploaded.csv.",
                },
                status_code=404,
            )

    try:
        normalized = _parse_run_settings_json(settings)
    except Exception as e:
        return JSONResponse({"error": "INVALID_RUN_SETTINGS", "message": str(e)}, status_code=422)

    _start_job(paths, normalized)
    _touch_run_registry(resolved_run_id, status="idle", message="Started from existing upload.")
    _log_event("run_restarted_existing", runId=resolved_run_id)
    return {
        "ok": True,
        "runId": resolved_run_id,
        "resolvedRunId": resolved_run_id,
        "message": "Routing started from existing uploaded.csv.",
        "status": "running",
        "progressUrl": f"/progress?runId={resolved_run_id}",
        "downloadCsvUrl": f"/download-csv?runId={resolved_run_id}",
        "downloadMapUrl": f"/download-map?runId={resolved_run_id}",
        "openMapUrl": f"/open-map?runId={resolved_run_id}",
    }


@app.post("/reset")
def reset():
    if _is_job_running():
        return JSONResponse(
            {
                "error": "Job is currently running; cannot reset safely.",
                "status": "running",
                "activeRunId": JOB_STATE.get("runId"),
            },
            status_code=409,
        )

    with JOB_LOCK:
        JOB_STATE["status"] = "idle"
        JOB_STATE["startedAt"] = None
        JOB_STATE["finishedAt"] = None
        JOB_STATE["error"] = None
        JOB_STATE["runId"] = None
        JOB_STATE["runSettings"] = None
        JOB_STATE["runSettingsMeta"] = None
        JOB_STATE["runSettingsSummary"] = None

    return {"status": "idle", "message": "Reset complete."}


@app.get("/progress")
def progress(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)

    if resolved_run_id and paths and paths.progress_file.exists():
        try:
            data = json.loads(paths.progress_file.read_text(encoding="utf-8"))
            data.setdefault("runId", resolved_run_id)
            data.setdefault("resolvedRunId", resolved_run_id)
            if JOB_STATE.get("runId") == resolved_run_id:
                data.setdefault("job", JOB_STATE)
                data.setdefault("runSettings", JOB_STATE.get("runSettings"))
                data.setdefault("runSettingsMeta", JOB_STATE.get("runSettingsMeta"))
                data.setdefault("runSettingsSummary", JOB_STATE.get("runSettingsSummary"))
            data.setdefault(
                "outputs",
                {
                    "csv": paths.output_csv.name if paths.output_csv.exists() else None,
                    "map": paths.output_map.name if paths.output_map.exists() else None,
                },
            )
            return JSONResponse(_compute_timing_fields(data))
        except Exception:
            pass

    # Legacy fallback when no runId data exists.
    if (not resolved_run_id) and LEGACY_PROGRESS_FILE.exists():
        try:
            data = json.loads(LEGACY_PROGRESS_FILE.read_text(encoding="utf-8"))
            data.setdefault("resolvedRunId", None)
            return JSONResponse(_compute_timing_fields(data))
        except Exception:
            pass

    return JSONResponse(_compute_timing_fields(_default_progress_payload(resolved_run_id, paths)))


def _resolve_download_target(runId: Optional[str], target: str) -> Tuple[Optional[str], Optional[Path]]:
    resolved_run_id, paths = _resolve_run(runId)
    if resolved_run_id and paths:
        if target == "csv":
            return resolved_run_id, paths.output_csv
        if target == "map":
            return resolved_run_id, paths.output_map
        if target == "edited_csv":
            return resolved_run_id, paths.edited_output_csv
        if target == "edited_map":
            return resolved_run_id, paths.edited_output_map

    # Legacy fallback
    if target == "csv" and LEGACY_OUTPUT_CSV.exists():
        return None, LEGACY_OUTPUT_CSV
    if target == "map" and LEGACY_OUTPUT_MAP.exists():
        return None, LEGACY_OUTPUT_MAP
    if target == "edited_csv" and LEGACY_EDITED_OUTPUT_CSV.exists():
        return None, LEGACY_EDITED_OUTPUT_CSV
    if target == "edited_map" and LEGACY_EDITED_OUTPUT_MAP.exists():
        return None, LEGACY_EDITED_OUTPUT_MAP

    return None, None


def _resolve_fieldroutes_artifact_target(runId: Optional[str], target: str) -> Tuple[Optional[str], Optional[Path]]:
    resolved_run_id, paths = _resolve_run(runId, prefer_uploaded=True)
    if not resolved_run_id or not paths:
        return None, None
    art = _fieldroutes_artifact_paths(paths)
    if target == "report":
        return resolved_run_id, art["report"]
    if target == "exceptions":
        return resolved_run_id, art["exceptions"]
    if target == "request_log":
        return resolved_run_id, art["requestLog"]
    return None, None


@app.get("/download-csv")
def download_csv(runId: Optional[str] = Query(default=None)):
    _, path = _resolve_download_target(runId, "csv")
    if not path or not path.exists():
        return JSONResponse({"error": "CSV not ready yet."}, status_code=404)
    return FileResponse(str(path), filename=path.name)


@app.get("/download-map")
def download_map(runId: Optional[str] = Query(default=None), inline: bool = Query(default=False)):
    _, path = _resolve_download_target(runId, "map")
    if not path or not path.exists():
        return JSONResponse({"error": "Map not ready yet."}, status_code=404)
    if inline:
        return FileResponse(str(path), media_type="text/html")
    return FileResponse(str(path), filename=path.name)


@app.get("/open-map")
def open_map(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)
    try:
        if resolved_run_id and paths and paths.output_csv.exists() and _map_html_stale(paths.output_map):
            _rebuild_base_map_from_csv(paths)
            _log_event("open_map_auto_rebuilt", runId=resolved_run_id, mapPath=str(paths.output_map))
        elif (not resolved_run_id) and LEGACY_OUTPUT_CSV.exists() and _map_html_stale(LEGACY_OUTPUT_MAP):
            rows = _load_plan_rows_list(LEGACY_OUTPUT_CSV)
            if rows:
                legacy_scaffolds = _infer_scaffold_routes_from_rows(rows)
                routes = _build_routes_from_rows(rows, manual_draft_edited=False, scaffold_routes=legacy_scaffolds)
                center_lat = float(sum(float(r.get("lat", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
                center_lng = float(sum(float(r.get("lng", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
                legacy_html = render_route_preview_html(
                    routes,
                    center_lat=center_lat,
                    center_lng=center_lng,
                    manual_draft_edited=False,
                    run_id=None,
                )
                LEGACY_OUTPUT_MAP.write_text(legacy_html, encoding="utf-8")
                _log_event("open_map_auto_rebuilt_legacy", mapPath=str(LEGACY_OUTPUT_MAP))
    except Exception as e:
        _log_event("open_map_auto_rebuild_failed", runId=resolved_run_id, error=str(e))

    _, path = _resolve_download_target(runId, "map")
    if not path or not path.exists():
        return JSONResponse({"error": "Map not ready yet."}, status_code=404)
    return FileResponse(str(path), media_type="text/html")


@app.get("/download-edited-csv")
def download_edited_csv(runId: Optional[str] = Query(default=None)):
    _, path = _resolve_download_target(runId, "edited_csv")
    if not path or not path.exists():
        return JSONResponse({"error": "Edited CSV not ready yet. Save a draft first."}, status_code=404)
    return FileResponse(str(path), filename=path.name)


@app.get("/download-edited-map")
def download_edited_map(runId: Optional[str] = Query(default=None), inline: bool = Query(default=False)):
    _, path = _resolve_download_target(runId, "edited_map")
    if not path or not path.exists():
        return JSONResponse({"error": "Edited map not ready yet. Save a draft first."}, status_code=404)
    if inline:
        return FileResponse(str(path), media_type="text/html")
    return FileResponse(str(path), filename=path.name)


@app.get("/open-edited-map")
def open_edited_map(runId: Optional[str] = Query(default=None)):
    resolved_run_id, paths = _resolve_run(runId)
    try:
        if resolved_run_id and paths and paths.edited_output_csv.exists() and _map_html_stale(paths.edited_output_map):
            _rebuild_edited_map_from_csv(paths)
            _log_event("open_edited_map_auto_rebuilt", runId=resolved_run_id, mapPath=str(paths.edited_output_map))
        elif (not resolved_run_id) and LEGACY_EDITED_OUTPUT_CSV.exists() and _map_html_stale(LEGACY_EDITED_OUTPUT_MAP):
            rows = _load_plan_rows_list(LEGACY_EDITED_OUTPUT_CSV)
            if rows:
                legacy_scaffolds = _infer_scaffold_routes_from_rows(rows)
                routes = _build_routes_from_rows(rows, manual_draft_edited=True, scaffold_routes=legacy_scaffolds)
                center_lat = float(sum(float(r.get("lat", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
                center_lng = float(sum(float(r.get("lng", 0.0) or 0.0) for r in rows) / max(1, len(rows)))
                legacy_html = render_route_preview_html(
                    routes,
                    center_lat=center_lat,
                    center_lng=center_lng,
                    manual_draft_edited=True,
                    run_id=None,
                )
                LEGACY_EDITED_OUTPUT_MAP.write_text(legacy_html, encoding="utf-8")
                _log_event("open_edited_map_auto_rebuilt_legacy", mapPath=str(LEGACY_EDITED_OUTPUT_MAP))
    except Exception as e:
        _log_event("open_edited_map_auto_rebuild_failed", runId=resolved_run_id, error=str(e))

    _, path = _resolve_download_target(runId, "edited_map")
    if not path or not path.exists():
        return JSONResponse({"error": "Edited map not ready yet. Save a draft first."}, status_code=404)
    return FileResponse(str(path), media_type="text/html")


@app.get("/download-fieldroutes-report")
def download_fieldroutes_report(runId: Optional[str] = Query(default=None)):
    _, path = _resolve_fieldroutes_artifact_target(runId, "report")
    if not path or not path.exists():
        return JSONResponse({"error": "FieldRoutes push report not ready yet."}, status_code=404)
    return FileResponse(str(path), filename=path.name)


@app.get("/download-fieldroutes-exceptions")
def download_fieldroutes_exceptions(runId: Optional[str] = Query(default=None)):
    _, path = _resolve_fieldroutes_artifact_target(runId, "exceptions")
    if not path or not path.exists():
        return JSONResponse({"error": "FieldRoutes exceptions CSV not ready yet."}, status_code=404)
    return FileResponse(str(path), filename=path.name)


@app.get("/download-fieldroutes-request-log")
def download_fieldroutes_request_log(runId: Optional[str] = Query(default=None)):
    _, path = _resolve_fieldroutes_artifact_target(runId, "request_log")
    if not path or not path.exists():
        return JSONResponse({"error": "FieldRoutes request log not ready yet."}, status_code=404)
    return FileResponse(str(path), filename=path.name)
