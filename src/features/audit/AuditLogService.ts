import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildAuditEntries, serializeEntries, AuditContext } from './auditCore';
import { isProFeatureEnabled, ProFeature, requirePro, TIER_DISPLAY } from '../../services/featureGates';
import { LicenseService } from '../../services/LicenseService';
import { debugWarn } from '../../common/logger';

/**
 * Appends DDL / destructive DML run against production-tagged connections to a
 * local JSONL audit file (NexQL Singularity feature). Recording is silent and
 * best-effort: it must never block or fail query execution. On lower tiers a
 * single per-session hint is shown the first time an auditable statement runs.
 */
export class AuditLogService {
  private static instance: AuditLogService;
  private context: vscode.ExtensionContext | undefined;
  private hintedThisSession = false;

  public static getInstance(): AuditLogService {
    if (!AuditLogService.instance) {
      AuditLogService.instance = new AuditLogService();
    }
    return AuditLogService.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    this.context = context;
  }

  public logFilePath(): string | undefined {
    if (!this.context) { return undefined; }
    return path.join(this.context.globalStorageUri.fsPath, 'audit', 'prod-audit.jsonl');
  }

  /** Record auditable statements from an executed batch. Never throws. */
  public async record(ctx: AuditContext, statements: string[]): Promise<void> {
    try {
      const entries = buildAuditEntries(ctx, statements);
      if (entries.length === 0) { return; }

      if (!isProFeatureEnabled(ProFeature.AuditLog)) {
        this.hintOnce();
        return;
      }

      const file = this.logFilePath();
      if (!file) { return; }
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.appendFile(file, serializeEntries(entries), 'utf8');
    } catch (err) {
      debugWarn('AuditLogService: failed to append audit entries', err);
    }
  }

  /** One nudge per session when prod DDL runs without the Team tier — never per-statement noise. */
  private hintOnce(): void {
    if (this.hintedThisSession || LicenseService.getInstance().getTier() === 'singularity') { return; }
    this.hintedThisSession = true;
    void vscode.window
      .showInformationMessage(
        `Production DDL detected. NexQL ${TIER_DISPLAY.singularity} keeps a local audit trail of schema changes on PROD connections.`,
        'Learn More',
      )
      .then((choice) => {
        if (choice === 'Learn More') {
          void vscode.commands.executeCommand('postgres-explorer.license.openUpgrade');
        }
      });
  }

  /** Open the audit log file (creates an empty one if none exists yet). */
  public async openLog(): Promise<void> {
    if (!(await requirePro(ProFeature.AuditLog))) { return; }
    const file = this.logFilePath();
    if (!file) {
      vscode.window.showWarningMessage('Audit log unavailable — extension storage not initialized.');
      return;
    }
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      if (!fs.existsSync(file)) {
        await fs.promises.writeFile(file, '', 'utf8');
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    } catch (err) {
      debugWarn('AuditLogService: failed to open audit log', err);
      vscode.window.showErrorMessage('Could not open the audit log file.');
    }
  }
}
