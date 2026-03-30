from __future__ import annotations

import json
import os
import random
import time
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import requests


RETRYABLE_HTTP_STATUS = {429, 500, 502, 503, 504}
AUTH_FIELDS = {"authenticationKey", "authenticationToken"}


class FieldRoutesApiError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: Optional[int] = None,
        retryable: bool = False,
        endpoint: Optional[str] = None,
        payload: Optional[Dict[str, Any]] = None,
        response_body: Optional[Any] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.retryable = retryable
        self.endpoint = endpoint
        self.payload = payload or {}
        self.response_body = response_body


@dataclass
class FieldRoutesConfig:
    base_url: str
    auth_key: str
    auth_token: str
    timeout_sec: float = 30.0
    write_qps: float = 8.0
    max_retries: int = 4

    @classmethod
    def from_env(cls) -> "FieldRoutesConfig":
        base_url = str(os.environ.get("FIELDROUTES_BASE_URL", "")).strip().rstrip("/")
        auth_key = str(os.environ.get("FIELDROUTES_AUTH_KEY", "")).strip()
        auth_token = str(os.environ.get("FIELDROUTES_AUTH_TOKEN", "")).strip()
        if not base_url:
            raise RuntimeError("FIELDROUTES_BASE_URL is required.")
        if not auth_key:
            raise RuntimeError("FIELDROUTES_AUTH_KEY is required.")
        if not auth_token:
            raise RuntimeError("FIELDROUTES_AUTH_TOKEN is required.")
        timeout_sec = float(os.environ.get("FIELDROUTES_TIMEOUT_SEC", "30") or 30)
        write_qps = float(os.environ.get("FIELDROUTES_WRITE_QPS", "8") or 8)
        return cls(
            base_url=base_url,
            auth_key=auth_key,
            auth_token=auth_token,
            timeout_sec=timeout_sec,
            write_qps=write_qps,
        )


def _utc_now() -> str:
    return datetime.utcnow().isoformat() + "Z"


def _safe_json(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)


class FieldRoutesClient:
    def __init__(
        self,
        config: FieldRoutesConfig,
        *,
        session: Optional[requests.Session] = None,
        log_sink: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> None:
        self.config = config
        self.session = session or requests.Session()
        self.log_sink = log_sink
        self._write_interval = 0.0 if config.write_qps <= 0 else (1.0 / float(config.write_qps))
        self._next_write_at = 0.0

    def _emit_log(self, payload: Dict[str, Any]) -> None:
        if not self.log_sink:
            return
        try:
            self.log_sink(payload)
        except Exception:
            pass

    def _sanitize_payload(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        cleaned = {}
        for key, value in (payload or {}).items():
            if key in AUTH_FIELDS:
                continue
            cleaned[str(key)] = _safe_json(value)
        return cleaned

    def _throttle_write(self) -> None:
        if self._write_interval <= 0:
            return
        now = time.monotonic()
        if now < self._next_write_at:
            time.sleep(self._next_write_at - now)
            now = time.monotonic()
        self._next_write_at = max(self._next_write_at, now) + self._write_interval

    def _auth_payload(self) -> Dict[str, Any]:
        return {
            "authenticationKey": self.config.auth_key,
            "authenticationToken": self.config.auth_token,
        }

    def _extract_api_error(self, response_payload: Any) -> Optional[str]:
        if isinstance(response_payload, dict):
            status = response_payload.get("status")
            success = response_payload.get("success")
            error = response_payload.get("error")
            errors = response_payload.get("errors")

            if success is False:
                return str(error or errors or "API response marked as unsuccessful.")
            if status in (0, "0", "error", "failed", False):
                return str(error or errors or "API returned failure status.")
            if isinstance(error, str) and error.strip():
                return error.strip()
            if isinstance(errors, list) and errors:
                return "; ".join([str(x) for x in errors])
            if isinstance(errors, dict) and errors:
                return json.dumps(errors, sort_keys=True)
        return None

    def _request(self, endpoint: str, payload: Dict[str, Any], *, write: bool = False) -> Any:
        ep = endpoint if endpoint.startswith("/") else f"/{endpoint}"
        url = f"{self.config.base_url}{ep}"
        form_payload = dict(payload or {})
        form_payload.update(self._auth_payload())
        sanitized_payload = self._sanitize_payload(form_payload)

        last_error: Optional[Exception] = None
        for attempt in range(self.config.max_retries + 1):
            if write:
                self._throttle_write()
            started = time.time()
            status_code = None
            body: Any = None
            err_msg: Optional[str] = None
            retryable = False

            try:
                response = self.session.post(url, data=form_payload, timeout=self.config.timeout_sec)
                status_code = int(response.status_code)
                text = response.text
                try:
                    body = response.json()
                except Exception:
                    body = {"raw": text}

                if status_code >= 400:
                    retryable = status_code in RETRYABLE_HTTP_STATUS
                    err_msg = f"HTTP {status_code}"
                else:
                    api_error = self._extract_api_error(body)
                    if api_error:
                        err_msg = api_error

                self._emit_log(
                    {
                        "ts": _utc_now(),
                        "method": "POST",
                        "endpoint": ep,
                        "statusCode": status_code,
                        "durationMs": int((time.time() - started) * 1000),
                        "attempt": attempt + 1,
                        "write": bool(write),
                        "payload": sanitized_payload,
                        "error": err_msg,
                    }
                )

                if err_msg is None:
                    return body

                if retryable and attempt < self.config.max_retries:
                    sleep_s = min(8.0, (2 ** attempt) * 0.5) + random.uniform(0, 0.25)
                    time.sleep(sleep_s)
                    continue

                raise FieldRoutesApiError(
                    f"FieldRoutes request failed for {ep}: {err_msg}",
                    status_code=status_code,
                    retryable=retryable,
                    endpoint=ep,
                    payload=sanitized_payload,
                    response_body=body,
                )
            except requests.RequestException as exc:
                last_error = exc
                self._emit_log(
                    {
                        "ts": _utc_now(),
                        "method": "POST",
                        "endpoint": ep,
                        "statusCode": status_code,
                        "durationMs": int((time.time() - started) * 1000),
                        "attempt": attempt + 1,
                        "write": bool(write),
                        "payload": sanitized_payload,
                        "error": str(exc),
                    }
                )
                if attempt < self.config.max_retries:
                    sleep_s = min(8.0, (2 ** attempt) * 0.5) + random.uniform(0, 0.25)
                    time.sleep(sleep_s)
                    continue
                raise FieldRoutesApiError(
                    f"FieldRoutes request failed for {ep}: {exc}",
                    status_code=None,
                    retryable=True,
                    endpoint=ep,
                    payload=sanitized_payload,
                    response_body=body,
                ) from exc

        raise FieldRoutesApiError(
            f"FieldRoutes request failed for {ep}: retry budget exhausted.",
            status_code=None,
            retryable=True,
            endpoint=ep,
            payload=sanitized_payload,
            response_body={"lastError": str(last_error) if last_error else "unknown"},
        )

    def preflight_auth(self) -> Any:
        # Lightweight authenticated call before any work starts.
        return self.employee_search(includeData=0, active=1)

    def employee_search(self, **params: Any) -> Any:
        payload = {"includeData": 1, "active": 1}
        payload.update(params)
        return self._request("/employee/search", payload, write=False)

    def route_search(self, *, assigned_tech: str, date: str, include_data: int = 1, **params: Any) -> Any:
        payload = {
            "assignedTech": assigned_tech,
            "date": date,
            "includeData": include_data,
        }
        payload.update(params)
        return self._request("/route/search", payload, write=False)

    def route_create(
        self,
        *,
        assigned_tech: str,
        date: str,
        template_id: Optional[int] = None,
        auto_create_group: int = 1,
        **params: Any,
    ) -> Any:
        payload = {
            "assignedTech": assigned_tech,
            "date": date,
            "autoCreateGroup": auto_create_group,
        }
        if template_id is not None:
            payload["templateID"] = int(template_id)
        payload.update(params)
        return self._request("/route/create", payload, write=True)

    def appointment_search(
        self,
        *,
        date_start: str,
        date_end: str,
        status: Optional[int] = 0,
        include_data: int = 1,
        **params: Any,
    ) -> Any:
        payload = {
            "dateStart": date_start,
            "dateEnd": date_end,
            "includeData": include_data,
        }
        if status not in (None, ""):
            payload["status"] = status
        payload.update(params)
        return self._request("/appointment/search", payload, write=False)

    def appointment_get(self, *, appointment_ids: Any, include_data: int = 1, **params: Any) -> Any:
        if isinstance(appointment_ids, (list, tuple, set)):
            packed_ids = ",".join([str(x) for x in appointment_ids if str(x).strip()])
        else:
            packed_ids = str(appointment_ids).strip()
        payload = {
            "appointmentID": packed_ids,
            "includeData": include_data,
        }
        payload.update(params)
        return self._request("/appointment/get", payload, write=False)

    def appointment_update(
        self,
        *,
        appointment_id: str,
        route_id: str,
        assigned_tech: str,
        sequence: int,
        duration: Optional[int] = None,
        bypass_locked_route: bool = False,
        bypass_schedule_permission: bool = False,
    ) -> Any:
        payload: Dict[str, Any] = {
            "appointmentID": str(appointment_id),
            "routeID": str(route_id),
            "assignedTech": str(assigned_tech),
            "sequence": int(sequence),
        }
        if duration is not None:
            payload["duration"] = int(duration)
        if bypass_locked_route:
            payload["bypassLockedRoute"] = 1
        if bypass_schedule_permission:
            payload["bypassSchedulePermission"] = 1
        return self._request("/appointment/update", payload, write=True)

    def appointment_create(
        self,
        *,
        customer_id: str,
        service_type: int,
        route_id: Optional[str] = None,
        assigned_tech: Optional[str] = None,
        subscription_id: Optional[str] = None,
        sequence: Optional[int] = None,
        duration: Optional[int] = None,
        **params: Any,
    ) -> Any:
        payload: Dict[str, Any] = {
            "customerID": str(customer_id),
            "type": int(service_type),
        }
        if route_id:
            payload["routeID"] = str(route_id)
        if assigned_tech:
            payload["assignedTech"] = str(assigned_tech)
        if subscription_id:
            payload["subscriptionID"] = str(subscription_id)
        if sequence is not None:
            payload["sequence"] = int(sequence)
        if duration is not None:
            payload["duration"] = int(duration)
        payload.update(params)
        return self._request("/appointment/create", payload, write=True)
