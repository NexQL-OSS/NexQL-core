import * as vscode from 'vscode';
import { ConnectionUtils } from '../../utils/connectionUtils';
import { ConnectionManager } from '../../services/ConnectionManager';
import { IndexBuilder } from './IndexBuilder';
import { IndexScope, BuildDepth, BuildMode } from './types';
import { listNonSystemSchemas } from './catalogQueries';
import { QuotaService } from '../../services/QuotaService';
import { ProFeature, requirePro } from '../../services/featureGates';

export async function runGuidedBuildWizard(
  context: vscode.ExtensionContext,
  builder: IndexBuilder,
  outputChannel: vscode.OutputChannel,
  preselected?: { connectionId: string; databaseName: string }
): Promise<void> {
  // Check quotas first if on free tier
  const allowed = await requirePro(ProFeature.DbIndexBuild);
  if (!allowed) {
    return;
  }

  // 1. Pick connection
  let connection;
  if (preselected?.connectionId) {
    connection = ConnectionUtils.findConnection(preselected.connectionId);
  }
  if (!connection) {
    connection = await ConnectionUtils.showConnectionPicker(undefined, {
      title: 'Database Index Setup',
      placeHolder: 'Select the database connection to index',
    });
  }
  if (!connection) {
    return;
  }

  // 2. Pick database
  let database = preselected?.databaseName;
  if (!database) {
    database = await ConnectionUtils.showDatabasePicker(connection, undefined, {
      title: 'Database Index Setup',
      placeHolder: 'Select the database to index',
    });
  }
  if (!database) {
    return;
  }

  // 3. Fetch schemas list
  let schemas: string[] = [];
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Connecting to fetch schemas list...',
      cancellable: false,
    },
    async () => {
      let client: any;
      try {
        client = await ConnectionManager.getInstance().getPooledClient({
          ...connection,
          database,
        });
        schemas = await listNonSystemSchemas(client);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Failed to connect and query schemas: ${err.message || err}`);
      } finally {
        if (client) {
          try { client.release(); } catch {}
        }
      }
    }
  );

  if (schemas.length === 0) {
    return;
  }

  // 4. Select schemas to index
  const schemaItems: vscode.QuickPickItem[] = schemas.map(s => ({
    label: s,
    picked: s === 'public',
  }));

  const selectedSchemas = await vscode.window.showQuickPick(schemaItems, {
    title: 'Select Schemas to Index',
    placeHolder: 'Select one or more schemas (Press Space to toggle, Enter to confirm)',
    canPickMany: true,
  });

  if (!selectedSchemas || selectedSchemas.length === 0) {
    return;
  }

  const includedSchemas = selectedSchemas.map(item => item.label);

  // 5. Select build depth
  const depthItems: (vscode.QuickPickItem & { depth: BuildDepth })[] = [
    {
      label: 'Structure only',
      description: 'Indexes tables, columns, views, constraints, and indexes',
      depth: 'structure',
    },
    {
      label: 'Structure + Statistics',
      description: 'Includes row counts, sizes, and structure',
      depth: 'stats',
    },
    {
      label: 'Structure + Stats + Sampled Profiles (Warning: sensitive stats)',
      description: 'Includes pg_stats column distributions (PII columns are automatically redacted)',
      depth: 'profiles',
    },
  ];

  const selectedDepth = await vscode.window.showQuickPick(depthItems, {
    title: 'Select Indexing Depth',
    placeHolder: 'Select detail depth for the index',
  });

  if (!selectedDepth) {
    return;
  }

  // Confirm profiles warning for prod environment
  const isProduction = connection.environment === 'production';
  if (selectedDepth.depth === 'profiles' && isProduction) {
    const confirm = await vscode.window.showWarningMessage(
      'Value profiling on a Production database indexes pg_stats information. Common PII fields are filtered out, but other user data columns could still leak details. Do you want to continue?',
      'Yes, build stats',
      'No, change depth'
    );
    if (confirm !== 'Yes, build stats') {
      return;
    }
  }

  // 6. Config PII exclusions
  const piiChoice = await vscode.window.showQuickPick(
    [
      { label: 'Keep default PII filters', description: 'Filters email, ssn, phone, password, token, address, card' },
      { label: 'Add custom PII columns', description: 'Specify additional column paths (schema.table.column) to exclude' }
    ],
    {
      title: 'PII Filtering Configuration',
      placeHolder: 'Select PII filtering preference'
    }
  );

  let piiExcludedColumns: string[] = [];
  if (piiChoice?.label === 'Add custom PII columns') {
    const customInput = await vscode.window.showInputBox({
      title: 'Custom PII Columns',
      prompt: 'Enter comma-separated column references (e.g. public.users.age, billing.orders.amount)',
      placeHolder: 'schema.table.column, schema.table.column'
    });
    if (customInput) {
      piiExcludedColumns = customInput.split(',').map(s => s.trim()).filter(s => s.length > 0);
    }
  }

  const scope: IndexScope = {
    includedSchemas,
    excludedObjects: [],
    piiExcludedColumns,
  };

  // 7. Confirm and execute
  const runConfirm = await vscode.window.showInformationMessage(
    `Start building local index for database "${database}"?`,
    'Build Index'
  );
  if (runConfirm !== 'Build Index') {
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Indexing database: ${database}`,
      cancellable: true,
    },
    async (progress, token) => {
      try {
        const manifest = await builder.build(
          connection.id,
          database,
          scope,
          selectedDepth.depth,
          'guided',
          connection.environment || 'development',
          token,
          progress
        );

        outputChannel.appendLine(`[IndexBuilder] Index built successfully in ${manifest.stats.buildMs}ms.`);
        vscode.window.showInformationMessage(
          `Index successfully built for "${database}"! (Count: ${manifest.counts.tables} tables, ${manifest.counts.views} views)`
        );

        // Refresh SettingsHubPanel & DbIndexPanel
        try {
          const { SettingsHubPanel } = await import('../settings/SettingsHubPanel');
          if (SettingsHubPanel.currentPanel) {
            SettingsHubPanel.currentPanel.refreshSection('dbindex');
          }
        } catch (e) {
          console.error('Failed to refresh SettingsHubPanel:', e);
        }
        try {
          const { DbIndexPanel } = await import('./panel/DbIndexPanel');
          if (DbIndexPanel.currentPanel) {
            DbIndexPanel.currentPanel.refreshState();
          }
        } catch (e) {
          console.error('Failed to refresh DbIndexPanel:', e);
        }
      } catch (err: any) {
        if (err instanceof vscode.CancellationError) {
          vscode.window.showInformationMessage('Database indexing was cancelled.');
        } else {
          vscode.window.showErrorMessage(`Failed to build index: ${err.message || err}`);
        }
      }
    }
  );
}
