# Engineering Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Configured MCP servers:

- `slack`
- `linear`
- `asana`
- `atlassian`
- `notion`
- `github`
- `pagerduty`
- `datadog`
- `google-calendar`
- `gmail`

## Setup Notes

1. Register and authenticate each MCP server in `plugins/engineering/.mcp.json`.
2. Start with read-only scopes for review, incident analysis, and documentation tasks.
3. Add write scopes only for approved workflows such as ticket updates or status posts.
4. Keep secrets in environment configuration, never in plugin files.
