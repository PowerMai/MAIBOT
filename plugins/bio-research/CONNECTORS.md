# Bio Research Connectors

This plugin is connector-ready. Configure integrations through `.mcp.json`.

Configured MCP servers:

- `pubmed`
- `clinicaltrials-gov`
- `chembl`
- `open-targets`
- `biorxiv`
- `benchling`
- `wiley`
- `synapse`

## Setup Notes

1. Register and authenticate each MCP server in `plugins/bio-research/.mcp.json`.
2. Prefer read-only permissions for literature and database discovery.
3. Enable write scopes only when validated for internal research workflows.
4. Keep tokens and credentials outside plugin files.
