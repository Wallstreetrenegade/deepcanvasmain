from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from typing import Any

import httpx
import jwt

from . import state as pi_state

logger = logging.getLogger(__name__)

CONFIG_FEATURE = "docuseal_connection"
SUBMISSIONS_FEATURE = "docuseal_submissions"
DEFAULT_API_BASE = "https://api.docuseal.com"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _text(value: Any, limit: int = 4000) -> str:
    return str(value or "").strip()[:limit]


def _load_config() -> dict[str, Any]:
    value = pi_state.load_feature(CONFIG_FEATURE, default={})
    return value if isinstance(value, dict) else {}


def _public_config(config: dict[str, Any] | None = None) -> dict[str, Any]:
    value = config or _load_config()
    token = _text(value.get("apiToken"), 1000) or _text(os.getenv("DOCUSEAL_API_TOKEN"), 1000)
    return {
        "connected": bool(token),
        "apiBase": _text(value.get("apiBase"), 300) or _text(os.getenv("DOCUSEAL_API_BASE"), 300) or DEFAULT_API_BASE,
        "templateId": _text(value.get("templateId"), 80),
        "templateName": _text(value.get("templateName"), 240),
        "hasStoredToken": bool(_text(value.get("apiToken"), 1000)),
    }


def _api_settings() -> tuple[str, str]:
    config = _load_config()
    base = _text(config.get("apiBase"), 300) or _text(os.getenv("DOCUSEAL_API_BASE"), 300) or DEFAULT_API_BASE
    token = _text(config.get("apiToken"), 1000) or _text(os.getenv("DOCUSEAL_API_TOKEN"), 1000)
    if not token:
        raise ValueError("Connect DocuSeal before sending an agreement.")
    if not base.startswith(("https://", "http://")):
        raise ValueError("DocuSeal API URL is invalid.")
    return base.rstrip("/"), token


async def _request(method: str, path: str, *, json_body: dict[str, Any] | None = None) -> Any:
    base, token = _api_settings()
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            response = await client.request(
                method,
                f"{base}{path}",
                headers={"X-Auth-Token": token, "Accept": "application/json"},
                json=json_body,
            )
    except httpx.RequestError as exc:
        raise ValueError("DocuSeal could not be reached. Please try again.") from exc
    if response.status_code >= 400:
        detail = ""
        try:
            payload = response.json()
            detail = _text(payload.get("error") or payload.get("message"), 500) if isinstance(payload, dict) else ""
        except Exception:
            detail = ""
        raise ValueError(detail or f"DocuSeal rejected the request ({response.status_code}).")
    if not response.content:
        return {}
    return response.json()


def _template_items(payload: Any) -> list[dict[str, Any]]:
    rows = payload.get("data", payload) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        return []
    result: list[dict[str, Any]] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        documents = row.get("documents") if isinstance(row.get("documents"), list) else []
        preview = ""
        if documents and isinstance(documents[0], dict):
            preview = _text(documents[0].get("url") or documents[0].get("preview_url"), 1000)
        result.append({
            "id": str(row.get("id") or ""),
            "name": _text(row.get("name") or row.get("title"), 240) or "Untitled agreement",
            "previewUrl": preview,
            "submitters": row.get("submitters") if isinstance(row.get("submitters"), list) else [],
            "fields": row.get("fields") if isinstance(row.get("fields"), list) else [],
        })
    return [item for item in result if item["id"]]


def _choose_agreement_template(items: list[dict[str, Any]], configured_id: str = "") -> dict[str, Any] | None:
    if configured_id:
        selected = next((item for item in items if item["id"] == configured_id), None)
        if selected:
            return selected
    keywords = ("kairos", "agreement", "service agreement")
    return next((item for item in items if any(keyword in item["name"].lower() for keyword in keywords)), items[0] if len(items) == 1 else None)


def _load_submissions() -> list[dict[str, Any]]:
    value = pi_state.load_feature(SUBMISSIONS_FEATURE, default=[])
    return [item for item in value if isinstance(item, dict)] if isinstance(value, list) else []


def _save_submission(item: dict[str, Any]) -> None:
    items = _load_submissions()
    key = _text(item.get("submissionId"), 100)
    items = [existing for existing in items if _text(existing.get("submissionId"), 100) != key]
    items.insert(0, item)
    pi_state.save_feature(SUBMISSIONS_FEATURE, items[:500])


def _submission_summary(payload: Any, fallback: dict[str, Any]) -> dict[str, Any]:
    row = payload if isinstance(payload, dict) else {}
    submitters = row.get("submitters") if isinstance(row.get("submitters"), list) else []
    signer = submitters[0] if submitters and isinstance(submitters[0], dict) else {}
    return {
        **fallback,
        "submissionId": str(row.get("id") or fallback.get("submissionId") or ""),
        "status": _text(row.get("status") or signer.get("status"), 60) or fallback.get("status") or "pending",
        "signingUrl": _text(signer.get("embed_src") or signer.get("url"), 1200),
        "completedAt": _text(row.get("completed_at") or signer.get("completed_at"), 80),
        "updatedAt": _now_iso(),
    }


def register_docuseal_handlers(channel: Any) -> None:
    async def builder_token(ws, req_id, params, session_id):
        raw = params if isinstance(params, dict) else {}
        try:
            _, token = _api_settings()
            email = _text(raw.get("email"), 320).lower()
            name = _text(raw.get("name"), 240)
            lead_id = _text(raw.get("leadId"), 120)
            if not email or "@" not in email:
                raise ValueError("This lead needs a valid email address.")
            admin_email = _text(os.getenv("DOCUSEAL_ADMIN_EMAIL"), 320) or "joshua.bd7@gmail.com"
            template_id_raw = _text(os.getenv("DOCUSEAL_TEMPLATE_ID"), 80) or "5565078"
            try:
                template_id = int(template_id_raw)
            except ValueError as exc:
                raise ValueError("The DocuSeal agreement template is not configured correctly.") from exc
            now = int(time.time())
            payload = {
                "user_email": admin_email,
                "integration_email": email,
                "template_id": template_id,
                "roles": ["First Party"],
                "submitters": [{"email": email, "name": name, "role": "First Party"}],
                "iat": now,
                "exp": now + 3600,
            }
            encoded = jwt.encode(payload, token, algorithm="HS256")
            await channel.send_response(ws, req_id, ok=True, payload={"token": encoded})
        except Exception as exc:
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="BAD_REQUEST")

    async def get_config(ws, req_id, params, session_id):
        await channel.send_response(ws, req_id, ok=True, payload={"config": _public_config()})

    async def save_config(ws, req_id, params, session_id):
        raw = params if isinstance(params, dict) else {}
        current = _load_config()
        token = _text(raw.get("apiToken"), 1000)
        config = {
            "apiBase": _text(raw.get("apiBase"), 300) or current.get("apiBase") or DEFAULT_API_BASE,
            "apiToken": token or current.get("apiToken") or "",
            "templateId": _text(raw.get("templateId"), 80),
            "templateName": _text(raw.get("templateName"), 240),
            "updatedAt": _now_iso(),
        }
        if raw.get("clearToken") is True:
            config["apiToken"] = ""
        pi_state.save_feature(CONFIG_FEATURE, config)
        await channel.send_response(ws, req_id, ok=True, payload={"config": _public_config(config)})

    async def list_templates(ws, req_id, params, session_id):
        try:
            payload = await _request("GET", "/templates?limit=100")
            items = _template_items(payload)
            config = _load_config()
            selected = _choose_agreement_template(items, _text(config.get("templateId"), 80))
            if selected and selected["id"] != _text(config.get("templateId"), 80):
                config.update({"templateId": selected["id"], "templateName": selected["name"], "updatedAt": _now_iso()})
                pi_state.save_feature(CONFIG_FEATURE, config)
            await channel.send_response(ws, req_id, ok=True, payload={"templates": items, "template": selected, "config": _public_config(config)})
        except Exception as exc:
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="BAD_REQUEST")

    async def send_agreement(ws, req_id, params, session_id):
        raw = params if isinstance(params, dict) else {}
        config = _load_config()
        template_id = _text(raw.get("templateId"), 80) or _text(config.get("templateId"), 80)
        email = _text(raw.get("email"), 320).lower()
        name = _text(raw.get("name"), 240)
        if not template_id:
            try:
                templates = _template_items(await _request("GET", "/templates?limit=100"))
                selected = _choose_agreement_template(templates)
                if selected:
                    template_id = selected["id"]
                    config.update({"templateId": selected["id"], "templateName": selected["name"], "updatedAt": _now_iso()})
                    pi_state.save_feature(CONFIG_FEATURE, config)
            except Exception as exc:
                await channel.send_response(ws, req_id, ok=False, error=str(exc), code="BAD_REQUEST")
                return
        if not template_id:
            await channel.send_response(ws, req_id, ok=False, error="The agreement template is not available.", code="BAD_REQUEST")
            return
        if not email or "@" not in email:
            await channel.send_response(ws, req_id, ok=False, error="This lead needs a valid email address.", code="BAD_REQUEST")
            return
        package = raw.get("package") if isinstance(raw.get("package"), dict) else {}
        field_values = {
            "Client Name": name,
            "Full Name": name,
            "Name": name,
            "Email": email,
            "Company": _text(raw.get("company"), 240),
            "Package": _text(package.get("name"), 500),
            "Package Name": _text(package.get("name"), 500),
            "Services": _text(package.get("services"), 4000),
            "Package Details": _text(package.get("services"), 4000),
            "Amount": _text(package.get("amount"), 80),
            "Price": _text(package.get("amount"), 80),
            "Payment Terms": _text(package.get("paymentTerms"), 1000),
            "Agreement Date": _text(package.get("agreementDate"), 80),
        }
        fields = [{"name": key, "default_value": value} for key, value in field_values.items() if value]
        role = _text(raw.get("role"), 120) or "Signer"
        body = {
            "template_id": int(template_id) if template_id.isdigit() else template_id,
            "send_email": True,
            "submitters": [{"role": role, "email": email, "name": name, "fields": fields}],
        }
        try:
            payload = await _request("POST", "/submissions", json_body=body)
            fallback = {
                "leadId": _text(raw.get("leadId"), 120),
                "leadName": name,
                "email": email,
                "templateId": template_id,
                "templateName": _text(raw.get("templateName"), 240) or _text(config.get("templateName"), 240),
                "package": package,
                "status": "pending",
                "sentAt": _now_iso(),
            }
            item = _submission_summary(payload, fallback)
            if not item["submissionId"]:
                raise ValueError("DocuSeal did not return a submission ID.")
            _save_submission(item)
            await channel.send_response(ws, req_id, ok=True, payload={"submission": item})
        except Exception as exc:
            logger.warning("DocuSeal submission failed: %s", exc)
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="BAD_REQUEST")

    async def list_submissions(ws, req_id, params, session_id):
        raw = params if isinstance(params, dict) else {}
        lead_id = _text(raw.get("leadId"), 120)
        items = _load_submissions()
        if lead_id:
            items = [item for item in items if _text(item.get("leadId"), 120) == lead_id]
        await channel.send_response(ws, req_id, ok=True, payload={"submissions": items})

    async def refresh_submission(ws, req_id, params, session_id):
        raw = params if isinstance(params, dict) else {}
        submission_id = _text(raw.get("submissionId"), 100)
        if not submission_id:
            await channel.send_response(ws, req_id, ok=False, error="Submission ID is required.", code="BAD_REQUEST")
            return
        try:
            payload = await _request("GET", f"/submissions/{submission_id}")
            existing = next((item for item in _load_submissions() if _text(item.get("submissionId"), 100) == submission_id), {})
            item = _submission_summary(payload, existing)
            _save_submission(item)
            await channel.send_response(ws, req_id, ok=True, payload={"submission": item})
        except Exception as exc:
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="BAD_REQUEST")

    channel.register_method("docuseal.get_config", get_config)
    channel.register_method("docuseal.builder_token", builder_token)
    channel.register_method("docuseal.save_config", save_config)
    channel.register_method("docuseal.list_templates", list_templates)
    channel.register_method("docuseal.send_agreement", send_agreement)
    channel.register_method("docuseal.list_submissions", list_submissions)
    channel.register_method("docuseal.refresh_submission", refresh_submission)

