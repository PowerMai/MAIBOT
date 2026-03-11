# Knowledge Engineering Plugin

This plugin provides Claude-style knowledge engineering workflows for ingestion, schema governance, quality auditing, and gap planning.

## Structure

- `commands/`: execution entrypoints for operational workflows
- `skills/`: reusable knowledge engineering capabilities
- `agents/`: role-specific agent overlays
- `.claude-plugin/plugin.json`: plugin manifest
- `.mcp.json`: MCP connector registry placeholder
- `CONNECTORS.md`: connector setup guidance

## Included Skills

This plugin keeps all existing knowledge engineering skills intact, including:

- user and web ingestion
- schema and ontology design/import
- entity extraction and relation verification
- quality audits and gap analysis

## Usage

1. Pick a command in `commands/` by objective.
2. Route execution through the corresponding skills.
3. Return outputs with metrics, risks, and next-step tasks.
