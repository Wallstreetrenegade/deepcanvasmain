# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Image generation backends for the Larry agent.

Mirrors `scripts/generate-slides.js` from the Larry skill repo:
- openai (gpt-image-1.5 — STRONGLY recommended; never gpt-image-1)
- stability (Stability AI text-to-image)
- replicate (any model via Replicate predictions API)

Each provider returns raw PNG bytes for a single 1024x1536 portrait image.
Retries with exponential-ish backoff (3000ms * attempt).
"""

from __future__ import annotations

import asyncio
import base64
import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

PORTRAIT_W = 1024
PORTRAIT_H = 1536


class ImageGenError(RuntimeError):
    pass


async def generate_openai(
    prompt: str, *, api_key: str, model: str = "gpt-image-1.5", timeout: float = 120.0
) -> bytes:
    if not api_key:
        raise ImageGenError("openai provider requires an API key")
    if model and "1.5" not in model and not model.startswith("dall-e"):
        logger.warning(
            "[larry.image] using %r — STRONGLY recommend gpt-image-1.5", model
        )
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            "https://api.openai.com/v1/images/generations",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "prompt": prompt,
                "n": 1,
                "size": f"{PORTRAIT_W}x{PORTRAIT_H}",
                "quality": "high",
            },
        )
    data = resp.json()
    if resp.status_code >= 400 or "error" in data:
        msg = (data.get("error") or {}).get("message") if isinstance(data, dict) else str(data)
        raise ImageGenError(f"openai image gen failed ({resp.status_code}): {msg or resp.text[:200]}")
    try:
        b64 = data["data"][0]["b64_json"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ImageGenError(f"openai response missing b64_json: {data!r}") from exc
    return base64.b64decode(b64)


async def generate_stability(
    prompt: str, *, api_key: str, model: str = "stable-diffusion-xl-1024-v1-0", timeout: float = 120.0
) -> bytes:
    if not api_key:
        raise ImageGenError("stability provider requires an API key")
    engine = model or "stable-diffusion-xl-1024-v1-0"
    async with httpx.AsyncClient(timeout=timeout) as client:
        resp = await client.post(
            f"https://api.stability.ai/v1/generation/{engine}/text-to-image",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            json={
                "text_prompts": [{"text": prompt, "weight": 1}],
                "cfg_scale": 7,
                "height": PORTRAIT_H,
                "width": PORTRAIT_W,
                "steps": 30,
                "samples": 1,
            },
        )
    data = resp.json()
    if resp.status_code >= 400 or "message" in data:
        raise ImageGenError(
            f"stability image gen failed ({resp.status_code}): {data.get('message') or resp.text[:200]}"
        )
    try:
        b64 = data["artifacts"][0]["base64"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ImageGenError(f"stability response missing artifacts: {data!r}") from exc
    return base64.b64decode(b64)


async def generate_replicate(
    prompt: str, *, api_key: str, model: str = "black-forest-labs/flux-1.1-pro", timeout: float = 180.0
) -> bytes:
    if not api_key:
        raise ImageGenError("replicate provider requires an API key")
    async with httpx.AsyncClient(timeout=timeout) as client:
        create_resp = await client.post(
            "https://api.replicate.com/v1/predictions",
            headers={
                "Authorization": f"Token {api_key}",
                "Content-Type": "application/json",
            },
            json={
                "model": model,
                "input": {
                    "prompt": prompt,
                    "width": PORTRAIT_W,
                    "height": PORTRAIT_H,
                    "num_outputs": 1,
                },
            },
        )
        prediction = create_resp.json()
        if create_resp.status_code >= 400 or "error" in prediction:
            err = prediction.get("error")
            raise ImageGenError(f"replicate create failed ({create_resp.status_code}): {err}")
        # Poll
        poll_url = (prediction.get("urls") or {}).get("get")
        if not poll_url:
            raise ImageGenError("replicate response missing poll url")
        for _ in range(120):  # up to ~4 min at 2s poll
            if prediction.get("status") in ("succeeded", "failed", "canceled"):
                break
            await asyncio.sleep(2.0)
            poll_resp = await client.get(
                poll_url, headers={"Authorization": f"Token {api_key}"}
            )
            prediction = poll_resp.json()
        if prediction.get("status") != "succeeded":
            raise ImageGenError(f"replicate prediction {prediction.get('status')}: {prediction.get('error')}")
        out = prediction.get("output")
        url = out[0] if isinstance(out, list) and out else out
        if not isinstance(url, str):
            raise ImageGenError(f"replicate output not a URL: {out!r}")
        img_resp = await client.get(url)
        img_resp.raise_for_status()
        return img_resp.content


_PROVIDERS = {
    "openai": generate_openai,
    "stability": generate_stability,
    "replicate": generate_replicate,
}


async def generate_image(
    prompt: str,
    *,
    provider: str,
    api_key: str,
    model: Optional[str] = None,
    retries: int = 2,
) -> bytes:
    """Generate one portrait image with retries.

    Raises ImageGenError on terminal failure.
    """
    fn = _PROVIDERS.get((provider or "").strip().lower())
    if not fn:
        raise ImageGenError(
            f"unknown provider {provider!r}; supported: {', '.join(_PROVIDERS)}"
        )
    last: Optional[BaseException] = None
    for attempt in range(retries + 1):
        try:
            kwargs = {"api_key": api_key}
            if model:
                kwargs["model"] = model
            return await fn(prompt, **kwargs)  # type: ignore[arg-type]
        except (ImageGenError, httpx.HTTPError, asyncio.TimeoutError) as exc:
            last = exc
            if attempt < retries:
                wait = 3.0 * (attempt + 1)
                logger.warning(
                    "[larry.image] %s attempt %d/%d failed: %s — retrying in %.1fs",
                    provider, attempt + 1, retries + 1, exc, wait,
                )
                await asyncio.sleep(wait)
            else:
                break
    raise ImageGenError(f"{provider} failed after {retries + 1} attempts: {last}")
