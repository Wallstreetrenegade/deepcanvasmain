# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Open Design MCP integration helpers for JiuWenClaw.

Open Design exposes a stdio MCP server (``od mcp``) and can also be reached
through SSE / streamable HTTP if a deployment provides a remote endpoint.
This helper keeps the integration env-driven while defaulting to enabled in
normal runtime, and only disabling when explicitly turned off.
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import shutil
from pathlib import Path
from typing import Any

from openjiuwen.core.foundation.tool import McpServerConfig
from openjiuwen.core.runner import Runner

logger = logging.getLogger(__name__)

_OPEN_DESIGN_DEFAULT_ID = "open_design_mcp"
_OPEN_DESIGN_DEFAULT_NAME = "open-design"
_SUPPORTED_CLIENT_TYPES = {"stdio", "sse", "streamable-http", "streamable_http", "http"}


def _parse_args(raw: str) -> list[str]:
    raw = (raw or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
            if isinstance(parsed, list):
                return [str(x) for x in parsed]
        except Exception:
            pass
    try:
        return shlex.split(raw, posix=(os.name != "nt"))
    except Exception:
        return raw.split()


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _open_design_repo_dir() -> Path:
    return _repo_root() / "packages" / "open-design"


def _default_stdio_command() -> tuple[str, list[str], str]:
    """Resolve the best local command for launching Open Design MCP over stdio."""
    repo_dir = _open_design_repo_dir()
    if repo_dir.exists():
        return "pnpm", ["exec", "od", "mcp"], str(repo_dir)

    return "od", ["mcp"], str(_repo_root())


def _normalize_client_type(client_type: str) -> str:
    value = (client_type or "").strip().lower()
    if value in {"http", "streamable_http"}:
        return "streamable-http"
    return value


def build_open_design_mcp_config() -> McpServerConfig | None:
    """Build MCP server config for Open Design.

    Env flags:
    - OPEN_DESIGN_MCP_ENABLED: 1/0
    - OPEN_DESIGN_MCP_CLIENT_TYPE: stdio|sse|streamable-http
    - OPEN_DESIGN_MCP_SERVER_PATH: remote MCP endpoint URL
    - OPEN_DESIGN_MCP_COMMAND / OPEN_DESIGN_MCP_ARGS: stdio command override
    """
    flag = (os.getenv("OPEN_DESIGN_MCP_ENABLED") or "").strip().lower()
    if flag in {"0", "false", "no", "off"}:
        return None

    server_id = (os.getenv("OPEN_DESIGN_MCP_SERVER_ID") or _OPEN_DESIGN_DEFAULT_ID).strip()
    server_name = (os.getenv("OPEN_DESIGN_MCP_SERVER_NAME") or _OPEN_DESIGN_DEFAULT_NAME).strip()
    client_type = _normalize_client_type(os.getenv("OPEN_DESIGN_MCP_CLIENT_TYPE") or "stdio")

    if client_type not in _SUPPORTED_CLIENT_TYPES:
        raise ValueError("OPEN_DESIGN_MCP_CLIENT_TYPE must be one of stdio|sse|streamable-http.")

    if client_type in {"sse", "streamable-http"}:
        server_path = (os.getenv("OPEN_DESIGN_MCP_SERVER_PATH") or "").strip()
        if not server_path:
            raise ValueError("OPEN_DESIGN_MCP_SERVER_PATH is required for remote Open Design MCP connections.")
        return McpServerConfig(
            server_id=server_id,
            server_name=server_name,
            server_path=server_path,
            client_type=client_type,
        )

    default_command, default_args, default_cwd = _default_stdio_command()
    command = (os.getenv("OPEN_DESIGN_MCP_COMMAND") or default_command).strip()
    if shutil.which(command) is None:
        return None
    args_raw = os.getenv("OPEN_DESIGN_MCP_ARGS", " ".join(default_args))
    args = _parse_args(args_raw)
    if not args:
        args = list(default_args)

    params: dict[str, Any] = {
        "command": command,
        "args": args,
        "cwd": (os.getenv("OPEN_DESIGN_MCP_CWD") or default_cwd).strip(),
    }
    timeout_raw = (os.getenv("OPEN_DESIGN_MCP_TIMEOUT_S") or "300").strip()
    try:
        timeout_s = int(timeout_raw)
        if timeout_s > 0:
            params["timeout_s"] = timeout_s
    except ValueError:
        pass

    extra_env: dict[str, str] = {}
    for key in (
        "OD_DATA_DIR",
        "OD_DAEMON_URL",
        "OPEN_DESIGN_DATA_DIR",
        "OPEN_DESIGN_DAEMON_URL",
    ):
        value = (os.getenv(key) or "").strip()
        if value:
            extra_env[key] = value
    if extra_env:
        params["env"] = extra_env

    return McpServerConfig(
        server_id=server_id,
        server_name=server_name,
        server_path=(os.getenv("OPEN_DESIGN_MCP_SERVER_PATH") or "stdio://open-design").strip(),
        client_type="stdio",
        params=params,
    )


async def register_open_design_mcp_server(agent: Any, *, tag: str = "agent.main") -> McpServerConfig | None:
    """Register Open Design MCP server and add it to the agent abilities."""
    cfg = build_open_design_mcp_config()
    if cfg is None:
        return None

    result = await Runner.resource_mgr.add_mcp_server(cfg, tag=tag)
    is_ok = False
    error_text = ""
    try:
        is_ok = bool(result.is_ok())
    except Exception:
        is_ok = False
    if not is_ok:
        for attr in ("error", "msg"):
            fn = getattr(result, attr, None)
            if callable(fn):
                try:
                    value = fn()
                    if value is not None:
                        error_text = str(value)
                        break
                except Exception:
                    pass
        if not error_text:
            error_text = str(result)
        if "already exist" not in error_text.lower():
            raise RuntimeError(f"Failed to register Open Design MCP server: {error_text}")

    agent.ability_manager.add(cfg)
    logger.info(
        "[open_design_tools] registered Open Design MCP server id=%s name=%s client_type=%s",
        cfg.server_id,
        cfg.server_name,
        getattr(cfg, "client_type", "stdio"),
    )
    return cfg
