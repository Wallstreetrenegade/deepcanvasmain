# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""Shared LLM resolver and caller for pi_agent feature modules.

Centralizes the provider/api_base/api_key/model resolution, placeholder
sanitization, and HTTP call logic used by App Builder, Social Larry, and the
Project Flow board. Eliminates the drift that previously caused features to
post against template values like ``https://example.com/compatible-mode/v1``.

Public surface
--------------
``PROVIDER_DEFAULTS``    Provider-specific (api_base, model, canonical name).
``PLACEHOLDER_MARKERS``  Substrings that mark an env value as a template.
``clean_value(v)``       Strip quotes/whitespace, return "" if placeholder.
``normalize_api_base(b)`` Strip trailing /chat/completions and slashes.
``first_value(*vs)``     Pick first non-empty cleaned value.
``resolve_config(...)``  Build the final resolver result (provider/base/key/model).
``is_ready(cfg)``        Convenience: all required fields present.
``call_llm(messages, cfg, ...)`` Provider-aware HTTP call with friendly errors.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Iterable

import httpx

logger = logging.getLogger(__name__)

ANTHROPIC_VERSION = "2023-06-01"

# Substrings that mark a value as a template / placeholder. We refuse to use
# these and fall through to provider defaults instead.
PLACEHOLDER_MARKERS: tuple[str, ...] = (
    "example.com",
    "example.invalid",
    "your-real-openai-compatible-endpoint",
    "your-model-name",
    "sk-xxxxxxxxx",
)

# Provider-specific defaults. Keys are lowercased provider strings.
PROVIDER_DEFAULTS: dict[str, dict[str, str]] = {
    "openai":      {"provider": "OpenAI",      "api_base": "https://api.openai.com/v1",                              "model": "gpt-5.4-mini"},
    "openrouter":  {"provider": "OpenRouter",  "api_base": "https://openrouter.ai/api/v1",                           "model": "openai/gpt-5.4-mini"},
    "google":      {"provider": "Google",      "api_base": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-pro"},
    "gemini":      {"provider": "Gemini",      "api_base": "https://generativelanguage.googleapis.com/v1beta/openai", "model": "gemini-2.5-flash"},
    "anthropic":   {"provider": "Anthropic",   "api_base": "https://api.anthropic.com/v1",                           "model": "claude-sonnet-4-5-20250929"},
    "dashscope":   {"provider": "DashScope",   "api_base": "https://dashscope.aliyuncs.com/compatible-mode/v1",      "model": "qwen-max"},
    "siliconflow": {"provider": "SiliconFlow", "api_base": "https://api.siliconflow.cn/v1",                          "model": "deepseek-ai/DeepSeek-V3"},
}


# ---------------------------------------------------------------------------
# Sanitizers
# ---------------------------------------------------------------------------


def clean_value(value: Any) -> str:
    """Return ``str(value)`` stripped of quotes/whitespace, or ``""`` if the
    value is empty or contains a known placeholder marker."""
    text = str(value or "").strip().strip('"').strip("'")
    if not text:
        return ""
    lowered = text.lower()
    if any(marker in lowered for marker in PLACEHOLDER_MARKERS):
        return ""
    return text


def normalize_api_base(api_base: Any) -> str:
    """Trim trailing slashes and ``/chat/completions`` if a caller pasted the
    full endpoint URL into the base field."""
    text = clean_value(api_base).rstrip("/")
    if text.endswith("/chat/completions"):
        text = text.rsplit("/chat/completions", 1)[0].rstrip("/")
    return text


def first_value(*values: Any) -> str:
    """Return the first non-empty cleaned value from ``values``."""
    for value in values:
        cleaned = clean_value(value)
        if cleaned:
            return cleaned
    return ""


def provider_defaults(provider: Any) -> dict[str, str]:
    """Return provider defaults keyed by lowercased provider name. Falls back
    to OpenAI for unknown providers."""
    key = str(provider or "").strip().lower()
    return PROVIDER_DEFAULTS.get(key, PROVIDER_DEFAULTS["openai"])


def _features_profile_complete() -> bool:
    return bool(
        clean_value(os.environ.get(_FEATURES_PROVIDER_ENV))
        and clean_value(os.environ.get(_FEATURES_API_BASE_ENV))
        and clean_value(os.environ.get(_FEATURES_API_KEY_ENV))
        and clean_value(os.environ.get(_FEATURES_MODEL_ENV))
    )


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


_FEATURES_PROVIDER_ENV = "FEATURES_PROVIDER"
_FEATURES_API_BASE_ENV = "FEATURES_API_BASE"
_FEATURES_API_KEY_ENV  = "FEATURES_API_KEY"
_FEATURES_MODEL_ENV    = "FEATURES_MODEL_NAME"


def _provider_specific_keys(provider_key: str) -> Iterable[str | None]:
    """Yield env-var names that are valid sources of an API key for the given
    provider, in priority order. Yields ``None`` placeholders so a caller can
    safely splat into ``first_value`` regardless of which envs are set."""
    if provider_key == "anthropic":
        yield os.environ.get("ANTHROPIC_API_KEY")
    elif provider_key in {"google", "gemini"}:
        yield os.environ.get("GOOGLE_API_KEY")
        yield os.environ.get("GEMINI_API_KEY")
    elif provider_key == "openrouter":
        yield os.environ.get("OPENROUTER_API_KEY")
    elif provider_key == "dashscope":
        yield os.environ.get("DASHSCOPE_API_KEY")
    elif provider_key == "siliconflow":
        yield os.environ.get("SILICONFLOW_API_KEY")


def resolve_config(overrides: dict[str, Any] | None = None) -> dict[str, str]:
    """Resolve the LLM config from ``overrides`` -> ``FEATURES_*`` envs ->
    global ``API_*`` / ``MODEL_*`` envs -> provider defaults.

    Recognized override keys (any of the aliases below):
        provider      / aiProvider
        api_base      / apiBase / aiApiBase / baseUrl
        api_key       / apiKey  / aiApiKey
        model         / aiModel

    Always returns a dict with keys ``provider``, ``api_base``, ``api_key``,
    ``model``. Values may be empty strings if nothing is configured.
    """
    overrides = overrides or {}

    use_dedicated_features = _features_profile_complete()

    # Provider
    provider = first_value(
        overrides.get("provider"),
        overrides.get("aiProvider"),
        os.environ.get(_FEATURES_PROVIDER_ENV) if use_dedicated_features else None,
        os.environ.get("MODEL_PROVIDER"),
    )
    defaults = provider_defaults(provider)
    if not provider or provider.lower() not in PROVIDER_DEFAULTS:
        provider = defaults["provider"]
    provider_key = provider.lower()

    # API base — overrides, env, then provider default
    api_base = normalize_api_base(first_value(
        overrides.get("api_base"),
        overrides.get("apiBase"),
        overrides.get("aiApiBase"),
        overrides.get("baseUrl"),
        os.environ.get(_FEATURES_API_BASE_ENV) if use_dedicated_features else None,
        os.environ.get("API_BASE"),
        defaults["api_base"],
    ))

    # API key — overrides, FEATURES_, provider-specific envs, generic envs
    api_key = first_value(
        overrides.get("api_key"),
        overrides.get("apiKey"),
        overrides.get("aiApiKey"),
        os.environ.get(_FEATURES_API_KEY_ENV) if use_dedicated_features else None,
        *_provider_specific_keys(provider_key),
        os.environ.get("API_KEY"),
        os.environ.get("OPENAI_API_KEY"),
    )

    # Model
    model = first_value(
        overrides.get("model"),
        overrides.get("aiModel"),
        os.environ.get(_FEATURES_MODEL_ENV) if use_dedicated_features else None,
        os.environ.get("MODEL_NAME"),
        defaults["model"],
    )

    return {"provider": provider, "api_base": api_base, "api_key": api_key, "model": model}


def is_ready(cfg: dict[str, str]) -> bool:
    return bool(cfg.get("api_base") and cfg.get("api_key") and cfg.get("model"))


def _uses_openai_completion_tokens(provider_key: str, model: str, api_base: str) -> bool:
    normalized_model = model.split("/", 1)[-1].lower()
    is_direct_openai = provider_key == "openai" or "api.openai.com" in api_base.lower()
    return is_direct_openai and normalized_model.startswith(("gpt-5", "o1", "o3", "o4"))


# ---------------------------------------------------------------------------
# HTTP caller
# ---------------------------------------------------------------------------


def _anthropic_payload(messages: list[dict[str, str]], model: str, max_tokens: int, temperature: float) -> dict[str, Any]:
    system_parts: list[str] = []
    chat_messages: list[dict[str, str]] = []
    for message in messages:
        role = message.get("role") or "user"
        content = message.get("content") or ""
        if role == "system":
            system_parts.append(content)
            continue
        chat_messages.append({"role": "assistant" if role == "assistant" else "user", "content": content})
    payload: dict[str, Any] = {
        "model": model,
        "messages": chat_messages or [{"role": "user", "content": "Continue."}],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if system_parts:
        payload["system"] = "\n\n".join(system_parts)
    return payload


async def call_llm(
    messages: list[dict[str, str]],
    cfg: dict[str, str],
    *,
    temperature: float = 0.4,
    max_tokens: int = 16000,
    timeout: float = 120.0,
) -> str:
    """Call the configured LLM and return the assistant text.

    Raises ``RuntimeError`` with a friendly message on missing config or HTTP
    errors. Never leaks raw httpx URLs/method-not-allowed text to callers."""
    if not is_ready(cfg):
        raise RuntimeError(
            "LLM not configured: set FEATURES_PROVIDER / FEATURES_MODEL_NAME / "
            "FEATURES_API_BASE / FEATURES_API_KEY (or the global model config) in Settings."
        )
    provider = cfg.get("provider") or "configured provider"
    provider_key = provider.lower()
    async with httpx.AsyncClient(timeout=timeout) as client:
        if provider_key == "anthropic":
            resp = await client.post(
                f"{cfg['api_base']}/messages",
                headers={
                    "x-api-key": cfg["api_key"],
                    "anthropic-version": ANTHROPIC_VERSION,
                    "Content-Type": "application/json",
                },
                json=_anthropic_payload(messages, cfg["model"], max_tokens, temperature),
            )
        else:
            json_payload: dict[str, Any] = {
                "model": cfg["model"],
                "messages": messages,
            }
            if _uses_openai_completion_tokens(provider_key, cfg["model"], cfg["api_base"]):
                json_payload["max_completion_tokens"] = max_tokens
            else:
                json_payload["temperature"] = temperature
                json_payload["max_tokens"] = max_tokens
            resp = await client.post(
                f"{cfg['api_base']}/chat/completions",
                headers={
                    "Authorization": f"Bearer {cfg['api_key']}",
                    "Content-Type": "application/json",
                },
                json=json_payload,
            )
        try:
            resp.raise_for_status()
        except httpx.HTTPStatusError as exc:
            status = exc.response.status_code
            if status in (401, 403):
                raise RuntimeError(
                    f"{provider} rejected the configured API key ({status}). "
                    f"Open Settings and save a valid {provider} API key."
                ) from exc
            if status == 404:
                raise RuntimeError(
                    f"{provider} returned 404 for the configured endpoint "
                    f"({cfg['api_base']}). Check the API base and model name in Settings."
                ) from exc
            if status == 405:
                raise RuntimeError(
                    f"{provider} API base does not accept chat completions "
                    f"({cfg['api_base']}). Save the provider's default API base in Settings."
                ) from exc
            if status == 429:
                raise RuntimeError(
                    f"{provider} rate-limited the request (429). Try again in a moment."
                ) from exc
            raise RuntimeError(
                f"{provider} request failed with HTTP {status}: {exc.response.text[:300]}"
            ) from exc
        data = resp.json()
    if provider_key == "anthropic":
        content = data.get("content") if isinstance(data, dict) else None
        if isinstance(content, list):
            text_parts = [
                str(item.get("text") or "")
                for item in content
                if isinstance(item, dict) and item.get("type") == "text"
            ]
            result = "\n".join(part for part in text_parts if part).strip()
            if result:
                return result
        raise RuntimeError(f"{provider} returned an unexpected response shape.")
    try:
        return str(data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"{provider} returned an unexpected response shape: {exc}") from exc
