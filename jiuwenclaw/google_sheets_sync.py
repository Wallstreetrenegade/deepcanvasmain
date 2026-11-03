"""Idempotent public Google Sheets lead synchronization for the shared CRM."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import os
import re
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

from jiuwenclaw import auth
from jiuwenclaw.utils import get_user_workspace_dir


REQUIRED_HEADERS = {"Email", "First Name", "Last Name", "Phone", "Source", "Added Date"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _email(value: Any) -> str:
    return str(value or "").strip().lower()


def _phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    return digits[1:] if len(digits) == 11 and digits.startswith("1") else digits


def _identity(email: str, phone: str) -> str:
    return f"email:{email}" if email else f"phone:{phone}"


def _lead_id(email: str, phone: str) -> str:
    digest = hashlib.sha256(_identity(email, phone).encode("utf-8")).hexdigest()[:24]
    return f"lead_sheet_{digest}"


def _created_time(value: Any, fallback: str) -> str:
    clean = str(value or "").strip()
    if not clean:
        return fallback
    try:
        return datetime.fromisoformat(clean.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat(
            timespec="milliseconds"
        ).replace("+00:00", "Z")
    except ValueError:
        return clean[:80]


def _address(row: dict[str, str]) -> str:
    locality = " ".join(part for part in (row.get("City", "").strip(), row.get("State", "").strip(), row.get("Zip", "").strip()) if part)
    return ", ".join(part for part in (row.get("Street", "").strip(), locality, row.get("Country", "").strip()) if part)


def _sheet_rows(content: str) -> list[dict[str, str]]:
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
    headers = set(reader.fieldnames or ())
    missing = sorted(REQUIRED_HEADERS - headers)
    if missing:
        raise RuntimeError(f"Google Sheet is missing required columns: {', '.join(missing)}")
    return [{str(key): str(value or "") for key, value in row.items()} for row in reader]


def _scope_id(team_id: str) -> str:
    return str(get_user_workspace_dir() / "teams" / team_id / "pi_agent")


def sync_public_sheet() -> dict[str, int]:
    url = os.getenv("GOOGLE_SHEETS_LEADS_CSV_URL", "").strip()
    team_id = os.getenv("GOOGLE_SHEETS_CRM_TEAM_ID", "").strip()
    if not url or not team_id:
        raise RuntimeError("Google Sheets lead sync is not configured")

    request = urllib.request.Request(url, headers={"User-Agent": "DeepCanvasCRM/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310 - configured public feed
        content = response.read().decode("utf-8-sig")
    rows = _sheet_rows(content)
    now = _now_iso()
    scope = _scope_id(team_id)
    stats = {"rows": len(rows), "added": 0, "updated": 0, "duplicates": 0, "invalid": 0}

    with auth._connection() as con:  # noqa: SLF001 - product persistence boundary
        stored = con.execute(
            "SELECT payload FROM feature_state WHERE scope_id = ? AND feature = 'crm' FOR UPDATE",
            (scope,),
        ).fetchone()
        if not stored:
            raise RuntimeError(f"Shared CRM scope was not found for team {team_id}")
        payload = json.loads(stored["payload"])
        leads = payload.get("leads") if isinstance(payload.get("leads"), list) else []
        by_identity: dict[str, dict[str, Any]] = {}
        for lead in leads:
            if not isinstance(lead, dict):
                continue
            email = _email(lead.get("email"))
            phone = _phone(lead.get("phone"))
            if email:
                by_identity.setdefault(f"email:{email}", lead)
            if phone:
                by_identity.setdefault(f"phone:{phone}", lead)

        added: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            email = _email(row.get("Email"))
            phone = _phone(row.get("Phone"))
            if not email and not phone:
                stats["invalid"] += 1
                continue
            key = _identity(email, phone)
            if key in seen:
                stats["duplicates"] += 1
                continue
            seen.add(key)
            lead = by_identity.get(f"email:{email}") if email else None
            lead = lead or (by_identity.get(f"phone:{phone}") if phone else None)
            name = " ".join(part for part in (row.get("First Name", "").strip(), row.get("Last Name", "").strip()) if part)
            lead_name = row.get("Source", "").strip()
            created = _created_time(row.get("Added Date"), now)
            custom_updates = {
                "custom_created_time": str(row.get("Added Date") or "").strip(),
                "custom_last_purchased": str(row.get("Last Purchased") or "").strip(),
                "lead_gen_batch": "Google Sheets",
            }
            if lead is not None:
                changed = False
                for field, value in (("name", name), ("email", email), ("phone", phone), ("leadName", lead_name), ("address", _address(row))):
                    if value and lead.get(field) != value:
                        lead[field] = value
                        changed = True
                custom = dict(lead.get("customFields") or {})
                for field, value in custom_updates.items():
                    if value and custom.get(field) != value:
                        custom[field] = value
                        changed = True
                if changed:
                    lead["customFields"] = custom
                    lead["updatedAt"] = now
                    stats["updated"] += 1
                continue

            lead = {
                "id": _lead_id(email, phone), "name": name or email or phone, "leadName": lead_name,
                "company": "", "email": email, "phone": phone, "address": _address(row), "website": "",
                "owner": "", "source": "Google Sheets", "stage": "new", "status": "active", "score": 0,
                "opm": 0, "saleAmount": 0, "nextAction": "", "lastContactAt": "", "tags": [],
                "customFields": {key: value for key, value in custom_updates.items() if value},
                "notes": [], "formAnswers": {}, "isNew": True, "createdAt": created, "updatedAt": now,
            }
            added.append(lead)
            if email:
                by_identity[f"email:{email}"] = lead
            if phone:
                by_identity[f"phone:{phone}"] = lead
            stats["added"] += 1

        payload["leads"] = added + leads
        payload["lastSavedAt"] = now
        con.execute(
            "UPDATE feature_state SET payload = ?, updated_at = ? WHERE scope_id = ? AND feature = 'crm'",
            (json.dumps(payload, ensure_ascii=False, separators=(",", ":")), int(time.time()), scope),
        )
        con.commit()
    return stats


def main() -> None:
    stats = sync_public_sheet()
    print("GOOGLE_SHEETS_SYNC_OK", " ".join(f"{key}={value}" for key, value in stats.items()))


if __name__ == "__main__":
    main()
