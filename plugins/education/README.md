# Education Plugin

This plugin provides Claude-style education workflows for homework checking, student learning support, and teacher lesson preparation.

## Structure

- `commands/`: education execution entrypoints
- `skills/`: reusable education capabilities
- `.claude-plugin/plugin.json`: plugin manifest
- `.mcp.json`: MCP connector registry placeholder
- `CONNECTORS.md`: connector setup guidance

## Migration Notes

This plugin migrates staged skills from `tmp/skills_migration_staging`:

- `homework_check` -> `skills/homework-check`
- `student_learning` -> `skills/student-learning`
- `teacher_lesson_prep` -> `skills/teacher-lesson-prep`
