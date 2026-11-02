from __future__ import annotations

import pytest

from jiuwenclaw import auth


def test_signup_can_be_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DEEPCANVAS_ALLOW_SIGNUPS", "false")

    with pytest.raises(auth.AuthError) as exc_info:
        auth.signup("blocked@example.com", "password123", "Blocked")

    assert exc_info.value.code == "SIGNUPS_DISABLED"
