# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""External memory configuration helpers."""

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from .config import (
    _load_config,
    get_embed_config,
    get_memory_engine,
    is_builtin_memory_allowed,
    is_external_memory_allowed,
)

logger = logging.getLogger(__name__)

_DEFAULT_USER = "__default__"
_DEFAULT_SCOPE = "__default__"
_LTM_SUBDIR = "memory/ltm"


def get_external_memory_config(config: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Return the ``memory.external`` section with defaults filled in."""
    cfg = config if config is not None else _load_config()
    memory_cfg = (cfg or {}).get("memory", {}) if isinstance(cfg, dict) else {}
    external_cfg = memory_cfg.get("external", {}) if isinstance(memory_cfg, dict) else {}
    if not isinstance(external_cfg, dict):
        external_cfg = {}

    return {
        "provider": str(external_cfg.get("provider") or "").strip(),
        "user_id": external_cfg.get("user_id") or _DEFAULT_USER,
        "scope_id": external_cfg.get("scope_id") or _DEFAULT_SCOPE,
        "allowed_plugins": external_cfg.get("allowed_plugins") or [],
        "openjiuwen": external_cfg.get("openjiuwen") or {},
        "mem0": external_cfg.get("mem0") or {},
        "openviking": external_cfg.get("openviking") or {},
    }


def is_external_memory_enabled(config: Optional[Dict[str, Any]] = None) -> bool:
    """Return True when external memory is allowed and a provider is configured."""
    if not is_external_memory_allowed(config):
        return False
    return bool(get_external_memory_config(config).get("provider"))


def _resolve_ltm_dir() -> Path:
    """Default LTM data dir under ~/.jiuwenclaw/memory/ltm."""
    base = Path.home() / ".jiuwenclaw" / _LTM_SUBDIR
    base.mkdir(parents=True, exist_ok=True)
    return base


def build_openjiuwen_provider_config(ext_cfg: Dict[str, Any]) -> Dict[str, Any]:
    """Map local config into the shape expected by OpenJiuwenMemoryProvider."""
    openjiuwen_cfg = ext_cfg.get("openjiuwen") or {}
    ltm_dir = _resolve_ltm_dir()

    kv_backend = str(openjiuwen_cfg.get("kv_type") or "shelve").lower()
    kv_path = openjiuwen_cfg.get("kv_path") or str(ltm_dir / "kv")

    vector_backend = str(openjiuwen_cfg.get("vector_type") or "chroma").lower()
    vector_dir = openjiuwen_cfg.get("vector_persist_dir") or str(ltm_dir / "chroma")

    db_backend = str(openjiuwen_cfg.get("db_type") or "sqlite").lower()
    db_path = openjiuwen_cfg.get("db_path") or str(ltm_dir / "ltm.db")

    embed_cfg = get_embed_config() or {}
    embedding = {
        "model_name": embed_cfg.get("model") or os.getenv("EMBED_MODEL", ""),
        "base_url": embed_cfg.get("base_url") or os.getenv("EMBED_BASE_URL", ""),
        "api_key": embed_cfg.get("api_key") or os.getenv("EMBED_API_KEY", ""),
    }
    if not embedding["model_name"]:
        logger.warning(
            "[external_memory] Embedding not configured - OpenJiuwen LTM will skip vector search"
        )

    return {
        "kv": {"backend": kv_backend, "path": kv_path},
        "vector": {"backend": vector_backend, "persist_directory": vector_dir},
        "db": {"backend": db_backend, "path": db_path},
        "embedding": embedding,
    }


__all__ = [
    "build_openjiuwen_provider_config",
    "get_external_memory_config",
    "get_memory_engine",
    "is_builtin_memory_allowed",
    "is_external_memory_allowed",
    "is_external_memory_enabled",
]
