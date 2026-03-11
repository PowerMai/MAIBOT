# Education Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Learning management systems
- Assignment and grading platforms
- Curriculum and content repositories
- School communication platforms

## Setup Notes

1. Register MCP servers in `plugins/education/.mcp.json`.
2. Start with read-only scopes for curriculum lookup and student context retrieval.
3. Enable write scopes only for approved feedback publishing workflows.
4. Keep credentials in environment configuration, never in plugin files.
