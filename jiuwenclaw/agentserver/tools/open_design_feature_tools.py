# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.
"""Open Design daemon bridge tools for App Builder and main-agent workflows."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from openjiuwen.core.foundation.tool import tool


def _od_base_url() -> str:
    raw = (
        os.getenv("OPEN_DESIGN_DAEMON_URL")
        or os.getenv("OD_DAEMON_URL")
        or "http://127.0.0.1:7456"
    ).strip()
    return raw.rstrip("/")


def _normalize_method(method: str) -> str:
    value = (method or "GET").strip().upper()
    if value in {"GET", "POST", "PUT", "PATCH", "DELETE"}:
        return value
    raise ValueError("method must be one of GET, POST, PUT, PATCH, DELETE")


def _normalize_path(path: str) -> str:
    value = (path or "").strip()
    if not value:
        raise ValueError("path is required")
    if not value.startswith("/api/"):
        raise ValueError("path must start with /api/")
    return value


def _parse_json_dict(raw: str, field_name: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception as exc:
        raise ValueError(f"{field_name} must be valid JSON object text") from exc
    if not isinstance(parsed, dict):
        raise ValueError(f"{field_name} must decode to a JSON object")
    return parsed


def _request(
    *,
    method: str,
    path: str,
    query: dict[str, Any] | None = None,
    body: dict[str, Any] | None = None,
    timeout_s: int = 60,
) -> dict[str, Any]:
    base = _od_base_url()
    query = query or {}
    body = body or {}
    qs = urllib.parse.urlencode(
        {k: v for k, v in query.items() if v is not None and v != ""},
        doseq=True,
    )
    url = f"{base}{path}"
    if qs:
        url = f"{url}?{qs}"

    payload = None
    headers = {"Accept": "application/json"}
    if method in {"POST", "PUT", "PATCH"}:
        payload = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url=url, method=method, data=payload, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=max(1, int(timeout_s))) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            content_type = str(resp.headers.get("Content-Type", ""))
            parsed: Any = raw
            if "application/json" in content_type:
                try:
                    parsed = json.loads(raw) if raw else {}
                except Exception:
                    parsed = {"raw": raw}
            return {"ok": True, "status": int(resp.status), "data": parsed, "url": url}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if exc.fp else ""
        parsed: Any = raw
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            pass
        return {
            "ok": False,
            "status": int(exc.code),
            "error": parsed or str(exc),
            "url": url,
        }
    except Exception as exc:
        return {"ok": False, "status": 0, "error": str(exc), "url": url}


@tool(
    description=(
        "Call any Open Design daemon API route. "
        "Use this to access full Open Design capabilities from App Builder: "
        "skills, design systems, plugins, runs, projects, media, automations, connectors, and live artifacts."
    ),
)
def open_design_api_request(
    method: str = "GET",
    path: str = "/api/skills",
    query_json: str = "",
    body_json: str = "",
    timeout_s: int = 60,
) -> dict[str, Any]:
    """Generic Open Design API bridge.

    Args:
        method: HTTP method (GET, POST, PUT, PATCH, DELETE).
        path: API path beginning with /api/.
        query_json: JSON object string for query parameters.
        body_json: JSON object string for request body.
        timeout_s: Request timeout in seconds.
    """
    http_method = _normalize_method(method)
    api_path = _normalize_path(path)
    query = _parse_json_dict(query_json, "query_json")
    body = _parse_json_dict(body_json, "body_json")
    return _request(method=http_method, path=api_path, query=query, body=body, timeout_s=timeout_s)


@tool(
    description=(
        "Return a quick Open Design capability snapshot (skills, design systems, plugins, projects, media models)."
    ),
)
def open_design_capability_snapshot() -> dict[str, Any]:
    """Fetch a compact snapshot so agents can discover what Open Design exposes right now."""
    checks: list[tuple[str, str]] = [
        ("skills", "/api/skills"),
        ("design_systems", "/api/design-systems"),
        ("plugins", "/api/plugins"),
        ("projects", "/api/projects"),
        ("media_models", "/api/media/models"),
    ]
    out: dict[str, Any] = {"base_url": _od_base_url(), "checks": {}}
    for key, path in checks:
        out["checks"][key] = _request(method="GET", path=path, timeout_s=30)
    return out


OPEN_DESIGN_FEATURE_TOOLS = [
    open_design_api_request,
    open_design_capability_snapshot,
]


def get_open_design_feature_tools() -> list[Any]:
    """Return Open Design bridge tools for main-agent registration."""
    return list(OPEN_DESIGN_FEATURE_TOOLS)

