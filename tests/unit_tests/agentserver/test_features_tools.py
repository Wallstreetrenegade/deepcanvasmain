# Copyright (c) Huawei Technologies Co., Ltd. 2026. All rights reserved.

"""Focused regression tests for feature-tool exposure and mirror coverage."""

import asyncio
import json

from jiuwenclaw.agentserver.tools import features_tools
from jiuwenclaw.pi_agent import handlers as pi_handlers


def test_feature_tools_export_expected_main_agent_surface():
    tools = features_tools.get_feature_tools()
    names = [tool.card.name for tool in tools]

    assert len(names) == len(set(names))
    assert "features_catalog" in names
    assert "features_overview" in names
    assert "features_state_get" in names
    assert "features_kanban_create_card" in names
    assert "features_crm_create_lead" in names
    assert "features_storage_create_text_file" in names
    assert "features_project_flow_create_node" in names
    assert "features_lead_gen_create_prospect" in names
    assert "features_lead_gen_update_campaign" in names
    assert "features_lead_gen_attach_prospect_to_campaign" in names
    assert "features_video_meeting_start_meeting" in names


def test_pi_state_whitelist_covers_declared_ui_feature_mirrors():
    assert "lead_gen" in pi_handlers._ALLOWED_FEATURES
    assert "video_meeting" in pi_handlers._ALLOWED_FEATURES


def test_feature_catalog_keeps_placeholder_features_visible():
    assert features_tools.FEATURE_CATALOG["lead_gen"]["status"] == "live_state"
    assert features_tools.FEATURE_CATALOG["lead_gen"]["agent_access"] == "read_write"
    assert features_tools.FEATURE_CATALOG["video_meeting"]["status"] == "live_state"
    assert features_tools.FEATURE_CATALOG["video_meeting"]["agent_access"] == "read_write"


def test_feature_catalog_marks_true_read_write_workspaces():
    assert features_tools.FEATURE_CATALOG["kanban"]["agent_access"] == "read_write"
    assert features_tools.FEATURE_CATALOG["crm"]["agent_access"] == "read_write"
    assert features_tools.FEATURE_CATALOG["storage"]["agent_access"] == "read_write"
    assert features_tools.FEATURE_CATALOG["project_flow"]["agent_access"] == "read_write"
    assert features_tools.FEATURE_CATALOG["video_meeting"]["agent_access"] == "read_write"


def test_lead_gen_tool_mutations_round_trip(monkeypatch):
    state = {
        "lead_gen": {"prospects": [{"id": "prospect_1", "name": "Taylor", "notes": [], "score": 80}], "campaigns": []},
    }

    def fake_load(feature, default=None):
        return state.get(feature, default)

    def fake_save(feature, snapshot):
        state[feature] = snapshot

    monkeypatch.setattr(features_tools.pi_state, "load_feature", fake_load)
    monkeypatch.setattr(features_tools.pi_state, "save_feature", fake_save)

    campaign_result = json.loads(asyncio.run(features_tools.features_lead_gen_create_campaign._func("Q3 outbound")))
    assert campaign_result["ok"] is True
    campaign_id = campaign_result["campaign"]["id"]

    attach_result = json.loads(asyncio.run(features_tools.features_lead_gen_attach_prospect_to_campaign._func(campaign_id, "prospect_1")))
    assert attach_result["ok"] is True
    assert "prospect_1" in state["lead_gen"]["campaigns"][0]["leadIds"]

    detach_result = json.loads(asyncio.run(features_tools.features_lead_gen_detach_prospect_from_campaign._func(campaign_id, "prospect_1")))
    assert detach_result["ok"] is True
    assert "prospect_1" not in state["lead_gen"]["campaigns"][0]["leadIds"]
