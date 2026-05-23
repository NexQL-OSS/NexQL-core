# Command Files Refactoring Guide

This guide explains how to refactor command files to use the new common utilities in `commandUtils.ts`.

## Overview

The `commandUtils.ts` file provides reusable utilities for:
- SQL query templates
- Markdown formatting
- Notebook creation
- Object type utilities
- Validation helpers
- Common maintenance operations

## Key Utilities

### 1. SQL Templates (`SQL_TEMPLATES`)

**Before:**
```typescript
const sql = `-- Drop table\nDROP TABLE IF EXISTS "${schema}"."${table}";`;
```

**After:**
```typescript
import { SQL_TEMPLATES } from './commandUtils';
const sql = SQL_TEMPLATES.DROP.TABLE(schema, table);
```

### 2. Markdown Formatting (`MarkdownUtils`)

**Before:**
```typescript
const markdown = `### Drop Table: \`${schema}.${table}\`

<div style="font-size: 12px; background-color: #3e2d2d; border-left: 3px solid #e74c3c; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px;">
    <strong>🛑 DANGER:</strong> This will permanently delete the table.
</div>`;
```

**After:**
```typescript
import { MarkdownUtils } from './commandUtils';
const markdown = MarkdownUtils.header(`Drop Table: \`${schema}.${table}\``) +
    MarkdownUtils.dangerBox('This will permanently delete the table.');
```

### 3. Object Kind Labels (`ObjectUtils`)

**Before:**
```typescript
const getKindLabel = (kind: string) => {
    switch (kind) {
        case 'r': return '📊 Table';
        case 'v': return '👁️ View';
        case 'm': return '💾 Materialized View';
        default: return kind;
    }
};
```

**After:**
```typescript
import { ObjectUtils } from './commandUtils';
const label = ObjectUtils.getKindLabel(kind);
```

### 4. Simple Notebook Creation

**Before:**
```typescript
export async function cmdDropTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
    try {
        validateItem(item);
        const connection = await getConnectionWithPassword(item.connectionId!);
        const metadata = createMetadata(connection, item.databaseName);

        const markdown = `### Drop Table: \`${item.schema}.${item.label}\`

<div style="font-size: 12px; background-color: #3e2d2d; border-left: 3px solid #e74c3c; padding: 6px 10px; margin-bottom: 15px; border-radius: 3px;">
    <strong>🛑 DANGER:</strong> This will permanently delete the table.
</div>`;

        const sql = `-- Drop table\nDROP TABLE IF EXISTS "${item.schema}"."${item.label}";`;

        const cells = [
            new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, markdown, 'markdown'),
            new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql, 'sql')
        ];

        await createAndShowNotebook(cells, metadata);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create drop table notebook: ${err.message}`);
    }
}
```

**After:**
```typescript
import { createSimpleNotebook, SQL_TEMPLATES, MarkdownUtils } from './commandUtils';
import { validateItem } from './connection';

export async function cmdDropTable(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
    try {
        validateItem(item);
        
        const markdown = MarkdownUtils.header(`Drop Table: \`${item.schema}.${item.label}\``) +
            MarkdownUtils.dangerBox('This will permanently delete the table.');
        
        const sql = SQL_TEMPLATES.DROP.TABLE(item.schema, item.label);

        await createSimpleNotebook(item, 'Drop Table', sql, markdown);
    } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to create drop table notebook: ${err.message}`);
    }
}
```

### 5. Multi-Section Notebooks

**Before:**
```typescript
const cells = [
    new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '##### 📖 Query Data', 'markdown'),
    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql1, 'sql'),
    new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, '##### 🗑️ Drop Table', 'markdown'),
    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, sql2, 'sql')
];
```

**After:**
```typescript
import { createMultiSectionNotebook } from './commandUtils';

await createMultiSectionNotebook(item, [
    { title: '📖 Query Data', sql: sql1 },
    { title: '🗑️ Drop Table', sql: sql2, markdown: MarkdownUtils.warningBox('This is destructive') }
]);
```

### 6. Properties Tables

**Before:**
```typescript
const markdown = `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left; width: 30%;">Property</th><th style="text-align: left;">Value</th></tr>
    <tr><td><strong>Name</strong></td><td>${name}</td></tr>
    <tr><td><strong>Owner</strong></td><td>${owner}</td></tr>
    <tr><td><strong>Size</strong></td><td>${size}</td></tr>
</table>`;
```

**After:**
```typescript
import { MarkdownUtils } from './commandUtils';

const markdown = MarkdownUtils.propertiesTable({
    'Name': name,
    'Owner': owner,
    'Size': size
});
```

### 7. Operations Tables

**Before:**
```typescript
const markdown = `<table style="font-size: 11px; width: 100%; border-collapse: collapse;">
    <tr><th style="text-align: left;">Operation</th><th style="text-align: left;">Description</th><th style="text-align: left;">Risk Level</th></tr>
    <tr><td><strong>Query</strong></td><td>View data</td><td>✅ Safe</td></tr>
    <tr><td><strong>Drop</strong></td><td>Delete table</td><td>🔴 Destructive</td></tr>
</table>`;
```

**After:**
```typescript
import { MarkdownUtils } from './commandUtils';

const markdown = MarkdownUtils.operationsTable([
    { operation: '🔍 Query', description: 'View data', riskLevel: '✅ Safe' },
    { operation: '🗑️ Drop', description: 'Delete table', riskLevel: '🔴 Destructive' }
]);
```

### 8. Format Helpers

**Before:**
```typescript
const isNullableText = column.is_nullable === 'YES' ? '✅ Yes' : '🚫 No';
const comment = column.comment || '—';
```

**After:**
```typescript
import { FormatHelpers } from './commandUtils';

const isNullableText = FormatHelpers.formatBoolean(column.is_nullable === 'YES');
const comment = FormatHelpers.formatArray([column.comment], '—');
```

### 9. Validation

**Before:**
```typescript
const input = await vscode.window.showInputBox({
    prompt: 'Enter column name',
    validateInput: (value) => {
        if (!value) return 'Column name cannot be empty';
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
            return 'Invalid column name. Use only letters, numbers, and underscores.';
        }
        return null;
    }
});
```

**After:**
```typescript
import { ValidationHelpers } from './commandUtils';

const input = await vscode.window.showInputBox({
    prompt: 'Enter column name',
    validateInput: ValidationHelpers.validateColumnName
});
```

### 10. Maintenance Operations

**Before:**
```typescript
const sql = `-- Vacuum table\nVACUUM (VERBOSE, ANALYZE) ${schema}.${table};`;
```

**After:**
```typescript
import { MaintenanceTemplates } from './commandUtils';

const sql = MaintenanceTemplates.vacuum(schema, table);
```

### 11. Error Handling

**Before:**
```typescript
} catch (err: any) {
    vscode.window.showErrorMessage(`Failed to generate SELECT statement: ${err.message}`);
}
```

**After:**
```typescript
import { ErrorHandlers } from './commandUtils';

} catch (err: any) {
    await ErrorHandlers.handleCommandError(err, 'generate SELECT statement');
}
```

**Or with action button:**
```typescript
await ErrorHandlers.showError(
    'Operation failed: ' + message,
    'Open Settings',
    'workbench.action.openSettings'
);
```

### 12. String Utilities

**Before:**
```typescript
responseText = responseText.replace(/^```sql\n/, '').replace(/^```\n/, '').replace(/\n```$/, '');
```

**After:**
```typescript
import { StringUtils } from './commandUtils';

responseText = StringUtils.cleanMarkdownCodeBlocks(responseText);
```

## Benefits of Refactoring

1. **Code Consistency**: All commands use the same styling and formatting
2. **Easier Maintenance**: Update formatting once, affects all commands
3. **Reduced Duplication**: Common patterns extracted to reusable functions
4. **Better Type Safety**: Centralized validation and utilities
5. **Improved Readability**: Command files focus on business logic, not boilerplate
6. **Faster Development**: New commands can be built quickly using existing patterns

## Migration Strategy

1. **Identify duplicated code** in your command file
2. **Check if utility exists** in `commandUtils.ts`
3. **Import the utility** instead of duplicating code
4. **Test the command** to ensure it works as expected
5. **Remove old code** that's been replaced by utilities

## Example: Complete Refactored File

See `views.ts` (after refactoring) for a complete example of a fully refactored command file.

## Adding New Utilities

If you find a pattern that's repeated across multiple files but not yet in `commandUtils.ts`:

1. Add it to the appropriate section in `commandUtils.ts`
2. Export it for use in other files
3. Update this guide with the new utility
4. Refactor existing files to use the new utility

## Common Patterns Summary

| Pattern | Utility | Location |
|---------|---------|----------|
| SQL DROP statements | `SQL_TEMPLATES.DROP.*` | commandUtils.ts |
| SQL SELECT statements | `SQL_TEMPLATES.SELECT.*` | commandUtils.ts |
| Info boxes | `MarkdownUtils.infoBox()` | commandUtils.ts |
| Warning boxes | `MarkdownUtils.warningBox()` | commandUtils.ts |
| Danger boxes | `MarkdownUtils.dangerBox()` | commandUtils.ts |
| Success/tip boxes | `MarkdownUtils.successBox()` | commandUtils.ts |
| Object type icons | `ObjectUtils.getKindLabel()` | commandUtils.ts |
| Simple notebooks | `createSimpleNotebook()` | commandUtils.ts |
| Multi-section notebooks | `createMultiSectionNotebook()` | commandUtils.ts |
| Properties tables | `MarkdownUtils.propertiesTable()` | commandUtils.ts |
| Operations tables | `MarkdownUtils.operationsTable()` | commandUtils.ts |
| Format booleans | `FormatHelpers.formatBoolean()` | commandUtils.ts |
| Validate identifiers | `ValidationHelpers.validateIdentifier()` | commandUtils.ts |
| Maintenance operations | `MaintenanceTemplates.*` | commandUtils.ts |
| Error handling | `ErrorHandlers.showError()`, `ErrorHandlers.handleCommandError()` | commandUtils.ts |
| String utilities | `StringUtils.cleanMarkdownCodeBlocks()`, `StringUtils.truncate()` | commandUtils.ts |

## Questions?

If you're unsure how to refactor a specific pattern, check:
1. This guide for examples
2. `commandUtils.ts` for available utilities
3. Existing refactored files for real-world examples
