import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../../providers/DatabaseTreeProvider';
import { CommandBase } from '../../common/commands/CommandBase';
import { NotebookBuilder, MarkdownUtils } from '../helper';
import { TableSQL } from '../sql';
import { cmdInsertTable, cmdUpdateTable, cmdEditTable } from './operations';

export async function cmdScriptSelect(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create SELECT script', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`📖 SELECT Script: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.infoBox('Execute the query below to retrieve data from the table.')
      )
      .addSql(TableSQL.select(item.schema!, item.label))
      .show();
  });
}

export async function cmdScriptInsert(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await cmdInsertTable(item, context);
}

export async function cmdScriptUpdate(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await cmdUpdateTable(item, context);
}

export async function cmdScriptDelete(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await CommandBase.run(context, item, 'create DELETE script', async (conn, client, metadata) => {
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`🗑️ DELETE Script: \`${item.schema}.${item.label}\``) +
        MarkdownUtils.warningBox('This will delete rows from the table. Always use a WHERE clause!')
      )
      .addSql(TableSQL.delete(item.schema!, item.label))
      .show();
  });
}

export async function cmdScriptCreate(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  await cmdEditTable(item, context);
}
