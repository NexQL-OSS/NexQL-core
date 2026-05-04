import * as vscode from 'vscode';
import type { ConnectionConfig } from '../../common/types';
import { getConnectionWithPassword } from '../../commands/connection';
import { buildPgDumpArgv } from './buildPgDumpArgs';
import { runPgTool } from './PgToolRunner';
import { prependConnectionArgs, resolveConnectionForTools } from './resolveConnectionForTools';
import type { PgDumpFormatFlag } from './types';

export interface PgStudioPgDumpTaskDefinition extends vscode.TaskDefinition {
  type: 'pgstudio-pgdump';
  connectionId: string;
  databaseName: string;
  outputPath: string;
  dumpFormat?: 'custom' | 'plain' | 'directory' | 'tar';
  verbose?: boolean;
  schemaOnly?: boolean;
  dataOnly?: boolean;
}

export function registerPgDumpTaskProvider(context: vscode.ExtensionContext): void {
  const provider: vscode.TaskProvider = {
    provideTasks: () => Promise.resolve([]),

    resolveTask(task: vscode.Task): vscode.Task | undefined {
      if (task.definition.type !== 'pgstudio-pgdump') {
        return undefined;
      }
      const def = task.definition as PgStudioPgDumpTaskDefinition;
      if (!def.connectionId || !def.databaseName || !def.outputPath) {
        return undefined;
      }

      const execution = new vscode.CustomExecution(async () => {
        const writeEmitter = new vscode.EventEmitter<string>();
        const closeEmitter = new vscode.EventEmitter<number>();

        const pty: vscode.Pseudoterminal = {
          onDidWrite: writeEmitter.event,
          onDidClose: closeEmitter.event,
          open: async () => {
            let exitCode = 1;
            try {
              const connRow = await getConnectionWithPassword(def.connectionId, def.databaseName);
              const connections =
                vscode.workspace.getConfiguration().get<ConnectionConfig[]>('postgresExplorer.connections') || [];
              const cfg = connections.find(c => c.id === connRow.id);
              if (!cfg) {
                writeEmitter.fire('Connection id not found in settings.\r\n');
                closeEmitter.fire(1);
                return;
              }

              const resolved = await resolveConnectionForTools(cfg, connRow.password);
              try {
                const fmtMap: Record<string, PgDumpFormatFlag> = {
                  custom: 'c',
                  plain: 'p',
                  directory: 'd',
                  tar: 't'
                };
                const fmt = fmtMap[def.dumpFormat ?? 'custom'] ?? 'c';
                const argv = buildPgDumpArgv({
                  format: fmt,
                  verbose: def.verbose ?? true,
                  schemaOnly: def.schemaOnly ?? false,
                  dataOnly: def.dataOnly ?? false,
                  blobs: true,
                  parallelJobs: 1,
                  compression: fmt === 'c' ? 9 : null,
                  outputPath: def.outputPath,
                  database: def.databaseName
                });
                const fullArgv = prependConnectionArgs(argv, resolved);
                writeEmitter.fire(fullArgv.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ') + '\r\n\r\n');

                const result = await runPgTool({
                  argv: fullArgv,
                  env: resolved.env,
                  onStdout: chunk => writeEmitter.fire(chunk.replace(/\n/g, '\r\n')),
                  onStderr: chunk => writeEmitter.fire(chunk.replace(/\n/g, '\r\n'))
                });
                exitCode = result.exitCode === 0 ? 0 : 1;
              } finally {
                resolved.dispose();
              }
            } catch (e) {
              writeEmitter.fire(`${e}\r\n`);
              exitCode = 1;
            }
            closeEmitter.fire(exitCode);
          },
          close: () => {}
        };

        return pty;
      });

      return new vscode.Task(
        task.definition as vscode.TaskDefinition,
        task.scope ?? vscode.TaskScope.Workspace,
        task.name || `pg_dump ${def.databaseName}`,
        task.source || 'pgstudio',
        execution,
        task.problemMatchers ?? []
      );
    }
  };

  context.subscriptions.push(vscode.tasks.registerTaskProvider('pgstudio-pgdump', provider));
}
