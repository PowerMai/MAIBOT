# Finance Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- ERP/GL systems (SAP, Oracle, NetSuite, Kingdee, Yonyou)
- Subledger and billing systems
- Data warehouse and BI platforms
- Document repositories for audit evidence

## Setup Notes

1. Register MCP servers in `plugins/finance/.mcp.json`.
2. Use read-only scopes first for reconciliation and review flows.
3. Enable write scopes only for approved close postings.
4. Keep credentials in environment secrets, never in plugin files.
