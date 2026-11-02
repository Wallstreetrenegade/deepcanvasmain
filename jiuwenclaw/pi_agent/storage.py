# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Storage feature backend: disk-backed files, folders, categories, and drive auth.

Files are persisted under the user's Jiuwen workspace and metadata is mirrored
through ``pi_agent.state`` so the main agent can inspect the user's storage
without receiving raw file bytes or OAuth tokens.
"""

from __future__ import annotations

import base64
import datetime as _dt
import logging
import mimetypes
import os
import re
import uuid
from pathlib import Path
from typing import Any, Optional

import httpx

from jiuwenclaw.auth import get_current_user_data_dir

from . import state as pi_state

FEATURE = "storage"
logger = logging.getLogger(__name__)

_DATA_URL_RE = re.compile(r"^data:([^;]+);base64,(.*)$", re.DOTALL)
_ROOT_FOLDER_ID = "root"
_ROOT_FOLDER_NAME = "MAIN"


def _now_iso() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")


def _storage_dir() -> Path:
    base = get_current_user_data_dir() / "storage"
    (base / "files").mkdir(parents=True, exist_ok=True)
    (base / "thumbnails").mkdir(parents=True, exist_ok=True)
    return base


def _default_categories() -> list[dict[str, Any]]:
    now = _now_iso()
    return [
        {"id": "images", "name": "Images", "kind": "system", "createdAt": now, "updatedAt": now},
        {"id": "videos", "name": "Videos", "kind": "system", "createdAt": now, "updatedAt": now},
        {"id": "documents", "name": "Documents", "kind": "system", "createdAt": now, "updatedAt": now},
        {"id": "other", "name": "Other", "kind": "system", "createdAt": now, "updatedAt": now},
    ]


def _default_state() -> dict[str, Any]:
    now = _now_iso()
    return {
        "files": [],
        "folders": [
            {"id": _ROOT_FOLDER_ID, "name": _ROOT_FOLDER_NAME, "parentId": None, "createdAt": now, "updatedAt": now},
        ],
        "categories": _default_categories(),
        "providers": {
            "googleDrive": {"status": "not_configured", "clientId": "", "lastError": None, "updatedAt": now},
            "oneDrive": {"status": "not_configured", "clientId": "", "lastError": None, "updatedAt": now},
        },
        "providerSecrets": {},
        "updatedAt": now,
    }


def _normalize_state(raw: Any) -> dict[str, Any]:
    base = _default_state()
    if not isinstance(raw, dict):
        return base
    files = raw.get("files") if isinstance(raw.get("files"), list) else []
    folders = raw.get("folders") if isinstance(raw.get("folders"), list) else []
    categories = raw.get("categories") if isinstance(raw.get("categories"), list) else []
    providers = raw.get("providers") if isinstance(raw.get("providers"), dict) else {}
    provider_secrets = raw.get("providerSecrets") if isinstance(raw.get("providerSecrets"), dict) else {}
    base["files"] = [f for f in files if isinstance(f, dict)]
    if folders:
        base["folders"] = [f for f in folders if isinstance(f, dict)]
    if not any(f.get("id") == _ROOT_FOLDER_ID for f in base["folders"]):
        base["folders"].insert(0, _default_state()["folders"][0])
    for folder in base["folders"]:
        if folder.get("id") == _ROOT_FOLDER_ID:
            folder["name"] = _ROOT_FOLDER_NAME
            folder["parentId"] = None
            break
    if categories:
        base["categories"] = [c for c in categories if isinstance(c, dict)]
    present_category_ids = {str(c.get("id")) for c in base["categories"]}
    for cat in _default_categories():
        if cat["id"] not in present_category_ids:
            base["categories"].append(cat)
    for key in ("googleDrive", "oneDrive"):
        if isinstance(providers.get(key), dict):
            base["providers"][key].update(providers[key])
    base["providerSecrets"] = provider_secrets
    base["updatedAt"] = raw.get("updatedAt") or base["updatedAt"]
    return base


def _load_state() -> dict[str, Any]:
    return _normalize_state(pi_state.load_feature(FEATURE, default=None))


def _public_state(state: dict[str, Any]) -> dict[str, Any]:
    out = {k: v for k, v in state.items() if k != "providerSecrets"}
    out["files"] = [
        {k: v for k, v in item.items() if k not in {"diskPath", "thumbnailPath"}}
        for item in state.get("files", [])
        if isinstance(item, dict)
    ]
    providers = {}
    for key, provider in (state.get("providers") or {}).items():
        if isinstance(provider, dict):
            providers[key] = {k: v for k, v in provider.items() if k not in {"deviceCode"}}
    out["providers"] = providers
    return out


def _save_state(state: dict[str, Any]) -> dict[str, Any]:
    state["updatedAt"] = _now_iso()
    pi_state.save_feature(FEATURE, state)
    return state


def _safe_name(name: str) -> str:
    text = (name or "").strip().replace("\x00", "")
    return text[:180] or "untitled"


def _extension(name: str, mime_type: str) -> str:
    suffix = Path(name).suffix.lower()
    if suffix:
        return suffix[:16]
    guessed = mimetypes.guess_extension(mime_type or "") or ""
    return guessed[:16]


def _kind(mime_type: str, name: str) -> str:
    lowered = (mime_type or "").lower()
    if lowered.startswith("image/"):
        return "image"
    if lowered.startswith("video/"):
        return "video"
    if lowered.startswith("audio/"):
        return "audio"
    if lowered.startswith("text/") or lowered in {
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    }:
        return "document"
    lower_name = name.lower()
    if lower_name.endswith((".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".txt", ".csv", ".md")):
        return "document"
    return "other"


def _default_category(kind: str) -> str:
    if kind == "image":
        return "images"
    if kind == "video":
        return "videos"
    if kind == "document":
        return "documents"
    return "other"


def _decode_data_url(data_url: str) -> tuple[str, bytes]:
    match = _DATA_URL_RE.match(data_url or "")
    if not match:
        raise ValueError("file content must be a base64 data URL")
    return match.group(1), base64.b64decode(match.group(2))


def _decode_optional_data_url(data_url: str) -> tuple[str, bytes] | None:
    if not data_url:
        return None
    match = _DATA_URL_RE.match(data_url)
    if not match:
        return None
    return match.group(1), base64.b64decode(match.group(2))


def _folder_exists(state: dict[str, Any], folder_id: str) -> bool:
    return any(f.get("id") == folder_id for f in state.get("folders", []))


def _category_exists(state: dict[str, Any], category_id: str) -> bool:
    return any(c.get("id") == category_id for c in state.get("categories", []))


def _descendant_folder_ids(state: dict[str, Any], folder_id: str) -> set[str]:
    out = {folder_id}
    changed = True
    while changed:
        changed = False
        for folder in state.get("folders", []):
            fid = str(folder.get("id") or "")
            parent_id = str(folder.get("parentId") or "")
            if parent_id in out and fid not in out:
                out.add(fid)
                changed = True
    return out


def _delete_physical_file(file_meta: dict[str, Any]) -> None:
    for key in ("diskPath", "thumbnailPath"):
        value = file_meta.get(key)
        if value:
            try:
                Path(value).unlink(missing_ok=True)
            except OSError:
                pass


def _provider_config(state: dict[str, Any], provider: str) -> dict[str, Any]:
    if provider not in {"googleDrive", "oneDrive"}:
        raise ValueError("provider must be googleDrive or oneDrive")
    return state.setdefault("providers", {}).setdefault(provider, {})


def _provider_scopes(provider: str) -> str:
    if provider == "googleDrive":
        return "https://www.googleapis.com/auth/drive.file"
    return "Files.ReadWrite offline_access User.Read"


async def _start_device_flow(provider: str, client_id: str) -> dict[str, Any]:
    if provider == "googleDrive":
        url = "https://oauth2.googleapis.com/device/code"
        data = {"client_id": client_id, "scope": _provider_scopes(provider)}
    else:
        url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode"
        data = {"client_id": client_id, "scope": _provider_scopes(provider)}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, data=data)
    payload = resp.json()
    if resp.status_code >= 400:
        raise RuntimeError(payload.get("error_description") or payload.get("error") or resp.text[:300])
    return payload


async def _poll_device_flow(provider: str, client_id: str, device_code: str) -> dict[str, Any]:
    grant = "urn:ietf:params:oauth:grant-type:device_code"
    if provider == "googleDrive":
        url = "https://oauth2.googleapis.com/token"
        data = {"client_id": client_id, "device_code": device_code, "grant_type": grant}
    else:
        url = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token"
        data = {"client_id": client_id, "device_code": device_code, "grant_type": grant}
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(url, data=data)
    payload = resp.json()
    if resp.status_code >= 400:
        code = payload.get("error") or "oauth_error"
        if code in {"authorization_pending", "slow_down"}:
            return {"pending": True, "error": code, "message": payload.get("error_description") or code}
        raise RuntimeError(payload.get("error_description") or code)
    return payload


def register_storage_handlers(channel: Any) -> None:  # noqa: C901
    async def _reply(ws, req_id, state: dict[str, Any], *, extra: Optional[dict] = None) -> None:
        payload: dict[str, Any] = {"state": _public_state(state)}
        if extra:
            payload.update(extra)
        await channel.send_response(ws, req_id, ok=True, payload=payload)

    async def _fail(ws, req_id, message: str, code: str = "BAD_REQUEST") -> None:
        await channel.send_response(ws, req_id, ok=False, error=message, code=code)

    def _p(params: Any) -> dict[str, Any]:
        return params if isinstance(params, dict) else {}

    async def _get_state(ws, req_id, params, session_id):
        await _reply(ws, req_id, _save_state(_load_state()))

    async def _create_folder(ws, req_id, params, session_id):
        p = _p(params)
        name = _safe_name(str(p.get("name") or "New folder"))
        parent_id = str(p.get("parentId") or _ROOT_FOLDER_ID)
        state = _load_state()
        if not _folder_exists(state, parent_id):
            return await _fail(ws, req_id, "parent folder not found", "NOT_FOUND")
        folder = {"id": uuid.uuid4().hex[:12], "name": name, "parentId": parent_id, "createdAt": _now_iso(), "updatedAt": _now_iso()}
        state["folders"].append(folder)
        await _reply(ws, req_id, _save_state(state), extra={"folderId": folder["id"]})

    async def _update_folder(ws, req_id, params, session_id):
        p = _p(params)
        folder_id = str(p.get("folderId") or "")
        patch = p.get("patch") if isinstance(p.get("patch"), dict) else {}
        if folder_id == _ROOT_FOLDER_ID:
            return await _fail(ws, req_id, "root folder cannot be changed")
        state = _load_state()
        for folder in state["folders"]:
            if folder.get("id") == folder_id:
                if "name" in patch:
                    folder["name"] = _safe_name(str(patch["name"]))
                if "parentId" in patch and _folder_exists(state, str(patch["parentId"])):
                    folder["parentId"] = str(patch["parentId"])
                folder["updatedAt"] = _now_iso()
                return await _reply(ws, req_id, _save_state(state))
        await _fail(ws, req_id, "folder not found", "NOT_FOUND")

    async def _delete_folder(ws, req_id, params, session_id):
        p = _p(params)
        folder_id = str(p.get("folderId") or "")
        if folder_id == _ROOT_FOLDER_ID:
            return await _fail(ws, req_id, "root folder cannot be deleted")
        state = _load_state()
        ids = _descendant_folder_ids(state, folder_id)
        if folder_id not in ids or not any(f.get("id") == folder_id for f in state["folders"]):
            return await _fail(ws, req_id, "folder not found", "NOT_FOUND")
        removed_files = [f for f in state["files"] if f.get("folderId") in ids]
        for file_meta in removed_files:
            _delete_physical_file(file_meta)
        state["files"] = [f for f in state["files"] if f.get("folderId") not in ids]
        state["folders"] = [f for f in state["folders"] if f.get("id") not in ids]
        await _reply(ws, req_id, _save_state(state))

    async def _create_category(ws, req_id, params, session_id):
        p = _p(params)
        name = _safe_name(str(p.get("name") or "New category"))
        state = _load_state()
        category = {"id": uuid.uuid4().hex[:12], "name": name, "kind": "custom", "createdAt": _now_iso(), "updatedAt": _now_iso()}
        state["categories"].append(category)
        await _reply(ws, req_id, _save_state(state), extra={"categoryId": category["id"]})

    async def _delete_category(ws, req_id, params, session_id):
        p = _p(params)
        category_id = str(p.get("categoryId") or "")
        state = _load_state()
        category = next((c for c in state["categories"] if c.get("id") == category_id), None)
        if not category:
            return await _fail(ws, req_id, "category not found", "NOT_FOUND")
        if category.get("kind") == "system":
            return await _fail(ws, req_id, "system categories cannot be deleted")
        state["categories"] = [c for c in state["categories"] if c.get("id") != category_id]
        for file_meta in state["files"]:
            if file_meta.get("categoryId") == category_id:
                file_meta["categoryId"] = _default_category(file_meta.get("kind") or "other")
        await _reply(ws, req_id, _save_state(state))

    async def _upload_file(ws, req_id, params, session_id):
        p = _p(params)
        raw_file = p.get("file") if isinstance(p.get("file"), dict) else {}
        name = _safe_name(str(raw_file.get("name") or "upload"))
        content = str(raw_file.get("dataUrl") or "")
        try:
            mime_type, raw = _decode_data_url(content)
        except (ValueError, base64.binascii.Error) as exc:
            return await _fail(ws, req_id, str(exc))
        mime_type = str(raw_file.get("mimeType") or mime_type or mimetypes.guess_type(name)[0] or "application/octet-stream")
        kind = _kind(mime_type, name)
        state = _load_state()
        folder_id = str(raw_file.get("folderId") or p.get("folderId") or _ROOT_FOLDER_ID)
        if not _folder_exists(state, folder_id):
            return await _fail(ws, req_id, "folder not found", "NOT_FOUND")
        category_id = str(raw_file.get("categoryId") or p.get("categoryId") or _default_category(kind))
        if not _category_exists(state, category_id):
            category_id = _default_category(kind)
        file_id = uuid.uuid4().hex
        ext = _extension(name, mime_type)
        disk_path = _storage_dir() / "files" / f"{file_id}{ext}"
        disk_path.write_bytes(raw)
        thumb_path = ""
        thumb = _decode_optional_data_url(str(raw_file.get("thumbnailDataUrl") or ""))
        if thumb:
            thumb_mime, thumb_raw = thumb
            thumb_ext = _extension("thumbnail.jpg", thumb_mime) or ".jpg"
            thumb_file = _storage_dir() / "thumbnails" / f"{file_id}{thumb_ext}"
            thumb_file.write_bytes(thumb_raw)
            thumb_path = str(thumb_file)
        item = {
            "id": file_id,
            "name": name,
            "mimeType": mime_type,
            "kind": kind,
            "sizeBytes": len(raw),
            "extension": ext,
            "folderId": folder_id,
            "categoryId": category_id,
            "diskPath": str(disk_path),
            "thumbnailPath": thumb_path,
            "thumbnailDataUrl": raw_file.get("thumbnailDataUrl") or "",
            "notes": str(raw_file.get("notes") or ""),
            "createdAt": _now_iso(),
            "updatedAt": _now_iso(),
        }
        state["files"].insert(0, item)
        await _reply(ws, req_id, _save_state(state), extra={"fileId": file_id})

    async def _update_file(ws, req_id, params, session_id):
        p = _p(params)
        file_id = str(p.get("fileId") or "")
        patch = p.get("patch") if isinstance(p.get("patch"), dict) else {}
        state = _load_state()
        for file_meta in state["files"]:
            if file_meta.get("id") == file_id:
                if "name" in patch:
                    file_meta["name"] = _safe_name(str(patch["name"]))
                if "folderId" in patch and _folder_exists(state, str(patch["folderId"])):
                    file_meta["folderId"] = str(patch["folderId"])
                if "categoryId" in patch and _category_exists(state, str(patch["categoryId"])):
                    file_meta["categoryId"] = str(patch["categoryId"])
                if "notes" in patch:
                    file_meta["notes"] = str(patch["notes"] or "")
                file_meta["updatedAt"] = _now_iso()
                return await _reply(ws, req_id, _save_state(state))
        await _fail(ws, req_id, "file not found", "NOT_FOUND")

    async def _delete_file(ws, req_id, params, session_id):
        p = _p(params)
        file_id = str(p.get("fileId") or "")
        state = _load_state()
        found = next((f for f in state["files"] if f.get("id") == file_id), None)
        if not found:
            return await _fail(ws, req_id, "file not found", "NOT_FOUND")
        _delete_physical_file(found)
        state["files"] = [f for f in state["files"] if f.get("id") != file_id]
        await _reply(ws, req_id, _save_state(state))

    async def _get_file_blob(ws, req_id, params, session_id):
        p = _p(params)
        file_id = str(p.get("fileId") or "")
        state = _load_state()
        found = next((f for f in state["files"] if f.get("id") == file_id), None)
        if not found:
            return await _fail(ws, req_id, "file not found", "NOT_FOUND")
        try:
            raw = Path(found["diskPath"]).read_bytes()
        except OSError:
            return await _fail(ws, req_id, "stored file missing on disk", "NOT_FOUND")
        data_url = f"data:{found.get('mimeType') or 'application/octet-stream'};base64,{base64.b64encode(raw).decode('ascii')}"
        await _reply(ws, req_id, state, extra={"file": {"id": file_id, "name": found.get("name"), "mimeType": found.get("mimeType"), "dataUrl": data_url}})

    async def _save_provider_settings(ws, req_id, params, session_id):
        p = _p(params)
        provider_key = str(p.get("provider") or "")
        state = _load_state()
        try:
            provider = _provider_config(state, provider_key)
        except ValueError as exc:
            return await _fail(ws, req_id, str(exc))
        client_id = str(p.get("clientId") or "").strip()
        provider["clientId"] = client_id
        provider["status"] = "ready_to_connect" if client_id else "not_configured"
        provider["lastError"] = None
        provider["updatedAt"] = _now_iso()
        await _reply(ws, req_id, _save_state(state))

    async def _start_drive_connect(ws, req_id, params, session_id):
        p = _p(params)
        provider_key = str(p.get("provider") or "")
        state = _load_state()
        try:
            provider = _provider_config(state, provider_key)
        except ValueError as exc:
            return await _fail(ws, req_id, str(exc))
        client_id = str(provider.get("clientId") or "").strip()
        if not client_id:
            return await _fail(ws, req_id, "client id is required before connecting")
        try:
            payload = await _start_device_flow(provider_key, client_id)
        except Exception as exc:  # noqa: BLE001
            provider["status"] = "error"
            provider["lastError"] = str(exc)
            return await _reply(ws, req_id, _save_state(state))
        provider.update({
            "status": "pending",
            "deviceCode": payload.get("device_code"),
            "userCode": payload.get("user_code"),
            "verificationUri": payload.get("verification_uri") or payload.get("verification_url"),
            "verificationUriComplete": payload.get("verification_uri_complete"),
            "expiresAt": (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=int(payload.get("expires_in") or 900))).isoformat(timespec="seconds"),
            "intervalSec": int(payload.get("interval") or 5),
            "lastError": None,
            "updatedAt": _now_iso(),
        })
        await _reply(ws, req_id, _save_state(state))

    async def _poll_drive_connect(ws, req_id, params, session_id):
        p = _p(params)
        provider_key = str(p.get("provider") or "")
        state = _load_state()
        try:
            provider = _provider_config(state, provider_key)
        except ValueError as exc:
            return await _fail(ws, req_id, str(exc))
        client_id = str(provider.get("clientId") or "").strip()
        device_code = str(provider.get("deviceCode") or "")
        if not (client_id and device_code):
            return await _fail(ws, req_id, "no pending connection for this provider")
        try:
            token_payload = await _poll_device_flow(provider_key, client_id, device_code)
        except Exception as exc:  # noqa: BLE001
            provider["status"] = "error"
            provider["lastError"] = str(exc)
            return await _reply(ws, req_id, _save_state(state))
        if token_payload.get("pending"):
            provider["status"] = "pending"
            provider["lastError"] = token_payload.get("message")
            provider["updatedAt"] = _now_iso()
            return await _reply(ws, req_id, _save_state(state), extra={"pending": True})
        state.setdefault("providerSecrets", {})[provider_key] = {
            "accessToken": token_payload.get("access_token"),
            "refreshToken": token_payload.get("refresh_token"),
            "tokenType": token_payload.get("token_type"),
            "scope": token_payload.get("scope"),
            "expiresAt": (_dt.datetime.now(_dt.timezone.utc) + _dt.timedelta(seconds=int(token_payload.get("expires_in") or 3600))).isoformat(timespec="seconds"),
        }
        provider.update({"status": "connected", "lastError": None, "connectedAt": _now_iso(), "updatedAt": _now_iso()})
        provider.pop("deviceCode", None)
        await _reply(ws, req_id, _save_state(state), extra={"connected": True})

    async def _disconnect_provider(ws, req_id, params, session_id):
        p = _p(params)
        provider_key = str(p.get("provider") or "")
        state = _load_state()
        try:
            provider = _provider_config(state, provider_key)
        except ValueError as exc:
            return await _fail(ws, req_id, str(exc))
        state.setdefault("providerSecrets", {}).pop(provider_key, None)
        provider.update({"status": "ready_to_connect" if provider.get("clientId") else "not_configured", "lastError": None, "connectedAt": None, "updatedAt": _now_iso()})
        provider.pop("deviceCode", None)
        await _reply(ws, req_id, _save_state(state))

    methods = {
        "storage.get_state": _get_state,
        "storage.create_folder": _create_folder,
        "storage.update_folder": _update_folder,
        "storage.delete_folder": _delete_folder,
        "storage.create_category": _create_category,
        "storage.delete_category": _delete_category,
        "storage.upload_file": _upload_file,
        "storage.update_file": _update_file,
        "storage.delete_file": _delete_file,
        "storage.get_file_blob": _get_file_blob,
        "storage.save_provider_settings": _save_provider_settings,
        "storage.start_drive_connect": _start_drive_connect,
        "storage.poll_drive_connect": _poll_drive_connect,
        "storage.disconnect_provider": _disconnect_provider,
    }
    for name, fn in methods.items():
        channel.register_method(name, fn)
    logger.info("[storage] registered %d RPC methods", len(methods))