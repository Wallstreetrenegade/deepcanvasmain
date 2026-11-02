# Copyright (c) Huawei Technologies Co., Ltd. 2025. All rights reserved.
"""PI Agent - behind-the-scenes feature supervisor.

The PI Agent is **not** a separate chat. It is a set of capabilities the
main Jiuween chat agent uses to stay fully aware of the feature
workspaces (Storage, Kanban, CRM, Lead Gen, Video Meeting, and Project Flow).

Two things live in this package:

1. ``state`` - a JSON-file mirror of the frontend feature stores.
   The frontend silently pushes updates here whenever a feature store
   mutates; the main agent's tools read from these files.
2. ``handlers`` - the ``pi.state.sync`` / ``pi.state.get`` RPC methods
   that make the silent mirror possible.

The actual agent-facing capabilities live in
``jiuwenclaw.agentserver.tools.features_tools`` and are registered on
the main ``DeepAgent`` the same way every other Jiuween tool is.
"""

from jiuwenclaw.pi_agent.handlers import register_pi_handlers

__all__ = ["register_pi_handlers"]
