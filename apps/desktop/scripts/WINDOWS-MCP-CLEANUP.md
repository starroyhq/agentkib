# Windows MCP process cleanup verification

From the repository root on Windows:

```powershell
pnpm verify:windows:mcp-cleanup
pnpm verify:windows:mcp-cleanup --force
```

Both commands generate the current protocol and build the backend first. Close any
running AgentKib development instance before running them so native build files
are not locked.

The fixture starts a real stdio MCP server, child, and grandchild. All three stay
alive even when stdin closes. The verifier confirms they are alive before stopping
the MCP and checks that none remain afterward. The default command also checks
the backend shutdown request used by application exit; `--force` instead kills
the Electron utility process to verify Windows Job Object cleanup.

The test uses Electron utility processes and isolated temporary configuration.
It does not exercise the application's UI quit guard. It allocates a local port
dynamically and removes test data and processes on completion. A failure returns
a nonzero exit code.
