/**
 * Registry seam for the premium Cloud Sync feature. Core tree providers and
 * commands call through this module instead of importing the concrete
 * SyncController/SyncIndex classes, which live in packages/pro/src — never
 * in the free build. Set during activatePro; every accessor is undefined
 * (and callers fall back gracefully) in builds without the sync feature.
 */

export interface ISyncEntry {
  kind: 'notebook' | 'query';
  spaceId?: string;
  filePath?: string;
  name?: string;
}

export interface ISyncTeamItem {
  id: string;
  entry: ISyncEntry;
}

export interface ISyncDataSource {
  listTeamItems(): ISyncTeamItem[];
  getWorkspaceName(spaceId: string): string | undefined;
  getRoleForSpace(spaceId: string): string | undefined;
  findByPath(filePath: string): ISyncTeamItem | undefined;
  getEntryById(id: string): ISyncTeamItem | undefined;
  /** Mark a locally-deleted item excluded from future cloud sync (keeps the cloud copy). */
  setItemExcluded(id: string, excluded: boolean): Promise<void>;
  /** Remove an item from cloud storage outright. */
  removeFromCloud(id: string): Promise<boolean>;
  /** Debounced check for remote changes right after a user opens an item. */
  scheduleOpenCheck(
    itemId: string,
    opts?: {
      kind?: 'notebook' | 'query';
      label?: string;
      reloadUri?: import('vscode').Uri;
      onReload?: () => void;
    },
  ): void;
  isItemReadOnly(id: string): boolean;
}

export interface ICloudDeletePrompt {
  isItemSyncedToCloud(context: import('vscode').ExtensionContext, itemId: string): boolean;
  resolveDeleteCloudChoice(
    context: import('vscode').ExtensionContext,
    itemId: string,
    itemLabel: string,
  ): Promise<'keep-cloud' | 'delete-cloud' | null>;
  applyLocalDeleteCloudChoice(itemId: string, choice: 'keep-cloud' | 'delete-cloud'): Promise<void>;
}

/** Write-capable handle onto the local sync item index, scoped to one extension context. */
export interface ISyncIndexHandle {
  get(id: string): ISyncEntry | undefined;
  findByPath(filePath: string): ISyncTeamItem | undefined;
  update(id: string, patch: Partial<ISyncEntry> & { kind: 'notebook' | 'query' }): void;
  flush(): Promise<void>;
}

export interface IAiUsageBackend {
  fetchUsage(context: import('vscode').ExtensionContext): Promise<any | null>;
}

export type ISyncBootstrapHook = (context: import('vscode').ExtensionContext) => void | Promise<void>;
export type ISyncIndexFactory = (context: import('vscode').ExtensionContext) => ISyncIndexHandle;
/** Loosely-typed activity record — shape owned by the premium SyncActivityLog; core only ever forwards it. */
export type ISyncActivityInput = Record<string, unknown>;

let syncDataSource: ISyncDataSource | undefined;
let cloudDeletePrompt: ICloudDeletePrompt | undefined;
let aiUsageBackend: IAiUsageBackend | undefined;
let syncBootstrapHook: ISyncBootstrapHook | undefined;
let syncIndexFactory: ISyncIndexFactory | undefined;
let syncActivityRecorder: ((input: ISyncActivityInput) => void) | undefined;
let instantSyncTrigger: (() => void) | undefined;

export function setSyncDataSource(ds: ISyncDataSource | undefined): void {
  syncDataSource = ds;
}
export function getSyncDataSource(): ISyncDataSource | undefined {
  return syncDataSource;
}

export function setCloudDeletePrompt(p: ICloudDeletePrompt | undefined): void {
  cloudDeletePrompt = p;
}
export function getCloudDeletePrompt(): ICloudDeletePrompt | undefined {
  return cloudDeletePrompt;
}

export function setAiUsageBackend(b: IAiUsageBackend | undefined): void {
  aiUsageBackend = b;
}
export function getAiUsageBackend(): IAiUsageBackend | undefined {
  return aiUsageBackend;
}

export function setSyncBootstrapHook(hook: ISyncBootstrapHook | undefined): void {
  syncBootstrapHook = hook;
}
export function getSyncBootstrapHook(): ISyncBootstrapHook | undefined {
  return syncBootstrapHook;
}

export function setSyncIndexFactory(factory: ISyncIndexFactory | undefined): void {
  syncIndexFactory = factory;
}
export function createSyncIndex(context: import('vscode').ExtensionContext): ISyncIndexHandle | undefined {
  return syncIndexFactory?.(context);
}

export function setSyncActivityRecorder(recorder: ((input: ISyncActivityInput) => void) | undefined): void {
  syncActivityRecorder = recorder;
}
export function recordSyncActivity(input: ISyncActivityInput): void {
  syncActivityRecorder?.(input);
}

export function setInstantSyncTrigger(trigger: (() => void) | undefined): void {
  instantSyncTrigger = trigger;
}
export function triggerInstantSync(): void {
  instantSyncTrigger?.();
}
