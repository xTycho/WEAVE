# WEAVE Context Router
Load context on demand; never read `.claude/features/` wholesale.
1. Start of task: call `weave_get_active_context` and read only the paths it returns.
2. New feature area: call `weave_activate_node` with the feature id, then re-read the active paths.
3. Finished or irrelevant area: call `weave_sever_node` to drop its context cord.
4. If WEAVE tools are unavailable, read only files the user names explicitly.
Feature notes live in `.claude/features/<id>/`; keep each file short and specific.
