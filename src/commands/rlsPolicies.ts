import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils } from './helper';
import { PolicySQL } from './sql/policies';
import { requirePro, ProFeature } from '../services/featureGates';
import { RlsPolicyStudioPanel } from '../schemaDesigner/RlsPolicyStudioPanel';

/**
 * Open the visual RLS Policy Studio for a table: click-to-configure command,
 * permissive/restrictive, roles, and USING / WITH CHECK expressions with AI
 * natural-language generation and a live SQL preview (execute via notebook).
 */
export async function cmdCreatePolicy(item: DatabaseTreeItem, context: vscode.ExtensionContext): Promise<void> {
  if (!(await requirePro(ProFeature.SchemaDesigner, context))) { return; }
  await RlsPolicyStudioPanel.openForTable(item, context);
}

export async function cmdDropPolicy(item: DatabaseTreeItem, _context: vscode.ExtensionContext): Promise<void> {
  if (item.type !== 'policy' || !item.schema || !item.tableName) {
    await vscode.window.showErrorMessage('Select an RLS policy under a table to drop it.');
    return;
  }

  if (item.label.startsWith('Cannot read')) {
    await vscode.window.showErrorMessage('Policies could not be loaded. Fix permissions first.');
    return;
  }

  const policyName = item.label;
  const confirm = await vscode.window.showWarningMessage(
    `Drop policy "${policyName}" on "${item.schema}"."${item.tableName}"? Row-level access rules may change immediately.`,
    { modal: true },
    'Drop',
  );
  if (confirm !== 'Drop') {
    return;
  }

  const { metadata, release } = await getDatabaseConnection(item);
  try {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Drop policy: ${policyName}`) +
          MarkdownUtils.dangerBox(
            `Drops policy "${policyName}" on "${item.schema}"."${item.tableName}". Review and execute in the SQL cell when ready.`,
          ),
      )
      .addSql(PolicySQL.drop(item.schema, item.tableName, policyName))
      .show();
  } finally {
    release();
  }
}

