# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Lightweight product auth and per-user persistence context.

This module intentionally keeps the first SaaS auth layer small and local:
SQLite for users/sessions/settings, PBKDF2 password hashes, and bearer-style
session tokens passed through the WebChannel RPC envelope.
"""

from __future__ import annotations

import base64
from contextlib import contextmanager
import contextvars
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from jiuwenclaw.utils import get_user_workspace_dir
from jiuwenclaw import database

logger = logging.getLogger(__name__)

_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_PASSWORD_MIN_LEN = 8
_PBKDF2_ITERATIONS = 260_000
_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30
_LOGIN_WINDOW_SECONDS = 15 * 60
_LOGIN_MAX_FAILURES = 10
_CURRENT_USER: contextvars.ContextVar[dict[str, Any] | None] = contextvars.ContextVar(
    "jiuwenclaw_current_user",
    default=None,
)


class AuthError(RuntimeError):
    def __init__(self, message: str, code: str = "AUTH_ERROR") -> None:
        super().__init__(message)
        self.code = code


def _db_path() -> Path:
    root = get_user_workspace_dir() / "auth"
    root.mkdir(parents=True, exist_ok=True)
    return root / "auth.db"


def _connect():  # noqa: ANN202
    con = database.connect(_db_path())
    _ensure_schema(con)
    return con


@contextmanager
def _connection():
    con = _connect()
    try:
        yield con
    finally:
        con.close()


def _ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            iterations INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            created_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS user_settings (
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (user_id, key)
        );
        CREATE TABLE IF NOT EXISTS login_attempts (
            email TEXT NOT NULL,
            attempted_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_login_attempts_email_time
            ON login_attempts(email, attempted_at);
        """
    )
    con.commit()


def _now() -> int:
    return int(time.time())


def _normalize_email(email: str) -> str:
    return (email or "").strip().lower()


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _hash_password(password: str, salt: bytes | None = None, iterations: int = _PBKDF2_ITERATIONS) -> tuple[str, str, int]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return (
        base64.b64encode(digest).decode("ascii"),
        base64.b64encode(salt).decode("ascii"),
        iterations,
    )


def _verify_password(password: str, *, expected_hash: str, salt: str, iterations: int) -> bool:
    try:
        salt_bytes = base64.b64decode(salt.encode("ascii"))
    except Exception:
        return False
    actual, _, _ = _hash_password(password, salt_bytes, iterations)
    return hmac.compare_digest(actual, expected_hash)


def _user_payload(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "email": row["email"],
        "displayName": row["display_name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _create_token(con: sqlite3.Connection, user_id: str) -> tuple[str, int]:
    token = secrets.token_urlsafe(40)
    now = _now()
    con.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
    max_sessions = max(1, int(os.getenv("DEEPCANVAS_MAX_SESSIONS_PER_USER", "10")))
    stale_rows = con.execute(
        "SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT -1 OFFSET ?",
        (user_id, max_sessions - 1),
    ).fetchall()
    if stale_rows:
        con.executemany("DELETE FROM sessions WHERE token_hash = ?", [(row["token_hash"],) for row in stale_rows])
    expires_at = now + _SESSION_TTL_SECONDS
    con.execute(
        "INSERT INTO sessions(token_hash, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
        (_token_hash(token), user_id, now, expires_at, now),
    )
    return token, expires_at


def signup(email: str, password: str, display_name: str = "") -> dict[str, Any]:
    email_norm = _normalize_email(email)
    if not _EMAIL_RE.match(email_norm):
        raise AuthError("Enter a valid email address.", "INVALID_EMAIL")
    if len(password or "") < _PASSWORD_MIN_LEN:
        raise AuthError("Password must be at least 8 characters.", "WEAK_PASSWORD")
    display = (display_name or email_norm.split("@", 1)[0]).strip()[:80] or email_norm
    user_id = f"usr_{uuid.uuid4().hex}"
    password_hash, salt, iterations = _hash_password(password)
    now = _now()
    with _connection() as con:
        max_users = max(1, int(os.getenv("DEEPCANVAS_PUBLIC_BETA_MAX_USERS", "250")))
        user_count = int(con.execute("SELECT COUNT(*) FROM users").fetchone()[0])
        if user_count >= max_users:
            raise AuthError(
                "The public beta is currently full. Please check back soon.",
                "BETA_FULL",
            )
        try:
            con.execute(
                """
                INSERT INTO users(id, email, display_name, password_hash, salt, iterations, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, email_norm, display, password_hash, salt, iterations, now, now),
            )
        except Exception as exc:
            if database.is_integrity_error(exc):
                raise AuthError("An account already exists for that email.", "EMAIL_EXISTS") from exc
            raise
        token, expires_at = _create_token(con, user_id)
        con.commit()
        row = con.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
    try:
        provision_user_runtime(user_id)
    except Exception as exc:
        # Account creation and private-runtime creation are one logical SaaS
        # operation. Never leave a loginable user pointing at a partial or
        # missing agent workspace.
        with _connection() as con:
            con.execute("DELETE FROM users WHERE id = ?", (user_id,))
            con.commit()
        raise AuthError(
            "We could not initialize your private agent workspace. Please try again.",
            "RUNTIME_PROVISION_FAILED",
        ) from exc
    return {"user": _user_payload(row), "token": token, "expiresAt": expires_at}


def login(email: str, password: str) -> dict[str, Any]:
    email_norm = _normalize_email(email)
    with _connection() as con:
        now = _now()
        window_start = now - _LOGIN_WINDOW_SECONDS
        con.execute("DELETE FROM login_attempts WHERE attempted_at < ?", (window_start,))
        recent_failures = int(con.execute(
            "SELECT COUNT(*) FROM login_attempts WHERE email = ? AND attempted_at >= ?",
            (email_norm, window_start),
        ).fetchone()[0])
        if recent_failures >= _LOGIN_MAX_FAILURES:
            con.commit()
            raise AuthError("Too many login attempts. Try again in 15 minutes.", "RATE_LIMITED")
        row = con.execute("SELECT * FROM users WHERE email = ?", (email_norm,)).fetchone()
        if row is None or not _verify_password(
            password or "",
            expected_hash=row["password_hash"],
            salt=row["salt"],
            iterations=int(row["iterations"]),
        ):
            con.execute(
                "INSERT INTO login_attempts(email, attempted_at) VALUES (?, ?)",
                (email_norm, now),
            )
            con.commit()
            raise AuthError("Invalid email or password.", "INVALID_CREDENTIALS")
        con.execute("DELETE FROM login_attempts WHERE email = ?", (email_norm,))
        token, expires_at = _create_token(con, row["id"])
        con.commit()
    return {"user": _user_payload(row), "token": token, "expiresAt": expires_at}


def authenticate_token(token: str | None) -> dict[str, Any] | None:
    raw = (token or "").strip()
    if not raw:
        return None
    now = _now()
    with _connection() as con:
        row = con.execute(
            """
            SELECT users.* FROM sessions
            JOIN users ON users.id = sessions.user_id
            WHERE sessions.token_hash = ? AND sessions.expires_at > ?
            """,
            (_token_hash(raw), now),
        ).fetchone()
        if row is None:
            return None
        con.execute(
            "UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?",
            (now, _token_hash(raw)),
        )
        con.commit()
    return _user_payload(row)


def logout(token: str | None) -> None:
    raw = (token or "").strip()
    if not raw:
        return
    with _connection() as con:
        con.execute("DELETE FROM sessions WHERE token_hash = ?", (_token_hash(raw),))
        con.commit()


def set_current_user(user: dict[str, Any] | None) -> contextvars.Token:
    return _CURRENT_USER.set(user)


def reset_current_user(token: contextvars.Token) -> None:
    _CURRENT_USER.reset(token)


def get_current_user() -> dict[str, Any] | None:
    return _CURRENT_USER.get()


def require_current_user() -> dict[str, Any]:
    user = get_current_user()
    if not user:
        raise AuthError("Authentication required.", "AUTH_REQUIRED")
    return user


def has_owner_funded_beta_access(user: dict[str, Any] | None = None) -> bool:
    user = user or get_current_user()
    if not user:
        return False
    beta_all = str(os.getenv("DEEPCANVAS_OWNER_FUNDED_BETA_ALL_USERS", "")).strip().lower()
    if beta_all in {"1", "true", "yes", "on"}:
        return True
    allowed = {
        item.strip().lower()
        for item in os.getenv("DEEPCANVAS_OWNER_FUNDED_ALLOWLIST", "").split(",")
        if item.strip()
    }
    try:
        cutoff = int(os.getenv("DEEPCANVAS_OWNER_FUNDED_BETA_CUTOFF", "1785891654"))
    except ValueError:
        cutoff = 0
    return str(user.get("email") or "").lower() in allowed or int(user.get("createdAt") or 0) <= cutoff


def require_owner_funded_beta_access(service_name: str) -> dict[str, Any]:
    """Limit owner-funded integrations to the configured authenticated beta cohort."""
    user = require_current_user()
    if has_owner_funded_beta_access(user):
        return user
    raise AuthError(
        f"{service_name} is limited during the public beta. Connect your own provider or join the access list.",
        "BETA_SERVICE_LIMITED",
    )


def get_current_user_id(default: str = "default") -> str:
    user = get_current_user()
    return str(user.get("id") if user else default)


def get_current_user_data_dir() -> Path:
    user_id = get_current_user_id()
    base = get_user_workspace_dir() / "users" / user_id
    base.mkdir(parents=True, exist_ok=True)
    return base


def provision_user_runtime(user_id: str) -> Path:
    """Create a pristine, private Jiuwen workspace for one SaaS user."""
    safe_user_id = re.sub(r"[^A-Za-z0-9_.-]", "_", str(user_id or "").strip())
    if not safe_user_id:
        raise ValueError("A user id is required to provision a runtime")
    workspace = get_user_workspace_dir() / "users" / safe_user_id / "agent" / "jiuwenclaw_workspace"
    if workspace.exists():
        return workspace
    template = Path(__file__).resolve().parent / "resources" / "agent" / "jiuwenclaw_workspace"
    workspace.parent.mkdir(parents=True, exist_ok=True)

    # Provision into a sibling directory and publish it atomically. Copying a
    # large skill tree directly into the live user path can leave a half-built
    # runtime when OneDrive, antivirus, or another worker observes a transient
    # file. Python caches are build artifacts and must never be part of a SaaS
    # user's runtime template.
    staging = workspace.parent / f".p-{uuid.uuid4().hex[:8]}"
    try:
        if template.is_dir():
            shutil.copytree(
                template,
                staging,
                # Skills are installed per user through Skill Management. A
                # fresh account should not clone the large developer catalog,
                # which is both wasteful and a source of Windows path failures.
                ignore=shutil.ignore_patterns(
                    "skills", "__pycache__", "*.pyc", "*.pyo", ".pytest_cache"
                ),
            )
        else:
            staging.mkdir(parents=True, exist_ok=False)
        for stem in ("BOOTSTRAP", "AGENT", "HEARTBEAT", "IDENTITY", "SOUL"):
            source = staging / f"{stem}_EN.md"
            target = staging / f"{stem}.md"
            if source.is_file() and not target.exists():
                shutil.copy2(source, target)
        memory_source = staging / "memory" / "MEMORY_EN.md"
        memory_target = staging / "memory" / "MEMORY.md"
        if memory_source.is_file() and not memory_target.exists():
            shutil.copy2(memory_source, memory_target)
        (staging / "memory").mkdir(parents=True, exist_ok=True)
        (staging / "skills").mkdir(parents=True, exist_ok=True)
        try:
            staging.replace(workspace)
        except FileExistsError:
            # Another request completed provisioning the same user first.
            pass
    finally:
        if staging.exists():
            shutil.rmtree(staging, ignore_errors=True)
    return workspace


def get_runtime_config(user_id: str | None = None) -> dict[str, Any]:
    """Return the configured shared or authenticated-user runtime settings."""
    uid = user_id or require_current_user()["id"]
    shared_uid = str(
        os.getenv("RUNTIME_CONFIG_SHARED_USER_ID")
        or os.getenv("RINGCENTRAL_SHARED_USER_ID", "")
    ).strip()
    settings_uid = shared_uid or uid
    value = get_settings(settings_uid).get("runtime_config", {})
    config = dict(value) if isinstance(value, dict) else {}
    for key in tuple(config):
        if ("api_key" in key.lower() or "token" in key.lower()) and config[key]:
            try:
                config[key] = _decrypt_runtime_secret(str(config[key]))
            except AuthError as exc:
                # A database restore can outlive the server-local Fernet key.
                # Keep the encrypted value in storage, but do not make the
                # entire authenticated app/config bootstrap fail because one
                # provider secret can no longer be decrypted.
                logger.warning(
                    "Stored runtime credential is unavailable for user=%s key=%s: %s",
                    settings_uid,
                    key,
                    exc,
                )
                config[key] = ""
    return config


def update_runtime_config(config: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
    """Merge SaaS runtime settings without modifying process-global environment."""
    uid = user_id or require_current_user()["id"]
    shared_uid = str(
        os.getenv("RUNTIME_CONFIG_SHARED_USER_ID")
        or os.getenv("RINGCENTRAL_SHARED_USER_ID", "")
    ).strip()
    settings_uid = shared_uid or uid
    merged = get_runtime_config(settings_uid)
    merged.update({str(key): value for key, value in config.items()})
    stored = dict(merged)
    for key in tuple(stored):
        if ("api_key" in key.lower() or "token" in key.lower()) and stored[key]:
            stored[key] = _encrypt_runtime_secret(str(stored[key]))
    update_settings({"runtime_config": stored}, settings_uid)
    return merged


def _runtime_secret_cipher():
    """Return a stable server-local Fernet cipher for SaaS credentials."""
    from cryptography.fernet import Fernet

    key_path = _db_path().parent / "runtime_config.key"
    if not key_path.exists():
        key_path.write_bytes(Fernet.generate_key())
        try:
            key_path.chmod(0o600)
        except OSError:
            pass
    return Fernet(key_path.read_bytes().strip())


def _encrypt_runtime_secret(value: str) -> str:
    if value.startswith("fernet:"):
        return value
    return "fernet:" + _runtime_secret_cipher().encrypt(value.encode("utf-8")).decode("ascii")


def _decrypt_runtime_secret(value: str) -> str:
    if not value.startswith("fernet:"):
        return value
    try:
        return _runtime_secret_cipher().decrypt(value[7:].encode("ascii")).decode("utf-8")
    except Exception as exc:
        raise AuthError("Stored provider credential could not be decrypted.", "CREDENTIAL_ERROR") from exc


def get_settings(user_id: str | None = None) -> dict[str, Any]:
    uid = user_id or require_current_user()["id"]
    with _connection() as con:
        rows = con.execute("SELECT key, value FROM user_settings WHERE user_id = ?", (uid,)).fetchall()
    out: dict[str, Any] = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except Exception:
            out[row["key"]] = row["value"]
    return out


def update_settings(settings: dict[str, Any], user_id: str | None = None) -> dict[str, Any]:
    uid = user_id or require_current_user()["id"]
    now = _now()
    with _connection() as con:
        for key, value in settings.items():
            safe_key = str(key).strip()[:120]
            if not safe_key:
                continue
            con.execute(
                """
                INSERT INTO user_settings(user_id, key, value, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (uid, safe_key, json.dumps(value, ensure_ascii=False), now),
            )
        con.commit()
    return get_settings(uid)


def list_configured_runtime_user_ids() -> list[str]:
    """Return users that have a complete private main-model connection."""
    with _connection() as con:
        rows = con.execute("SELECT id FROM users ORDER BY created_at").fetchall()
    configured: list[str] = []
    for row in rows:
        cfg = get_runtime_config(str(row["id"]))
        if all(str(cfg.get(key) or "").strip() for key in (
            "model_provider", "model", "api_base", "api_key",
        )):
            configured.append(str(row["id"]))
    return configured

