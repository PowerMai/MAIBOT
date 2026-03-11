# Human Resources Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Configured MCP servers:

- `slack`
- `workday`
- `greenhouse`
- `lever`
- `bamboohr`
- `notion`
- `google-calendar`
- `gmail`

## Setup Notes

1. Register and authenticate each MCP server in `plugins/human-resources/.mcp.json`.
2. Start with read-only scopes for policy, reporting, and review workflows.
3. Grant write scopes only for approved hiring and onboarding operations.
4. Keep credentials outside plugin files.
