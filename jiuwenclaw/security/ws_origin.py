# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""Shared WebSocket origin validation helpers."""

from __future__ import annotations

import os
from http import HTTPStatus
from typing import Any
from urllib.parse import urlsplit

_ALLOWED_WS_ORIGIN_HOSTS = {
    "127.0.0.1",
    "localhost",
    *{
        host.strip().lower()
        for host in os.getenv("ALLOWED_WS_ORIGIN_HOSTS", "").split(",")
        if host.strip()
    },
}
_FORBIDDEN_BODY = b"Forbidden: Origin not allowed\n"


def is_allowed_browser_origin(origin: str | None) -> bool:
    if origin is None:
        return False
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    return bool(parsed.hostname and parsed.hostname.lower() in _ALLOWED_WS_ORIGIN_HOSTS)


def extract_handshake_request(args: tuple[Any, ...]) -> tuple[str, Any]:
    path = ""
    headers = None
    if len(args) >= 2:
        first, second = args[0], args[1]
        if isinstance(first, str):
            path = first
            headers = second
        else:
            path = getattr(second, "path", "") or ""
            headers = getattr(second, "headers", second)
    return path, headers


def get_header_value(headers: Any, key: str) -> str | None:
    if headers is None:
        return None
    getter = getattr(headers, "get", None)
    if callable(getter):
        value = getter(key)
        if value is None:
            value = getter(key.lower())
        return str(value) if value is not None else None
    return None


def forbidden_origin_response(process_request_args: tuple[Any, ...]) -> Any:
    status = HTTPStatus.FORBIDDEN
    headers = [
        ("Content-Type", "text/plain; charset=utf-8"),
        ("Content-Length", str(len(_FORBIDDEN_BODY))),
    ]

    if process_request_args and not isinstance(process_request_args[0], str):
        from websockets.datastructures import Headers
        from websockets.http11 import Response

        return Response(status.value, status.phrase, Headers(headers), _FORBIDDEN_BODY)

    return status, headers, _FORBIDDEN_BODY
