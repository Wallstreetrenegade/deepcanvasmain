---
name: features-workspaces
version: 1.0.0
description: Know and operate JiuwenClaw feature workspaces: Storage, Kanban, CRM, Lead Gen, Video Meeting, Project Flow, feature settings, and live mirrored state.
tags: [features, workspaces, storage, files, kanban, crm, project-flow, lead-gen, video-meeting, settings]
---

# Features Workspaces

Use this skill when the user asks about feature settings, workspaces, or live state inside Storage, Kanban, CRM, Project Flow, Lead Gen, or Video Meeting.

## Operating Model

The main chat agent is the front door and orchestrator. It should not tell the user it cannot know about features when feature tools are available.

Feature services are backend workers and state mirrors:

- `storage.*` powers Storage: disk-backed files, folders, categories, thumbnails, downloads, and Google Drive/OneDrive device authorization.
- `pi.state.*` mirrors frontend workspace state into JSON snapshots that main-agent tools can inspect.

## Required First Step

For broad questions such as "what features do you have", "how are features wired", "what feature settings exist", or "who manages the features", call `features_catalog` or `features_overview` first.

For a specific feature, call the narrow tool first when available:

- Kanban: `features_kanban_summary`, then `features_kanban_list` when details are needed.
- Storage: `features_storage_summary`, then `features_state_get` when sanitized raw folder/file/provider detail is needed.
- CRM: `features_crm_list` or `features_crm_find`.
- Project Flow: `features_project_flow_list`.
- Any feature or alias: `features_state_get`.
- Feature model/API readiness: `features_settings_status`.

## Response Rules

- Treat live tool output as authoritative.
- If a feature is a UI workspace but has no mirrored backend state yet, say that clearly instead of inventing data.
- Never reveal API keys, tokens, passwords, bearer strings, OAuth tokens, or raw media/data URLs. The tools redact them; keep them redacted.
- For Storage, raw file bytes, thumbnail data URLs, local disk paths, OAuth tokens, and device codes must stay hidden/redacted in normal answers.
- When the user asks for status across everything, combine `features_overview` with narrow tools only if the user needs detail.

## Feature Map

- Storage: user images, videos, audio, documents, folders, categories, thumbnails, local disk-backed file records, downloads, and optional Google Drive/OneDrive connection status.
- Kanban: tasks, cards, columns, subtasks, notes, board status.
- CRM: leads, contacts, companies, statuses, pipeline and follow-up data.
- Lead Gen: UI workspace for lead generation; backend mirror may be absent until implemented or opened.
- Video Meeting: UI workspace for meetings; backend mirror may be absent until implemented or opened.
- Project Flow: workflow/diagram graph, nodes, edges, board title, and project structure.
