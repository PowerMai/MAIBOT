# Design Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Configured MCP servers:

- `figma`
- `linear`
- `jira`
- `notion`
- `slack`
- `google-drive`
- `github`

## Setup Notes

1. Register and authenticate each MCP server in `plugins/design/.mcp.json`.
2. Start with read-only scopes for design review and research workflows.
3. Add write scopes for approved handoff and documentation operations.
4. Keep access tokens outside plugin files.
