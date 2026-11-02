"""Project Flow production RPCs for URL ingestion, workflow execution, and provider-aware generation."""

from __future__ import annotations

import asyncio
import base64
import datetime as _dt
import html
import ipaddress
import json
import logging
import os
import re
import socket
import uuid
from io import BytesIO
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import httpx
from google import genai

from . import feature_llm
from .larry_image_gen import ImageGenError, generate_image

logger = logging.getLogger(__name__)

_FAL_QUEUE_BASE = "https://queue.fal.run"
# Defaults exposed to the client when a node does not yet specify model fields.
_DEFAULT_AI_PROVIDER = "OpenAI"
_DEFAULT_AI_API_BASE = "https://api.openai.com/v1"
_DEFAULT_AI_MODEL = "gpt-5.4-mini"
_DEFAULT_VISION_BY_PROVIDER: dict[str, dict[str, str]] = {
    "openai": {"provider": "OpenAI", "api_base": "https://api.openai.com/v1", "model": "gpt-image-1"},
    "google": {"provider": "Google", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "imagen-4.0-generate-preview"},
    "gemini": {"provider": "Gemini", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "gemini-2.5-flash-image"},
    "falai": {"provider": "FalAI", "api_base": "https://fal.run/", "model": "fal-ai/flux/dev"},
}
_DEFAULT_VIDEO_BY_PROVIDER: dict[str, dict[str, str]] = {
    "openai": {"provider": "OpenAI", "api_base": "https://api.openai.com/v1", "model": "sora-2"},
    "google": {"provider": "Google", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "veo-3.0-generate-preview"},
    "gemini": {"provider": "Gemini", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "veo-3.0-generate-preview"},
    "falai": {"provider": "FalAI", "api_base": "https://fal.run/", "model": "fal-ai/kling-video/v2.1/master/text-to-video"},
}
_DEFAULT_AUDIO_BY_PROVIDER: dict[str, dict[str, str]] = {
    "openai": {"provider": "OpenAI", "api_base": "https://api.openai.com/v1", "model": "gpt-4o-mini-transcribe"},
    "google": {"provider": "Google", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "gemini-2.5-flash"},
    "gemini": {"provider": "Gemini", "api_base": "https://generativelanguage.googleapis.com/v1beta/openai/", "model": "gemini-2.5-flash"},
}


class _PageTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.description = ""
        self._in_title = False
        self._skip_depth = 0
        self._chunks: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"}:
            self._skip_depth += 1
            return
        if tag == "title":
            self._in_title = True
            return
        if tag == "meta":
            attr_map = {key.lower(): (value or "") for key, value in attrs}
            name = attr_map.get("name", "").lower()
            prop = attr_map.get("property", "").lower()
            if name == "description" or prop == "og:description":
                self.description = _clean_text(attr_map.get("content", ""))[:700]

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        if tag in {"script", "style", "noscript", "svg"} and self._skip_depth:
            self._skip_depth -= 1
            return
        if tag == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._skip_depth:
            return
        clean = _clean_text(data)
        if not clean:
            return
        if self._in_title:
            self.title = _clean_text(f"{self.title} {clean}")[:180]
            return
        if len(clean) > 2:
            self._chunks.append(clean)

    @property
    def text(self) -> str:
        return _clean_text(" ".join(self._chunks))


def _now_iso() -> str:
    return _dt.datetime.now().isoformat(timespec="seconds")


def _clean_text(value: Any) -> str:
    return re.sub(r"\s+", " ", html.unescape(str(value or ""))).strip()


def _clip(value: str, limit: int = 280) -> str:
    value = _clean_text(value)
    return value if len(value) <= limit else f"{value[: limit - 3].rstrip()}..."


def _provider_alias(provider: Any) -> str:
    value = _clean_text(provider).lower().replace(" ", "")
    aliases = {
        "openai-compatible": "openai",
        "googlegemini": "gemini",
        "fal": "falai",
        "fal.ai": "falai",
    }
    return aliases.get(value, value or "openai")


def _provider_key_for_env(provider: str) -> str:
    provider_key = _provider_alias(provider)
    if provider_key == "falai":
        return "falai"
    return provider_key


def _pick_provider_defaults(bucket: str, provider: Any) -> dict[str, str]:
    provider_key = _provider_alias(provider)
    if bucket == "vision":
        return _DEFAULT_VISION_BY_PROVIDER.get(provider_key, _DEFAULT_VISION_BY_PROVIDER["openai"])
    if bucket == "video":
        return _DEFAULT_VIDEO_BY_PROVIDER.get(provider_key, _DEFAULT_VIDEO_BY_PROVIDER["falai"])
    if bucket == "audio":
        return _DEFAULT_AUDIO_BY_PROVIDER.get(provider_key, _DEFAULT_AUDIO_BY_PROVIDER["openai"])
    return feature_llm.provider_defaults(provider)


def _provider_api_key(provider: Any, *, bucket: str = "chat") -> str:
    provider_key = _provider_alias(provider)
    if bucket == "vision":
        if provider_key == "openai":
            return feature_llm.first_value(os.environ.get("VISION_API_KEY"), os.environ.get("OPENAI_API_KEY"), os.environ.get("API_KEY"))
        if provider_key in {"google", "gemini"}:
            return feature_llm.first_value(os.environ.get("VISION_API_KEY"), os.environ.get("GOOGLE_API_KEY"), os.environ.get("GEMINI_API_KEY"), os.environ.get("API_KEY"))
        if provider_key == "falai":
            return feature_llm.first_value(os.environ.get("FAL_API_KEY"), os.environ.get("FAL_KEY"))
    if bucket == "video":
        if provider_key in {"openai", "google", "gemini"}:
            return feature_llm.first_value(os.environ.get("VIDEO_API_KEY"), *_provider_specific_key_values(provider_key), os.environ.get("API_KEY"))
        if provider_key == "falai":
            return feature_llm.first_value(os.environ.get("FAL_API_KEY"), os.environ.get("FAL_KEY"))
    if bucket == "audio":
        return feature_llm.first_value(os.environ.get("AUDIO_API_KEY"), *_provider_specific_key_values(provider_key), os.environ.get("API_KEY"))
    return feature_llm.resolve_config({"provider": provider}).get("api_key", "")


def _provider_specific_key_values(provider_key: str) -> tuple[str, ...]:
    if provider_key == "openai":
        return (os.environ.get("OPENAI_API_KEY", ""),)
    if provider_key in {"google", "gemini"}:
        return (os.environ.get("GOOGLE_API_KEY", ""), os.environ.get("GEMINI_API_KEY", ""))
    if provider_key == "anthropic":
        return (os.environ.get("ANTHROPIC_API_KEY", ""),)
    return ()


def _resolve_runtime_provider(bucket: str) -> dict[str, Any]:
    env_provider_key = {
        "vision": "VISION_PROVIDER",
        "video": "VIDEO_PROVIDER",
        "audio": "AUDIO_PROVIDER",
    }.get(bucket)
    configured = feature_llm.resolve_config()
    provider = feature_llm.first_value(os.environ.get(env_provider_key or ""), configured.get("provider"))
    defaults = _pick_provider_defaults(bucket, provider)
    provider_name = defaults["provider"]
    api_key = _provider_api_key(provider_name, bucket=bucket)
    return {
        "provider": provider_name,
        "api_base": feature_llm.first_value(
            os.environ.get({
                "vision": "VISION_API_BASE",
                "video": "VIDEO_API_BASE",
                "audio": "AUDIO_API_BASE",
            }.get(bucket, "") or ""),
            defaults.get("api_base"),
        ),
        "model": feature_llm.first_value(
            os.environ.get({
                "vision": "VISION_MODEL_NAME",
                "video": "VIDEO_MODEL_NAME",
                "audio": "AUDIO_MODEL_NAME",
            }.get(bucket, "") or ""),
            defaults.get("model"),
        ),
        "api_key_configured": bool(api_key),
    }


def _runtime_defaults_payload() -> dict[str, Any]:
    ai = feature_llm.resolve_config()
    return {
        "ai": {
            "provider": ai.get("provider") or _DEFAULT_AI_PROVIDER,
            "api_base": ai.get("api_base") or _DEFAULT_AI_API_BASE,
            "model": ai.get("model") or _DEFAULT_AI_MODEL,
            "api_key_configured": bool(ai.get("api_key")),
        },
        "vision": _resolve_runtime_provider("vision"),
        "video": _resolve_runtime_provider("video"),
        "audio": _resolve_runtime_provider("audio"),
        "falConfigured": bool(feature_llm.first_value(os.environ.get("FAL_API_KEY"), os.environ.get("FAL_KEY"))),
        "githubTokenConfigured": bool(feature_llm.first_value(os.environ.get("GITHUB_TOKEN"), os.environ.get("github_token"))),
    }


def _make_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:10]}"


def _safe_url(raw_url: str) -> str:
    url = raw_url.strip()
    if not url:
        raise ValueError("URL is required")
    if "://" not in url:
        url = f"https://{url}"
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Only http and https URLs can be ingested")
    host = (parsed.hostname or "").lower()
    if host in {"localhost", "0.0.0.0"} or host.endswith(".local"):
        raise ValueError("Local URLs cannot be ingested")
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
            raise ValueError("Private network URLs cannot be ingested")
    except ValueError as exc:
        if "URLs cannot" in str(exc):
            raise
    try:
        resolved = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
        for item in resolved[:6]:
            ip = ipaddress.ip_address(item[4][0])
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                raise ValueError("Private network URLs cannot be ingested")
    except socket.gaierror:
        raise ValueError("URL host could not be resolved") from None
    return url


async def _fetch_page(url: str) -> dict[str, str]:
    headers = {
        "User-Agent": "ExclawProjectFlow/1.0 (+https://exclaw.ai)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.7",
    }
    async with httpx.AsyncClient(timeout=20.0, follow_redirects=True, headers=headers) as client:
        response = await client.get(url)
        response.raise_for_status()
    parser = _PageTextParser()
    content_type = response.headers.get("content-type", "")
    body = response.text[:220000]
    if "html" in content_type.lower() or "<html" in body[:2000].lower():
        parser.feed(body)
        text = parser.text
        title = parser.title
        description = parser.description
    else:
        text = _clean_text(body)
        title = urlparse(str(response.url)).hostname or "Ingested URL"
        description = ""
    parsed = urlparse(str(response.url))
    return {
        "url": str(response.url),
        "host": parsed.hostname or urlparse(url).hostname or "website",
        "title": title or parsed.hostname or "Ingested URL",
        "description": description,
        "text": text[:18000],
    }


def _extract_keywords(text: str, limit: int = 7) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9'-]{3,}", text.lower())
    stop = {
        "that", "this", "with", "from", "your", "have", "will", "their", "about", "more", "what", "when", "where",
        "which", "into", "using", "used", "were", "been", "they", "them", "then", "than", "only", "also", "over",
        "home", "page", "click", "learn", "contact", "privacy", "terms", "copyright", "reserved", "cookie",
    }
    counts: dict[str, int] = {}
    for word in words:
        if word in stop or len(word) < 4:
            continue
        counts[word] = counts.get(word, 0) + 1
    return [word for word, _count in sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def _node(kind: str, x: int, y: int, **data: Any) -> dict[str, Any]:
    accent_by_kind = {
        "project": "#2dd4bf",
        "note": "#f59e0b",
        "story": "#f472b6",
        "art": "#a78bfa",
        "url": "#14b8a6",
        "audio": "#06b6d4",
        "ai": "#8b5cf6",
        "workflow": "#14b8a6",
        "imageGenerator": "#ec4899",
        "videoGenerator": "#f43f5e",
    }
    icon_by_kind = {
        "project": "TK",
        "note": "NT",
        "story": "SB",
        "art": "AR",
        "url": "URL",
        "audio": "AUD",
        "ai": "AI",
        "workflow": "RUN",
        "imageGenerator": "IMG+",
        "videoGenerator": "VID+",
    }
    media_defaults = _pick_provider_defaults("video" if kind == "videoGenerator" else "vision", data.get("mediaProvider"))
    node_data = {
        "kind": kind,
        "title": data.pop("title", "Node"),
        "subtitle": data.pop("subtitle", ""),
        "body": data.pop("body", ""),
        "tags": data.pop("tags", []),
        "accent": data.pop("accent", accent_by_kind.get(kind, "#2dd4bf")),
        "icon": data.pop("icon", icon_by_kind.get(kind, "NT")),
        "checklist": data.pop("checklist", []),
        "url": data.pop("url", ""),
        "fileName": data.pop("fileName", ""),
        "fileType": data.pop("fileType", ""),
        "fileSizeLabel": data.pop("fileSizeLabel", ""),
        "mediaSrc": data.pop("mediaSrc", ""),
        "previewMode": data.pop("previewMode", "cover"),
        "audioTranscript": data.pop("audioTranscript", ""),
        "audioDurationLabel": data.pop("audioDurationLabel", ""),
        "drawingStrokes": data.pop("drawingStrokes", []),
        "drawingBackground": data.pop("drawingBackground", "#081018"),
        "aiProvider": data.pop("aiProvider", _DEFAULT_AI_PROVIDER),
        "aiApiBase": data.pop("aiApiBase", _DEFAULT_AI_API_BASE),
        "aiApiKey": data.pop("aiApiKey", ""),
        "aiModel": data.pop("aiModel", _DEFAULT_AI_MODEL),
        "aiPrompt": data.pop("aiPrompt", "Analyze the connected nodes and recommend next steps."),
        "aiResult": data.pop("aiResult", ""),
        "aiMessages": data.pop("aiMessages", []),
        "workflowRole": data.pop("workflowRole", "runner" if kind == "workflow" else "assistant"),
        "workflowStatus": data.pop("workflowStatus", ""),
        "workflowResult": data.pop("workflowResult", ""),
        "mediaProvider": data.pop("mediaProvider", media_defaults["provider"]),
        "mediaApiBase": data.pop("mediaApiBase", media_defaults["api_base"]),
        "mediaApiKey": data.pop("mediaApiKey", ""),
        "mediaModel": data.pop("mediaModel", media_defaults["model"]),
        "mediaPrompt": data.pop("mediaPrompt", ""),
        "mediaRequestId": data.pop("mediaRequestId", ""),
        "mediaStatus": data.pop("mediaStatus", ""),
        "mediaResultUrl": data.pop("mediaResultUrl", ""),
        "lastRunAt": data.pop("lastRunAt", ""),
    }
    node_data.update(data)
    return {"id": _make_id("node"), "type": "projectFlowNode", "position": {"x": x, "y": y}, "data": node_data}


def _edge(source: str, target: str, label: str = "") -> dict[str, Any]:
    return {
        "id": _make_id("edge"),
        "source": source,
        "target": target,
        "label": label,
        "type": "smoothstep",
        "animated": False,
        "markerEnd": {"type": "arrowclosed"},
    }


def _build_url_snapshot(page: dict[str, str], *, snap_to_grid: bool = True, show_grid: bool = True) -> dict[str, Any]:
    text = page["text"]
    description = page["description"] or _clip(text, 360)
    keywords = _extract_keywords(f"{page['title']} {description} {text}")
    keyword_text = ", ".join(keywords) or "audience, offer, proof, creative, conversion"
    title = _clip(page["title"], 52)

    source = _node("url", 80, 170, title=title, subtitle=page["host"], url=page["url"], body=description, tags=["ingested", "source"])
    brand = _node(
        "art",
        360,
        80,
        title="Brand signals",
        subtitle="Extracted from page",
        body=f"Primary signals: {keyword_text}.\n\nPositioning notes: {description}",
        tags=["brand", "voice"],
    )
    audience = _node(
        "note",
        360,
        290,
        title="Audience + offer",
        subtitle="Marketing angle",
        body=f"Use the page copy to identify the highest-intent buyer, core pain, promise, proof, and offer. Keywords: {keyword_text}.",
        tags=["audience", "offer"],
    )
    ad_plan = _node(
        "story",
        640,
        80,
        title="Ad storyboard",
        subtitle="Hook -> proof -> CTA",
        body="Frame 1: hook the pain. Frame 2: show product proof. Frame 3: make the CTA clear.",
        tags=["ads", "storyboard"],
    )
    ai = _node(
        "ai",
        650,
        300,
        title="Marketing strategist",
        subtitle="Connected-context AI",
        aiPrompt="Build a professional campaign from the connected URL and notes. Include audience, offer, landing-page structure, ad hooks, visual prompts, and next tasks.",
        body="Run this node after editing the connected marketing notes.",
        tags=["ai", "strategy"],
    )
    image = _node(
        "imageGenerator",
        950,
        90,
        title="Campaign image",
        subtitle="Provider visual",
        mediaPrompt=f"Create a premium marketing image for {title}. Brand signals: {keyword_text}. Clear product/value proposition, polished ad creative.",
        tags=["image", "ad"],
    )
    video = _node(
        "videoGenerator",
        950,
        310,
        title="Short ad video",
        subtitle="Provider motion",
        mediaProvider="FalAI",
        mediaModel="fal-ai/kling-video/v2.1/master/text-to-video",
        mediaPrompt=f"Create a short product ad video concept for {title}. Hook, product benefit, proof, and CTA. Brand signals: {keyword_text}.",
        tags=["video", "ad"],
    )
    workflow = _node("workflow", 1230, 220, title="Campaign runner", subtitle="Execute flow", body="Run the connected campaign strategy and generator nodes.", tags=["workflow", "marketing"])
    nodes = [source, brand, audience, ad_plan, ai, image, video, workflow]
    edges = [
        _edge(source["id"], brand["id"], "extracts"),
        _edge(source["id"], audience["id"], "targets"),
        _edge(audience["id"], ad_plan["id"], "frames"),
        _edge(brand["id"], ai["id"], "brand"),
        _edge(audience["id"], ai["id"], "offer"),
        _edge(ad_plan["id"], ai["id"], "story"),
        _edge(ai["id"], image["id"], "visual brief"),
        _edge(ai["id"], video["id"], "motion brief"),
        _edge(ai["id"], workflow["id"], "run"),
        _edge(image["id"], workflow["id"], "asset"),
        _edge(video["id"], workflow["id"], "output"),
    ]
    return {
        "boardTitle": f"{title} campaign",
        "boardMode": "marketing",
        "nodes": nodes,
        "edges": edges,
        "selectedNodeId": ai["id"],
        "snapToGrid": snap_to_grid,
        "showMiniMap": False,
        "showGrid": show_grid,
    }


def _llm_config(overrides: dict[str, Any] | None = None) -> dict[str, str]:
    return feature_llm.resolve_config(overrides)


async def _call_llm(messages: list[dict[str, str]], overrides: dict[str, Any] | None = None) -> str:
    return await feature_llm.call_llm(
        messages,
        _llm_config(overrides),
        temperature=0.35,
        max_tokens=5000,
    )


def _node_context(node: dict[str, Any]) -> str:
    data = node.get("data") if isinstance(node.get("data"), dict) else {}
    fields = [
        f"ID: {node.get('id')}",
        f"Kind: {data.get('kind')}",
        f"Title: {data.get('title')}",
        f"Subtitle: {data.get('subtitle')}",
        f"Body: {_clip(str(data.get('body') or ''), 900)}",
    ]
    if data.get("url"):
        fields.append(f"URL: {data.get('url')}")
    if data.get("fileName"):
        fields.append(f"File: {data.get('fileName')} ({data.get('fileType') or 'unknown'})")
    if data.get("audioTranscript"):
        fields.append(f"Transcript: {_clip(str(data.get('audioTranscript') or ''), 1200)}")
    if data.get("mediaResultUrl"):
        fields.append(f"Generated asset: {data.get('mediaResultUrl')}")
    if data.get("aiResult"):
        fields.append(f"AI result: {_clip(str(data.get('aiResult') or ''), 1200)}")
    if data.get("workflowResult"):
        fields.append(f"Workflow result: {_clip(str(data.get('workflowResult') or ''), 1200)}")
    if data.get("tags"):
        fields.append(f"Tags: {', '.join(str(tag) for tag in data.get('tags', [])[:8])}")
    return "\n".join(fields)


def _connected_nodes(node_id: str, nodes: list[Any], edges: list[Any]) -> list[dict[str, Any]]:
    ids = set()
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if source == node_id and target:
            ids.add(target)
        if target == node_id and source:
            ids.add(source)
    by_id = {str(node.get("id")): node for node in nodes if isinstance(node, dict)}
    return [by_id[node_ref] for node_ref in ids if node_ref in by_id]


async def _run_connected_ai(params: dict[str, Any]) -> dict[str, Any]:
    node_id = str(params.get("nodeId") or params.get("node_id") or "").strip()
    prompt = _clean_text(params.get("prompt"))
    nodes = params.get("nodes") if isinstance(params.get("nodes"), list) else []
    edges = params.get("edges") if isinstance(params.get("edges"), list) else []
    node = params.get("node") if isinstance(params.get("node"), dict) else {}
    node_data = node.get("data") if isinstance(node.get("data"), dict) else {}
    if not node_id:
        raise ValueError("AI node id is required")
    if not prompt:
        raise ValueError("AI prompt is required")

    raw_messages = params.get("messages") if isinstance(params.get("messages"), list) else []
    chat_messages = [
        {
            "role": "assistant" if str(item.get("role") or "") == "assistant" else "user",
            "content": _clean_text(item.get("content")),
        }
        for item in raw_messages
        if isinstance(item, dict) and _clean_text(item.get("content"))
    ]

    connected = _connected_nodes(node_id, nodes, edges)
    if not connected:
        connected = [item for item in nodes if isinstance(item, dict) and str(item.get("id")) != node_id][:10]
    context = "\n\n---\n\n".join(_node_context(item) for item in connected[:14])
    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": (
                "You are the Project Flow AI node inside Exclaw. Use the connected board context and continue the local node chat. "
                "Answer follow-up questions, revise prior work when asked, and produce concrete outputs from the connected nodes. "
                "Be specific, structured, and execution-focused."
            ),
        },
        {
            "role": "user",
            "content": f"Board: {params.get('boardTitle') or 'Untitled'}\nAI node: {node_data.get('title') or node_id}\n\nConnected context:\n{context or '(none)'}",
        },
    ]
    messages.extend(chat_messages[:-1])
    messages.append(
        {
            "role": "user",
            "content": chat_messages[-1]["content"] if chat_messages else prompt,
        }
    )
    result = await _call_llm(messages, params)
    return {"result": result, "lastRunAt": _now_iso()}


def _github_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "DeepCanvasProjectFlow/1.0",
    }
    token = feature_llm.first_value(os.environ.get("GITHUB_TOKEN"), os.environ.get("github_token"))
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def _parse_github_repo_url(raw_url: str) -> dict[str, str]:
    url = _safe_url(raw_url)
    parsed = urlparse(url)
    if parsed.hostname not in {"github.com", "www.github.com"}:
        raise ValueError("GitHub ingest only accepts github.com URLs")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2:
        raise ValueError("GitHub URL must include owner and repository name")
    owner, repo = parts[0], parts[1].removesuffix(".git")
    ref = ""
    subpath = ""
    if len(parts) >= 4 and parts[2] in {"tree", "blob"}:
        ref = parts[3]
        if len(parts) > 4:
            subpath = "/".join(parts[4:])
    return {"owner": owner, "repo": repo, "ref": ref, "path": subpath, "url": url}


async def _fetch_github_repo_snapshot(url: str, *, snap_to_grid: bool = True, show_grid: bool = True) -> dict[str, Any]:
    repo_ref = _parse_github_repo_url(url)
    owner = repo_ref["owner"]
    repo = repo_ref["repo"]
    ref = repo_ref["ref"]
    subpath = repo_ref["path"].strip("/")
    repo_api = f"https://api.github.com/repos/{owner}/{repo}"
    async with httpx.AsyncClient(timeout=30.0, headers=_github_headers(), follow_redirects=True) as client:
        repo_resp = await client.get(repo_api)
        repo_resp.raise_for_status()
        repo_data = repo_resp.json()
        default_branch = ref or str(repo_data.get("default_branch") or "main")
        tree_resp = await client.get(f"{repo_api}/git/trees/{default_branch}?recursive=1")
        tree_resp.raise_for_status()
        tree_data = tree_resp.json()

    tree = tree_data.get("tree")
    if not isinstance(tree, list) or not tree:
        raise ValueError("Repository tree is empty or unavailable")

    visible_entries = []
    prefix = f"{subpath}/" if subpath else ""
    for item in tree:
        if not isinstance(item, dict):
            continue
        path = str(item.get("path") or "").strip("/")
        if not path:
            continue
        if prefix and not path.startswith(prefix):
            continue
        trimmed_path = path[len(prefix):] if prefix else path
        if not trimmed_path or trimmed_path.count("/") > 3:
            continue
        visible_entries.append({**item, "path": trimmed_path})

    if not visible_entries:
        raise ValueError("No repository files found at that GitHub path")

    directories = sorted({"/".join(str(item["path"]).split("/")[:depth]) for item in visible_entries for depth in range(1, len(str(item["path"]).split("/")))} , key=lambda value: (value.count("/"), value.lower()))
    lane: dict[int, int] = {}

    def _pos(depth: int) -> tuple[int, int]:
        row = lane.get(depth, 0)
        lane[depth] = row + 1
        return 90 + depth * 270, 100 + row * 120

    nodes: list[dict[str, Any]] = []
    edges: list[dict[str, Any]] = []
    lookup: dict[str, str] = {}

    root = _node(
        "project",
        70,
        120,
        title=repo if not subpath else f"{repo}/{subpath}",
        subtitle=f"{owner} • {default_branch}",
        body=_clip(str(repo_data.get("description") or "GitHub repository ingest."), 240),
        url=repo_ref["url"],
        tags=["github", "repo"],
    )
    nodes.append(root)
    lookup[""] = root["id"]

    for directory in directories[:60]:
        x, y = _pos(directory.count("/") + 1)
        folder = _node("project", x, y, title=directory.split("/")[-1], subtitle="Folder", body=directory, tags=["folder", "github"])
        nodes.append(folder)
        lookup[directory.lower()] = folder["id"]
        parent_key = "/".join(directory.split("/")[:-1]).lower()
        edges.append(_edge(lookup.get(parent_key, root["id"]), folder["id"], "contains"))

    files_added = 0
    for item in visible_entries:
        if str(item.get("type")) != "blob":
            continue
        path = str(item["path"])
        parts = path.split("/")
        x, y = _pos(len(parts) + 1)
        ext = os.path.splitext(path)[1].lower()
        if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
            kind = "image"
        elif ext in {".mp4", ".mov", ".webm", ".m4v"}:
            kind = "video"
        elif ext in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}:
            kind = "audio"
        elif ext in {".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".swift", ".sql"}:
            kind = "code"
        else:
            kind = "document"
        node = _node(
            kind,
            x,
            y,
            title=parts[-1],
            subtitle=("/".join(parts[:-1]) or "Root"),
            body=f"GitHub blob • {path}",
            fileName=parts[-1],
            fileType="application/octet-stream",
            fileSizeLabel=f"{int(item.get('size') or 0) // 1024} KB" if item.get("size") else "",
            url=f"https://github.com/{owner}/{repo}/blob/{default_branch}/{prefix}{path}",
            tags=["github", kind],
        )
        nodes.append(node)
        parent_key = "/".join(parts[:-1]).lower()
        edges.append(_edge(lookup.get(parent_key, root["id"]), node["id"], "contains"))
        files_added += 1
        if files_added >= 72:
            break

    review = _node(
        "ai",
        930,
        180,
        title="Repo diagram AI",
        subtitle="Architecture reader",
        aiPrompt="Analyze the connected repository map. Summarize the architecture, major subsystems, likely tech stack, hotspots, and next review priorities. Output a clear repo diagram narrative.",
        body="Run this after inspecting the ingested repository graph.",
        tags=["github", "analysis"],
    )
    workflow = _node(
        "workflow",
        1210,
        180,
        title="Repo workflow",
        subtitle="Run AI review",
        body="Execute the connected repository analysis flow.",
        tags=["github", "workflow"],
    )
    nodes.extend([review, workflow])
    edges.append(_edge(root["id"], review["id"], "analyze"))
    edges.append(_edge(review["id"], workflow["id"], "run"))

    return {
        "snapshot": {
            "boardTitle": root["data"]["title"],
            "boardMode": "codebase",
            "nodes": nodes,
            "edges": edges,
            "selectedNodeId": review["id"],
            "snapToGrid": snap_to_grid,
            "showMiniMap": False,
            "showGrid": show_grid,
        },
        "message": f"Ingested GitHub repository {owner}/{repo} into a repo diagram.",
    }


async def _generate_gemini_image(prompt: str, *, api_key: str, model: str) -> bytes:
    if not api_key:
        raise ValueError("Gemini image generation requires a Google/Gemini API key")
    client = genai.Client(api_key=api_key)
    response = client.models.generate_content(model=model or "gemini-2.5-flash-image", contents=[prompt])
    parts = []
    if getattr(response, "parts", None):
        parts = list(response.parts)
    else:
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            content = getattr(candidates[0], "content", None)
            parts = list(getattr(content, "parts", None) or [])
    for part in parts:
        inline_data = getattr(part, "inline_data", None)
        data = getattr(inline_data, "data", None)
        if data:
            return bytes(data)
    raise ValueError("Gemini did not return image bytes for this request")


def _bytes_to_data_url(raw: bytes, *, mime: str) -> str:
    return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"


def _guess_audio_mime(file_name: str, file_type: str) -> str:
    if file_type and "/" in file_type:
        return file_type
    extension = os.path.splitext(file_name)[1].lower()
    return {
        ".mp3": "audio/mpeg",
        ".wav": "audio/wav",
        ".m4a": "audio/mp4",
        ".aac": "audio/aac",
        ".ogg": "audio/ogg",
        ".flac": "audio/flac",
    }.get(extension, "audio/mpeg")


async def _transcribe_audio(params: dict[str, Any]) -> dict[str, Any]:
    media_src = str(params.get("mediaSrc") or "").strip()
    file_name = str(params.get("fileName") or "audio.mp3").strip() or "audio.mp3"
    if not media_src.startswith("data:"):
        raise ValueError("Audio node must contain an uploaded audio file before transcription")
    match = re.match(r"^data:([^;]+);base64,(.+)$", media_src, re.DOTALL)
    if not match:
        raise ValueError("Audio data URL is invalid")
    mime, b64 = match.groups()
    audio_bytes = base64.b64decode(b64)
    api_key = _provider_api_key("OpenAI", bucket="audio")
    api_base = feature_llm.first_value(os.environ.get("AUDIO_API_BASE"), os.environ.get("API_BASE"), "https://api.openai.com/v1").rstrip("/")
    model = feature_llm.first_value(os.environ.get("AUDIO_MODEL_NAME"), "gpt-4o-mini-transcribe")
    if not api_key:
        raise ValueError("Audio transcription needs an audio/OpenAI API key in configuration")
    files = {"file": (file_name, audio_bytes, mime or _guess_audio_mime(file_name, ""))}
    data = {"model": model}
    async with httpx.AsyncClient(timeout=180.0) as client:
        response = await client.post(
            f"{api_base}/audio/transcriptions",
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files=files,
        )
        response.raise_for_status()
    payload = response.json()
    transcript = _clean_text(payload.get("text") or "")
    if not transcript:
        raise ValueError("Audio transcription returned no text")
    return {"transcript": transcript, "lastRunAt": _now_iso()}


def _fal_headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Key {api_key}", "Content-Type": "application/json"}


def _extract_media_url(value: Any) -> str:
    if isinstance(value, str):
        return value if value.startswith(("http://", "https://")) else ""
    if isinstance(value, list):
        for item in value:
            found = _extract_media_url(item)
            if found:
                return found
    if isinstance(value, dict):
        for key in ("url", "content_url", "file_url", "video_url", "image_url"):
            found = _extract_media_url(value.get(key))
            if found:
                return found
        for key in ("images", "videos", "video", "image", "output", "data"):
            found = _extract_media_url(value.get(key))
            if found:
                return found
    return ""


async def _fal_generate(params: dict[str, Any]) -> dict[str, Any]:
    api_key = str(params.get("apiKey") or params.get("api_key") or "").strip()
    endpoint = str(params.get("endpoint") or "").strip().strip("/")
    prompt = _clean_text(params.get("prompt"))
    if not api_key:
        raise ValueError("FAL API key is required on the generator node")
    if not endpoint or "://" in endpoint or endpoint.startswith("."):
        raise ValueError("Valid fal.ai endpoint is required")
    if not prompt:
        raise ValueError("Generation prompt is required")

    context_nodes = _connected_nodes(str(params.get("nodeId") or ""), params.get("nodes") or [], params.get("edges") or [])
    context = "\n\n".join(_node_context(item) for item in context_nodes[:6])
    enhanced_prompt = prompt if not context else f"{prompt}\n\nConnected Project Flow context:\n{context}"
    request_body = {"prompt": enhanced_prompt}

    async with httpx.AsyncClient(timeout=150.0) as client:
        submit = await client.post(f"{_FAL_QUEUE_BASE}/{endpoint}", headers=_fal_headers(api_key), json=request_body)
        submit.raise_for_status()
        submit_data = submit.json()

        result_data = submit_data
        status = str(submit_data.get("status") or "submitted") if isinstance(submit_data, dict) else "submitted"
        status_url = str(submit_data.get("status_url") or "") if isinstance(submit_data, dict) else ""
        response_url = str(submit_data.get("response_url") or "") if isinstance(submit_data, dict) else ""
        request_id = str(submit_data.get("request_id") or submit_data.get("requestId") or "") if isinstance(submit_data, dict) else ""

        for _attempt in range(60):
            direct_url = _extract_media_url(result_data)
            if direct_url and status.lower() not in {"in_queue", "in_progress", "submitted"}:
                return {"resultUrl": direct_url, "requestId": request_id, "status": status or "completed", "lastRunAt": _now_iso()}
            if response_url and status.upper() == "COMPLETED":
                result = await client.get(response_url, headers=_fal_headers(api_key))
                result.raise_for_status()
                result_data = result.json()
                return {"resultUrl": _extract_media_url(result_data), "requestId": request_id, "status": "completed", "lastRunAt": _now_iso()}
            if not status_url:
                break
            await asyncio.sleep(1.5)
            status_response = await client.get(status_url, headers=_fal_headers(api_key))
            status_response.raise_for_status()
            result_data = status_response.json()
            if isinstance(result_data, dict):
                status = str(result_data.get("status") or status)
                response_url = str(result_data.get("response_url") or response_url)
                request_id = str(result_data.get("request_id") or request_id)

        direct_url = _extract_media_url(result_data)
        return {"resultUrl": direct_url, "requestId": request_id, "status": status, "lastRunAt": _now_iso()}


async def _generate_media(params: dict[str, Any]) -> dict[str, Any]:
    kind = str(params.get("kind") or "imageGenerator").strip()
    prompt = _clean_text(params.get("prompt"))
    if not prompt:
        raise ValueError("Generation prompt is required")
    provider = str(params.get("provider") or "").strip() or (
        _resolve_runtime_provider("video" if kind == "videoGenerator" else "vision")["provider"]
    )
    provider_key = _provider_alias(provider)
    model = feature_llm.first_value(params.get("model"), _pick_provider_defaults("video" if kind == "videoGenerator" else "vision", provider).get("model"))
    api_key = feature_llm.first_value(params.get("apiKey"), _provider_api_key(provider, bucket="video" if kind == "videoGenerator" else "vision"))
    context_nodes = _connected_nodes(str(params.get("nodeId") or ""), params.get("nodes") or [], params.get("edges") or [])
    context = "\n\n".join(_node_context(item) for item in context_nodes[:6])
    enhanced_prompt = prompt if not context else f"{prompt}\n\nConnected Project Flow context:\n{context}"

    if kind == "videoGenerator":
        if provider_key != "falai":
            raise ValueError("Project Flow video generation currently runs through FalAI. Set a FalAI key or switch this node to FalAI.")
        return await _fal_generate(
            {
                "apiKey": api_key,
                "endpoint": model,
                "prompt": enhanced_prompt,
                "nodeId": params.get("nodeId"),
                "nodes": params.get("nodes"),
                "edges": params.get("edges"),
            }
        )

    if provider_key == "falai":
        return await _fal_generate(
            {
                "apiKey": api_key,
                "endpoint": model,
                "prompt": enhanced_prompt,
                "nodeId": params.get("nodeId"),
                "nodes": params.get("nodes"),
                "edges": params.get("edges"),
            }
        )
    if provider_key == "openai":
        raw = await generate_image(enhanced_prompt, provider="openai", api_key=api_key, model=model)
        return {"resultUrl": _bytes_to_data_url(raw, mime="image/png"), "requestId": "", "status": "completed", "lastRunAt": _now_iso()}
    if provider_key in {"google", "gemini"}:
        raw = await _generate_gemini_image(enhanced_prompt, api_key=api_key, model=model)
        return {"resultUrl": _bytes_to_data_url(raw, mime="image/png"), "requestId": "", "status": "completed", "lastRunAt": _now_iso()}
    raise ValueError(f"Unsupported Project Flow media provider: {provider}")


def _topological_node_ids(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> list[str]:
    ids = [str(node.get("id")) for node in nodes if isinstance(node, dict) and node.get("id")]
    indegree = {node_id: 0 for node_id in ids}
    outgoing: dict[str, list[str]] = {node_id: [] for node_id in ids}
    for edge in edges:
        if not isinstance(edge, dict):
            continue
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if source in indegree and target in indegree:
            indegree[target] += 1
            outgoing[source].append(target)
    queue = [node_id for node_id, degree in indegree.items() if degree == 0]
    ordered: list[str] = []
    while queue:
        current = queue.pop(0)
        ordered.append(current)
        for target in outgoing.get(current, []):
            indegree[target] -= 1
            if indegree[target] == 0:
                queue.append(target)
    for node_id in ids:
        if node_id not in ordered:
            ordered.append(node_id)
    return ordered


async def _run_workflow(params: dict[str, Any]) -> dict[str, Any]:
    nodes = [node for node in (params.get("nodes") or []) if isinstance(node, dict)]
    edges = [edge for edge in (params.get("edges") or []) if isinstance(edge, dict)]
    board_title = str(params.get("boardTitle") or "Untitled")
    if not nodes:
        raise ValueError("Workflow has no nodes to run")
    node_by_id = {str(node.get("id")): json.loads(json.dumps(node)) for node in nodes}
    ordered_ids = _topological_node_ids(nodes, edges)
    steps: list[str] = []

    for node_id in ordered_ids:
        node = node_by_id.get(node_id)
        if not node:
            continue
        data = node.get("data") if isinstance(node.get("data"), dict) else {}
        kind = str(data.get("kind") or "")
        if kind == "audio" and data.get("mediaSrc") and not data.get("audioTranscript"):
            result = await _transcribe_audio({"mediaSrc": data.get("mediaSrc"), "fileName": data.get("fileName")})
            data["audioTranscript"] = result["transcript"]
            data["lastRunAt"] = result["lastRunAt"]
            steps.append(f"transcribed {data.get('title') or 'audio'}")
        elif kind == "ai":
            prior_messages = data.get("aiMessages") if isinstance(data.get("aiMessages"), list) else []
            workflow_prompt = data.get("aiPrompt") or "Analyze the connected workflow and produce the next output."
            workflow_messages = list(prior_messages) + [{"id": _make_id("ai_msg"), "role": "user", "content": workflow_prompt}]
            result = await _run_connected_ai(
                {
                    "boardTitle": board_title,
                    "nodeId": node_id,
                    "node": node,
                    "nodes": list(node_by_id.values()),
                    "edges": edges,
                    "prompt": workflow_prompt,
                    "messages": workflow_messages,
                    "provider": data.get("aiProvider"),
                    "apiBase": data.get("aiApiBase"),
                    "apiKey": data.get("aiApiKey"),
                    "model": data.get("aiModel"),
                }
            )
            data["aiResult"] = result["result"]
            data["aiMessages"] = workflow_messages + [{"id": _make_id("ai_msg"), "role": "assistant", "content": result["result"]}]
            data["lastRunAt"] = result["lastRunAt"]
            steps.append(f"ran {data.get('title') or 'AI node'}")
        elif kind in {"imageGenerator", "videoGenerator"}:
            result = await _generate_media(
                {
                    "kind": kind,
                    "boardTitle": board_title,
                    "nodeId": node_id,
                    "node": node,
                    "nodes": list(node_by_id.values()),
                    "edges": edges,
                    "provider": data.get("mediaProvider"),
                    "apiBase": data.get("mediaApiBase"),
                    "apiKey": data.get("mediaApiKey"),
                    "model": data.get("mediaModel"),
                    "prompt": data.get("mediaPrompt"),
                }
            )
            data["mediaResultUrl"] = result.get("resultUrl") or ""
            data["mediaRequestId"] = result.get("requestId") or ""
            data["mediaStatus"] = result.get("status") or "completed"
            data["mediaSrc"] = result.get("resultUrl") or data.get("mediaSrc") or ""
            data["lastRunAt"] = result.get("lastRunAt") or _now_iso()
            steps.append(f"generated {data.get('title') or kind}")
        elif kind == "workflow":
            data["workflowStatus"] = "completed"
            data["workflowResult"] = "Workflow completed:\n- " + "\n- ".join(steps) if steps else "Workflow completed with no runnable nodes."
            data["lastRunAt"] = _now_iso()

    return {"nodes": list(node_by_id.values()), "summary": "Workflow completed." if steps else "No runnable steps were found.", "steps": steps, "lastRunAt": _now_iso()}


def register_project_flow_handlers(channel: Any) -> None:
    """Register ``project_flow.*`` RPC methods on the given web channel."""

    async def _fail(ws, req_id, message: str, code: str = "BAD_REQUEST") -> None:
        await channel.send_response(ws, req_id, ok=False, error=message, code=code)

    def _params(params: Any) -> dict[str, Any]:
        return params if isinstance(params, dict) else {}

    async def _ingest_url(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            p = _params(params)
            url = _safe_url(str(p.get("url") or ""))
            page = await _fetch_page(url)
            snapshot = _build_url_snapshot(page, snap_to_grid=bool(p.get("snapToGrid", True)), show_grid=bool(p.get("showGrid", True)))
            await channel.send_response(ws, req_id, ok=True, payload={"snapshot": snapshot, "message": f"Ingested {page['host']} into a marketing flow."})
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            await _fail(ws, req_id, f"URL fetch failed with HTTP {exc.response.status_code}", code="FETCH_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.ingest_url] %s", exc)
            await _fail(ws, req_id, "URL ingestion failed", code="INTERNAL_ERROR")

    async def _ingest_github(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            p = _params(params)
            payload = await _fetch_github_repo_snapshot(
                str(p.get("url") or ""),
                snap_to_grid=bool(p.get("snapToGrid", True)),
                show_grid=bool(p.get("showGrid", True)),
            )
            await channel.send_response(ws, req_id, ok=True, payload=payload)
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 403:
                await _fail(ws, req_id, "GitHub rejected the request. Add a GitHub token in configuration or wait for the rate limit to reset.", code="GITHUB_FAILED")
            else:
                await _fail(ws, req_id, f"GitHub fetch failed with HTTP {exc.response.status_code}", code="GITHUB_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.ingest_github] %s", exc)
            await _fail(ws, req_id, "GitHub ingestion failed", code="INTERNAL_ERROR")

    async def _run_ai(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            await channel.send_response(ws, req_id, ok=True, payload=await _run_connected_ai(_params(params)))
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            await _fail(ws, req_id, f"LLM request failed with HTTP {exc.response.status_code}", code="LLM_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.run_ai] %s", exc)
            await _fail(ws, req_id, str(exc), code="INTERNAL_ERROR")

    async def _runtime_defaults(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            await channel.send_response(ws, req_id, ok=True, payload=_runtime_defaults_payload())
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.runtime_defaults] %s", exc)
            await _fail(ws, req_id, "Could not load Project Flow defaults", code="INTERNAL_ERROR")

    async def _generate(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            await channel.send_response(ws, req_id, ok=True, payload=await _generate_media(_params(params)))
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            await _fail(ws, req_id, f"Media generation failed with HTTP {exc.response.status_code}", code="MEDIA_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.generate_media] %s", exc)
            await _fail(ws, req_id, str(exc), code="INTERNAL_ERROR")

    async def _transcribe(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            await channel.send_response(ws, req_id, ok=True, payload=await _transcribe_audio(_params(params)))
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            await _fail(ws, req_id, f"Audio transcription failed with HTTP {exc.response.status_code}", code="AUDIO_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.transcribe_audio] %s", exc)
            await _fail(ws, req_id, str(exc), code="INTERNAL_ERROR")

    async def _workflow(ws, req_id, params, session_id):  # noqa: ANN001
        try:
            await channel.send_response(ws, req_id, ok=True, payload=await _run_workflow(_params(params)))
        except ValueError as exc:
            await _fail(ws, req_id, str(exc))
        except httpx.HTTPStatusError as exc:
            await _fail(ws, req_id, f"Workflow execution failed with HTTP {exc.response.status_code}", code="WORKFLOW_FAILED")
        except Exception as exc:  # noqa: BLE001
            logger.exception("[project_flow.run_workflow] %s", exc)
            await _fail(ws, req_id, str(exc), code="INTERNAL_ERROR")

    channel.register_method("project_flow.ingest_url", _ingest_url)
    channel.register_method("project_flow.ingest_github", _ingest_github)
    channel.register_method("project_flow.run_ai", _run_ai)
    channel.register_method("project_flow.runtime_defaults", _runtime_defaults)
    channel.register_method("project_flow.generate_media", _generate)
    channel.register_method("project_flow.transcribe_audio", _transcribe)
    channel.register_method("project_flow.run_workflow", _workflow)
    logger.info("[project_flow] registered 7 RPC methods")
