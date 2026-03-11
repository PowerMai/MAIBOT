# Operations Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Configured MCP servers:

- `slack`
- `notion`
- `jira`
- `asana`
- `google-drive`
- `confluence`
- `zendesk`

## Setup Notes

1. Register and authenticate each MCP server in `plugins/operations/.mcp.json`.
2. Keep default access read-only for diagnostics and reporting.
3. Enable write operations only for approved process or vendor workflows.
4. Store secrets in environment configuration, not plugin files.
