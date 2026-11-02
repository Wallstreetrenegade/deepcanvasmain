"""Per-user Google Calendar OAuth and event synchronization."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from jiuwenclaw import auth

_SCOPE = "https://www.googleapis.com/auth/calendar.events"


def _config() -> dict[str, str]:
    return {
        "client_id": os.getenv("GOOGLE_CALENDAR_CLIENT_ID", "").strip(),
        "client_secret": os.getenv("GOOGLE_CALENDAR_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.getenv("GOOGLE_CALENDAR_REDIRECT_URI", "").strip(),
        "encryption_key": os.getenv("GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY", "").strip(),
    }


def _require_config() -> dict[str, str]:
    config = _config()
    if not all(config.values()):
        raise auth.AuthError("Google Calendar is not configured yet.", "GOOGLE_CALENDAR_NOT_CONFIGURED")
    return config


def _cipher():  # noqa: ANN202
    from cryptography.fernet import Fernet
    raw = _require_config()["encryption_key"].encode()
    return Fernet(base64.urlsafe_b64encode(hashlib.sha256(raw).digest()))


def _encrypt(value: str) -> str:
    return _cipher().encrypt(value.encode()).decode()


def _decrypt(value: str) -> str:
    return _cipher().decrypt(value.encode()).decode()


def _schema(con) -> None:  # noqa: ANN001
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS google_calendar_connections (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            email TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS google_calendar_oauth_states (
            state TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            expires_at INTEGER NOT NULL
        );
        """
    )
    con.commit()


def _request(url: str, *, token: str = "", data: dict[str, Any] | None = None,
             method: str | None = None) -> dict[str, Any]:
    body = urllib.parse.urlencode(data).encode() if data is not None else None
    headers = {"Accept": "application/json", "User-Agent": "DeepCanvas/1.0"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=25) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise auth.AuthError(f"Google Calendar request failed: {detail[:300]}", "GOOGLE_CALENDAR_ERROR") from exc


def _json_request(url: str, token: str, payload: dict[str, Any], method: str = "POST") -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=25) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode(errors="replace")
        raise auth.AuthError(f"Google Calendar request failed: {detail[:300]}", "GOOGLE_CALENDAR_ERROR") from exc


def connection_state() -> dict[str, Any]:
    user = auth.require_current_user()
    with auth._connection() as con:  # noqa: SLF001
        _schema(con)
        row = con.execute("SELECT email FROM google_calendar_connections WHERE user_id=?", (user["id"],)).fetchone()
    return {"configured": all(_config().values()), "connected": bool(row), "email": row["email"] if row else ""}


def create_authorization() -> dict[str, str]:
    user = auth.require_current_user()
    config = _require_config()
    state = secrets.token_urlsafe(32)
    now = int(time.time())
    with auth._connection() as con:  # noqa: SLF001
        _schema(con)
        con.execute("DELETE FROM google_calendar_oauth_states WHERE expires_at < ? OR user_id=?", (now, user["id"]))
        con.execute("INSERT INTO google_calendar_oauth_states(state,user_id,expires_at) VALUES(?,?,?)", (state, user["id"], now + 600))
        con.commit()
    query = urllib.parse.urlencode({
        "client_id": config["client_id"], "redirect_uri": config["redirect_uri"],
        "response_type": "code", "scope": _SCOPE, "access_type": "offline",
        "prompt": "consent", "include_granted_scopes": "true", "state": state,
    })
    return {"authorizationUrl": f"https://accounts.google.com/o/oauth2/v2/auth?{query}"}


def complete_authorization(query: dict[str, list[str]]) -> tuple[bool, str]:
    state = (query.get("state") or [""])[0]
    code = (query.get("code") or [""])[0]
    if not state or not code:
        return False, "Missing Google authorization response."
    config = _require_config()
    now = int(time.time())
    with auth._connection() as con:  # noqa: SLF001
        _schema(con)
        row = con.execute("SELECT * FROM google_calendar_oauth_states WHERE state=?", (state,)).fetchone()
        con.execute("DELETE FROM google_calendar_oauth_states WHERE state=?", (state,))
        con.commit()
    if not row or row["expires_at"] < now:
        return False, "Google authorization expired. Please try again."
    tokens = _request("https://oauth2.googleapis.com/token", data={
        "client_id": config["client_id"], "client_secret": config["client_secret"],
        "code": code, "grant_type": "authorization_code", "redirect_uri": config["redirect_uri"],
    })
    access = str(tokens.get("access_token") or "")
    refresh = str(tokens.get("refresh_token") or "")
    if not access or not refresh:
        return False, "Google did not return offline calendar access. Please reconnect."
    profile = _request("https://www.googleapis.com/calendar/v3/users/me/calendarList/primary", token=access)
    with auth._connection() as con:  # noqa: SLF001
        _schema(con)
        con.execute(
            """INSERT INTO google_calendar_connections(user_id,access_token,refresh_token,expires_at,email,created_at,updated_at)
            VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,
            refresh_token=excluded.refresh_token,expires_at=excluded.expires_at,email=excluded.email,updated_at=excluded.updated_at""",
            (row["user_id"], _encrypt(access), _encrypt(refresh), now + int(tokens.get("expires_in") or 3600), profile.get("id", ""), now, now),
        )
        con.commit()
    return True, "Google Calendar connected."


def _access_token(user_id: str) -> str:
    config = _require_config()
    with auth._connection() as con:  # noqa: SLF001
        _schema(con)
        row = con.execute("SELECT * FROM google_calendar_connections WHERE user_id=?", (user_id,)).fetchone()
        if not row:
            raise auth.AuthError("Connect Google Calendar first.", "GOOGLE_CALENDAR_NOT_CONNECTED")
        if row["expires_at"] > int(time.time()) + 60:
            return _decrypt(row["access_token"])
        tokens = _request("https://oauth2.googleapis.com/token", data={
            "client_id": config["client_id"], "client_secret": config["client_secret"],
            "refresh_token": _decrypt(row["refresh_token"]), "grant_type": "refresh_token",
        })
        access = str(tokens.get("access_token") or "")
        con.execute("UPDATE google_calendar_connections SET access_token=?,expires_at=?,updated_at=? WHERE user_id=?",
                    (_encrypt(access), int(time.time()) + int(tokens.get("expires_in") or 3600), int(time.time()), user_id))
        con.commit()
        return access


def list_events(time_min: str, time_max: str) -> dict[str, Any]:
    user = auth.require_current_user()
    token = _access_token(user["id"])
    query = urllib.parse.urlencode({"timeMin": time_min, "timeMax": time_max, "singleEvents": "true", "orderBy": "startTime", "maxResults": 500})
    payload = _request(f"https://www.googleapis.com/calendar/v3/calendars/primary/events?{query}", token=token)
    items = []
    for event in payload.get("items", []):
        start = event.get("start", {})
        end = event.get("end", {})
        start_value = start.get("dateTime") or start.get("date") or ""
        end_value = end.get("dateTime") or end.get("date") or ""
        if not start_value:
            continue
        all_day = "date" in start
        items.append({
            "id": f"google_{event.get('id', '')}", "title": event.get("summary") or "Untitled event",
            "notes": event.get("description") or "", "kind": "event", "date": start_value[:10],
            "startTime": "" if all_day else start_value[11:16], "endTime": "" if all_day else end_value[11:16],
            "allDay": all_day, "location": event.get("location") or "", "googleEventId": event.get("id"),
            "googleHtmlLink": event.get("htmlLink"), "createdAt": event.get("created") or "", "updatedAt": event.get("updated") or "",
        })
    return {"items": items}


def create_event(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    token = _access_token(user["id"])
    date = str(params.get("date") or "")
    all_day = bool(params.get("allDay", True))
    if all_day:
        start, end = {"date": date}, {"date": date}
        # Google requires an exclusive end date for all-day events.
        from datetime import date as date_type, timedelta
        end = {"date": (date_type.fromisoformat(date) + timedelta(days=1)).isoformat()}
    else:
        timezone = str(params.get("timeZone") or "UTC")
        start = {"dateTime": f"{date}T{params.get('startTime', '09:00')}:00", "timeZone": timezone}
        end = {"dateTime": f"{date}T{params.get('endTime', '10:00')}:00", "timeZone": timezone}
    event = _json_request("https://www.googleapis.com/calendar/v3/calendars/primary/events", token, {
        "summary": str(params.get("title") or "Untitled"), "description": str(params.get("notes") or ""),
        "location": str(params.get("location") or ""), "start": start, "end": end,
    })
    return {"googleEventId": event.get("id"), "googleHtmlLink": event.get("htmlLink")}


def register_google_calendar_handlers(channel: Any) -> None:
    async def state(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=connection_state())
    async def connect(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=create_authorization())
    async def events(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=list_events(str(params.get("timeMin") or ""), str(params.get("timeMax") or "")))
    async def create(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=create_event(params))
    channel.register_method("calendar.google.state", state)
    channel.register_method("calendar.google.connect", connect)
    channel.register_method("calendar.google.events", events)
    channel.register_method("calendar.google.create", create)

