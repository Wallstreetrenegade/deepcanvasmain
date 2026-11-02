# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""RPC handlers for silent frontend->backend feature state mirroring.

The frontend feature stores (Kanban, CRM, and Project Flow)
subscribe to their own mutations and quietly call ``pi.state.sync`` to
push the latest snapshot to the backend. The main Jiuween agent's
feature tools then read those mirrored snapshots when the user asks
about their tasks/leads/workflow/posts - no visible UI, no buttons.

This file intentionally contains only the silent-mirror RPCs. The
agent-facing tools live in ``jiuwenclaw.agentserver.tools.features_tools``
and are registered on the DeepAgent via the standard toolkit path.
"""

from __future__ import annotations

import logging
from typing import Any

from jiuwenclaw.pi_agent import state as pi_state

logger = logging.getLogger(__name__)


_ALLOWED_FEATURES = frozenset({
    "kanban",
    "crm",
    "project_flow",
    "lead_gen",
    "storage",
    "video_meeting",
})


def register_pi_handlers(channel: Any) -> None:
    """Register ``pi.state.*`` RPC methods on the given web channel."""

    async def _pi_state_get(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            if not isinstance(params, dict):
                await channel.send_response(ws, req_id, ok=False, error="params must be object", code="BAD_REQUEST")
                return
            feature = str(params.get("feature") or "").strip()
            if feature not in _ALLOWED_FEATURES:
                await channel.send_response(ws, req_id, ok=False, error=f"unknown feature: {feature!r}", code="BAD_REQUEST")
                return
            data = pi_state.load_feature(feature)
            await channel.send_response(ws, req_id, ok=True, payload={"feature": feature, "data": data})
        except Exception as exc:  # noqa: BLE001
            logger.exception("[pi.state.get] %s", exc)
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="INTERNAL_ERROR")

    async def _pi_state_sync(ws, req_id, params, session_id):  # noqa: ANN001
        """Persist a frontend feature snapshot. Called silently on every store change."""
        try:
            if not isinstance(params, dict):
                await channel.send_response(ws, req_id, ok=False, error="params must be object", code="BAD_REQUEST")
                return
            feature = str(params.get("feature") or "").strip()
            if feature not in _ALLOWED_FEATURES:
                await channel.send_response(ws, req_id, ok=False, error=f"unknown feature: {feature!r}", code="BAD_REQUEST")
                return
            data = params.get("data")
            pi_state.save_feature(feature, data)
            await channel.send_response(ws, req_id, ok=True, payload={"feature": feature, "ok": True})
        except Exception as exc:  # noqa: BLE001
            logger.exception("[pi.state.sync] %s", exc)
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="INTERNAL_ERROR")

    async def _crm_delete(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        try:
            if not isinstance(params, dict) or not isinstance(params.get("leadIds"), list):
                await channel.send_response(ws, req_id, ok=False, error="leadIds must be an array", code="BAD_REQUEST")
                return
            deleted_at = str(params.get("deletedAt") or "").strip()
            if not deleted_at:
                await channel.send_response(ws, req_id, ok=False, error="deletedAt is required", code="BAD_REQUEST")
                return
            deleted = pi_state.delete_crm_leads(params["leadIds"], deleted_at)
            await channel.send_response(ws, req_id, ok=True, payload={"deletedCount": deleted})
        except Exception as exc:  # noqa: BLE001
            logger.exception("[pi.state.crm.delete] %s", exc)
            await channel.send_response(ws, req_id, ok=False, error=str(exc), code="INTERNAL_ERROR")

    channel.register_method("pi.state.get", _pi_state_get)
    channel.register_method("pi.state.sync", _pi_state_sync)
    channel.register_method("pi.state.crm.delete", _crm_delete)

    logger.info("[pi_agent] registered pi.state.* RPC methods")
