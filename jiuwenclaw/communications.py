"""Account-first SignalWire calling for Deep Canvas."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import logging
import os
import re
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

from jiuwenclaw import auth

_LOGGER = logging.getLogger(__name__)

_NORTH_AMERICA_NUMBER = re.compile(r"^\+1[2-9]\d{9}$")
_FINAL_STATUSES = frozenset({"completed", "failed", "canceled", "no-answer"})
_DISPOSITIONS = frozenset({"answered", "no-answer", "voicemail", "follow-up", "bad-number", ""})


def _now() -> int:
    return int(time.time())


def _config() -> dict[str, str]:
    space = os.getenv("SIGNALWIRE_SPACE_URL", "").strip().rstrip("/")
    if space and not space.startswith(("http://", "https://")):
        space = f"https://{space}"
    return {
        "space_url": space,
        "project_id": os.getenv("SIGNALWIRE_PROJECT_ID", "").strip(),
        "api_token": os.getenv("SIGNALWIRE_API_TOKEN", "").strip(),
        "caller_id": os.getenv("SIGNALWIRE_TEST_NUMBER", "").strip(),
        "caller_id_resource": os.getenv("SIGNALWIRE_TEST_NUMBER_ID", "").strip(),
    }


def _require_config() -> dict[str, str]:
    config = _config()
    missing = [key for key in ("space_url", "project_id", "api_token", "caller_id") if not config[key]]
    if missing:
        raise auth.AuthError("Calling is not configured yet.", "COMMUNICATIONS_NOT_CONFIGURED")
    return config


def _ensure_schema(con) -> None:  # noqa: ANN001
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS communications_accounts (
            id TEXT PRIMARY KEY,
            account_type TEXT NOT NULL,
            owner_user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS communications_subscribers (
            account_id TEXT NOT NULL REFERENCES communications_accounts(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider_subscriber_id TEXT,
            provider_reference TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, user_id)
        );
        CREATE TABLE IF NOT EXISTS communications_calls (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL REFERENCES communications_accounts(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            provider_call_id TEXT,
            direction TEXT NOT NULL,
            from_number TEXT NOT NULL,
            to_number TEXT NOT NULL,
            lead_id TEXT,
            lead_name TEXT,
            status TEXT NOT NULL,
            disposition TEXT,
            notes TEXT,
            started_at INTEGER NOT NULL,
            connected_at INTEGER,
            ended_at INTEGER,
            duration_seconds INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_communications_calls_user
            ON communications_calls(user_id, started_at DESC);
        CREATE TABLE IF NOT EXISTS communications_presence (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            status TEXT NOT NULL,
            call_id TEXT,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ringcentral_connections (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            access_token TEXT NOT NULL,
            refresh_token TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            account_id TEXT,
            extension_id TEXT,
            extension_name TEXT,
            phone_number TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS ringcentral_oauth_states (
            state TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            code_verifier TEXT NOT NULL,
            expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS aircall_connections (
            user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
            api_id TEXT NOT NULL,
            api_token TEXT NOT NULL,
            aircall_user_id TEXT NOT NULL,
            aircall_user_name TEXT,
            number_id TEXT NOT NULL,
            number_name TEXT,
            number_digits TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        """
    )
    con.commit()


def _ringcentral_config() -> dict[str, str]:
    return {
        "server": os.getenv("RINGCENTRAL_SERVER", "https://platform.ringcentral.com").strip().rstrip("/"),
        "client_id": os.getenv("RINGCENTRAL_CLIENT_ID", "").strip(),
        "client_secret": os.getenv("RINGCENTRAL_CLIENT_SECRET", "").strip(),
        "redirect_uri": os.getenv("RINGCENTRAL_REDIRECT_URI", "").strip(),
        "encryption_key": os.getenv("RINGCENTRAL_TOKEN_ENCRYPTION_KEY", "").strip(),
        # Deep Canvas employees share one RingCentral extension.  Keeping one
        # canonical token row prevents each app login from drifting onto a
        # different (or stale) refresh-token chain.
        "shared_user_id": os.getenv("RINGCENTRAL_SHARED_USER_ID", "").strip(),
    }


def _aircall_request(path: str, api_id: str, api_token: str, *, method: str = "GET",
                     data: dict[str, Any] | None = None) -> dict[str, Any]:
    credentials = base64.b64encode(f"{api_id}:{api_token}".encode("utf-8")).decode("ascii")
    request = urllib.request.Request(
        f"https://api.aircall.io/v1/{path.lstrip('/')}",
        method=method,
        headers={"Authorization": f"Basic {credentials}", "Accept": "application/json",
                 "Content-Type": "application/json"},
        data=json.dumps(data).encode("utf-8") if data is not None else None,
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        _LOGGER.warning("Aircall request failed status=%s path=%s", exc.code, path)
        if exc.code == 401:
            raise auth.AuthError("Aircall API ID or token is incorrect.", "AIRCALL_AUTH_FAILED") from exc
        if exc.code == 405:
            raise auth.AuthError("The selected Aircall user is unavailable or already on a call.", "AIRCALL_USER_UNAVAILABLE") from exc
        raise auth.AuthError(f"Aircall rejected the request: {detail or exc.reason}", "AIRCALL_REQUEST_FAILED") from exc
    except urllib.error.URLError as exc:
        raise auth.AuthError("Aircall could not be reached. Try again shortly.", "AIRCALL_UNAVAILABLE") from exc


def _aircall_encrypt(value: str) -> str:
    return _token_cipher().encrypt(value.encode("utf-8")).decode("ascii")


def _aircall_decrypt(value: str) -> str:
    return _token_cipher().decrypt(value.encode("ascii")).decode("utf-8")


def _aircall_connection(con, user_id: str, *, include_secrets: bool = False) -> dict[str, Any] | None:  # noqa: ANN001
    row = con.execute("SELECT * FROM aircall_connections WHERE user_id = ?", (user_id,)).fetchone()
    if not row:
        return None
    result = {"connected": True, "userId": row["aircall_user_id"],
              "userName": row["aircall_user_name"] or "Aircall user", "numberId": row["number_id"],
              "numberName": row["number_name"] or "Aircall line", "phoneNumber": row["number_digits"] or ""}
    if include_secrets:
        result.update({"apiId": _aircall_decrypt(row["api_id"]),
                       "apiToken": _aircall_decrypt(row["api_token"])})
    return result


def connect_aircall(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    api_id = str(params.get("apiId") or "").strip()
    api_token = str(params.get("apiToken") or "").strip()
    if not api_id or not api_token:
        raise auth.AuthError("Enter the Aircall API ID and API token.", "AIRCALL_CREDENTIALS_REQUIRED")
    _aircall_request("ping", api_id, api_token)
    users = _aircall_request("users?per_page=50", api_id, api_token).get("users") or []
    numbers = _aircall_request("numbers?per_page=50", api_id, api_token).get("numbers") or []
    if not users or not numbers:
        raise auth.AuthError("Aircall needs at least one user and one phone number.", "AIRCALL_ACCOUNT_INCOMPLETE")
    selected_user = users[0]
    user_numbers = selected_user.get("numbers") or []
    selected_number = user_numbers[0] if user_numbers else numbers[0]
    now = _now()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute(
            """INSERT INTO aircall_connections
               (user_id,api_id,api_token,aircall_user_id,aircall_user_name,number_id,number_name,number_digits,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
               api_id=excluded.api_id,api_token=excluded.api_token,aircall_user_id=excluded.aircall_user_id,
               aircall_user_name=excluded.aircall_user_name,number_id=excluded.number_id,number_name=excluded.number_name,
               number_digits=excluded.number_digits,updated_at=excluded.updated_at""",
            (user["id"], _aircall_encrypt(api_id), _aircall_encrypt(api_token), str(selected_user["id"]),
             str(selected_user.get("name") or selected_user.get("email") or "Aircall user"), str(selected_number["id"]),
             str(selected_number.get("name") or "Aircall line"), str(selected_number.get("digits") or ""), now, now),
        )
        con.commit()
        connection = _aircall_connection(con, user["id"])
    return {"connection": connection, "users": users, "numbers": numbers}


def disconnect_aircall() -> dict[str, Any]:
    user = auth.require_current_user()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute("DELETE FROM aircall_connections WHERE user_id = ?", (user["id"],))
        con.commit()
    return {"connected": False}


def _require_ringcentral_config() -> dict[str, str]:
    config = _ringcentral_config()
    missing = [key for key in ("client_id", "client_secret", "redirect_uri", "encryption_key") if not config[key]]
    if missing:
        raise auth.AuthError("RingCentral connection is not configured yet.", "RINGCENTRAL_NOT_CONFIGURED")
    return config


def _token_cipher():  # noqa: ANN202
    from cryptography.fernet import Fernet

    raw = _require_ringcentral_config()["encryption_key"].encode("utf-8")
    key = base64.urlsafe_b64encode(hashlib.sha256(raw).digest())
    return Fernet(key)


def _encrypt_token(value: str) -> str:
    return _token_cipher().encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt_token(value: str) -> str:
    return _token_cipher().decrypt(value.encode("ascii")).decode("utf-8")


def _ringcentral_connection(con, user_id: str) -> dict[str, Any] | None:  # noqa: ANN001
    _ensure_schema(con)
    owner_id = _ringcentral_config()["shared_user_id"] or user_id
    row = con.execute("SELECT * FROM ringcentral_connections WHERE user_id = ?", (owner_id,)).fetchone()
    if not row:
        return None
    return {
        "connected": True,
        "accountId": row["account_id"],
        "extensionId": row["extension_id"],
        "displayName": row["extension_name"] or "RingCentral",
        "phoneNumber": row["phone_number"] or "",
    }


def create_ringcentral_authorization() -> dict[str, Any]:
    user = auth.require_current_user()
    config = _require_ringcentral_config()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    now = _now()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute("DELETE FROM ringcentral_oauth_states WHERE expires_at < ? OR user_id = ?", (now, user["id"]))
        con.execute(
            "INSERT INTO ringcentral_oauth_states(state, user_id, code_verifier, expires_at) VALUES (?, ?, ?, ?)",
            (state, user["id"], verifier, now + 600),
        )
        con.commit()
    query = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": config["client_id"],
        "redirect_uri": config["redirect_uri"],
        # Ask for the complete communications permission set on every new
        # connection. Existing grants cannot gain newly approved scopes until
        # the user reconnects and explicitly authorizes them.
        "scope": "ReadAccounts RingOut VoipCalling SMS ReadMessages",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "prompt": "login",
    })
    return {"authorizationUrl": f"{config['server']}/restapi/oauth/authorize?{query}"}


def _ringcentral_request(url: str, *, token: str = "", data: dict[str, Any] | None = None,
                         basic: tuple[str, str] | None = None,
                         json_data: dict[str, Any] | None = None) -> dict[str, Any]:
    headers = {"Accept": "application/json"}
    body = None
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if basic:
        encoded = base64.b64encode(f"{basic[0]}:{basic[1]}".encode()).decode()
        headers["Authorization"] = f"Basic {encoded}"
    if json_data is not None:
        body = json.dumps(json_data).encode()
        headers["Content-Type"] = "application/json"
    elif data is not None:
        body = urllib.parse.urlencode(data).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(
        url, data=body, headers=headers, method="POST" if data is not None or json_data is not None else "GET"
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = _ringcentral_http_error(exc)
        _LOGGER.warning("RingCentral request failed status=%s path=%s detail=%s", exc.code,
                        urllib.parse.urlparse(url).path, detail)
        raise auth.AuthError(f"RingCentral: {detail}", "RINGCENTRAL_REQUEST_FAILED") from exc


def _ringcentral_http_error(exc: urllib.error.HTTPError) -> str:
    """Extract a useful, non-secret RingCentral error for logs and the UI."""
    try:
        raw = exc.read().decode("utf-8", errors="replace")
        payload = json.loads(raw)
        if isinstance(payload, dict):
            candidates = [payload.get("error_description"), payload.get("message"), payload.get("error")]
            errors = payload.get("errors")
            if isinstance(errors, list) and errors and isinstance(errors[0], dict):
                candidates.insert(0, errors[0].get("message"))
            detail = next((str(item) for item in candidates if item and not isinstance(item, (dict, list))), "")
            if detail:
                return re.sub(r"[\r\n]+", " ", detail)[:300]
    except Exception:  # noqa: BLE001
        pass
    return f"request failed with HTTP {exc.code}"


def complete_ringcentral_authorization(query: dict[str, list[str]]) -> tuple[bool, str]:
    state = (query.get("state") or [""])[0]
    code = (query.get("code") or [""])[0]
    error = (query.get("error_description") or query.get("error") or [""])[0]
    if error:
        return False, str(error)[:240]
    if not state or not code:
        return False, "Missing RingCentral authorization response."
    config = _require_ringcentral_config()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        row = con.execute("SELECT * FROM ringcentral_oauth_states WHERE state = ?", (state,)).fetchone()
        con.execute("DELETE FROM ringcentral_oauth_states WHERE state = ?", (state,))
        con.commit()
    if not row or int(row["expires_at"]) < _now():
        return False, "This RingCentral connection request expired. Please try again."
    tokens = _ringcentral_request(
        f"{config['server']}/restapi/oauth/token",
        data={"grant_type": "authorization_code", "code": code, "redirect_uri": config["redirect_uri"],
              "code_verifier": row["code_verifier"]},
        basic=(config["client_id"], config["client_secret"]),
    )
    access = str(tokens.get("access_token") or "")
    refresh = str(tokens.get("refresh_token") or "")
    if not access or not refresh:
        return False, "RingCentral did not return a reusable connection."
    profile = _ringcentral_request(f"{config['server']}/restapi/v1.0/account/~/extension/~", token=access)
    phones = _ringcentral_request(
        f"{config['server']}/restapi/v1.0/account/~/extension/~/phone-number", token=access
    )
    records = phones.get("records") if isinstance(phones.get("records"), list) else []
    phone = next((str(item.get("phoneNumber") or "") for item in records if "CallerId" in (item.get("features") or [])), "")
    now = _now()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute(
            """INSERT INTO ringcentral_connections
               (user_id, access_token, refresh_token, expires_at, account_id, extension_id, extension_name,
                phone_number, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET access_token=excluded.access_token,
               refresh_token=excluded.refresh_token, expires_at=excluded.expires_at, account_id=excluded.account_id,
               extension_id=excluded.extension_id, extension_name=excluded.extension_name,
               phone_number=excluded.phone_number, updated_at=excluded.updated_at""",
            (_ringcentral_config()["shared_user_id"] or row["user_id"], _encrypt_token(access), _encrypt_token(refresh), now + int(tokens.get("expires_in") or 3600),
             str(profile.get("account", {}).get("id") or ""), str(profile.get("id") or ""),
             str(profile.get("name") or profile.get("contact", {}).get("email") or "RingCentral")[:160],
             phone[:40], now, now),
        )
        con.commit()
    return True, "RingCentral connected to Deep Canvas."


def disconnect_ringcentral() -> dict[str, Any]:
    user = auth.require_current_user()
    shared_user_id = _ringcentral_config()["shared_user_id"]
    if shared_user_id:
        raise auth.AuthError(
            "RingCentral is managed as a shared company connection.",
            "RINGCENTRAL_SHARED_CONNECTION",
        )
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute("DELETE FROM ringcentral_connections WHERE user_id = ?", (user["id"],))
        con.commit()
    return {"connected": False}


def _ringcentral_access(con, user_id: str) -> tuple[str, Any]:  # noqa: ANN001
    config = _require_ringcentral_config()
    owner_id = config["shared_user_id"] or user_id
    row = con.execute("SELECT * FROM ringcentral_connections WHERE user_id = ?", (owner_id,)).fetchone()
    if not row:
        raise auth.AuthError("Connect RingCentral before placing this call.", "RINGCENTRAL_NOT_CONNECTED")
    if int(row["expires_at"]) > _now() + 90:
        return _decrypt_token(row["access_token"]), row
    tokens = _ringcentral_request(
        f"{config['server']}/restapi/oauth/token",
        data={"grant_type": "refresh_token", "refresh_token": _decrypt_token(row["refresh_token"])},
        basic=(config["client_id"], config["client_secret"]),
    )
    access = str(tokens.get("access_token") or "")
    refresh = str(tokens.get("refresh_token") or "")
    if not access:
        raise auth.AuthError("Reconnect RingCentral to continue calling.", "RINGCENTRAL_RECONNECT_REQUIRED")
    con.execute(
        "UPDATE ringcentral_connections SET access_token=?, refresh_token=?, expires_at=?, updated_at=? WHERE user_id=?",
        (_encrypt_token(access), _encrypt_token(refresh or _decrypt_token(row["refresh_token"])),
         _now() + int(tokens.get("expires_in") or 3600), _now(), owner_id),
    )
    con.commit()
    return access, con.execute("SELECT * FROM ringcentral_connections WHERE user_id = ?", (owner_id,)).fetchone()


def _ringcentral_ringout(token: str, from_number: str, to_number: str) -> dict[str, Any]:
    config = _require_ringcentral_config()
    payload: dict[str, Any] = {"to": {"phoneNumber": to_number}, "playPrompt": False}
    if from_number:
        payload["from"] = {"phoneNumber": from_number}
    request = urllib.request.Request(
        f"{config['server']}/restapi/v1.0/account/~/extension/~/ring-out",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as exc:
        detail = _ringcentral_http_error(exc)
        _LOGGER.warning("RingCentral RingOut failed status=%s detail=%s", exc.code, detail)
        if exc.code in {401, 403}:
            raise auth.AuthError(
                f"RingCentral calling permission is missing ({detail}). Reconnect after the RingOut scope is enabled.",
                "RINGCENTRAL_CALLING_PERMISSION_REQUIRED",
            ) from exc
        raise auth.AuthError(f"RingCentral could not start this call: {detail}", "RINGCENTRAL_CALL_FAILED") from exc


def ringcentral_webphone_credentials() -> dict[str, Any]:
    """Provision short-lived SIP credentials for the signed-in user's browser phone."""
    user = auth.require_current_user()
    config = _require_ringcentral_config()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        access, connection = _ringcentral_access(con, user["id"])
    try:
        provision = _ringcentral_request(
            f"{config['server']}/restapi/v1.0/client-info/sip-provision",
            token=access,
            json_data={"sipInfo": [{"transport": "WSS"}]},
        )
    except auth.AuthError as exc:
        message = str(exc)
        if "VoIPCalling" in message or "VoIP Calling" in message:
            raise auth.AuthError(
                "RingCentral browser calling permission is missing. Enable the VoIP Calling scope, then disconnect and reconnect RingCentral.",
                "RINGCENTRAL_VOIP_PERMISSION_REQUIRED",
            ) from exc
        raise
    records = provision.get("sipInfo")
    sip_info = records[0] if isinstance(records, list) and records and isinstance(records[0], dict) else None
    required = {"authorizationId", "domain", "outboundProxy", "username", "password"}
    if not sip_info or not required.issubset(sip_info):
        raise auth.AuthError(
            "RingCentral did not provision this extension for browser calling. Confirm the user has a digital line.",
            "RINGCENTRAL_WEBPHONE_UNAVAILABLE",
        )
    return {"sipInfo": sip_info, "callerId": str(connection["phone_number"] or "")}


def _ringcentral_caller_ids_for_token(token: str) -> list[dict[str, str]]:
    config = _require_ringcentral_config()
    # RingCentral splits company numbers and extension-assigned direct lines
    # across two resources.  Loading only the account resource can hide the
    # signed-in caller's second line, so merge both collections.
    records: list[Any] = []
    endpoint_paths = (
        "/restapi/v1.0/account/~/phone-number?perPage=1000",
        "/restapi/v1.0/account/~/extension/~/phone-number?perPage=1000",
    )
    errors: list[Exception] = []
    for path in endpoint_paths:
        try:
            payload = _ringcentral_request(f"{config['server']}{path}", token=token)
        except Exception as exc:  # Keep the usable endpoint when one scope is narrower.
            errors.append(exc)
            continue
        endpoint_records = payload.get("records") if isinstance(payload.get("records"), list) else []
        records.extend(endpoint_records)
    if not records and errors:
        raise errors[0]
    choices: list[dict[str, str]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        number = str(record.get("phoneNumber") or "").strip()
        usage = str(record.get("usageType") or "")
        number_type = str(record.get("type") or "")
        features = record.get("features") if isinstance(record.get("features"), list) else []
        if not number or number_type.lower() == "faxonly":
            continue
        if usage != "MainCompanyNumber" and "CallerId" not in features:
            continue
        label = "Company main" if usage == "MainCompanyNumber" else str(record.get("label") or record.get("type") or "Direct number")
        choices.append({"phoneNumber": number, "label": label, "usageType": usage})
    unique = {item["phoneNumber"]: item for item in choices}
    return sorted(unique.values(), key=lambda item: (item["usageType"] != "MainCompanyNumber", item["phoneNumber"]))


def _normalize_north_america_number(value: str) -> str:
    digits = re.sub(r"\D", "", value or "")
    if len(digits) == 10:
        return f"+1{digits}"
    if len(digits) == 11 and digits.startswith("1"):
        return f"+{digits}"
    normalized = value.strip() if value.strip().startswith("+") else digits
    if not _NORTH_AMERICA_NUMBER.fullmatch(normalized):
        raise auth.AuthError("Enter a valid US or Canadian mobile number, such as +15125550123.", "INVALID_PHONE_NUMBER")
    return normalized


def _ringcentral_sms_numbers_for_token(token: str) -> list[dict[str, str]]:
    config = _require_ringcentral_config()
    payload = _ringcentral_request(
        f"{config['server']}/restapi/v1.0/account/~/extension/~/phone-number?perPage=1000", token=token
    )
    records = payload.get("records") if isinstance(payload.get("records"), list) else []
    choices: list[dict[str, str]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        number = str(record.get("phoneNumber") or "").strip()
        features = record.get("features") if isinstance(record.get("features"), list) else []
        if not number or not ({"SmsSender", "SmsRecipient"} & set(features)):
            continue
        choices.append({"phoneNumber": number, "label": str(record.get("label") or "SMS line")})
    unique = {item["phoneNumber"]: item for item in choices}
    return sorted(unique.values(), key=lambda item: item["phoneNumber"])


def ringcentral_sms_state() -> dict[str, Any]:
    user = auth.require_current_user()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        connection = _ringcentral_connection(con, user["id"])
        if not connection:
            return {"connected": False, "provider": "ringcentral", "senderNumbers": []}
        access, row = _ringcentral_access(con, user["id"])
    numbers = _ringcentral_sms_numbers_for_token(access)
    fallback = str(row["phone_number"] or "")
    return {"connected": True, "provider": "ringcentral", "displayName": str(row["extension_name"] or "RingCentral"),
            "senderNumbers": numbers, "defaultSender": numbers[0]["phoneNumber"] if numbers else fallback,
            "smsAvailable": bool(numbers)}


def ringcentral_sms_messages(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    phone_number = _normalize_north_america_number(str(params.get("phoneNumber") or ""))
    config = _require_ringcentral_config()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        access, _connection = _ringcentral_access(con, user["id"])
    query = urllib.parse.urlencode({"messageType": "SMS", "phoneNumber": phone_number, "perPage": 100})
    payload = _ringcentral_request(
        f"{config['server']}/restapi/v1.0/account/~/extension/~/message-store?{query}", token=access
    )
    records = payload.get("records") if isinstance(payload.get("records"), list) else []
    messages: list[dict[str, Any]] = []
    for record in records:
        if not isinstance(record, dict):
            continue
        sender = record.get("from") if isinstance(record.get("from"), dict) else {}
        recipients = record.get("to") if isinstance(record.get("to"), list) else []
        messages.append({"id": str(record.get("id") or ""), "direction": str(record.get("direction") or "Inbound").lower(),
                         "fromNumber": str(sender.get("phoneNumber") or ""),
                         "toNumbers": [str(item.get("phoneNumber") or "") for item in recipients if isinstance(item, dict)],
                         "text": str(record.get("subject") or ""),
                         "status": str(record.get("messageStatus") or "received").lower(),
                         "readStatus": str(record.get("readStatus") or "").lower(),
                         "createdAt": str(record.get("creationTime") or record.get("lastModifiedTime") or ""),
                         "attachments": record.get("attachments") if isinstance(record.get("attachments"), list) else []})
    messages.sort(key=lambda item: item["createdAt"])
    return {"phoneNumber": phone_number, "messages": messages}


def ringcentral_sms_send(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    to_number = _normalize_north_america_number(str(params.get("toNumber") or ""))
    from_number = _normalize_north_america_number(str(params.get("fromNumber") or ""))
    message = str(params.get("text") or "").strip()
    if not message:
        raise auth.AuthError("Write a message before sending.", "SMS_MESSAGE_REQUIRED")
    if len(message) > 5000:
        raise auth.AuthError("This message is too long. Keep it under 5,000 characters.", "SMS_MESSAGE_TOO_LONG")
    config = _require_ringcentral_config()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        access, _connection = _ringcentral_access(con, user["id"])
    allowed = {item["phoneNumber"] for item in _ringcentral_sms_numbers_for_token(access)}
    if from_number not in allowed:
        raise auth.AuthError("Choose a RingCentral number enabled for SMS.", "SMS_SENDER_NOT_AVAILABLE")
    try:
        record = _ringcentral_request(
            f"{config['server']}/restapi/v1.0/account/~/extension/~/sms", token=access,
            json_data={"from": {"phoneNumber": from_number}, "to": [{"phoneNumber": to_number}], "text": message},
        )
    except auth.AuthError as exc:
        if "permission" in str(exc).lower() or "scope" in str(exc).lower() or "403" in str(exc):
            raise auth.AuthError("RingCentral SMS permission is not enabled for this connection. Enable the SMS scope, then reconnect RingCentral.", "RINGCENTRAL_SMS_PERMISSION_REQUIRED") from exc
        raise
    return {"id": str(record.get("id") or ""), "direction": "outbound", "fromNumber": from_number,
            "toNumbers": [to_number], "text": str(record.get("subject") or message),
            "status": str(record.get("messageStatus") or "queued").lower(), "createdAt": str(record.get("creationTime") or "")}


def ringcentral_caller_ids() -> dict[str, Any]:
    user = auth.require_current_user()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        access, connection = _ringcentral_access(con, user["id"])
    choices = _ringcentral_caller_ids_for_token(access)
    fallback = str(connection["phone_number"] or "")
    if fallback and not any(item["phoneNumber"] == fallback for item in choices):
        choices.append({"phoneNumber": fallback, "label": "Direct number", "usageType": "DirectNumber"})
    return {"callerIds": choices, "defaultCallerId": choices[0]["phoneNumber"] if choices else fallback}


def _call_presence(con, user_id: str) -> dict[str, Any]:  # noqa: ANN001
    row = con.execute(
        "SELECT status, call_id, updated_at FROM communications_presence WHERE user_id = ?", (user_id,)
    ).fetchone()
    if not row or _now() - int(row["updated_at"]) > 45:
        return {"status": "available", "callId": None, "updatedAt": None}
    return {"status": row["status"], "callId": row["call_id"], "updatedAt": row["updated_at"]}


def list_teammates() -> dict[str, Any]:
    """Return only accepted teammates, with privacy-safe live call availability."""
    from jiuwenclaw import team_up

    user = auth.require_current_user()
    with auth._connection() as con:  # noqa: SLF001
        team_up._ensure_schema(con)  # noqa: SLF001 - shared application database boundary
        _ensure_schema(con)
        rows = con.execute(
            """SELECT DISTINCT u.id, u.email, u.display_name,
                      rc.phone_number AS ringcentral_phone_number
               FROM team_members mine
               JOIN team_members other ON other.team_id = mine.team_id AND other.user_id != mine.user_id
               JOIN users u ON u.id = other.user_id
               LEFT JOIN ringcentral_connections rc ON rc.user_id = u.id
               WHERE mine.user_id = ? ORDER BY u.display_name, u.email""",
            (user["id"],),
        ).fetchall()
        teammates = [{
            "id": row["id"], "email": row["email"], "displayName": row["display_name"],
            "destination": f"/private/deepcanvas:{row['id']}",
            "ringCentralDestination": str(row["ringcentral_phone_number"] or ""),
            "callPresence": _call_presence(con, row["id"]),
        } for row in rows]
    return {"teammates": teammates}


def update_presence(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    status = str(params.get("status") or "available").strip().lower()
    if status not in {"available", "ringing", "on-call"}:
        raise auth.AuthError("Invalid call presence.", "INVALID_CALL_PRESENCE")
    call_id = str(params.get("callId") or "").strip()[:160] or None
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute(
            """INSERT INTO communications_presence(user_id, status, call_id, updated_at)
               VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET
               status = excluded.status, call_id = excluded.call_id, updated_at = excluded.updated_at""",
            (user["id"], status, call_id, _now()),
        )
        con.commit()
    return {"status": status, "callId": call_id}


def _personal_account(con, user: dict[str, Any]):  # noqa: ANN001
    _ensure_schema(con)
    row = con.execute(
        "SELECT * FROM communications_accounts WHERE owner_user_id = ?", (user["id"],)
    ).fetchone()
    if row:
        return row
    now = _now()
    account_id = f"com_{uuid.uuid4().hex}"
    con.execute(
        """INSERT INTO communications_accounts
           (id, account_type, owner_user_id, provider, status, created_at, updated_at)
           VALUES (?, 'personal', ?, 'signalwire', 'active', ?, ?)""",
        (account_id, user["id"], now, now),
    )
    con.execute(
        """INSERT INTO communications_subscribers
           (account_id, user_id, provider_reference, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)""",
        (account_id, user["id"], f"deepcanvas:{user['id']}", now, now),
    )
    con.commit()
    return con.execute("SELECT * FROM communications_accounts WHERE id = ?", (account_id,)).fetchone()


def _signalwire_error_detail(body: Any) -> str:
    if not isinstance(body, dict):
        return ""
    errors = body.get("errors")
    if isinstance(errors, list) and errors and isinstance(errors[0], dict):
        code = str(errors[0].get("code") or "")
        message = str(errors[0].get("message") or "")
        if code == "insufficient_balance":
            return "Your SignalWire account needs calling credit before calls can be placed."
        return message
    return str(body.get("message") or body.get("error") or "")


def _post_json(url: str, payload: dict[str, Any], project_id: str, api_token: str) -> dict[str, Any]:
    import base64

    authorization = base64.b64encode(f"{project_id}:{api_token}".encode()).decode()
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Basic {authorization}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:  # noqa: S310
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            body = json.loads(exc.read().decode("utf-8"))
            detail = _signalwire_error_detail(body)
        except Exception:  # noqa: BLE001
            pass
        raise auth.AuthError(
            f"SignalWire rejected the calling request{f': {detail}' if detail else '.'}",
            "SIGNALWIRE_REQUEST_FAILED",
        ) from exc
    except (urllib.error.URLError, TimeoutError) as exc:
        raise auth.AuthError("SignalWire could not be reached. Try again shortly.", "SIGNALWIRE_UNAVAILABLE") from exc


def get_state() -> dict[str, Any]:
    user = auth.require_current_user()
    config = _config()
    with auth._connection() as con:  # noqa: SLF001
        account = _personal_account(con, user)
        ringcentral = _ringcentral_connection(con, user["id"])
        aircall = _aircall_connection(con, user["id"])
        rows = con.execute(
            """SELECT id, provider_call_id, direction, from_number, to_number, lead_id, lead_name,
                      status, disposition, notes, started_at, connected_at, ended_at, duration_seconds
               FROM communications_calls WHERE user_id = ? ORDER BY started_at DESC LIMIT 20""",
            (user["id"],),
        ).fetchall()
    return {
        "enabled": all(config[key] for key in ("space_url", "project_id", "api_token", "caller_id")),
        "account": {"id": account["id"], "type": account["account_type"], "status": account["status"]},
        "callerId": config["caller_id"],
        "allowedRegion": "US/Canada",
        "ringcentral": ringcentral or {"connected": False},
        "aircall": aircall or {"connected": False},
        "ringcentralConfigured": all(_ringcentral_config()[key] for key in ("client_id", "client_secret", "encryption_key")),
        "calls": [{
            "id": row["id"], "providerCallId": row["provider_call_id"], "direction": row["direction"],
            "fromNumber": row["from_number"], "toNumber": row["to_number"], "leadId": row["lead_id"],
            "leadName": row["lead_name"], "status": row["status"], "disposition": row["disposition"],
            "notes": row["notes"], "startedAt": row["started_at"], "connectedAt": row["connected_at"],
            "endedAt": row["ended_at"], "durationSeconds": row["duration_seconds"],
        } for row in rows],
    }


async def create_browser_token() -> dict[str, Any]:
    user = auth.require_owner_funded_beta_access("Calling")
    config = _require_config()
    with auth._connection() as con:  # noqa: SLF001
        account = _personal_account(con, user)
        subscriber = con.execute(
            "SELECT * FROM communications_subscribers WHERE account_id = ? AND user_id = ?",
            (account["id"], user["id"]),
        ).fetchone()
    expire_at = _now() + 60 * 60
    payload = await asyncio.to_thread(
        _post_json,
        f"{config['space_url']}/api/fabric/subscribers/tokens",
        {
            "reference": subscriber["provider_reference"],
            "display_name": str(user.get("displayName") or user["email"])[:80],
            "expire_at": expire_at,
        },
        config["project_id"],
        config["api_token"],
    )
    subscriber_id = str(payload.get("subscriber_id") or "")
    token = str(payload.get("token") or "")
    if not subscriber_id or not token:
        raise auth.AuthError("SignalWire returned an incomplete browser token.", "SIGNALWIRE_INVALID_RESPONSE")
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        con.execute(
            """UPDATE communications_subscribers SET provider_subscriber_id = ?, updated_at = ?
               WHERE account_id = ? AND user_id = ?""",
            (subscriber_id, _now(), account["id"], user["id"]),
        )
        con.commit()
    return {"token": token, "expiresAt": expire_at, "subscriberId": subscriber_id, "callerId": config["caller_id"]}


def start_call(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    provider = str(params.get("provider") or "signalwire").strip().lower()
    if provider not in {"signalwire", "ringcentral", "aircall"}:
        raise auth.AuthError("Unsupported phone provider.", "INVALID_PHONE_PROVIDER")
    config = _require_config() if provider == "signalwire" else _config()
    if provider == "signalwire":
        auth.require_owner_funded_beta_access("Calling")
    raw_number = str(params.get("toNumber") or "").strip()
    digits = re.sub(r"\D", "", raw_number)
    if len(digits) == 10:
        to_number = f"+1{digits}"
    elif len(digits) == 11 and digits.startswith("1"):
        to_number = f"+{digits}"
    else:
        to_number = raw_number if raw_number.startswith("+") else digits
    if not _NORTH_AMERICA_NUMBER.fullmatch(to_number):
        raise auth.AuthError("Enter a valid US or Canadian number with country code, such as +15125550123.", "INVALID_PHONE_NUMBER")
    now = _now()
    call_id = f"call_{uuid.uuid4().hex}"
    lead_id = str(params.get("leadId") or "").strip()[:120] or None
    lead_name = str(params.get("leadName") or "").strip()[:160] or None
    provider_call_id = ""
    from_number = config["caller_id"] if provider != "aircall" else "Aircall"
    with auth._connection() as con:  # noqa: SLF001
        account = _personal_account(con, user)
        if provider == "ringcentral":
            access_token, rc_connection = _ringcentral_access(con, user["id"])
            choices = _ringcentral_caller_ids_for_token(access_token)
            allowed = {item["phoneNumber"] for item in choices}
            requested_caller_id = str(params.get("callerId") or "").strip()
            fallback = str(rc_connection["phone_number"] or "")
            from_number = requested_caller_id if requested_caller_id in allowed else (
                choices[0]["phoneNumber"] if choices else fallback
            )
        elif provider == "aircall":
            connection = _aircall_connection(con, user["id"], include_secrets=True)
            if not connection:
                raise auth.AuthError("Connect Aircall before placing this call.", "AIRCALL_NOT_CONNECTED")
            from_number = str(connection["phoneNumber"] or "Aircall")
        con.execute(
            """INSERT INTO communications_calls
               (id, account_id, user_id, provider_call_id, direction, from_number, to_number, lead_id, lead_name,
                status, started_at, updated_at) VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?)""",
            (call_id, account["id"], user["id"], provider_call_id or None, from_number, to_number, lead_id,
             lead_name, "starting", now, now),
        )
        con.commit()
    mode = "ringcentral-browser" if provider == "ringcentral" else (
        "aircall-browser" if provider == "aircall" else "browser"
    )
    return {"callId": call_id, "toNumber": to_number, "callerId": from_number,
            "provider": provider, "mode": mode}


def update_call(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    call_id = str(params.get("callId") or "")
    status = str(params.get("status") or "").strip().lower()[:40]
    provider_call_id = str(params.get("providerCallId") or "").strip()[:160] or None
    allowed_statuses = {"starting", "ringing", "connected", "completed", "failed", "canceled", "no-answer"}
    if status not in allowed_statuses:
        raise auth.AuthError("Invalid call status.", "INVALID_CALL_STATUS")
    now = _now()
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        row = con.execute(
            "SELECT * FROM communications_calls WHERE id = ? AND user_id = ?", (call_id, user["id"])
        ).fetchone()
        if not row:
            raise auth.AuthError("Call record not found.", "CALL_NOT_FOUND")
        connected_at = row["connected_at"] or (now if status == "connected" else None)
        ended_at = now if status in _FINAL_STATUSES else row["ended_at"]
        duration = max(0, ended_at - (connected_at or row["started_at"])) if ended_at else 0
        con.execute(
            """UPDATE communications_calls SET provider_call_id = COALESCE(?, provider_call_id), status = ?,
               connected_at = ?, ended_at = ?, duration_seconds = ?, updated_at = ? WHERE id = ?""",
            (provider_call_id, status, connected_at, ended_at, duration, now, call_id),
        )
        con.commit()
    return {"callId": call_id, "status": status, "durationSeconds": duration}


def set_disposition(params: dict[str, Any]) -> dict[str, Any]:
    user = auth.require_current_user()
    call_id = str(params.get("callId") or "")
    disposition = str(params.get("disposition") or "").strip().lower()
    notes = str(params.get("notes") or "").strip()[:4000]
    if disposition not in _DISPOSITIONS:
        raise auth.AuthError("Invalid call disposition.", "INVALID_DISPOSITION")
    with auth._connection() as con:  # noqa: SLF001
        _ensure_schema(con)
        result = con.execute(
            """UPDATE communications_calls SET disposition = ?, notes = ?, updated_at = ?
               WHERE id = ? AND user_id = ?""",
            (disposition or None, notes or None, _now(), call_id, user["id"]),
        )
        con.commit()
    if not result.rowcount:
        raise auth.AuthError("Call record not found.", "CALL_NOT_FOUND")
    return {"callId": call_id, "disposition": disposition, "notes": notes}


def register_communications_handlers(channel: Any) -> None:
    async def state_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=get_state())

    async def token_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=await create_browser_token())

    async def start_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=start_call(params or {}))

    async def update_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=update_call(params or {}))

    async def disposition_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=set_disposition(params or {}))

    async def teammates_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=list_teammates())

    async def presence_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=update_presence(params or {}))

    async def ringcentral_connect_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=create_ringcentral_authorization())

    async def ringcentral_disconnect_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=disconnect_ringcentral())

    async def ringcentral_webphone_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=ringcentral_webphone_credentials())

    async def ringcentral_caller_ids_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=ringcentral_caller_ids())

    async def ringcentral_sms_state_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=ringcentral_sms_state())

    async def ringcentral_sms_messages_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=ringcentral_sms_messages(params or {}))

    async def ringcentral_sms_send_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=ringcentral_sms_send(params or {}))

    async def aircall_connect_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=connect_aircall(params or {}))

    async def aircall_disconnect_handler(ws, req_id, params, session_id):  # noqa: ANN001, ARG001
        await channel.send_response(ws, req_id, ok=True, payload=disconnect_aircall())

    channel.register_method("communications.state", state_handler)
    channel.register_method("communications.browser_token", token_handler)
    channel.register_method("communications.call.start", start_handler)
    channel.register_method("communications.call.update", update_handler)
    channel.register_method("communications.call.disposition", disposition_handler)
    channel.register_method("communications.teammates", teammates_handler)
    channel.register_method("communications.presence", presence_handler)
    channel.register_method("communications.ringcentral.connect", ringcentral_connect_handler)
    channel.register_method("communications.ringcentral.disconnect", ringcentral_disconnect_handler)
    channel.register_method("communications.ringcentral.webphone", ringcentral_webphone_handler)
    channel.register_method("communications.ringcentral.caller_ids", ringcentral_caller_ids_handler)
    channel.register_method("communications.ringcentral.sms.state", ringcentral_sms_state_handler)
    channel.register_method("communications.ringcentral.sms.messages", ringcentral_sms_messages_handler)
    channel.register_method("communications.ringcentral.sms.send", ringcentral_sms_send_handler)
    channel.register_method("communications.aircall.connect", aircall_connect_handler)
    channel.register_method("communications.aircall.disconnect", aircall_disconnect_handler)

