# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
import json
import os
from typing import Any, Optional

from pydantic import Field
import httpx
from openjiuwen.core.common.logging import llm_logger, LogEventType
from openjiuwen.core.common.security.ssl_utils import SslUtils
from openjiuwen.core.common.security.url_utils import UrlUtils
from openjiuwen.core.foundation.llm.schema.config import ModelClientConfig
from openjiuwen.core.foundation.llm.model_clients.openai_model_client import \
    AssistantMessageChunk, OpenAIModelClient, ToolCall, UsageMetadata


class PatchOpenAIModelClient(OpenAIModelClient):

    def _create_async_openai_client(self, timeout: Optional[float] = None) -> "openai.AsyncOpenAI":
        """
        Create an OpenAI Async client with configured SSL/proxy/http client settings.
        
        Args:
            timeout: Optional timeout override for this specific request
        """
        from openai import AsyncOpenAI
        
        ssl_verify, ssl_cert = self.model_client_config.verify_ssl, self.model_client_config.ssl_cert
        verify = SslUtils.create_strict_ssl_context(ssl_cert) if ssl_verify else ssl_verify

        http_client = httpx.AsyncClient(
            proxy=UrlUtils.get_global_proxy_url(self.model_client_config.api_base),
            verify=verify
        )

        # Use method-level timeout if provided, otherwise use config timeout
        final_timeout = timeout if timeout is not None else self.model_client_config.timeout
        llm_logger.info(
            "Before create openai client, model client config params ready.",
            event_type=LogEventType.LLM_CALL_START,
            timeout=final_timeout,
            max_retries=self.model_client_config.max_retries
        )
        default_headers = os.getenv("default_headers", None)
        try:
            default_headers = json.loads(default_headers) if default_headers else None
        except json.decoder.JSONDecodeError as error:
            llm_logger.warning(f"Model default headers parse failed: {error}")
            default_headers = None
        return AsyncOpenAI(
            api_key=self.model_client_config.api_key,
            base_url=self.model_client_config.api_base,
            http_client=http_client,
            timeout=final_timeout,
            max_retries=self.model_client_config.max_retries,
            default_headers=default_headers
        )
    
    def _parse_stream_chunk(self, chunk: Any) -> Optional[AssistantMessageChunk]:
        """Parse OpenAI streaming response chunk
        
        Args:
            chunk: OpenAI streaming response chunk
            
        Returns:
            AssistantMessageChunk or None
        """
        if not chunk.choices:
            return None

        choice = chunk.choices[0]
        delta = choice.delta

        # Extract content
        content = getattr(delta, 'content', None) or ""
        reasoning_content = getattr(delta, 'reasoning_content', None)

        # Parse tool_calls delta
        tool_calls = []
        if hasattr(delta, 'tool_calls') and delta.tool_calls:
            for tc_delta in delta.tool_calls:
                if hasattr(tc_delta, 'function') and tc_delta.function:
                    index = getattr(tc_delta, 'index', None)
                    function_name = getattr(tc_delta.function, 'name', None) or ""
                    function_arguments = getattr(tc_delta.function, 'arguments', None) or ""

                    tool_call = ToolCall(
                        id=getattr(tc_delta, 'id', '') or "",
                        type="function",
                        name=function_name,
                        arguments=function_arguments,
                        index=index
                    )
                    tool_calls.append(tool_call)

        # Build usage_metadata (usually only in the last chunk)
        usage_metadata = None
        if hasattr(chunk, 'usage') and chunk.usage:
            usage_metadata = UsageMetadata(
                model_name=self.model_config.model_name,
                input_tokens=getattr(chunk.usage, 'prompt_tokens', 0) or 0,
                output_tokens=getattr(chunk.usage, 'completion_tokens', 0) or 0,
                total_tokens=getattr(chunk.usage, 'total_tokens', 0) or 0
            )

        return AssistantMessageChunk(
            content=content,
            reasoning_content=reasoning_content,
            tool_calls=tool_calls if tool_calls else None,
            usage_metadata=usage_metadata,
            finish_reason=choice.finish_reason or "null"
        )


def apply_openai_model_client_patch() -> None:
    """Monkey-patch upstream OpenAIModelClient with JiuwenClaw SSL/headers/stream behavior."""
    _impl = PatchOpenAIModelClient.__dict__
    setattr(OpenAIModelClient, "_create_async_openai_client", _impl["_create_async_openai_client"])
    setattr(OpenAIModelClient, "_parse_stream_chunk", _impl["_parse_stream_chunk"])
    _install_gemini_request_params_shim()
    _apply_provider_registry_patch()


def _install_gemini_request_params_shim() -> None:
    """Wrap ``OpenAIModelClient._build_request_params`` for Gemini endpoints.

    This shim used to inject ``extra_body.google.thinking_config`` to disable
    Gemini thinking. Google's OpenAI-compatible chat-completions endpoint now
    rejects that payload with ``Unknown name "google"``, which breaks the main
    chat before the request can stream. Keep the wrapper only as a guard that
    removes that unsupported field if it is present from an older process or
    caller-provided extra body.

    Implementation note: we use a closure around the original bound method
    rather than a subclass + ``super()`` so that reassignment onto the already
    imported ``OpenAIModelClient`` class does not trip Python's ``super()``
    MRO check (``super(type, obj): obj must be an instance or subtype``).
    The shim is **idempotent** — calling it twice does not double-wrap.
    """
    marker = "_jiuwenclaw_gemini_shim"
    if getattr(OpenAIModelClient, marker, False):
        return
    original = OpenAIModelClient._build_request_params

    def _build_request_params(self, **kwargs):
        params = original(self, **kwargs)
        api_base = (self.model_client_config.api_base or "").lower()
        if "generativelanguage.googleapis.com" in api_base:
            existing_extra = params.get("extra_body")
            if isinstance(existing_extra, dict) and "google" in existing_extra:
                cleaned_extra = {key: value for key, value in existing_extra.items() if key != "google"}
                if cleaned_extra:
                    params["extra_body"] = cleaned_extra
                else:
                    params.pop("extra_body", None)
        model_name = str(
            params.get("model")
            or getattr(getattr(self, "model_config", None), "model", "")
            or getattr(getattr(self, "model_config", None), "model_name", "")
            or ""
        ).split("/", 1)[-1].lower()
        if "api.openai.com" in api_base and model_name.startswith(("gpt-5", "o1", "o3", "o4")):
            params.pop("temperature", None)
            if "max_tokens" in params and "max_completion_tokens" not in params:
                params["max_completion_tokens"] = params.pop("max_tokens")
        return params

    OpenAIModelClient._build_request_params = _build_request_params
    setattr(OpenAIModelClient, marker, True)


def _apply_provider_registry_patch() -> None:
    """Register additional model providers into the openjiuwen client registry.

    These aliases extend the stock registry (OpenAI/OpenRouter/SiliconFlow/DashScope/
    InferenceAffinity) with entries for Gemini, Anthropic, Google, FalAI, and
    ElevenLabs. Each routes through the OpenAI-compatible client, which the
    upstream project explicitly supports as the integration surface for these
    providers.

    The authoritative registry at runtime is the global ``ClientRegistry`` from
    ``openjiuwen.core.common.clients``; entries are keyed as ``"llm_<Name>"``.
    The ``_CLIENT_TYPE_REGISTRY`` dict inside ``model.py`` is retained only as a
    legacy mirror. We populate both so either lookup path resolves.

    Strictly additive — existing provider entries are never overwritten.
    """
    extra_providers = {
        "Gemini": OpenAIModelClient,
        "Google": OpenAIModelClient,
        "Anthropic": OpenAIModelClient,
        "FalAI": OpenAIModelClient,
        "ElevenLabs": OpenAIModelClient,
    }

    # 1) Register into the real runtime registry used by Model._create_model_client.
    try:
        from openjiuwen.core.common.clients import get_client_registry
        client_registry = get_client_registry()
        existing = set(client_registry.list_clients())
        for provider_name, client_cls in extra_providers.items():
            full_name = f"llm_{provider_name}"
            if full_name in existing:
                continue

            def _make_factory(cls):
                def _factory(**kwargs):
                    return cls(**kwargs)
                return _factory

            client_registry._factories[full_name] = _make_factory(client_cls)
            client_registry._client_classes[full_name] = client_cls
    except Exception:
        # Registry API surface changed or unavailable — fall through to mirror dict.
        pass

    # 2) Legacy mirror inside model.py (kept for any code that still reads it).
    try:
        from openjiuwen.core.foundation.llm import model as _model_mod
        legacy = getattr(_model_mod, "_CLIENT_TYPE_REGISTRY", None)
        if isinstance(legacy, dict):
            for provider_name, client_cls in extra_providers.items():
                legacy.setdefault(provider_name, client_cls)
    except ImportError:
        pass
