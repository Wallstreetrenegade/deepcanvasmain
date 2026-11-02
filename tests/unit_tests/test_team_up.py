from pathlib import Path

import pytest

from jiuwenclaw import auth, team_up
from jiuwenclaw.pi_agent import state as pi_state


def _use_workspace(monkeypatch, root: Path) -> None:
    monkeypatch.setattr(auth, "get_user_workspace_dir", lambda: root)
    monkeypatch.setattr(team_up, "get_user_workspace_dir", lambda: root)


def test_team_invite_shares_selected_feature_only(monkeypatch, tmp_path):
    _use_workspace(monkeypatch, tmp_path)
    owner_session = auth.signup("owner@example.com", "password123", "Owner")
    member_session = auth.signup("member@example.com", "password123", "Member")

    owner_token = auth.set_current_user(owner_session["user"])
    try:
        pi_state.save_feature("crm", {"leads": [{"name": "Shared lead"}]})
        pi_state.save_feature("kanban", {"cards": [{"title": "Private task"}]})
        invite = team_up.create_invite("member@example.com", ["crm"])
        assert team_up.shared_feature_dir("crm") is None
        assert team_up.shared_feature_dir("kanban") is None
        assert pi_state.load_feature("crm")["leads"][0]["name"] == "Shared lead"
    finally:
        auth.reset_current_user(owner_token)

    member_token = auth.set_current_user(member_session["user"])
    try:
        assert team_up.shared_feature_dir("crm") is None
        team_up.respond_to_invite(invite["inviteId"], True)
        assert pi_state.load_feature("crm")["leads"][0]["name"] == "Shared lead"
        pi_state.save_feature("crm", {"leads": [{"name": "Member update"}]})
        pi_state.save_feature("kanban", {"cards": [{"title": "Member private"}]})
    finally:
        auth.reset_current_user(member_token)

    owner_token = auth.set_current_user(owner_session["user"])
    try:
        assert pi_state.load_feature("crm")["leads"][0]["name"] == "Member update"
        assert pi_state.load_feature("kanban")["cards"][0]["title"] == "Private task"
    finally:
        auth.reset_current_user(owner_token)


def test_team_chat_requires_membership(monkeypatch, tmp_path):
    _use_workspace(monkeypatch, tmp_path)
    owner = auth.signup("owner@example.com", "password123", "Owner")["user"]
    member = auth.signup("member@example.com", "password123", "Member")["user"]
    owner_token = auth.set_current_user(owner)
    try:
        invite = team_up.create_invite("member@example.com", ["crm"])
        first = team_up.send_message(invite["teamId"], "Ready when you are")
        assert first["body"] == "Ready when you are"
    finally:
        auth.reset_current_user(owner_token)

    member_token = auth.set_current_user(member)
    try:
        team_up.respond_to_invite(invite["inviteId"], True)
        team_up.send_message(invite["teamId"], "I am in")
        messages = team_up.list_messages(invite["teamId"])["messages"]
        assert [message["body"] for message in messages] == ["Ready when you are", "I am in"]
    finally:
        auth.reset_current_user(member_token)


def test_declined_invite_releases_feature_for_another_invite(monkeypatch, tmp_path):
    _use_workspace(monkeypatch, tmp_path)
    owner = auth.signup("owner@example.com", "password123", "Owner")["user"]
    first_member = auth.signup("first@example.com", "password123", "First")["user"]
    auth.signup("second@example.com", "password123", "Second")

    owner_token = auth.set_current_user(owner)
    try:
        invite = team_up.create_invite("first@example.com", ["crm"])
    finally:
        auth.reset_current_user(owner_token)

    member_token = auth.set_current_user(first_member)
    try:
        team_up.respond_to_invite(invite["inviteId"], False)
    finally:
        auth.reset_current_user(member_token)

    owner_token = auth.set_current_user(owner)
    try:
        replacement = team_up.create_invite("second@example.com", ["crm"])
        assert replacement["features"] == ["crm"]
    finally:
        auth.reset_current_user(owner_token)


def test_team_and_private_chat_mutations_are_authorized(monkeypatch, tmp_path):
    _use_workspace(monkeypatch, tmp_path)
    owner = auth.signup("owner@example.com", "password123", "Owner")["user"]
    member = auth.signup("member@example.com", "password123", "Member")["user"]

    owner_token = auth.set_current_user(owner)
    try:
        invite = team_up.create_invite("member@example.com", ["crm"])
    finally:
        auth.reset_current_user(owner_token)

    member_token = auth.set_current_user(member)
    try:
        team_up.respond_to_invite(invite["inviteId"], True)
    finally:
        auth.reset_current_user(member_token)

    owner_token = auth.set_current_user(owner)
    try:
        team_message = team_up.send_message(invite["teamId"], "team original")
        direct_message = team_up.send_direct_message(member["id"], "private original")
        team_up.update_message(invite["teamId"], team_message["id"], "team edited")
        team_up.update_direct_message(member["id"], direct_message["id"], "private edited")
    finally:
        auth.reset_current_user(owner_token)

    member_token = auth.set_current_user(member)
    try:
        with pytest.raises(auth.AuthError):
            team_up.delete_message(invite["teamId"], team_message["id"])
        with pytest.raises(auth.AuthError):
            team_up.delete_direct_message(owner["id"], direct_message["id"])
        assert team_up.list_messages(invite["teamId"])["messages"][0]["body"] == "team edited"
        assert team_up.list_direct_messages(owner["id"])["messages"][0]["body"] == "private edited"
        assert team_up.clear_messages(invite["teamId"])["deletedCount"] == 1
        assert team_up.clear_direct_messages(owner["id"])["deletedCount"] == 1
        assert team_up.list_messages(invite["teamId"])["messages"] == []
        assert team_up.list_direct_messages(owner["id"])["messages"] == []
    finally:
        auth.reset_current_user(member_token)

