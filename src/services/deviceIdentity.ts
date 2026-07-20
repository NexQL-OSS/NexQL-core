import * as crypto from 'crypto';
import * as vscode from 'vscode';

// Keys are shared with packages/pro/src/features/sync/constants.ts (same
// string values) — duplicated here since this file is core-owned and must
// not depend on the premium package.
const SYNC_DEVICE_ID_KEY = 'postgres-explorer.sync.deviceId';
const SYNC_DEVICE_NAME_KEY = 'postgres-explorer.sync.deviceName';

export function getOrCreateDeviceId(context: vscode.ExtensionContext): string {
  const existing = context.globalState.get<string>(SYNC_DEVICE_ID_KEY);
  if (existing) {
    return existing;
  }
  const id = crypto.randomUUID();
  void context.globalState.update(SYNC_DEVICE_ID_KEY, id);
  return id;
}

export function defaultDeviceName(): string {
  const host = vscode.env.appName?.trim();
  const suffix = vscode.env.machineId.slice(0, 8);
  if (host && suffix) {
    return `${host} (${suffix})`;
  }
  return host || suffix || 'This device';
}

export function getDeviceName(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(SYNC_DEVICE_NAME_KEY);
}

export async function setDeviceName(context: vscode.ExtensionContext, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error('Device name is required');
  }
  await context.globalState.update(SYNC_DEVICE_NAME_KEY, trimmed);
}

export async function ensureDeviceName(context: vscode.ExtensionContext): Promise<string> {
  const existing = getDeviceName(context);
  if (existing) {
    return existing;
  }
  const defaultName = defaultDeviceName();
  const name = await vscode.window.showInputBox({
    title: 'Name this device',
    prompt: 'Shown in sync history and device list',
    value: defaultName,
    ignoreFocusOut: true,
  });
  const resolved = (name || defaultName).trim();
  await context.globalState.update(SYNC_DEVICE_NAME_KEY, resolved);
  return resolved;
}
