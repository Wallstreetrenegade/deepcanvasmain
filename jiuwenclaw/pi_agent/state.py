# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""JSON-file backed state store for the PI Agent.

Each feature has its own file under ``<user_workspace>/pi_agent/``:

- ``kanban.json``        : list of KanbanCard-like dicts
- ``crm.json``           : CRM snapshot with leads, columns, filters, and view settings
- ``project_flow.json``  : Project Flow board snapshot with nodes, edges, AI prompts, generator metadata, and URL-ingested flows

The shapes mirror the frontend Zustand stores so the frontend can push its
localStorage here with a single RPC call. The PI agent reads/writes these
files through a small helper that avoids touching disk on every attribute
access (cached with mtime invalidation).
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from jiuwenclaw.auth import get_current_user_data_dir
from jiuwenclaw import auth, database

logger = logging.getLogger(__name__)

_LOCK = threading.RLock()
_CACHE: dict[str, tuple[float, Any]] = {}


def _postgres_scope(feature: str) -> str:
    return str(_base_dir_for_feature(feature))


def _ensure_postgres_schema(con: Any) -> None:
    con.execute(
        """CREATE TABLE IF NOT EXISTS feature_state (
            scope_id TEXT NOT NULL,
            feature TEXT NOT NULL,
            payload TEXT NOT NULL,
            updated_at BIGINT NOT NULL,
            PRIMARY KEY (scope_id, feature)
        )"""
    )
    con.commit()


def _merge_crm_snapshots(current: Any, incoming: Any) -> Any:
    """Keep newer per-lead edits when collaborative clients save snapshots."""
    if not isinstance(current, dict) or not isinstance(incoming, dict):
        return incoming
    current_leads = current.get("leads")
    incoming_leads = incoming.get("leads")
    if not isinstance(current_leads, list) or not isinstance(incoming_leads, list):
        return incoming

    current_by_id = {
        str(lead.get("id")): lead
        for lead in current_leads
        if isinstance(lead, dict) and lead.get("id")
    }
    tombstones = dict(current.get("deletedLeadIds") if isinstance(current.get("deletedLeadIds"), dict) else {})
    if isinstance(incoming.get("deletedLeadIds"), dict):
        for lead_id, deleted_at in incoming["deletedLeadIds"].items():
            if str(deleted_at or "") > str(tombstones.get(str(lead_id)) or ""):
                tombstones[str(lead_id)] = str(deleted_at)
    incoming_ids: set[str] = set()
    merged_leads: list[Any] = []
    for incoming_lead in incoming_leads:
        if not isinstance(incoming_lead, dict) or not incoming_lead.get("id"):
            merged_leads.append(incoming_lead)
            continue
        incoming_id = str(incoming_lead.get("id"))
        deleted_at = str(tombstones.get(incoming_id) or "")
        incoming_updated = str(incoming_lead.get("updatedAt") or incoming_lead.get("updated_at") or "")
        if deleted_at and deleted_at >= incoming_updated:
            continue
        incoming_ids.add(incoming_id)
        current_lead = current_by_id.get(incoming_id)
        if current_lead is None:
            # The server is the authority for whether an imported identity is
            # new. This also supports clients that were open before the NEW
            # badge field was deployed.
            new_lead = dict(incoming_lead)
            new_lead["isNew"] = True
            merged_leads.append(new_lead)
            continue
        current_updated = str(current_lead.get("updatedAt") or current_lead.get("updated_at") or "")
        selected_lead = dict(current_lead if current_updated > incoming_updated else incoming_lead)
        if current_lead.get("isNew") is True:
            selected_lead["isNew"] = True
        merged_leads.append(selected_lead)

    # A stale collaborative tab must never erase server-side records merely
    # because its older whole-snapshot payload does not contain them. Explicit
    # deletion must use a dedicated mutation boundary; snapshot sync is
    # additive/merging and therefore preserves every server-only lead.
    merged_leads.extend(
        lead
        for lead_id, lead in current_by_id.items()
        if lead_id not in incoming_ids and lead_id not in tombstones
    )

    # When an incoming snapshot is missing server-known leads, it is a stale or
    # partially initialized browser cache. Keep the server's CRM configuration
    # (columns, stages, filters, forms, favorites) as the base as well as its
    # missing leads. A complete/newer snapshot may still replace that config.
    incoming_is_truncated = len(incoming_ids) < len(current_by_id)
    merged = dict(current if incoming_is_truncated else incoming)
    merged["leads"] = merged_leads
    merged["deletedLeadIds"] = tombstones
    current_favorites_updated = str(current.get("favoriteStagesUpdatedAt") or "")
    incoming_favorites_updated = str(incoming.get("favoriteStagesUpdatedAt") or "")
    if current_favorites_updated > incoming_favorites_updated:
        merged["favoriteStages"] = current.get("favoriteStages", [])
        merged["favoriteStagesUpdatedAt"] = current_favorites_updated
    return merged


def delete_crm_leads(lead_ids: list[str], deleted_at: str) -> int:
    """Atomically remove CRM leads and retain tombstones against stale clients."""
    clean_ids = {str(value).strip() for value in lead_ids if str(value).strip()}
    if not clean_ids:
        return 0
    current = load_feature("crm", default={})
    if not isinstance(current, dict):
        current = {}
    leads = current.get("leads") if isinstance(current.get("leads"), list) else []
    remaining = [lead for lead in leads if not (isinstance(lead, dict) and str(lead.get("id") or "") in clean_ids)]
    deleted_count = len(leads) - len(remaining)
    tombstones = dict(current.get("deletedLeadIds") or {})
    for lead_id in clean_ids:
        tombstones[lead_id] = deleted_at
    current["leads"] = remaining
    current["deletedLeadIds"] = tombstones
    save_feature("crm", current)
    return deleted_count


def _base_dir() -> Path:
    # A granted feature moves into team-owned storage; every other feature
    # remains in the authenticated user's private directory.
    return _base_dir_for_feature("")


def _base_dir_for_feature(feature: str) -> Path:
    if feature:
        from jiuwenclaw.team_up import shared_feature_dir

        shared = shared_feature_dir(feature)
        if shared is not None:
            return shared
    base = get_current_user_data_dir() / "pi_agent"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _feature_path(feature: str) -> Path:
    safe = feature.replace("/", "_").replace("\\", "_")
    return _base_dir_for_feature(feature) / f"{safe}.json"


def load_feature(feature: str, default: Any = None) -> Any:
    """Load a feature's JSON blob. Returns ``default`` if file is missing."""
    if database.is_postgres():
        with auth._connection() as con:  # noqa: SLF001
            _ensure_postgres_schema(con)
            row = con.execute(
                "SELECT payload FROM feature_state WHERE scope_id = ? AND feature = ?",
                (_postgres_scope(feature), feature),
            ).fetchone()
        if not row:
            return default if default is not None else []
        try:
            return json.loads(row["payload"])
        except (TypeError, json.JSONDecodeError):
            logger.exception("[pi_agent.state] invalid PostgreSQL payload for %s", feature)
            return default if default is not None else []
    path = _feature_path(feature)
    with _LOCK:
        if not path.exists():
            return default if default is not None else []
        try:
            mtime = path.stat().st_mtime
        except OSError:
            return default if default is not None else []
        cached = _CACHE.get(str(path))
        if cached and cached[0] == mtime:
            return cached[1]
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("[pi_agent.state] failed to read %s: %s", path, exc)
            return default if default is not None else []
        _CACHE[str(path)] = (mtime, data)
        return data


def save_feature(feature: str, data: Any) -> None:
    """Write a feature JSON blob atomically and refresh the cache."""
    if database.is_postgres():
        scope_id = _postgres_scope(feature)
        with _LOCK, auth._connection() as con:  # noqa: SLF001
            _ensure_postgres_schema(con)
            row = con.execute(
                "SELECT payload FROM feature_state WHERE scope_id = ? AND feature = ? FOR UPDATE",
                (scope_id, feature),
            ).fetchone()
            if feature == "crm" and row:
                try:
                    data = _merge_crm_snapshots(json.loads(row["payload"]), data)
                except (TypeError, json.JSONDecodeError):
                    pass
            con.execute(
                """INSERT INTO feature_state(scope_id, feature, payload, updated_at)
                   VALUES (?, ?, ?, ?)
                   ON CONFLICT(scope_id, feature) DO UPDATE SET
                     payload = excluded.payload, updated_at = excluded.updated_at""",
                (scope_id, feature, json.dumps(data, ensure_ascii=False), int(time.time())),
            )
            con.commit()
        return
    path = _feature_path(feature)
    tmp = path.with_suffix(".json.tmp")
    with _LOCK:
        try:
            # Keep the immediately previous CRM snapshot recoverable. CRM is
            # collaborative and a stale/empty client must not make lead loss
            # irreversible even if it reaches this persistence boundary.
            if feature == "crm" and path.is_file():
                backup = path.with_suffix(".json.bak")
                shutil.copy2(path, backup)
                try:
                    with open(path, "r", encoding="utf-8") as current_file:
                        data = _merge_crm_snapshots(json.load(current_file), data)
                except (OSError, json.JSONDecodeError):
                    pass
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp, path)
            try:
                _CACHE[str(path)] = (path.stat().st_mtime, data)
            except OSError:
                _CACHE.pop(str(path), None)
        except OSError as exc:
            logger.warning("[pi_agent.state] failed to write %s: %s", path, exc)
            raise


def list_features() -> list[str]:
    """Return all feature keys currently persisted on disk."""
    if database.is_postgres():
        with auth._connection() as con:  # noqa: SLF001
            _ensure_postgres_schema(con)
            rows = con.execute(
                "SELECT feature FROM feature_state WHERE scope_id = ? ORDER BY feature",
                (_postgres_scope(""),),
            ).fetchall()
        return [str(row["feature"]) for row in rows]
    try:
        return sorted(p.stem for p in _base_dir().glob("*.json"))
    except OSError:
        return []


def base_dir_str() -> str:
    return str(_base_dir())


def copy_feature_scope(source_scope: str, target_scope: str, feature: str, *, overwrite: bool = False) -> None:
    """Copy one PostgreSQL-backed feature snapshot between private/team scopes."""
    if not database.is_postgres():
        return
    with auth._connection() as con:  # noqa: SLF001
        _ensure_postgres_schema(con)
        row = con.execute(
            "SELECT payload FROM feature_state WHERE scope_id = ? AND feature = ?",
            (source_scope, feature),
        ).fetchone()
        if not row:
            return
        if overwrite:
            con.execute(
                """INSERT INTO feature_state(scope_id, feature, payload, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(scope_id, feature) DO UPDATE SET
                     payload = excluded.payload, updated_at = excluded.updated_at""",
                (target_scope, feature, row["payload"], int(time.time())),
            )
        else:
            con.execute(
                """INSERT INTO feature_state(scope_id, feature, payload, updated_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(scope_id, feature) DO NOTHING""",
                (target_scope, feature, row["payload"], int(time.time())),
            )
        con.commit()

