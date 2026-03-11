# Productivity Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Suggested connector categories:

- Calendar systems (Google Calendar, Outlook)
- Task systems (Jira, Linear, Trello, Asana)
- Notes and docs (Notion, Confluence, Docs APIs)
- Messaging and reminders (Slack, Teams, email)

## Setup Notes

1. Register MCP servers in `plugins/productivity/.mcp.json`.
2. Grant least-privilege access by default.
3. Validate write scopes before enabling task updates.
4. Keep credentials out of plugin files and use environment secrets.
