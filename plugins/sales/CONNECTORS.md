# Sales Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- CRM systems (Salesforce, HubSpot, Dynamics)
- Prospecting and firmographic data sources
- Call recording and meeting intelligence tools
- Email and sequencing platforms
- Tender and procurement notice platforms
- Compliance and qualification data providers

## Setup Notes

1. Register MCP servers in `plugins/sales/.mcp.json`.
2. Start with read-only scopes for research and briefing workflows.
3. Enable write scopes only for approved CRM updates and outreach actions.
4. Keep secrets in environment configuration, never in plugin files.
