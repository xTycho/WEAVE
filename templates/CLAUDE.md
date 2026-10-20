# WEAVE context router
Each thread starts with a short WEAVE note naming its context window: core files, warm files, attached folders and detached files.
1. Start with the warm files, then the attached folders. Open cold files only when the task needs them.
2. Skip detached files unless the user asks for them.
3. Need another area? Call `weave_attach` with a folder or file. Done with one? Call `weave_detach`.
4. `weave_map` lists features with token costs; `weave_get_context` lists the current window. Both return paths only.
