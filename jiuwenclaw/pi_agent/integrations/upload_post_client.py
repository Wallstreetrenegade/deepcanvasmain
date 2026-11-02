# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Async client for the Upload-Post REST API.

Docs: https://docs.upload-post.com

All requests authenticate via ``Authorization: Apikey <key>``.
Responses are returned as parsed JSON dicts; the client raises
``UploadPostError`` for non-2xx responses and ``UploadPostAuthError`` for 401.
"""

from __future__ import annotations

import logging
from typing import Any, Iterable, Optional

import httpx

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.upload-post.com/api"
DEFAULT_TIMEOUT = 60.0


class UploadPostError(RuntimeError):
    def __init__(self, status: int, message: str, payload: Any = None):
        super().__init__(f"Upload-Post {status}: {message}")
        self.status = status
        self.message = message
        self.payload = payload


class UploadPostAuthError(UploadPostError):
    pass


class UploadPostClient:
    """Async wrapper over every Upload-Post endpoint used by Jiuwen."""

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        if not api_key:
            raise ValueError("UploadPostClient requires an API key")
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    # ------------------------------------------------------------------
    # low-level helpers
    # ------------------------------------------------------------------

    def _headers(self, extra: Optional[dict] = None) -> dict:
        h = {"Authorization": f"Apikey {self.api_key}"}
        if extra:
            h.update(extra)
        return h

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[dict] = None,
        json_body: Optional[dict] = None,
        data: Optional[dict] = None,
        files: Optional[list] = None,
        headers: Optional[dict] = None,
        expect_json: bool = True,
        timeout: Optional[float] = None,
    ) -> Any:
        url = f"{self.base_url}{path}"
        async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
            try:
                resp = await client.request(
                    method,
                    url,
                    params=params,
                    json=json_body,
                    data=data,
                    files=files,
                    headers=self._headers(headers),
                )
            except httpx.HTTPError as exc:
                raise UploadPostError(0, f"transport error: {exc}") from exc

        if resp.status_code == 401:
            raise UploadPostAuthError(401, "invalid or expired API key", _safe_json(resp))
        if resp.status_code >= 400:
            payload = _safe_json(resp)
            msg = ""
            if isinstance(payload, dict):
                msg = payload.get("error") or payload.get("message") or ""
            if not msg:
                msg = resp.text[:200]
            raise UploadPostError(resp.status_code, msg or "request failed", payload)

        if not expect_json:
            return resp.content
        try:
            return resp.json()
        except ValueError:
            return {"raw": resp.text}

    # ------------------------------------------------------------------
    # Account
    # ------------------------------------------------------------------

    async def me(self) -> dict:
        return await self._request("GET", "/uploadposts/me")

    # ------------------------------------------------------------------
    # User profiles
    # ------------------------------------------------------------------

    async def list_users(self) -> dict:
        return await self._request("GET", "/uploadposts/users")

    async def create_user(self, username: str) -> dict:
        return await self._request(
            "POST", "/uploadposts/users", json_body={"username": username}
        )

    async def get_user(self, username: str) -> dict:
        return await self._request("GET", f"/uploadposts/users/{username}")

    async def delete_user(self, username: str) -> dict:
        return await self._request(
            "DELETE", "/uploadposts/users", json_body={"username": username}
        )

    async def generate_jwt(
        self,
        username: str,
        *,
        redirect_url: Optional[str] = None,
        logo_image: Optional[str] = None,
        redirect_button_text: Optional[str] = None,
        connect_title: Optional[str] = None,
        connect_description: Optional[str] = None,
        platforms: Optional[Iterable[str]] = None,
        show_calendar: Optional[bool] = None,
        readonly_calendar: Optional[bool] = None,
    ) -> dict:
        body: dict[str, Any] = {"username": username}
        if redirect_url is not None:
            body["redirect_url"] = redirect_url
        if logo_image is not None:
            body["logo_image"] = logo_image
        if redirect_button_text is not None:
            body["redirect_button_text"] = redirect_button_text
        if connect_title is not None:
            body["connect_title"] = connect_title
        if connect_description is not None:
            body["connect_description"] = connect_description
        if platforms is not None:
            body["platforms"] = list(platforms)
        if show_calendar is not None:
            body["show_calendar"] = bool(show_calendar)
        if readonly_calendar is not None:
            body["readonly_calendar"] = bool(readonly_calendar)
        return await self._request(
            "POST", "/uploadposts/users/generate-jwt", json_body=body
        )

    # ------------------------------------------------------------------
    # Uploads
    # ------------------------------------------------------------------

    async def upload_video(
        self,
        *,
        user: str,
        platforms: Iterable[str],
        video: Optional[tuple] = None,
        video_url: Optional[str] = None,
        fields: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
        timeout: float = 600.0,
    ) -> dict:
        """Upload a video. Provide either ``video`` (name, bytes, mime) or ``video_url``."""
        data = _flatten_form(fields or {}, user=user, platforms=platforms)
        if video_url:
            data["video"] = video_url
            files = None
        elif video:
            files = [("video", video)]
        else:
            raise ValueError("upload_video requires video or video_url")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/upload",
            data=data, files=files, headers=headers, timeout=timeout,
        )

    async def upload_photos(
        self,
        *,
        user: str,
        platforms: Iterable[str],
        photos: Optional[list[tuple]] = None,
        photo_urls: Optional[list[str]] = None,
        fields: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
        timeout: float = 300.0,
    ) -> dict:
        data = _flatten_form(fields or {}, user=user, platforms=platforms)
        files: list[tuple] = []
        if photo_urls:
            # Upload-Post accepts JSON array in multipart for photos[] as URLs as well,
            # but the simplest route is multi-valued form field.
            for url in photo_urls:
                files.append(("photos[]", (None, url)))
        for ph in photos or []:
            files.append(("photos[]", ph))
        if not files:
            raise ValueError("upload_photos requires at least one photo")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/upload_photos",
            data=data, files=files, headers=headers, timeout=timeout,
        )

    async def upload_text(
        self,
        *,
        user: str,
        platforms: Iterable[str],
        title: str,
        fields: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        data = _flatten_form(
            fields or {}, user=user, platforms=platforms, extras={"title": title}
        )
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/upload_text", data=data, headers=headers
        )

    async def upload_document(
        self,
        *,
        user: str,
        document: Optional[tuple] = None,
        document_url: Optional[str] = None,
        title: str,
        fields: Optional[dict] = None,
        idempotency_key: Optional[str] = None,
    ) -> dict:
        data = _flatten_form(
            fields or {}, user=user, platforms=["linkedin"], extras={"title": title}
        )
        if document_url:
            data["document"] = document_url
            files = None
        elif document:
            files = [("document", document)]
        else:
            raise ValueError("upload_document requires document or document_url")
        headers = {"Idempotency-Key": idempotency_key} if idempotency_key else None
        return await self._request(
            "POST", "/upload_document",
            data=data, files=files, headers=headers, timeout=300.0,
        )

    # ------------------------------------------------------------------
    # Status / history
    # ------------------------------------------------------------------

    async def status(
        self,
        *,
        request_id: Optional[str] = None,
        job_id: Optional[str] = None,
    ) -> dict:
        if not (request_id or job_id):
            raise ValueError("status() requires request_id or job_id")
        params: dict[str, str] = {}
        if request_id:
            params["request_id"] = request_id
        if job_id:
            params["job_id"] = job_id
        return await self._request("GET", "/uploadposts/status", params=params)

    async def history(
        self,
        page: int = 1,
        limit: int = 10,
        *,
        profile_username: Optional[str] = None,
    ) -> dict:
        params: dict[str, Any] = {"page": page, "limit": limit}
        if profile_username:
            params["profile_username"] = profile_username
        return await self._request("GET", "/uploadposts/history", params=params)

    # ------------------------------------------------------------------
    # Schedule
    # ------------------------------------------------------------------

    async def list_scheduled(self) -> Any:
        return await self._request("GET", "/uploadposts/schedule")

    async def cancel_schedule(self, job_id: str) -> dict:
        return await self._request("DELETE", f"/uploadposts/schedule/{job_id}")

    async def edit_schedule(
        self,
        job_id: str,
        *,
        scheduled_date: Optional[str] = None,
        timezone: Optional[str] = None,
        title: Optional[str] = None,
        caption: Optional[str] = None,
    ) -> dict:
        body: dict[str, Any] = {}
        if scheduled_date is not None:
            body["scheduled_date"] = scheduled_date
        if timezone is not None:
            body["timezone"] = timezone
        if title is not None:
            body["title"] = title
        if caption is not None:
            body["caption"] = caption
        return await self._request(
            "PATCH", f"/uploadposts/schedule/{job_id}", json_body=body
        )

    # ------------------------------------------------------------------
    # Queue
    # ------------------------------------------------------------------

    async def queue_settings(self, profile_username: str) -> dict:
        return await self._request(
            "GET", "/uploadposts/queue/settings",
            params={"profile_username": profile_username},
        )

    async def update_queue_settings(
        self,
        profile_username: str,
        *,
        timezone: Optional[str] = None,
        slots: Optional[list[dict]] = None,
        days_of_week: Optional[list[int]] = None,
        max_posts_per_slot: Optional[int] = None,
    ) -> dict:
        body: dict[str, Any] = {"profile_username": profile_username}
        if timezone is not None:
            body["timezone"] = timezone
        if slots is not None:
            body["slots"] = slots
        if days_of_week is not None:
            body["days_of_week"] = days_of_week
        if max_posts_per_slot is not None:
            body["max_posts_per_slot"] = max_posts_per_slot
        return await self._request(
            "POST", "/uploadposts/queue/settings", json_body=body
        )

    async def queue_preview(self, profile_username: str, count: int = 10) -> dict:
        return await self._request(
            "GET", "/uploadposts/queue/preview",
            params={"profile_username": profile_username, "count": count},
        )

    async def queue_next_slot(self, profile_username: str) -> dict:
        return await self._request(
            "GET", "/uploadposts/queue/next-slot",
            params={"profile_username": profile_username},
        )

    async def mark_slot_full(self, profile_username: str, slot_datetime: str) -> dict:
        return await self._request(
            "POST", "/uploadposts/queue/slot-full",
            json_body={"profile_username": profile_username, "slot_datetime": slot_datetime},
        )

    async def unmark_slot_full(self, profile_username: str, slot_datetime: str) -> dict:
        return await self._request(
            "DELETE", "/uploadposts/queue/slot-full",
            json_body={"profile_username": profile_username, "slot_datetime": slot_datetime},
        )

    # ------------------------------------------------------------------
    # Page / board / location lookups
    # ------------------------------------------------------------------

    async def facebook_pages(self, profile: Optional[str] = None) -> dict:
        params = {"profile": profile} if profile else None
        return await self._request("GET", "/uploadposts/facebook/pages", params=params)

    async def linkedin_pages(self, profile: Optional[str] = None) -> dict:
        params = {"profile": profile} if profile else None
        return await self._request("GET", "/uploadposts/linkedin/pages", params=params)

    async def pinterest_boards(self, profile: Optional[str] = None) -> dict:
        params = {"profile": profile} if profile else None
        return await self._request("GET", "/uploadposts/pinterest/boards", params=params)

    async def google_business_locations(self, profile: Optional[str] = None) -> dict:
        params = {"profile": profile} if profile else None
        return await self._request(
            "GET", "/uploadposts/google-business/locations", params=params
        )

    # ------------------------------------------------------------------
    # Analytics
    # ------------------------------------------------------------------

    async def analytics(
        self,
        profile_username: str,
        platforms: Iterable[str],
        *,
        page_id: Optional[str] = None,
        page_urn: Optional[str] = None,
    ) -> dict:
        params: dict[str, str] = {"platforms": ",".join(platforms)}
        if page_id:
            params["page_id"] = page_id
        if page_urn:
            params["page_urn"] = page_urn
        return await self._request(
            "GET", f"/analytics/{profile_username}", params=params
        )

    async def total_impressions(
        self,
        profile_username: str,
        *,
        period: Optional[str] = None,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        platform: Optional[str] = None,
        breakdown: Optional[bool] = None,
        metrics: Optional[Iterable[str]] = None,
    ) -> dict:
        params: dict[str, Any] = {}
        if period:
            params["period"] = period
        if start_date:
            params["start_date"] = start_date
        if end_date:
            params["end_date"] = end_date
        if platform:
            params["platform"] = platform
        if breakdown is not None:
            params["breakdown"] = "true" if breakdown else "false"
        if metrics:
            params["metrics"] = ",".join(metrics)
        return await self._request(
            "GET",
            f"/uploadposts/total-impressions/{profile_username}",
            params=params,
        )

    async def post_analytics(
        self,
        *,
        request_id: Optional[str] = None,
        platform_post_id: Optional[str] = None,
        platform: Optional[str] = None,
        user: Optional[str] = None,
    ) -> dict:
        if request_id:
            return await self._request(
                "GET", f"/uploadposts/post-analytics/{request_id}",
                params={"platform": platform} if platform else None,
            )
        if not (platform_post_id and platform and user):
            raise ValueError(
                "post_analytics requires request_id OR (platform_post_id+platform+user)"
            )
        return await self._request(
            "GET", "/uploadposts/post-analytics",
            params={
                "platform_post_id": platform_post_id,
                "platform": platform,
                "user": user,
            },
        )

    async def platform_metrics(self) -> dict:
        return await self._request("GET", "/uploadposts/platform-metrics")

    # ------------------------------------------------------------------
    # Media list
    # ------------------------------------------------------------------

    async def media_list(
        self, *, platform: str, user: str, page_urn: Optional[str] = None
    ) -> dict:
        params = {"platform": platform, "user": user}
        if page_urn:
            params["page_urn"] = page_urn
        return await self._request("GET", "/uploadposts/media", params=params)

    # ------------------------------------------------------------------
    # FFmpeg editor
    # ------------------------------------------------------------------

    async def ffmpeg_job_create(
        self,
        *,
        file: tuple,
        full_command: str,
        output_extension: str,
    ) -> dict:
        data = {"full_command": full_command, "output_extension": output_extension}
        files = [("file", file)]
        return await self._request(
            "POST", "/uploadposts/ffmpeg/editor",
            data=data, files=files, timeout=300.0,
        )

    async def ffmpeg_job_status(self, job_id: str) -> dict:
        return await self._request(
            "GET", "/uploadposts/ffmpeg/editor/status", params={"job_id": job_id}
        )

    async def ffmpeg_job_download(self, job_id: str) -> bytes:
        return await self._request(
            "GET", "/uploadposts/ffmpeg/editor/download",
            params={"job_id": job_id},
            expect_json=False,
            timeout=300.0,
        )

    # ------------------------------------------------------------------
    # Notifications / webhooks
    # ------------------------------------------------------------------

    async def notifications_set(
        self,
        *,
        webhook_url: Optional[str] = None,
        telegram_chat_id: Optional[str] = None,
        webhook_events: Optional[dict] = None,
    ) -> dict:
        body: dict[str, Any] = {}
        if webhook_url is not None:
            body["webhook_url"] = webhook_url
        if telegram_chat_id is not None:
            body["telegram_chat_id"] = telegram_chat_id
        if webhook_events is not None:
            body["webhook_events"] = webhook_events
        return await self._request(
            "POST", "/uploadposts/users/notifications", json_body=body
        )


def _safe_json(resp: httpx.Response) -> Any:
    try:
        return resp.json()
    except ValueError:
        return None


def _flatten_form(
    fields: dict,
    *,
    user: str,
    platforms: Iterable[str],
    extras: Optional[dict] = None,
) -> list[tuple[str, str]]:
    """Convert a dict of optional fields + user/platforms into multipart form tuples.

    Multi-value arrays (``platform[]``, ``tags[]``, etc.) must be sent as repeated
    tuples, which ``httpx`` supports via a list of (key, value) pairs.
    """
    out: list[tuple[str, str]] = [("user", str(user))]
    for p in platforms:
        out.append(("platform[]", str(p)))
    merged: dict[str, Any] = {}
    merged.update(fields or {})
    if extras:
        merged.update({k: v for k, v in extras.items() if v is not None})
    for k, v in merged.items():
        if v is None:
            continue
        if isinstance(v, bool):
            out.append((k, "true" if v else "false"))
        elif isinstance(v, (list, tuple)):
            key = k if k.endswith("[]") else f"{k}[]"
            for item in v:
                out.append((key, str(item)))
        else:
            out.append((k, str(v)))
    return out
