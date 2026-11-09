# MCP connection guide screenshots

These screenshots render the current `McpConnectionCard` and `McpRuntimeProbe`
components with the application CSS and English translations. The surrounding
page is a synthetic fixture, rather than the full desktop application.

The workspace, paths, server status, and API results are synthetic. Codex uses its
default project configuration path, `/workspaces/demo/.codex/config.toml`. No real
workspace, client configuration, upstream service, or business tool is accessed.

- `01-connection-ready.png`: workspace and Agent selection, complete Hub URL,
  configuration snippet, target path, and reload guidance.
- `02-review-diff.png`: connection-only changes preserve existing configuration.
- `03-verified-tools.png`: configuration written, Hub catalog verification, and
  the latest upstream probe are displayed as separate results.
- `04-boundary-states.png`: empty workspace list, loading details, and a failed
  details request.

Captured with the Playwright CLI using an isolated Vite fixture under ignored
`output/playwright/mcp-connection-fixture/`. These images demonstrate component
rendering and interaction; they do not establish that a native client has loaded
the connection or that a real Hub or upstream service is reachable. The connection
card is a new entry point with no matching card in the previous UI.
