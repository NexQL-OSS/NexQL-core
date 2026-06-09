import * as vscode from 'vscode';
import { DatabaseTreeItem } from '../providers/DatabaseTreeProvider';
import { getDatabaseConnection, NotebookBuilder, MarkdownUtils } from './helper';
import { PartitionSQL, PartitionDefinition, PartitionStrategy } from './sql/partitions';

export async function cmdListPartitions(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item);
  try {
    const schema = item.schema!;
    const table = item.tableName || item.label;
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Partitions of ${schema}.${table}`) +
        MarkdownUtils.infoBox('Lists all partition child tables, their bounds, size, and row estimates.')
      )
      .addSql(PartitionSQL.list(schema, table))
      .addMarkdown('##### Partition Key Definition')
      .addSql(PartitionSQL.isPartitioned(schema, table))
      .show();
  } finally {
    release();
  }
}

export async function cmdDetachPartition(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  const partitionName = item.label;
  const table = item.tableName!;
  const confirm = await vscode.window.showWarningMessage(
    `Detach partition "${partitionName}" from table "${table}"? The partition will remain as a standalone table.`,
    { modal: true },
    'Detach'
  );
  if (confirm !== 'Detach') { return; }
  const { metadata, release } = await getDatabaseConnection(item);
  try {
    const schema = item.schema!;
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Detach Partition: ${partitionName}`) +
        MarkdownUtils.warningBox(`Detaching partition "${partitionName}" from "${schema}"."${table}". The table will remain as a standalone table.`)
      )
      .addSql(PartitionSQL.detach(schema, table, partitionName))
      .show();
  } finally {
    release();
  }
}

export async function cmdShowPartitionProperties(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item);
  try {
    const schema = item.schema!;
    const table = item.tableName!;
    const partitionName = item.label;
    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Partition: ${partitionName}`) +
        MarkdownUtils.infoBox(`Partition of table "${schema}"."${table}". Shows partition bound and sub-partitions if any.`)
      )
      .addSql(PartitionSQL.list(schema, table))
      .addMarkdown('##### Create Range Partition Template')
      .addSql(PartitionSQL.createRangePartition(schema, table))
      .addMarkdown('##### Create List Partition Template')
      .addSql(PartitionSQL.createListPartition(schema, table))
      .show();
  } finally {
    release();
  }
}

export async function cmdCreatePartition(item: DatabaseTreeItem, context: vscode.ExtensionContext) {
  const { metadata, release } = await getDatabaseConnection(item);
  try {
    const schema = item.schema!;
    const table = item.tableName || item.label;

    const def = await collectPartitionDefinition(schema, table);
    if (!def) {
      release();
      return;
    }

    await new NotebookBuilder(metadata)
      .addMarkdown(
        MarkdownUtils.header(`Create ${def.strategy.toUpperCase()} partition on ${schema}.${table}`) +
        MarkdownUtils.infoBox(
          `New partition "${def.partitionName}" of "${schema}"."${table}". Review the generated statement and run it when ready.`,
        ),
      )
      .addSql(PartitionSQL.createPartition(def))
      .show();
  } finally {
    release();
  }
}

/** Interactive prompts that assemble a {@link PartitionDefinition} for guided creation. */
async function collectPartitionDefinition(
  parentSchema: string,
  parentTable: string,
): Promise<PartitionDefinition | undefined> {
  const strategyPick = await vscode.window.showQuickPick(
    [
      { label: 'range', description: 'FOR VALUES FROM (...) TO (...)' },
      { label: 'list', description: 'FOR VALUES IN (...)' },
      { label: 'hash', description: 'FOR VALUES WITH (MODULUS m, REMAINDER r)' },
      { label: 'default', description: 'Catch-all DEFAULT partition' },
    ],
    { title: 'Partition strategy', placeHolder: 'Match the parent table partition key' },
  );
  if (!strategyPick) { return undefined; }
  const strategy = strategyPick.label as PartitionStrategy;

  const partitionName = (await vscode.window.showInputBox({
    title: 'New partition table name',
    placeHolder: `e.g. ${parentTable}_2024`,
    validateInput: (v) => (v && v.trim() ? undefined : 'Partition name is required'),
  }))?.trim();
  if (!partitionName) { return undefined; }

  const def: PartitionDefinition = { parentSchema, parentTable, partitionName, strategy };

  if (strategy === 'range') {
    const from = await vscode.window.showInputBox({
      title: 'Lower bound (FROM)',
      prompt: 'Inclusive lower bound expression',
      placeHolder: "e.g. '2024-01-01' or MINVALUE",
    });
    if (from === undefined) { return undefined; }
    const to = await vscode.window.showInputBox({
      title: 'Upper bound (TO)',
      prompt: 'Exclusive upper bound expression',
      placeHolder: "e.g. '2025-01-01' or MAXVALUE",
    });
    if (to === undefined) { return undefined; }
    def.from = from.trim();
    def.to = to.trim();
  } else if (strategy === 'list') {
    const values = await vscode.window.showInputBox({
      title: 'List values',
      prompt: 'Comma-separated value expressions',
      placeHolder: "e.g. 'EU', 'US', 'APAC'",
      validateInput: (v) => (v && v.trim() ? undefined : 'At least one value is required'),
    });
    if (values === undefined || !values.trim()) { return undefined; }
    def.values = values.trim();
  } else if (strategy === 'hash') {
    const modulusRaw = await vscode.window.showInputBox({
      title: 'Modulus',
      prompt: 'Total number of hash partitions',
      placeHolder: 'e.g. 4',
      validateInput: (v) => (/^\d+$/.test(v?.trim() ?? '') && Number(v) > 0 ? undefined : 'Enter a positive integer'),
    });
    if (modulusRaw === undefined) { return undefined; }
    const remainderRaw = await vscode.window.showInputBox({
      title: 'Remainder',
      prompt: `This partition's remainder (0 .. modulus-1)`,
      placeHolder: 'e.g. 0',
      validateInput: (v) => (/^\d+$/.test(v?.trim() ?? '') ? undefined : 'Enter a non-negative integer'),
    });
    if (remainderRaw === undefined) { return undefined; }
    def.modulus = Number(modulusRaw.trim());
    def.remainder = Number(remainderRaw.trim());
  }

  return def;
}
