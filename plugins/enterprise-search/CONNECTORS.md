# Enterprise Search Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Internal document management systems
- Knowledge bases and wiki platforms
- Source indexing and vector retrieval services
- Data governance and access policy systems

## Setup Notes

1. Register MCP servers in `plugins/enterprise-search/.mcp.json`.
2. Start with read-only scopes for retrieval and synthesis tasks.
3. Enforce source and access policies before enabling broader data scopes.
4. Keep secrets in environment configuration, never in plugin files.
