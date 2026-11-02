# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Feature-awareness tools for the main JiuWenClaw agent.

The feature workspaces are real UI/backend capabilities, not a separate
conversation surface. These tools give the main DeepAgent a durable map of the
available features plus live, secret-safe snapshots from the PI state mirror.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from openjiuwen.core.foundation.tool import tool

from jiuwenclaw import auth
from jiuwenclaw.pi_agent import state as pi_state
logger = logging.getLogger(__name__)

SECRET_MARKERS = (
    "api_key",
    "apikey",
    "api-key",
    "authorization",
    "bearer",
    "credential",
    "password",
    "secret",
    "token",
)
LARGE_DATA_KEYS = {"dataurl", "thumbnailurl", "bytes", "content", "raw", "htmlpreview", "diskpath", "thumbnailpath", "devicecode"}
MAX_LIST_ITEMS = 25
MAX_DICT_ITEMS = 80
MAX_STRING_LEN = 900


FEATURE_CATALOG: dict[str, dict[str, Any]] = {
    "storage": {
        "label": "Storage",
        "status": "live_backend",
        "agent_access": "read_write",
        "state_keys": ["storage"],
        "workspace_key": "storage",
        "agent_tools": [
            "features_storage_summary", "features_state_get",
            "features_storage_create_folder", "features_storage_create_category",
            "features_storage_create_text_file", "features_storage_update_file",
            "features_storage_delete_file",
        ],
        "rpc_namespaces": ["storage.*", "pi.state.*"],
        "description": "User file storage for images, videos, documents, folders, categories, thumbnails, and optional Drive connections.",
    },
    "kanban": {
        "label": "Kanban",
        "status": "live_state",
        "agent_access": "read_write",
        "state_keys": ["kanban"],
        "workspace_key": "kanban",
        "agent_tools": [
            "features_kanban_summary", "features_kanban_list",
            "features_kanban_create_card", "features_kanban_update_card", "features_kanban_move_card",
        ],
        "rpc_namespaces": ["pi.state.*"],
        "description": "Task cards, columns, subtasks, notes, and board status mirrored from the Kanban workspace.",
    },
    "crm": {
        "label": "CRM",
        "status": "live_state",
        "agent_access": "read_write",
        "state_keys": ["crm"],
        "workspace_key": "crm",
        "agent_tools": [
            "features_crm_list", "features_crm_find",
            "features_crm_create_lead", "features_crm_update_lead", "features_crm_add_note",
        ],
        "rpc_namespaces": ["pi.state.*"],
        "description": "Leads, contacts, companies, statuses, notes, and pipeline data mirrored from CRM.",
    },
    "lead_gen": {
        "label": "Lead Gen",
        "status": "live_state",
        "agent_access": "read_write",
        "state_keys": ["lead_gen"],
        "workspace_key": "leadGen",
        "agent_tools": [
            "features_lead_gen_summary", "features_state_get",
            "features_lead_gen_list_prospects",
            "features_lead_gen_create_prospect",
            "features_lead_gen_update_prospect",
            "features_lead_gen_add_note",
            "features_lead_gen_create_campaign",
            "features_lead_gen_update_campaign",
            "features_lead_gen_attach_prospect_to_campaign",
            "features_lead_gen_detach_prospect_from_campaign",
            "features_lead_gen_delete_campaign",
        ],
        "rpc_namespaces": ["pi.state.*"],
        "description": "Lead generation workspace tracks prospects, research notes, outreach status, and campaigns.",
    },
    "video_meeting": {
        "label": "Video Meeting",
        "status": "live_state",
        "agent_access": "read_write",
        "state_keys": ["video_meeting"],
        "workspace_key": "videoMeeting",
        "agent_tools": [
            "features_state_get",
            "features_video_meeting_update_settings",
            "features_video_meeting_start_meeting",
            "features_video_meeting_close_meeting",
        ],
        "rpc_namespaces": ["user.settings.*", "pi.state.*"],
        "description": "Jitsi-powered video meeting workspace with per-user meeting defaults, invite URL, live room status, and mirrored state.",
    },
    "project_flow": {
        "label": "Project Flow",
        "status": "live_state",
        "agent_access": "read_write",
        "state_keys": ["project_flow"],
        "workspace_key": "projectFlow",
        "agent_tools": [
            "features_project_flow_list",
            "features_project_flow_set_board",
            "features_project_flow_create_node",
            "features_project_flow_update_node",
            "features_project_flow_delete_node",
            "features_project_flow_connect_nodes",
            "features_project_flow_delete_edge",
        ],
        "rpc_namespaces": ["pi.state.*"],
        "description": "Project graph with nodes, edges, board title, drawing/file nodes, and workflow structure.",
    },
}

FEATURE_ALIASES = {
    "documents": "storage",
    "file_storage": "storage",
    "files": "storage",
    "file-storage": "storage",
    "google-drive": "storage",
    "onedrive": "storage",
    "storage-files": "storage",
    "leadgen": "lead_gen",
    "lead-gen": "lead_gen",
    "projectflow": "project_flow",
    "project-flow": "project_flow",
    "video": "video_meeting",
    "video-meeting": "video_meeting",
    "videomeeting": "video_meeting",
}

DEFAULT_KANBAN_COLUMNS = [
    {"id": "todo", "title": "To Do"},
    {"id": "in-progress", "title": "In Progress"},
    {"id": "review", "title": "Review"},
    {"id": "done", "title": "Done"},
]
CRM_STAGE_OPTIONS = {"new", "qualified", "contacted", "proposal", "negotiation", "won", "lost"}
CRM_STATUS_OPTIONS = {"active", "nurturing", "follow-up", "stale", "closed"}


def _json_ok(payload: dict[str, Any]) -> str:
    return json.dumps({"ok": True, **payload}, ensure_ascii=False, separators=(",", ":"))


def _json_err(msg: str, **payload: Any) -> str:
    return json.dumps({"ok": False, "error": msg, **payload}, ensure_ascii=False, separators=(",", ":"))


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _feature_key(feature: str) -> str:
    raw = (feature or "").strip().lower().replace(" ", "_")
    return FEATURE_ALIASES.get(raw, raw)


def _load(feature: str, default: Any = None) -> Any:
    try:
        return pi_state.load_feature(feature, default=default)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[features_tools] failed to load %s: %s", feature, exc)
        return default


def _count(items: Any) -> int:
    return len(items) if isinstance(items, (list, tuple, dict, set)) else 0


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _video_meeting_summary_payload() -> dict[str, Any]:
    snapshot = _as_dict(_load("video_meeting", default={}))
    settings = _as_dict(snapshot.get("settings"))
    active = _as_dict(snapshot.get("activeMeeting")) if snapshot.get("activeMeeting") else {}
    room = active.get("roomName") or settings.get("roomName") or ""
    domain = active.get("domain") or settings.get("domain") or ""
    return {
        "state_present": bool(snapshot),
        "status": snapshot.get("status") or ("live" if active else "idle"),
        "domain": domain,
        "room": room,
        "invite_url": snapshot.get("inviteUrl") or "",
        "start_with_audio_muted": bool(settings.get("startWithAudioMuted", True)),
        "start_with_video_muted": bool(settings.get("startWithVideoMuted", True)),
        "updated_at": snapshot.get("updatedAt") or "",
    }


def _lead_gen_state_for_write() -> dict[str, Any]:
    snapshot = _as_dict(_load("lead_gen", default={}))
    snapshot["prospects"] = [item for item in _as_list(snapshot.get("prospects")) if isinstance(item, dict)]
    snapshot["campaigns"] = [item for item in _as_list(snapshot.get("campaigns")) if isinstance(item, dict)]
    snapshot["searchQuery"] = str(snapshot.get("searchQuery") or "")
    snapshot["selectedProspectId"] = snapshot.get("selectedProspectId")
    snapshot["updatedAt"] = str(snapshot.get("updatedAt") or _now_iso())
    return snapshot


def _lead_gen_summary_payload() -> dict[str, Any]:
    snapshot = _lead_gen_state_for_write()
    prospects = _as_list(snapshot.get("prospects"))
    campaigns = _as_list(snapshot.get("campaigns"))
    return {
        "prospect_count": len(prospects),
        "campaign_count": len(campaigns),
        "selected_prospect_id": snapshot.get("selectedProspectId"),
        "status_counts": _status_counts(prospects),
        "campaign_status_counts": _status_counts(campaigns),
        "high_intent_count": len([item for item in prospects if isinstance(item, dict) and int(item.get("score") or 0) >= 75]),
        "recent_prospects": _sanitize(prospects[:12]),
        "recent_campaigns": _sanitize(campaigns[:8]),
    }


def _save_lead_gen(snapshot: dict[str, Any]) -> dict[str, Any]:
    snapshot["updatedAt"] = _now_iso()
    pi_state.save_feature("lead_gen", snapshot)
    return _lead_gen_summary_payload()


def _looks_secret(key: str) -> bool:
    lowered = key.lower().replace("-", "_")
    return any(marker in lowered for marker in SECRET_MARKERS)


def _sanitize(value: Any, *, key: str = "", depth: int = 0) -> Any:
    lowered_key = key.lower()
    if _looks_secret(key):
        return "***REDACTED***" if value else ""
    if lowered_key in LARGE_DATA_KEYS:
        if value:
            return f"***OMITTED_{type(value).__name__.upper()}***"
        return value
    if depth >= 5:
        if isinstance(value, (dict, list, tuple)):
            return f"***TRUNCATED_{type(value).__name__.upper()}***"
        return value
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for index, (item_key, item_value) in enumerate(value.items()):
            if index >= MAX_DICT_ITEMS:
                out["_truncated"] = True
                out["_remaining_keys"] = len(value) - index
                break
            out[str(item_key)] = _sanitize(item_value, key=str(item_key), depth=depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        out_list = [_sanitize(item, depth=depth + 1) for item in list(value)[:MAX_LIST_ITEMS]]
        if len(value) > MAX_LIST_ITEMS:
            out_list.append({"_truncated": True, "_remaining_items": len(value) - MAX_LIST_ITEMS})
        return out_list
    if isinstance(value, str):
        if value.startswith("data:"):
            return "***OMITTED_DATA_URL***"
        if len(value) > MAX_STRING_LEN:
            return f"{value[:MAX_STRING_LEN]}...***TRUNCATED***"
    return value


def _env_value(*names: str) -> str:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    try:
        from jiuwenclaw.config import get_config_raw

        cfg = get_config_raw() or {}
        if isinstance(cfg, dict):
            for name in names:
                direct = cfg.get(name)
                if direct:
                    return str(direct)
                lower = cfg.get(name.lower())
                if lower:
                    return str(lower)
    except Exception as exc:  # noqa: BLE001
        logger.debug("[features_tools] config lookup failed: %s", exc)
    return ""


def _settings_status() -> dict[str, Any]:
    fields = {
        "FEATURES_PROVIDER": _env_value("FEATURES_PROVIDER", "features_provider"),
        "FEATURES_MODEL_NAME": _env_value("FEATURES_MODEL_NAME", "features_model"),
        "FEATURES_API_BASE": _env_value("FEATURES_API_BASE", "features_api_base"),
        "FEATURES_API_KEY": _env_value("FEATURES_API_KEY", "features_api_key"),
    }
    return {
        "features_model": {
            "provider": fields["FEATURES_PROVIDER"] or None,
            "model": fields["FEATURES_MODEL_NAME"] or None,
            "api_base_configured": bool(fields["FEATURES_API_BASE"]),
            "api_key_configured": bool(fields["FEATURES_API_KEY"]),
        },
        "missing_required_for_feature_llm": [
            key
            for key in ("FEATURES_API_BASE", "FEATURES_MODEL_NAME", "FEATURES_API_KEY")
            if not fields[key]
        ],
    }


def _status_counts(items: Iterable[Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        status = str(item.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def _kanban_summary_payload() -> dict[str, Any]:
    snapshot = _as_dict(_load("kanban", default={"cards": [], "columns": [], "entries": []}))
    cards = _as_list(snapshot.get("cards"))
    columns = _as_list(snapshot.get("columns"))
    by_col: dict[str, list[str]] = {}
    for card in cards:
        if not isinstance(card, dict):
            continue
        col = str(card.get("columnId") or card.get("column") or "uncategorised")
        by_col.setdefault(col, []).append(str(card.get("title") or card.get("name") or "(untitled)"))
    col_lookup = {str(c.get("id")): str(c.get("title") or c.get("name") or c.get("id")) for c in columns if isinstance(c, dict)}
    return {
        "total_cards": len(cards),
        "columns": [
            {
                "id": col_id,
                "title": col_lookup.get(col_id, col_id),
                "count": len(titles),
                "titles": titles[:30],
            }
            for col_id, titles in by_col.items()
        ],
        "entries": _count(snapshot.get("entries")),
    }


def _kanban_snapshot_for_write() -> dict[str, Any]:
    raw = _load("kanban", default=None)
    snapshot = raw if isinstance(raw, dict) else {}
    columns = _as_list(snapshot.get("columns")) or list(DEFAULT_KANBAN_COLUMNS)
    cards = _as_list(snapshot.get("cards"))
    entries = _as_list(snapshot.get("entries"))
    return {"entries": entries, "columns": columns, "cards": cards}


def _kanban_column_exists(snapshot: Mapping[str, Any], column_id: str) -> bool:
    return any(isinstance(column, Mapping) and str(column.get("id")) == column_id for column in _as_list(snapshot.get("columns")))


def _save_kanban(snapshot: dict[str, Any]) -> dict[str, Any]:
    pi_state.save_feature("kanban", snapshot)
    return _kanban_summary_payload()


def _crm_payload() -> tuple[list[Any], dict[str, Any]]:
    raw = _load("crm", default=[])
    if isinstance(raw, list):
        leads = raw
        meta: dict[str, Any] = {}
    elif isinstance(raw, dict):
        leads = _as_list(raw.get("leads") or raw.get("contacts") or raw.get("items"))
        meta = {key: value for key, value in raw.items() if key not in {"leads", "contacts", "items"}}
    else:
        leads = []
        meta = {}
    return leads, meta


def _crm_lead_search_text(lead: Mapping[str, Any]) -> str:
    parts: list[str] = []
    for key in (
        "name", "fullName", "title", "company", "email", "phone", "address",
        "website", "owner", "source", "stage", "status", "nextAction",
    ):
        value = lead.get(key)
        if value is not None:
            parts.append(str(value))
    for tag in _as_list(lead.get("tags")):
        parts.append(str(tag))
    custom = _as_dict(lead.get("customFields") or lead.get("custom_fields"))
    for value in custom.values():
        parts.append(str(value))
    for note in _as_list(lead.get("notes")):
        if isinstance(note, Mapping):
            parts.append(str(note.get("body") or note.get("text") or note.get("note") or ""))
        else:
            parts.append(str(note))
    return " ".join(parts)


def _crm_summary_payload() -> dict[str, Any]:
    leads, meta = _crm_payload()
    stages: dict[str, int] = {}
    sources: dict[str, int] = {}
    owners: dict[str, int] = {}
    recent: list[Any] = []
    for lead in leads:
        if not isinstance(lead, Mapping):
            continue
        stage = str(lead.get("stage") or "unknown")
        source = str(lead.get("source") or "unknown")
        owner = str(lead.get("owner") or "unassigned")
        stages[stage] = stages.get(stage, 0) + 1
        sources[source] = sources.get(source, 0) + 1
        owners[owner] = owners.get(owner, 0) + 1
        recent.append({
            "id": lead.get("id"),
            "name": lead.get("name") or lead.get("fullName") or lead.get("title"),
            "company": lead.get("company"),
            "stage": lead.get("stage"),
            "status": lead.get("status"),
            "score": lead.get("score"),
            "owner": lead.get("owner"),
            "source": lead.get("source"),
            "next_action": lead.get("nextAction") or lead.get("next_action"),
            "updated_at": lead.get("updatedAt") or lead.get("updated_at"),
        })
    return {
        "lead_count": len(leads),
        "status_counts": _status_counts(leads),
        "stage_counts": stages,
        "source_counts": sources,
        "owner_counts": owners,
        "column_count": _count(meta.get("columns")),
        "visible_columns": [
            column.get("label") or column.get("key")
            for column in _as_list(meta.get("columns"))
            if isinstance(column, Mapping) and column.get("visible") is not False
        ],
        "view_settings": {
            "view_preset": meta.get("viewPreset"),
            "stage_filter": meta.get("stageFilter"),
            "status_filter": meta.get("statusFilter"),
            "source_filter": meta.get("sourceFilter"),
            "sort_key": meta.get("sortKey"),
            "sort_direction": meta.get("sortDirection"),
            "density": meta.get("density"),
        },
        "last_saved_at": meta.get("lastSavedAt"),
        "recent": _sanitize(recent[:20]),
    }


def _crm_snapshot_for_write() -> dict[str, Any]:
    raw = _load("crm", default=None)
    now = _now_iso()
    if isinstance(raw, dict):
        snapshot = dict(raw)
        snapshot["leads"] = _as_list(snapshot.get("leads") or snapshot.get("contacts") or snapshot.get("items"))
    elif isinstance(raw, list):
        snapshot = {"leads": raw}
    else:
        snapshot = {"leads": []}
    snapshot.setdefault("schemaVersion", 2)
    snapshot.setdefault("columns", [])
    snapshot.setdefault("searchQuery", "")
    snapshot.setdefault("stageFilter", "all")
    snapshot.setdefault("statusFilter", "all")
    snapshot.setdefault("sourceFilter", "all")
    snapshot.setdefault("viewPreset", "all")
    snapshot.setdefault("density", "cozy")
    snapshot.setdefault("sortKey", "updatedAt")
    snapshot.setdefault("sortDirection", "desc")
    snapshot.setdefault("detailLeadId", None)
    snapshot.setdefault("lastSavedAt", now)
    return snapshot


def _clean_crm_stage(value: Any) -> str:
    stage = str(value or "new").strip().lower()
    return stage if stage in CRM_STAGE_OPTIONS else "new"


def _clean_crm_status(value: Any) -> str:
    status = str(value or "active").strip().lower()
    return status if status in CRM_STATUS_OPTIONS else "active"


def _save_crm(snapshot: dict[str, Any]) -> dict[str, Any]:
    snapshot["lastSavedAt"] = _now_iso()
    pi_state.save_feature("crm", snapshot)
    return _crm_summary_payload()


def _project_flow_summary_payload() -> dict[str, Any]:
    snapshot = _as_dict(_load("project_flow", default={"nodes": [], "edges": []}))
    nodes = _as_list(snapshot.get("nodes"))
    edges = _as_list(snapshot.get("edges"))
    kinds: dict[str, int] = {}
    for node in nodes:
        if not isinstance(node, dict):
            continue
        data = _as_dict(node.get("data"))
        kind = str(data.get("kind") or node.get("type") or "unknown")
        kinds[kind] = kinds.get(kind, 0) + 1
    return {
        "board_title": snapshot.get("boardTitle"),
        "board_mode": snapshot.get("boardMode"),
        "node_count": len(nodes),
        "edge_count": len(edges),
        "node_kinds": kinds,
        "nodes": _sanitize(nodes[:25]),
        "edges": _sanitize(edges[:25]),
    }


_PROJECT_FLOW_KIND_PRESETS: dict[str, dict[str, Any]] = {
    "project": {"title": "Milestone", "subtitle": "Owner - next move", "body": "What needs to ship next.", "tags": ["ship"], "accent": "#2dd4bf", "icon": "TK"},
    "code": {"title": "Service", "subtitle": "Boundary", "body": "Inputs -> logic -> outputs", "tags": ["api"], "accent": "#60a5fa", "icon": "</>"},
    "note": {"title": "Working note", "subtitle": "Scratchpad", "body": "Capture the important bit.", "tags": ["note"], "accent": "#f59e0b", "icon": "NT"},
    "story": {"title": "Scene", "subtitle": "Beat", "body": "What happens in this frame.", "tags": ["scene"], "accent": "#f472b6", "icon": "SB"},
    "art": {"title": "Art direction", "subtitle": "Mood", "body": "Palette, type, reference, texture.", "tags": ["mood"], "accent": "#a78bfa", "icon": "AR"},
    "document": {"title": "Brief", "subtitle": "Upload a file", "body": "Attach a source document.", "tags": ["doc"], "accent": "#38bdf8", "icon": "DOC"},
    "url": {"title": "Reference link", "subtitle": "Paste a URL", "body": "External source or working link.", "tags": ["link"], "accent": "#14b8a6", "icon": "URL"},
    "image": {"title": "Image reference", "subtitle": "Upload image", "body": "Still frame or design ref.", "tags": ["image"], "accent": "#fb7185", "icon": "IMG"},
    "video": {"title": "Video clip", "subtitle": "Upload video", "body": "Motion reference or edit asset.", "tags": ["video"], "accent": "#f97316", "icon": "VID"},
    "drawing": {"title": "Sketch pad", "subtitle": "Sketch", "body": "Annotate layout, flow, or composition.", "tags": ["sketch"], "accent": "#22c55e", "icon": "DRW"},
    "ai": {"title": "AI assistant", "subtitle": "Connected-context prompt", "body": "Connect this node to briefs, links, assets, or tasks.", "tags": ["ai"], "accent": "#8b5cf6", "icon": "AI"},
    "imageGenerator": {"title": "Image generator", "subtitle": "FAL image model", "body": "Generate a still image for this flow.", "tags": ["fal", "image"], "accent": "#ec4899", "icon": "IMG+"},
    "videoGenerator": {"title": "Video generator", "subtitle": "FAL video model", "body": "Generate a video concept for this flow.", "tags": ["fal", "video"], "accent": "#f43f5e", "icon": "VID+"},
}


def _project_flow_state_for_write() -> dict[str, Any]:
    snapshot = _as_dict(_load("project_flow", default={}))
    snapshot.setdefault("boardTitle", "Untitled flow")
    snapshot.setdefault("boardMode", "project")
    snapshot["nodes"] = [node for node in _as_list(snapshot.get("nodes")) if isinstance(node, dict)]
    snapshot["edges"] = [edge for edge in _as_list(snapshot.get("edges")) if isinstance(edge, dict)]
    snapshot.setdefault("selectedNodeId", None)
    snapshot.setdefault("snapToGrid", True)
    snapshot.setdefault("showMiniMap", False)
    snapshot.setdefault("showGrid", True)
    return snapshot


def _save_project_flow(snapshot: dict[str, Any]) -> dict[str, Any]:
    pi_state.save_feature("project_flow", snapshot)
    return _project_flow_summary_payload()


def _project_flow_make_node(kind: str, x: int, y: int, *, title: str = "", subtitle: str = "", body: str = "", tags: list[str] | None = None, url: str = "") -> dict[str, Any]:
    clean_kind = kind if kind in _PROJECT_FLOW_KIND_PRESETS else "note"
    preset = _PROJECT_FLOW_KIND_PRESETS[clean_kind]
    data = {
        "kind": clean_kind,
        "title": title.strip()[:180] or preset["title"],
        "subtitle": subtitle.strip()[:180] or preset["subtitle"],
        "body": body.strip()[:4000] or preset["body"],
        "tags": [str(tag).strip()[:80] for tag in (tags or preset["tags"]) if str(tag).strip()],
        "accent": preset["accent"],
        "icon": preset["icon"],
        "checklist": [],
        "url": url.strip(),
        "fileName": "",
        "fileType": "",
        "fileSizeLabel": "",
        "mediaSrc": "",
        "previewMode": "cover",
        "drawingStrokes": [],
        "drawingBackground": "#081018",
        "aiProvider": "OpenAI",
        "aiApiBase": "",
        "aiApiKey": "",
        "aiModel": "",
        "aiPrompt": "Analyze the connected nodes and recommend the next concrete steps.",
        "aiResult": "",
        "falApiKey": "",
        "falEndpoint": "fal-ai/flux/dev" if clean_kind != "videoGenerator" else "fal-ai/kling-video/v2.1/master/text-to-video",
        "falPrompt": "",
        "falRequestId": "",
        "falStatus": "",
        "falResultUrl": "",
        "lastRunAt": "",
    }
    return {
        "id": _make_id("node"),
        "type": "projectFlowNode",
        "position": {"x": int(x), "y": int(y)},
        "data": data,
    }


def _project_flow_make_edge(source: str, target: str, label: str = "") -> dict[str, Any]:
    return {
        "id": _make_id("edge"),
        "source": source,
        "target": target,
        "type": "smoothstep",
        "animated": False,
        "label": label.strip()[:180] or None,
        "markerEnd": {"type": "arrowclosed"},
    }


def _storage_summary_payload() -> dict[str, Any]:
    state = _as_dict(_load("storage", default={}))
    files = _as_list(state.get("files"))
    folders = _as_list(state.get("folders"))
    categories = _as_list(state.get("categories"))
    providers = _as_dict(state.get("providers"))
    by_kind: dict[str, int] = {}
    by_category: dict[str, int] = {}
    folder_lookup = {str(f.get("id")): str(f.get("name") or f.get("id")) for f in folders if isinstance(f, dict)}
    category_lookup = {str(c.get("id")): str(c.get("name") or c.get("id")) for c in categories if isinstance(c, dict)}
    total_bytes = 0
    recent: list[dict[str, Any]] = []
    for item in files:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "other")
        category_id = str(item.get("categoryId") or "other")
        by_kind[kind] = by_kind.get(kind, 0) + 1
        by_category[category_lookup.get(category_id, category_id)] = by_category.get(category_lookup.get(category_id, category_id), 0) + 1
        if isinstance(item.get("sizeBytes"), int):
            total_bytes += item["sizeBytes"]
        recent.append({
            "id": item.get("id"),
            "name": item.get("name"),
            "kind": kind,
            "mime_type": item.get("mimeType"),
            "folder": folder_lookup.get(str(item.get("folderId") or "root"), "Storage"),
            "category": category_lookup.get(category_id, category_id),
            "size_bytes": item.get("sizeBytes"),
            "updated_at": item.get("updatedAt"),
            "notes": item.get("notes"),
        })
    return {
        "file_count": len(files),
        "folder_count": max(0, len(folders) - 1),
        "category_count": len(categories),
        "total_bytes": total_bytes,
        "by_kind": by_kind,
        "by_category": by_category,
        "drive_connections": {
            key: {
                "status": value.get("status") if isinstance(value, dict) else None,
                "client_id_configured": bool(value.get("clientId")) if isinstance(value, dict) else False,
                "last_error": value.get("lastError") if isinstance(value, dict) else None,
            }
            for key, value in providers.items()
        },
        "recent_files": _sanitize(recent[:25]),
        "folders": _sanitize([
            {"id": f.get("id"), "name": f.get("name"), "parent_id": f.get("parentId")}
            for f in folders if isinstance(f, dict)
        ]),
    }


def _video_meeting_default_settings() -> dict[str, Any]:
    return {
        "domain": "meet.jit.si",
        "roomName": f"meeting-{uuid.uuid4().hex[:10]}",
        "displayName": "Guest",
        "email": "",
        "startWithAudioMuted": True,
        "startWithVideoMuted": True,
    }


def _normalize_video_meeting_settings(raw: Any) -> dict[str, Any]:
    base = _video_meeting_default_settings()
    if not isinstance(raw, dict):
        return base
    domain = str(raw.get("domain") or base["domain"]).strip().replace("https://", "").replace("http://", "")
    domain = domain.split("/", 1)[0].rstrip(":").lower() or base["domain"]
    room = re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9_-]", "-", str(raw.get("roomName") or base["roomName"]).strip().replace(" ", "-"))).strip("-")
    base.update({
        "domain": domain or base["domain"],
        "roomName": room[:96] or base["roomName"],
        "displayName": str(raw.get("displayName") or base["displayName"]).strip()[:120] or base["displayName"],
        "email": str(raw.get("email") or "").strip()[:180],
        "startWithAudioMuted": bool(raw.get("startWithAudioMuted", base["startWithAudioMuted"])),
        "startWithVideoMuted": bool(raw.get("startWithVideoMuted", base["startWithVideoMuted"])),
    })
    return base


def _video_meeting_snapshot_for_write() -> dict[str, Any]:
    raw = _as_dict(_load("video_meeting", default={}))
    settings = _normalize_video_meeting_settings(raw.get("settings"))
    active = _normalize_video_meeting_settings(raw.get("activeMeeting")) if isinstance(raw.get("activeMeeting"), dict) else None
    current = active or settings
    invite = f"https://{current['domain']}/{current['roomName']}"
    return {
        "settings": settings,
        "activeMeeting": active,
        "inviteUrl": invite,
        "status": "live" if active else "ready",
        "updatedAt": _now_iso(),
    }


def _save_video_meeting(snapshot: dict[str, Any]) -> dict[str, Any]:
    snapshot["updatedAt"] = _now_iso()
    current = snapshot.get("activeMeeting") or snapshot.get("settings") or _video_meeting_default_settings()
    snapshot["inviteUrl"] = f"https://{current['domain']}/{current['roomName']}"
    snapshot["status"] = "live" if snapshot.get("activeMeeting") else "ready"
    pi_state.save_feature("video_meeting", snapshot)
    try:
        auth.update_settings({"videoMeeting": snapshot["settings"]})
    except Exception as exc:  # noqa: BLE001
        logger.debug("[features_tools] failed to persist videoMeeting user setting: %s", exc)
    return _video_meeting_summary_payload()


def _feature_presence() -> dict[str, Any]:
    persisted = set(pi_state.list_features())
    presence: dict[str, Any] = {}
    for key, meta in FEATURE_CATALOG.items():
        state_keys = list(meta.get("state_keys") or [])
        present_keys = [state_key for state_key in state_keys if state_key in persisted]
        presence[key] = {
            "label": meta["label"],
            "status": meta["status"],
            "agent_access": meta.get("agent_access", "unknown"),
            "state_present": bool(present_keys),
            "present_state_keys": present_keys,
            "missing_state_keys": [state_key for state_key in state_keys if state_key not in persisted],
            "agent_tools": meta.get("agent_tools", []),
            "rpc_namespaces": meta.get("rpc_namespaces", []),
        }
    return presence


@tool(
    name="features_catalog",
    description=(
        "Return the complete feature catalog/manifest for the main agent: "
        "workspaces, live backend state keys, tool names, RPC namespaces, "
        "and whether each feature has live mirrored state. Use this for broad "
        "questions like 'what features do you have' or 'who manages features'."
    ),
)
async def features_catalog() -> str:
    return _json_ok({
        "features": _feature_presence(),
        "settings": _settings_status(),
        "state_dir": pi_state.base_dir_str(),
        "architecture": {
            "main_agent_role": "front door/orchestrator",
            "feature_workers": [],
            "state_mirror": "frontend stores call pi.state.sync; tools read JSON snapshots from the PI state directory",
            "secret_policy": "tool outputs redact keys/tokens/secrets and omit large media/data URLs",
        },
    })


@tool(
    name="features_settings_status",
    description=(
        "Check feature-agent settings without revealing secrets: FEATURES_PROVIDER, "
        "FEATURES_MODEL_NAME, FEATURES_API_BASE, and FEATURES_API_KEY."
    ),
)
async def features_settings_status() -> str:
    return _json_ok(_settings_status())


@tool(
    name="features_state_get",
    description=(
        "Get a secret-safe live state snapshot for one feature. Feature names/aliases: "
        "storage/files/documents, kanban, crm, project_flow, lead_gen, and video_meeting. "
        "Returns summary plus capped sanitized raw state if present."
    ),
)
async def features_state_get(feature: str) -> str:
    key = _feature_key(feature)
    if key not in FEATURE_CATALOG:
        return _json_err("unknown feature", known_features=sorted(FEATURE_CATALOG))
    meta = FEATURE_CATALOG[key]
    state_keys = list(meta.get("state_keys") or [])
    raw_states = {state_key: _load(state_key, default=None) for state_key in state_keys}
    present = {state_key: value for state_key, value in raw_states.items() if value is not None}
    summary: dict[str, Any]
    if key == "storage":
        summary = _storage_summary_payload()
    elif key == "kanban":
        summary = _kanban_summary_payload()
    elif key == "crm":
        summary = _crm_summary_payload()
    elif key == "project_flow":
        summary = _project_flow_summary_payload()
    elif key == "video_meeting":
        summary = _video_meeting_summary_payload()
    else:
        summary = {"state_present": bool(present), "note": meta["description"]}
    return _json_ok({
        "feature": key,
        "label": meta["label"],
        "status": meta["status"],
        "summary": summary,
        "raw_state": _sanitize(present),
    })


@tool(
    name="features_kanban_list",
    description=(
        "List all Kanban cards grouped by column. Use this when the user asks "
        "about their tasks, to-do list, Kanban board, or what's in progress."
    ),
)
async def features_kanban_list() -> str:
    snapshot = _as_dict(_load("kanban", default={"cards": [], "columns": [], "entries": []}))
    return _json_ok({
        "columns": _sanitize(_as_list(snapshot.get("columns"))),
        "cards": _sanitize(_as_list(snapshot.get("cards"))),
        "entries": _sanitize(_as_list(snapshot.get("entries"))),
        "count": _count(snapshot.get("cards")),
    })


@tool(
    name="features_kanban_summary",
    description=(
        "Compact Kanban summary: card counts per column and card titles. Use "
        "for high-level status questions like 'what do I have on my board'."
    ),
)
async def features_kanban_summary() -> str:
    return _json_ok(_kanban_summary_payload())


@tool(
    name="features_kanban_create_card",
    description=(
        "Create a Kanban card in the user's feature board. Use when the user "
        "asks the main agent to add a task/card. Args: title, optional notes, "
        "optional column_id (todo, in-progress, review, done), optional subtasks."
    ),
)
async def features_kanban_create_card(
    title: str,
    notes: str = "",
    column_id: str = "todo",
    subtasks: list[str] | None = None,
) -> str:
    clean_title = (title or "").strip()
    if not clean_title:
        return _json_err("title is required")
    snapshot = _kanban_snapshot_for_write()
    target_column = (column_id or "todo").strip()
    if not _kanban_column_exists(snapshot, target_column):
        target_column = str(_as_list(snapshot.get("columns"))[0].get("id") if _as_list(snapshot.get("columns")) else "todo")
    now = _now_iso()
    card = {
        "id": _make_id("card"),
        "title": clean_title[:220],
        "notes": (notes or "").strip(),
        "columnId": target_column,
        "subtasks": [
            {"id": _make_id("subtask"), "title": str(item).strip()[:220]}
            for item in (subtasks or [])
            if str(item).strip()
        ],
        "parentTitle": None,
        "createdAt": now,
        "updatedAt": now,
    }
    snapshot["cards"] = [card, *_as_list(snapshot.get("cards"))]
    summary = _save_kanban(snapshot)
    return _json_ok({"card": _sanitize(card), "summary": summary})


@tool(
    name="features_kanban_update_card",
    description=(
        "Update a Kanban card title and/or notes by card_id. Use after listing "
        "Kanban cards when the user asks to revise a task."
    ),
)
async def features_kanban_update_card(card_id: str, title: str = "", notes: str = "") -> str:
    cid = (card_id or "").strip()
    if not cid:
        return _json_err("card_id is required")
    snapshot = _kanban_snapshot_for_write()
    updated = None
    cards = []
    for card in _as_list(snapshot.get("cards")):
        if not isinstance(card, dict):
            continue
        if str(card.get("id")) == cid:
            if title.strip():
                card["title"] = title.strip()[:220]
            if notes.strip():
                card["notes"] = notes.strip()
            card["updatedAt"] = _now_iso()
            updated = dict(card)
        cards.append(card)
    if updated is None:
        return _json_err("card not found", card_id=cid)
    snapshot["cards"] = cards
    summary = _save_kanban(snapshot)
    return _json_ok({"card": _sanitize(updated), "summary": summary})


@tool(
    name="features_kanban_move_card",
    description=(
        "Move a Kanban card to another column by card_id and column_id. Valid "
        "default columns are todo, in-progress, review, done; custom board columns are also supported."
    ),
)
async def features_kanban_move_card(card_id: str, column_id: str) -> str:
    cid = (card_id or "").strip()
    target_column = (column_id or "").strip()
    if not cid or not target_column:
        return _json_err("card_id and column_id are required")
    snapshot = _kanban_snapshot_for_write()
    if not _kanban_column_exists(snapshot, target_column):
        return _json_err("column not found", column_id=target_column)
    moved = None
    cards = []
    for card in _as_list(snapshot.get("cards")):
        if not isinstance(card, dict):
            continue
        if str(card.get("id")) == cid:
            card["columnId"] = target_column
            card["updatedAt"] = _now_iso()
            moved = dict(card)
        cards.append(card)
    if moved is None:
        return _json_err("card not found", card_id=cid)
    snapshot["cards"] = cards
    summary = _save_kanban(snapshot)
    return _json_ok({"card": _sanitize(moved), "summary": summary})


@tool(
    name="features_crm_list",
    description=(
        "List all CRM leads/contacts. Use when the user asks about their "
        "pipeline, leads, contacts, customers, status, or follow-up list."
    ),
)
async def features_crm_list() -> str:
    leads, meta = _crm_payload()
    return _json_ok({
        "count": len(leads),
        "summary": _crm_summary_payload(),
        "meta": _sanitize(meta),
        "leads": _sanitize(leads),
    })


@tool(
    name="features_crm_find",
    description=(
        "Find CRM leads matching a case-insensitive substring across name, "
        "company, email, phone, source, status, or notes."
    ),
)
async def features_crm_find(query: str) -> str:
    leads, _ = _crm_payload()
    q = (query or "").strip().lower()
    if not q:
        return _json_err("query is required")
    hits = []
    for lead in leads:
        if not isinstance(lead, Mapping):
            continue
        hay = _crm_lead_search_text(lead)
        if q in hay.lower():
            hits.append(lead)
    return _json_ok({"count": len(hits), "query": query, "leads": _sanitize(hits)})


@tool(
    name="features_crm_create_lead",
    description=(
        "Create a CRM lead/contact. Use when the user asks the main agent to "
        "add a lead. Args include name plus optional company, email, phone, "
        "website, owner, source, stage, status, score, next_action, tags."
    ),
)
async def features_crm_create_lead(
    name: str,
    company: str = "",
    email: str = "",
    phone: str = "",
    website: str = "",
    owner: str = "",
    source: str = "Manual",
    stage: str = "new",
    status: str = "active",
    score: int = 50,
    next_action: str = "",
    tags: list[str] | None = None,
) -> str:
    clean_name = (name or "").strip()
    if not clean_name:
        return _json_err("name is required")
    snapshot = _crm_snapshot_for_write()
    now = _now_iso()
    lead = {
        "id": _make_id("lead"),
        "name": clean_name[:180],
        "company": (company or "").strip()[:180],
        "email": (email or "").strip()[:180],
        "phone": (phone or "").strip()[:80],
        "address": "",
        "website": (website or "").strip()[:240],
        "owner": (owner or "").strip()[:120],
        "source": (source or "Manual").strip()[:120],
        "stage": _clean_crm_stage(stage),
        "status": _clean_crm_status(status),
        "score": max(0, min(100, int(score or 0))),
        "nextAction": (next_action or "").strip()[:240],
        "lastContactAt": "",
        "tags": [str(tag).strip()[:80] for tag in (tags or []) if str(tag).strip()],
        "customFields": {},
        "notes": [],
        "createdAt": now,
        "updatedAt": now,
    }
    snapshot["leads"] = [lead, *_as_list(snapshot.get("leads"))]
    snapshot["detailLeadId"] = lead["id"]
    summary = _save_crm(snapshot)
    return _json_ok({"lead": _sanitize(lead), "summary": summary})


@tool(
    name="features_crm_update_lead",
    description=(
        "Update CRM lead fields by lead_id. Leave a field empty to keep its "
        "existing value. Supports company, email, phone, website, owner, source, "
        "stage, status, score, next_action."
    ),
)
async def features_crm_update_lead(
    lead_id: str,
    name: str = "",
    company: str = "",
    email: str = "",
    phone: str = "",
    website: str = "",
    owner: str = "",
    source: str = "",
    stage: str = "",
    status: str = "",
    score: int | None = None,
    next_action: str = "",
) -> str:
    lid = (lead_id or "").strip()
    if not lid:
        return _json_err("lead_id is required")
    snapshot = _crm_snapshot_for_write()
    updated = None
    leads = []
    for lead in _as_list(snapshot.get("leads")):
        if not isinstance(lead, dict):
            continue
        if str(lead.get("id")) == lid:
            if name.strip():
                lead["name"] = name.strip()[:180]
            if company.strip():
                lead["company"] = company.strip()[:180]
            if email.strip():
                lead["email"] = email.strip()[:180]
            if phone.strip():
                lead["phone"] = phone.strip()[:80]
            if website.strip():
                lead["website"] = website.strip()[:240]
            if owner.strip():
                lead["owner"] = owner.strip()[:120]
            if source.strip():
                lead["source"] = source.strip()[:120]
            if stage.strip():
                lead["stage"] = _clean_crm_stage(stage)
            if status.strip():
                lead["status"] = _clean_crm_status(status)
            if score is not None:
                lead["score"] = max(0, min(100, int(score or 0)))
            if next_action.strip():
                lead["nextAction"] = next_action.strip()[:240]
            lead["updatedAt"] = _now_iso()
            updated = dict(lead)
        leads.append(lead)
    if updated is None:
        return _json_err("lead not found", lead_id=lid)
    snapshot["leads"] = leads
    snapshot["detailLeadId"] = lid
    summary = _save_crm(snapshot)
    return _json_ok({"lead": _sanitize(updated), "summary": summary})


@tool(
    name="features_crm_add_note",
    description="Add a note to a CRM lead by lead_id. Use for follow-up notes, call notes, and user reminders.",
)
async def features_crm_add_note(lead_id: str, body: str) -> str:
    lid = (lead_id or "").strip()
    clean_body = (body or "").strip()
    if not lid or not clean_body:
        return _json_err("lead_id and body are required")
    snapshot = _crm_snapshot_for_write()
    note = {"id": _make_id("note"), "body": clean_body, "createdAt": _now_iso()}
    updated = None
    leads = []
    for lead in _as_list(snapshot.get("leads")):
        if not isinstance(lead, dict):
            continue
        if str(lead.get("id")) == lid:
            lead["notes"] = [note, *_as_list(lead.get("notes"))]
            lead["updatedAt"] = _now_iso()
            updated = dict(lead)
        leads.append(lead)
    if updated is None:
        return _json_err("lead not found", lead_id=lid)
    snapshot["leads"] = leads
    snapshot["detailLeadId"] = lid
    summary = _save_crm(snapshot)
    return _json_ok({"lead": _sanitize(updated), "note": _sanitize(note), "summary": summary})


@tool(
    name="features_project_flow_list",
    description=(
        "Get the Project Flow graph (nodes and edges). Use when the user asks "
        "about project structure, workflow, dependencies, board nodes, files, or diagrams."
    ),
)
async def features_project_flow_list() -> str:
    return _json_ok(_project_flow_summary_payload())


@tool(
    name="features_project_flow_set_board",
    description="Update the Project Flow board title and/or board mode.",
)
async def features_project_flow_set_board(title: str = "", mode: str = "") -> str:
    snapshot = _project_flow_state_for_write()
    if title.strip():
        snapshot["boardTitle"] = title.strip()[:180]
    if mode.strip():
        snapshot["boardMode"] = mode.strip()[:40]
    summary = _save_project_flow(snapshot)
    return _json_ok({"summary": summary})


@tool(
    name="features_project_flow_create_node",
    description="Create a Project Flow node. Args: kind plus optional title, subtitle, body, tags, url, x, y.",
)
async def features_project_flow_create_node(
    kind: str,
    title: str = "",
    subtitle: str = "",
    body: str = "",
    tags: list[str] | None = None,
    url: str = "",
    x: int = 180,
    y: int = 140,
) -> str:
    snapshot = _project_flow_state_for_write()
    node = _project_flow_make_node(kind.strip(), x, y, title=title, subtitle=subtitle, body=body, tags=tags, url=url)
    snapshot["nodes"] = [*snapshot["nodes"], node]
    snapshot["selectedNodeId"] = node["id"]
    summary = _save_project_flow(snapshot)
    return _json_ok({"node": _sanitize(node), "summary": summary})


@tool(
    name="features_project_flow_update_node",
    description="Update a Project Flow node by node_id. Supported fields: title, subtitle, body, tags, url, x, y.",
)
async def features_project_flow_update_node(
    node_id: str,
    title: str = "",
    subtitle: str = "",
    body: str = "",
    tags: list[str] | None = None,
    url: str = "",
    x: int | None = None,
    y: int | None = None,
) -> str:
    clean_id = (node_id or "").strip()
    if not clean_id:
        return _json_err("node_id is required")
    snapshot = _project_flow_state_for_write()
    updated = None
    for node in snapshot["nodes"]:
        if str(node.get("id")) != clean_id:
            continue
        data = _as_dict(node.get("data"))
        if title.strip():
            data["title"] = title.strip()[:180]
        if subtitle.strip():
            data["subtitle"] = subtitle.strip()[:180]
        if body.strip():
            data["body"] = body.strip()[:4000]
        if tags is not None:
            data["tags"] = [str(tag).strip()[:80] for tag in tags if str(tag).strip()]
        if url.strip():
            data["url"] = url.strip()[:1000]
        node["data"] = data
        if x is not None or y is not None:
            pos = _as_dict(node.get("position"))
            node["position"] = {"x": int(x if x is not None else pos.get("x") or 0), "y": int(y if y is not None else pos.get("y") or 0)}
        updated = node
        break
    if updated is None:
        return _json_err("node not found", node_id=clean_id)
    summary = _save_project_flow(snapshot)
    return _json_ok({"node": _sanitize(updated), "summary": summary})


@tool(
    name="features_project_flow_delete_node",
    description="Delete a Project Flow node and any connected edges by node_id.",
)
async def features_project_flow_delete_node(node_id: str) -> str:
    clean_id = (node_id or "").strip()
    if not clean_id:
        return _json_err("node_id is required")
    snapshot = _project_flow_state_for_write()
    before = len(snapshot["nodes"])
    snapshot["nodes"] = [node for node in snapshot["nodes"] if str(node.get("id")) != clean_id]
    if len(snapshot["nodes"]) == before:
        return _json_err("node not found", node_id=clean_id)
    snapshot["edges"] = [
        edge for edge in snapshot["edges"]
        if str(edge.get("source")) != clean_id and str(edge.get("target")) != clean_id
    ]
    if snapshot.get("selectedNodeId") == clean_id:
        snapshot["selectedNodeId"] = None
    summary = _save_project_flow(snapshot)
    return _json_ok({"deleted": clean_id, "summary": summary})


@tool(
    name="features_project_flow_connect_nodes",
    description="Create an edge between two Project Flow nodes by source_id and target_id.",
)
async def features_project_flow_connect_nodes(source_id: str, target_id: str, label: str = "") -> str:
    source = (source_id or "").strip()
    target = (target_id or "").strip()
    if not source or not target:
        return _json_err("source_id and target_id are required")
    snapshot = _project_flow_state_for_write()
    node_ids = {str(node.get("id")) for node in snapshot["nodes"]}
    if source not in node_ids or target not in node_ids:
        return _json_err("source_id and target_id must reference existing nodes")
    edge = _project_flow_make_edge(source, target, label)
    snapshot["edges"] = [*snapshot["edges"], edge]
    summary = _save_project_flow(snapshot)
    return _json_ok({"edge": _sanitize(edge), "summary": summary})


@tool(
    name="features_project_flow_delete_edge",
    description="Delete a Project Flow edge by edge_id.",
)
async def features_project_flow_delete_edge(edge_id: str) -> str:
    clean_id = (edge_id or "").strip()
    if not clean_id:
        return _json_err("edge_id is required")
    snapshot = _project_flow_state_for_write()
    before = len(snapshot["edges"])
    snapshot["edges"] = [edge for edge in snapshot["edges"] if str(edge.get("id")) != clean_id]
    if len(snapshot["edges"]) == before:
        return _json_err("edge not found", edge_id=clean_id)
    summary = _save_project_flow(snapshot)
    return _json_ok({"deleted": clean_id, "summary": summary})


@tool(
    name="features_lead_gen_summary",
    description="Summarize Lead Gen state: prospect counts, campaign counts, high-intent leads, and recent activity.",
)
async def features_lead_gen_summary() -> str:
    return _json_ok(_lead_gen_summary_payload())


@tool(
    name="features_lead_gen_list_prospects",
    description="List Lead Gen prospects and campaigns in the mirrored workspace.",
)
async def features_lead_gen_list_prospects() -> str:
    snapshot = _lead_gen_state_for_write()
    return _json_ok({
        "summary": _lead_gen_summary_payload(),
        "prospects": _sanitize(snapshot.get("prospects")),
        "campaigns": _sanitize(snapshot.get("campaigns")),
    })


@tool(
    name="features_lead_gen_create_prospect",
    description="Create a Lead Gen prospect with name and optional company, role, email, source, score, status, tags, and next_action.",
)
async def features_lead_gen_create_prospect(
    name: str,
    company: str = "",
    role: str = "",
    email: str = "",
    source: str = "Manual",
    score: int = 50,
    status: str = "new",
    tags: list[str] | None = None,
    next_action: str = "",
) -> str:
    clean_name = (name or "").strip()
    if not clean_name:
        return _json_err("name is required")
    snapshot = _lead_gen_state_for_write()
    prospect = {
        "id": _make_id("prospect"),
        "name": clean_name[:180],
        "company": (company or "").strip()[:180],
        "role": (role or "").strip()[:180],
        "email": (email or "").strip()[:180],
        "source": (source or "Manual").strip()[:120] or "Manual",
        "status": (status or "new").strip()[:40] or "new",
        "score": max(0, min(100, int(score or 0))),
        "tags": [str(item).strip()[:80] for item in (tags or []) if str(item).strip()],
        "notes": [],
        "nextAction": (next_action or "").strip()[:240],
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    snapshot["prospects"] = [prospect, *_as_list(snapshot.get("prospects"))]
    snapshot["selectedProspectId"] = prospect["id"]
    summary = _save_lead_gen(snapshot)
    return _json_ok({"prospect": _sanitize(prospect), "summary": summary})


@tool(
    name="features_lead_gen_update_prospect",
    description="Update a Lead Gen prospect by prospect_id.",
)
async def features_lead_gen_update_prospect(
    prospect_id: str,
    company: str = "",
    role: str = "",
    email: str = "",
    source: str = "",
    score: int | None = None,
    status: str = "",
    next_action: str = "",
) -> str:
    clean_id = (prospect_id or "").strip()
    if not clean_id:
        return _json_err("prospect_id is required")
    snapshot = _lead_gen_state_for_write()
    updated = None
    for prospect in _as_list(snapshot.get("prospects")):
        if not isinstance(prospect, dict) or str(prospect.get("id")) != clean_id:
            continue
        if company.strip():
            prospect["company"] = company.strip()[:180]
        if role.strip():
            prospect["role"] = role.strip()[:180]
        if email.strip():
            prospect["email"] = email.strip()[:180]
        if source.strip():
            prospect["source"] = source.strip()[:120]
        if score is not None:
            prospect["score"] = max(0, min(100, int(score or 0)))
        if status.strip():
            prospect["status"] = status.strip()[:40]
        if next_action.strip():
            prospect["nextAction"] = next_action.strip()[:240]
        prospect["updatedAt"] = _now_iso()
        updated = prospect
        break
    if updated is None:
        return _json_err("prospect not found", prospect_id=clean_id)
    summary = _save_lead_gen(snapshot)
    return _json_ok({"prospect": _sanitize(updated), "summary": summary})


@tool(
    name="features_lead_gen_add_note",
    description="Add a research or outreach note to a Lead Gen prospect by prospect_id.",
)
async def features_lead_gen_add_note(prospect_id: str, body: str) -> str:
    clean_id = (prospect_id or "").strip()
    clean_body = (body or "").strip()
    if not clean_id or not clean_body:
        return _json_err("prospect_id and body are required")
    snapshot = _lead_gen_state_for_write()
    note = {"id": _make_id("note"), "body": clean_body, "createdAt": _now_iso()}
    updated = None
    for prospect in _as_list(snapshot.get("prospects")):
        if not isinstance(prospect, dict) or str(prospect.get("id")) != clean_id:
            continue
        prospect["notes"] = [note, *_as_list(prospect.get("notes"))]
        prospect["updatedAt"] = _now_iso()
        updated = prospect
        break
    if updated is None:
        return _json_err("prospect not found", prospect_id=clean_id)
    summary = _save_lead_gen(snapshot)
    return _json_ok({"prospect": _sanitize(updated), "note": _sanitize(note), "summary": summary})


@tool(
    name="features_lead_gen_create_campaign",
    description="Create a Lead Gen outreach campaign with name and optional audience, offer, channel, status, and lead_ids.",
)
async def features_lead_gen_create_campaign(
    name: str,
    audience: str = "",
    offer: str = "",
    channel: str = "Email",
    status: str = "draft",
    lead_ids: list[str] | None = None,
) -> str:
    clean_name = (name or "").strip()
    if not clean_name:
        return _json_err("name is required")
    snapshot = _lead_gen_state_for_write()
    campaign = {
        "id": _make_id("campaign"),
        "name": clean_name[:180],
        "audience": (audience or "").strip()[:240],
        "offer": (offer or "").strip()[:240],
        "channel": (channel or "Email").strip()[:80] or "Email",
        "status": (status or "draft").strip()[:40] or "draft",
        "leadIds": [str(item).strip() for item in (lead_ids or []) if str(item).strip()],
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    }
    snapshot["campaigns"] = [campaign, *_as_list(snapshot.get("campaigns"))]
    summary = _save_lead_gen(snapshot)
    return _json_ok({"campaign": _sanitize(campaign), "summary": summary})


@tool(
    name="features_lead_gen_update_campaign",
    description="Update a Lead Gen campaign by campaign_id.",
)
async def features_lead_gen_update_campaign(
    campaign_id: str,
    name: str = "",
    audience: str = "",
    offer: str = "",
    channel: str = "",
    status: str = "",
) -> str:
    clean_id = (campaign_id or "").strip()
    if not clean_id:
        return _json_err("campaign_id is required")
    snapshot = _lead_gen_state_for_write()
    updated = None
    for campaign in _as_list(snapshot.get("campaigns")):
        if not isinstance(campaign, dict) or str(campaign.get("id")) != clean_id:
            continue
        if name.strip():
            campaign["name"] = name.strip()[:180]
        if audience.strip():
            campaign["audience"] = audience.strip()[:240]
        if offer.strip():
            campaign["offer"] = offer.strip()[:240]
        if channel.strip():
            campaign["channel"] = channel.strip()[:80]
        if status.strip():
            campaign["status"] = status.strip()[:40]
        campaign["updatedAt"] = _now_iso()
        updated = campaign
        break
    if updated is None:
        return _json_err("campaign not found", campaign_id=clean_id)
    summary = _save_lead_gen(snapshot)
    return _json_ok({"campaign": _sanitize(updated), "summary": summary})


@tool(
    name="features_lead_gen_attach_prospect_to_campaign",
    description="Attach a Lead Gen prospect to a campaign.",
)
async def features_lead_gen_attach_prospect_to_campaign(campaign_id: str, prospect_id: str) -> str:
    clean_campaign_id = (campaign_id or "").strip()
    clean_prospect_id = (prospect_id or "").strip()
    if not clean_campaign_id or not clean_prospect_id:
        return _json_err("campaign_id and prospect_id are required")
    snapshot = _lead_gen_state_for_write()
    prospect_exists = any(
        isinstance(prospect, dict) and str(prospect.get("id")) == clean_prospect_id
        for prospect in _as_list(snapshot.get("prospects"))
    )
    if not prospect_exists:
        return _json_err("prospect not found", prospect_id=clean_prospect_id)
    updated = None
    for campaign in _as_list(snapshot.get("campaigns")):
        if not isinstance(campaign, dict) or str(campaign.get("id")) != clean_campaign_id:
            continue
        lead_ids = [str(item).strip() for item in _as_list(campaign.get("leadIds")) if str(item).strip()]
        if clean_prospect_id not in lead_ids:
            lead_ids.append(clean_prospect_id)
        campaign["leadIds"] = lead_ids
        campaign["updatedAt"] = _now_iso()
        updated = campaign
        break
    if updated is None:
        return _json_err("campaign not found", campaign_id=clean_campaign_id)
    summary = _save_lead_gen(snapshot)
    return _json_ok({"campaign": _sanitize(updated), "summary": summary})


@tool(
    name="features_lead_gen_detach_prospect_from_campaign",
    description="Detach a Lead Gen prospect from a campaign.",
)
async def features_lead_gen_detach_prospect_from_campaign(campaign_id: str, prospect_id: str) -> str:
    clean_campaign_id = (campaign_id or "").strip()
    clean_prospect_id = (prospect_id or "").strip()
    if not clean_campaign_id or not clean_prospect_id:
        return _json_err("campaign_id and prospect_id are required")
    snapshot = _lead_gen_state_for_write()
    updated = None
    for campaign in _as_list(snapshot.get("campaigns")):
        if not isinstance(campaign, dict) or str(campaign.get("id")) != clean_campaign_id:
            continue
        lead_ids = [str(item).strip() for item in _as_list(campaign.get("leadIds")) if str(item).strip()]
        campaign["leadIds"] = [lead_id for lead_id in lead_ids if lead_id != clean_prospect_id]
        campaign["updatedAt"] = _now_iso()
        updated = campaign
        break
    if updated is None:
        return _json_err("campaign not found", campaign_id=clean_campaign_id)
    summary = _save_lead_gen(snapshot)
    return _json_ok({"campaign": _sanitize(updated), "summary": summary})


@tool(
    name="features_lead_gen_delete_campaign",
    description="Delete a Lead Gen campaign by campaign_id.",
)
async def features_lead_gen_delete_campaign(campaign_id: str) -> str:
    clean_id = (campaign_id or "").strip()
    if not clean_id:
        return _json_err("campaign_id is required")
    snapshot = _lead_gen_state_for_write()
    campaigns = _as_list(snapshot.get("campaigns"))
    remaining = [
        campaign
        for campaign in campaigns
        if not isinstance(campaign, dict) or str(campaign.get("id")) != clean_id
    ]
    if len(remaining) == len(campaigns):
        return _json_err("campaign not found", campaign_id=clean_id)
    snapshot["campaigns"] = remaining
    summary = _save_lead_gen(snapshot)
    return _json_ok({"deleted_campaign_id": clean_id, "summary": summary})


@tool(
    name="features_storage_create_folder",
    description="Create a folder in Storage. Optional parent_id defaults to root.",
)
async def features_storage_create_folder(name: str, parent_id: str = "root") -> str:
    from jiuwenclaw.pi_agent import storage as st

    state = st._load_state()  # noqa: SLF001
    target_parent = (parent_id or "root").strip() or "root"
    if not st._folder_exists(state, target_parent):  # noqa: SLF001
        return _json_err("parent folder not found", parent_id=target_parent)
    folder = {
        "id": uuid.uuid4().hex[:12],
        "name": st._safe_name(name or "New folder"),  # noqa: SLF001
        "parentId": target_parent,
        "createdAt": st._now_iso(),  # noqa: SLF001
        "updatedAt": st._now_iso(),  # noqa: SLF001
    }
    state["folders"].append(folder)
    st._save_state(state)  # noqa: SLF001
    return _json_ok({"folder": _sanitize(folder), "summary": _storage_summary_payload()})


@tool(
    name="features_storage_create_category",
    description="Create a custom category in Storage.",
)
async def features_storage_create_category(name: str) -> str:
    from jiuwenclaw.pi_agent import storage as st

    state = st._load_state()  # noqa: SLF001
    category = {
        "id": uuid.uuid4().hex[:12],
        "name": st._safe_name(name or "New category"),  # noqa: SLF001
        "kind": "custom",
        "createdAt": st._now_iso(),  # noqa: SLF001
        "updatedAt": st._now_iso(),  # noqa: SLF001
    }
    state["categories"].append(category)
    st._save_state(state)  # noqa: SLF001
    return _json_ok({"category": _sanitize(category), "summary": _storage_summary_payload()})


@tool(
    name="features_storage_create_text_file",
    description="Create a UTF-8 text or markdown file in Storage for notes, docs, prompts, or drafts.",
)
async def features_storage_create_text_file(
    name: str,
    content: str,
    folder_id: str = "root",
    category_id: str = "documents",
    notes: str = "",
    mime_type: str = "text/plain",
) -> str:
    from jiuwenclaw.pi_agent import storage as st

    clean_name = st._safe_name(name or "document.txt")  # noqa: SLF001
    if not clean_name:
        return _json_err("name is required")
    state = st._load_state()  # noqa: SLF001
    target_folder = (folder_id or "root").strip() or "root"
    if not st._folder_exists(state, target_folder):  # noqa: SLF001
        return _json_err("folder not found", folder_id=target_folder)
    target_category = (category_id or "documents").strip() or "documents"
    if not st._category_exists(state, target_category):  # noqa: SLF001
        target_category = "documents"
    file_id = uuid.uuid4().hex
    resolved_mime = (mime_type or "text/plain").strip()[:120] or "text/plain"
    ext = st._extension(clean_name, resolved_mime) or ".txt"  # noqa: SLF001
    disk_path = st._storage_dir() / "files" / f"{file_id}{ext}"  # noqa: SLF001
    raw = (content or "").encode("utf-8")
    disk_path.write_bytes(raw)
    item = {
        "id": file_id,
        "name": clean_name,
        "mimeType": resolved_mime,
        "kind": "document",
        "sizeBytes": len(raw),
        "extension": ext,
        "folderId": target_folder,
        "categoryId": target_category,
        "diskPath": str(disk_path),
        "thumbnailPath": "",
        "thumbnailDataUrl": "",
        "notes": (notes or "").strip(),
        "createdAt": st._now_iso(),  # noqa: SLF001
        "updatedAt": st._now_iso(),  # noqa: SLF001
    }
    state["files"].insert(0, item)
    st._save_state(state)  # noqa: SLF001
    return _json_ok({"file": _sanitize(item), "summary": _storage_summary_payload()})


@tool(
    name="features_storage_update_file",
    description="Update Storage file metadata by file_id. Supported fields: name, folder_id, category_id, notes.",
)
async def features_storage_update_file(
    file_id: str,
    name: str = "",
    folder_id: str = "",
    category_id: str = "",
    notes: str = "",
) -> str:
    from jiuwenclaw.pi_agent import storage as st

    clean_id = (file_id or "").strip()
    if not clean_id:
        return _json_err("file_id is required")
    state = st._load_state()  # noqa: SLF001
    updated = None
    for file_meta in state.get("files", []):
        if str(file_meta.get("id")) != clean_id:
            continue
        if name.strip():
            file_meta["name"] = st._safe_name(name)  # noqa: SLF001
        if folder_id.strip() and st._folder_exists(state, folder_id.strip()):  # noqa: SLF001
            file_meta["folderId"] = folder_id.strip()
        if category_id.strip() and st._category_exists(state, category_id.strip()):  # noqa: SLF001
            file_meta["categoryId"] = category_id.strip()
        if notes.strip():
            file_meta["notes"] = notes.strip()
        file_meta["updatedAt"] = st._now_iso()  # noqa: SLF001
        updated = file_meta
        break
    if updated is None:
        return _json_err("file not found", file_id=clean_id)
    st._save_state(state)  # noqa: SLF001
    return _json_ok({"file": _sanitize(updated), "summary": _storage_summary_payload()})


@tool(
    name="features_storage_delete_file",
    description="Delete a Storage file by file_id.",
)
async def features_storage_delete_file(file_id: str) -> str:
    from jiuwenclaw.pi_agent import storage as st

    clean_id = (file_id or "").strip()
    if not clean_id:
        return _json_err("file_id is required")
    state = st._load_state()  # noqa: SLF001
    found = next((item for item in state.get("files", []) if str(item.get("id")) == clean_id), None)
    if found is None:
        return _json_err("file not found", file_id=clean_id)
    st._delete_physical_file(found)  # noqa: SLF001
    state["files"] = [item for item in state.get("files", []) if str(item.get("id")) != clean_id]
    st._save_state(state)  # noqa: SLF001
    return _json_ok({"deleted": clean_id, "summary": _storage_summary_payload()})


@tool(
    name="features_storage_summary",
    description=(
        "Summarize Storage live state: files, folders, categories, thumbnails, "
        "document/media counts, recent file names, and Google Drive/OneDrive connection readiness."
    ),
)
async def features_storage_summary() -> str:
    return _json_ok(_storage_summary_payload())


@tool(
    name="features_video_meeting_update_settings",
    description="Update Video Meeting defaults such as domain, room_name, display_name, email, and mute preferences.",
)
async def features_video_meeting_update_settings(
    domain: str = "",
    room_name: str = "",
    display_name: str = "",
    email: str = "",
    start_with_audio_muted: bool | None = None,
    start_with_video_muted: bool | None = None,
) -> str:
    snapshot = _video_meeting_snapshot_for_write()
    settings = dict(snapshot["settings"])
    if domain.strip():
        settings["domain"] = domain
    if room_name.strip():
        settings["roomName"] = room_name
    if display_name.strip():
        settings["displayName"] = display_name
    if email.strip():
        settings["email"] = email
    if start_with_audio_muted is not None:
        settings["startWithAudioMuted"] = bool(start_with_audio_muted)
    if start_with_video_muted is not None:
        settings["startWithVideoMuted"] = bool(start_with_video_muted)
    snapshot["settings"] = _normalize_video_meeting_settings(settings)
    summary = _save_video_meeting(snapshot)
    return _json_ok({"settings": _sanitize(snapshot["settings"]), "summary": summary})


@tool(
    name="features_video_meeting_start_meeting",
    description="Start the current Video Meeting room using the saved meeting settings.",
)
async def features_video_meeting_start_meeting() -> str:
    snapshot = _video_meeting_snapshot_for_write()
    snapshot["activeMeeting"] = dict(snapshot["settings"])
    summary = _save_video_meeting(snapshot)
    return _json_ok({"meeting": _sanitize(snapshot["activeMeeting"]), "summary": summary})


@tool(
    name="features_video_meeting_close_meeting",
    description="Mark the current Video Meeting as closed while keeping the saved defaults.",
)
async def features_video_meeting_close_meeting() -> str:
    snapshot = _video_meeting_snapshot_for_write()
    snapshot["activeMeeting"] = None
    summary = _save_video_meeting(snapshot)
    return _json_ok({"status": "ready", "summary": summary})


@tool(
    name="features_overview",
    description=(
        "High-level snapshot across ALL feature workspaces. Use for questions "
        "like 'what features do you know about', 'what's on my plate', "
        "'summarize everything', or 'how are features wired'."
    ),
)
async def features_overview() -> str:
    return _json_ok({
        "catalog": _feature_presence(),
        "settings": _settings_status(),
        "kanban": _kanban_summary_payload(),
        "storage": _storage_summary_payload(),
        "crm": _crm_summary_payload(),
        "project_flow": {
            key: value
            for key, value in _project_flow_summary_payload().items()
            if key not in {"nodes", "edges"}
        },
    })


FEATURE_TOOLS = [
    features_catalog,
    features_overview,
    features_settings_status,
    features_state_get,
    features_storage_summary,
    features_storage_create_folder,
    features_storage_create_category,
    features_storage_create_text_file,
    features_storage_update_file,
    features_storage_delete_file,
    features_kanban_list,
    features_kanban_summary,
    features_kanban_create_card,
    features_kanban_update_card,
    features_kanban_move_card,
    features_crm_list,
    features_crm_find,
    features_crm_create_lead,
    features_crm_update_lead,
    features_crm_add_note,
    features_project_flow_list,
    features_project_flow_set_board,
    features_project_flow_create_node,
    features_project_flow_update_node,
    features_project_flow_delete_node,
    features_project_flow_connect_nodes,
    features_project_flow_delete_edge,
    features_lead_gen_summary,
    features_lead_gen_list_prospects,
    features_lead_gen_create_prospect,
    features_lead_gen_update_prospect,
    features_lead_gen_add_note,
    features_lead_gen_create_campaign,
    features_lead_gen_update_campaign,
    features_lead_gen_attach_prospect_to_campaign,
    features_lead_gen_detach_prospect_from_campaign,
    features_lead_gen_delete_campaign,
    features_video_meeting_update_settings,
    features_video_meeting_start_meeting,
    features_video_meeting_close_meeting,
]


def get_feature_tools() -> list[Any]:
    """Return the feature tools registered on the main agent."""
    return list(FEATURE_TOOLS)
