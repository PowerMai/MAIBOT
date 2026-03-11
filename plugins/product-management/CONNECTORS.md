# Product Management Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Product analytics and event platforms
- Issue trackers and delivery planning tools
- Customer feedback and research repositories
- Collaboration and stakeholder communication tools

## Setup Notes

1. Register MCP servers in `plugins/product-management/.mcp.json`.
2. Start with read-only scopes for metrics and research synthesis.
3. Enable write scopes only for approved roadmap and spec updates.
4. Keep secrets in environment configuration, never in plugin files.
