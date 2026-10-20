# WEAVE context router
WEAVE maps this project into areas, each with its own subagent (`weave-<area>` in .claude/agents/). A thread's first note lists them.
1. Hand a task that stays inside one area to that area's subagent. It works in its own context and returns a summary, so this thread stays small.
2. Do quick lookups and edits that cross areas here.
3. When a WEAVE line says to run /compact or /clear, tell the user in one line. Only the user can run them.
4. `weave_map` lists the areas; `weave_area_for` says which area a path is in. Both return paths only.
