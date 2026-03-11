# Finance Plugin

This plugin provides Claude-style finance workflows for period close and management analysis:

- Coordinate close execution and checklist progress
- Prepare reconciliations with traceable differences
- Explain variance with ROI and cost impact framing
- Support audit-ready statement and evidence outputs

## Structure

- `commands/`: entrypoints for close, reconciliation, and variance runs
- `skills/`: finance domain skills
- `.claude-plugin/plugin.json`: plugin manifest
- `.mcp.json`: MCP connector registry placeholder
- `CONNECTORS.md`: connector setup guidance

## Migration Notes

This plugin reuses relevant patterns from staging references:

- `tmp/skills_migration_staging/cost-optimization/SKILL.md`
- `tmp/skills_migration_staging/roi-analysis/SKILL.md`
- `tmp/skills_migration_staging/quality-report/SKILL.md`
