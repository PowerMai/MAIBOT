# Knowledge Engineering Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Source systems (documents, wiki, ticketing, databases)
- Crawling and ingestion pipelines
- Ontology and metadata management systems
- Validation, analytics, and observability backends

## Setup Notes

1. Register MCP servers in `plugins/knowledge-engineering/.mcp.json`.
2. Start with read-only scopes for source discovery and schema inspection.
3. Enable write scopes only for approved ingestion and remediation flows.
4. Keep credentials in environment configuration, never in plugin files.
