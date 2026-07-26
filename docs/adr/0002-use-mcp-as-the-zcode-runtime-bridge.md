# Use MCP as the ZCode runtime bridge

ZCode commands and the rescue agent call a plugin-provided MCP server, which invokes the shared Codex companion runtime and returns its output. ZCode rejects dynamic shell in command Markdown and does not guarantee plugin-root variables inside model-initiated Bash calls, while plugin MCP processes have a documented executable path and receive explicit root, data, and project environment values; hooks remain direct process entries because ZCode provides the same variables to plugin hooks.
