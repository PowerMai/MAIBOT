# Customer Support Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Ticketing systems (Zendesk, Freshdesk, Jira Service Management)
- CRM and customer account history systems
- Internal knowledge base and documentation repositories
- Chat and messaging support channels

## Setup Notes

1. Register MCP servers in `plugins/customer-support/.mcp.json`.
2. Start with read-only scopes for triage and response drafting.
3. Enable write scopes only for approved ticket updates and escalation actions.
4. Keep secrets in environment configuration, never in plugin files.
