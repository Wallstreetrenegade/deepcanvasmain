# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.

"""Context rail compatibility wrapper with offload hints."""

from __future__ import annotations

from openjiuwen.core.single_agent.rail.base import AgentCallbackContext
from openjiuwen.harness.prompts import PromptSection
from openjiuwen.harness.rails.base import DeepAgentRail

try:
    from openjiuwen.harness.rails.context_engineering_rail import ContextEngineeringRail
except ImportError:
    from openjiuwen.harness.rails.context_engineer import (
        ContextAssembleRail,
        ContextProcessorRail,
    )

    class ContextEngineeringRail(DeepAgentRail):
        """Compatibility adapter for newer split context rails."""

        priority = 85

        def __init__(self, processors=None, preset: bool = True, session_memory=None) -> None:
            super().__init__()
            self._assemble_rail = ContextAssembleRail()
            self._processor_rail = ContextProcessorRail(
                processors=processors,
                preset=preset,
                session_memory=session_memory,
            )
            self.system_prompt_builder = None

        @staticmethod
        def _bind_rail_runtime(rail: DeepAgentRail, workspace, sys_operation) -> None:
            """Support both legacy setter-style rails and newer bind_runtime rails."""
            if hasattr(rail, "bind_runtime"):
                rail.bind_runtime(
                    workspace=workspace,
                    sys_operation=sys_operation,
                )
                return
            if hasattr(rail, "set_workspace"):
                rail.set_workspace(workspace)
            if hasattr(rail, "set_sys_operation"):
                rail.set_sys_operation(sys_operation)

        def init(self, agent) -> None:
            self._bind_rail_runtime(
                self._assemble_rail,
                workspace=self.workspace,
                sys_operation=self.sys_operation,
            )
            self._bind_rail_runtime(
                self._processor_rail,
                workspace=self.workspace,
                sys_operation=self.sys_operation,
            )
            self._assemble_rail.init(agent)
            self._processor_rail.init(agent)
            self.system_prompt_builder = getattr(agent, "system_prompt_builder", None)

        def uninit(self, agent) -> None:
            self._processor_rail.uninit(agent)
            self._assemble_rail.uninit(agent)
            self.system_prompt_builder = None

        async def before_invoke(self, ctx: AgentCallbackContext) -> None:
            await self._processor_rail.before_invoke(ctx)

        async def before_model_call(self, ctx: AgentCallbackContext) -> None:
            await self._assemble_rail.before_model_call(ctx)
            await self._processor_rail.before_model_call(ctx)

        async def after_model_call(self, ctx: AgentCallbackContext) -> None:
            await self._processor_rail.after_model_call(ctx)

        async def after_tool_call(self, ctx: AgentCallbackContext) -> None:
            await self._processor_rail.after_tool_call(ctx)

        async def on_model_exception(self, ctx: AgentCallbackContext) -> None:
            await self._processor_rail.on_model_exception(ctx)


class JiuClawContextEngineeringRail(ContextEngineeringRail):
    """Extend context rails with a dedicated offload guidance section."""

    OFFLOAD_HINT_CN = (
        "# Context Compression\n\n"
        "Your context may be compressed automatically when it becomes too long and "
        "marked as [OFFLOAD: handle=<id>, type=<type>].\n\n"
        "Use reload_original_context_messages when you need the hidden content.\n\n"
        "Do not guess missing content.\n\n"
        'Storage type: "in_memory"'
    )

    OFFLOAD_HINT_EN = (
        "# Context Compression\n\n"
        "Your context will be automatically compressed when it becomes too long "
        "and marked with [OFFLOAD: handle=<id>, type=<type>].\n\n"
        'Call reload_original_context_messages(offload_handle="<id>", '
        'offload_type="<type>"), using the exact values from the marker.\n\n'
        "Do not guess or fabricate missing content.\n\n"
        'Storage types: "in_memory" (session cache)'
    )

    def __init__(self, processors=None, preset: bool = True, session_memory=None) -> None:
        super().__init__(
            processors=processors,
            preset=preset,
            session_memory=session_memory,
        )

    async def before_model_call(self, ctx: AgentCallbackContext) -> None:
        await super().before_model_call(ctx)

        if not self.system_prompt_builder:
            return

        lang = self.system_prompt_builder.language or "cn"
        hint = self.OFFLOAD_HINT_CN if lang == "cn" else self.OFFLOAD_HINT_EN

        self.system_prompt_builder.add_section(
            PromptSection(
                name="offload",
                content={lang: hint},
                priority=90,
            )
        )


__all__ = [
    "ContextEngineeringRail",
    "JiuClawContextEngineeringRail",
]
